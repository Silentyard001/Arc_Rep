# Phase 10 — Production Deployment & Operational Hardening

## Verdict: PRODUCTION READY

No blockers remain in the application layer. Goldsky authentication is the only
outstanding external dependency. The process-supervision gap discovered in Phase 9
is resolved.

---

## Deployment Inventory (pre-Phase 10)

| Item | State found |
|---|---|
| Frontend build | `vite build` → `dist/` — working |
| Backend runtime | `bun run server/index.ts` — working |
| `start` script | `package.json` → `bun run server/index.ts` |
| Process supervisor | **None** — Phase 9 found stale process running since Sep 23 |
| Dockerfile | **None** |
| Health endpoint | `/health` — existed but no deployment-verification fields |
| Environment vars | 5 server vars, documented in `.env.example` |
| `.gitignore` | Correct — `.env` protected, `.env.example` safe |
| PM2 | Not installed |
| Docker | Available but unused |

---

## Changes Made

### 1. `Dockerfile`
Multi-stage build:
- `deps` stage: `bun install --frozen-lockfile`
- `builder` stage: `bun run build` → `dist/`
- `production` stage: copies only `node_modules/`, `dist/`, `server/`, runs as non-root `arcuser`
- `HEALTHCHECK`: polls `GET /health` every 15s
- `EXPOSE`: 8080 (frontend), 3001 (API)
- `CMD`: `start.sh`

### 2. `start.sh`
Shell supervisor script:
- **Required env var validation**: fails loudly on missing `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` rather than starting in a degraded state
- **API restart loop**: restarts on non-zero exit up to `MAX_RESTARTS=10`, then stops
- **Clean shutdown**: exit code 0 stops the loop without restarting
- **Frontend process**: `bunx serve -s dist` on `FRONTEND_PORT` (default 8080), terminated on exit
- **Logging**: all events go to stdout/stderr for container log collection

### 3. Health endpoint (`server/routes/health.ts`)
New fields:
```json
{
  "status": "ok",
  "service": "arc-rep-api",
  "version": "1.0.0",
  "provider": "ArcRpcProvider",
  "startedAt": "2026-09-26T09:10:19.222Z",
  "uptimeSeconds": 48,
  "timestamp": "2026-09-26T09:11:07.859Z"
}
```
`startedAt` is set at module load time. After deployment, comparing `startedAt` to
the deploy time confirms the new process is actually running — resolving the Phase 9
stale-process risk.

### 4. `.env.example`
Updated to document all 5 server environment variables with inline explanations
of required vs optional and their purpose.

---

## Smoke Test Results

| Check | Result | Notes |
|---|---|---|
| Backend startup | PASS | 9 apps, 17 contracts, correct provider |
| Health check | PASS | Returns `provider`, `startedAt`, `uptimeSeconds` |
| Health via Vite proxy | PASS | `/api/health` correctly proxied |
| Invalid address | PASS | 400 + `INVALID_ADDRESS` code, no provider call |
| Zero-activity credentials | PASS | `ARC_EARLY_ADOPTER` = `insufficient_data`, `ARC_ACTIVE_WALLET` = `not_earned` |
| Builder/Bridge/Liquidity | PASS | All `insufficient_data` (partial/future signals) |
| Production build | PASS | `bun run build` → `dist/` in 17s |
| Restart recovery | PASS | Health returns 200 after process kill+restart |

---

## Environment & Secrets

No secrets in `src/`. No server env vars exposed to the browser. All credentials
read from `process.env.*`. `.env` correctly gitignored. `.env.example` contains
only placeholder names.

---

## Goldsky Status

**BLOCKED (external).**

The pipeline YAML is correct and ready. Authentication requires:
1. `goldsky login --token YOUR_API_KEY` in the Arc Studio terminal (desktop)
2. `turbo validate infra/goldsky/arc-rep-turbo.yaml`
3. `turbo apply` (explicit user authorization)

Once Goldsky is live and `GOLDSKY_POSTGRES_URL` is set, `start.sh` logs the
provider switch at startup, and `GET /health` returns `"provider": "GoldskyActivityProvider"`.

---

## Regression

- Tests: **442 pass / 0 fail** (unchanged from Phase 9 baseline)
- TypeScript: **PASS** (0 errors)
- Lint: **PASS** (0 errors, 2 pre-existing test-only warnings)
- Production build: **PASS**

---

## Final Production Gate

| | Status |
|---|---|
| APPLICATION | READY |
| DEPLOYMENT | READY (Dockerfile + start.sh) |
| PROCESS SUPERVISION | READY (restart loop, env validation, clean shutdown) |
| GOLDSKY | BLOCKED (external auth) |
| SECRETS/CONFIG | READY |
| MONITORING | READY (health endpoint with startedAt, provider, uptime) |
| REMAINING BLOCKERS | None (application layer) |

---

## Product Decision Required

`EARLY_ADOPTER_CUTOFF_UNIX` is currently set to `2025-12-31 23:59:59 UTC`.
This is approximately 9 months in the past. Before Goldsky backfill completes
and `ARC_EARLY_ADOPTER` transitions from `insufficient_data` to evaluable,
confirm whether:
- 2025-12-31 remains the intended early-adopter cutoff
- A different Arc ecosystem milestone date should be used
- The credential definition should be revised

This is a product decision, not an engineering bug.
