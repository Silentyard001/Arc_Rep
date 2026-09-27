# Arc Rep — Mainnet Readiness Audit
# Date: 2026-09-27
# Auditor: Arc Studio
# Status: READ-ONLY. No files modified.

## MAINNET READINESS

**READY WITH LIMITATIONS**

The application is deployable to Arc Mainnet today. The RPC provider
(`ArcRpcProvider`) functions correctly against Arc Mainnet RPC with no code
changes. Five of eight credentials evaluate from partial RPC data. The
remaining three require full historical Goldsky data and correctly surface
as `insufficient_data` until that infrastructure is restored.

The limitations are infra-only, not code defects.

---

## BLOCKERS

None. There are no application-layer blockers preventing deployment.

---

## REQUIRED BEFORE DEPLOYMENT

1. **`src/config.ts` references `arcTestnet` from `viem/chains`** — the
   frontend wagmi config hardcodes Arc Testnet (chain ID 5042002) as its
   primary chain. The RPC provider and all backend logic already target
   mainnet when `RPC_PROXY_CHAINS` contains `Arc_Mainnet`, but the frontend
   wallet connection, chain display, and ConnectKit modal still offer Arc
   Testnet. For a mainnet deployment the wagmi config must reference the
   mainnet chain (chain ID 5042).

   File: `src/config.ts`
   Change needed: swap `arcTestnet` for Arc Mainnet chain definition.
   Impact: wallet connection, ConnectKit chain display, frontend chain badge.
   This is the only code change required for mainnet.

2. **`Dockerfile` run-comment example uses `Arc_Testnet`** — the inline
   `docker run` example in the Dockerfile header says
   `-e RPC_PROXY_CHAINS=Arc_Testnet`. This is documentation only; it does not
   affect runtime. Needs updating to `Arc_Mainnet` before production Docker
   docs are shared.

3. **`start.sh` env validation checks `RPC_PROXY_*` but does not validate
   `RPC_PROXY_CHAINS` value** — the script confirms the var is set but not
   that it contains the correct chain key (`Arc_Mainnet` vs `Arc_Testnet`).
   A misconfigured chain key would silently fall back to public RPC. Low
   impact but worth noting.

---

## NON-BLOCKING ISSUES

1. **`server/index.ts` comment still says `arc-rep-pipeline.yaml`** — stale
   reference to the superseded Mirror pipeline. Documentation only.

2. **`seed-data.ts` comment says "Arc Testnet contracts unless noted otherwise"**
   — the registry contains both testnet and mainnet contracts correctly; the
   comment is misleading. Not a runtime issue.

3. **`ArcRpcProvider` uses `ARC_TESTNET_COMPASS_KEY = 'Arc_Testnet'`** for
   the RPC proxy lookup. For mainnet this should resolve against `Arc_Mainnet`.
   However: the provider does not fail if the compass key doesn't match — it
   falls back to the public RPC URL from `onchain-facts`. The fallback is the
   correct mainnet URL (`https://rpc.mainnet.arc.io`). No crash, no wrong
   network. Medium priority to fix for performance (proxy is faster than
   public RPC) but not a blocker.

4. **CORS is wide-open (`app.use(cors())`)** — allows any origin. Acceptable
   for a public read-only API but should be locked to the production domain
   before broad launch.

5. **Chunk size warnings in production build** — three chunks exceed 500 kB.
   Pre-existing, caused by Circle SDK dependencies. No functional impact.

6. **`vite.config.ts` proxy target is `localhost:3001`** — correct for
   development; in Docker the frontend static files are served separately and
   the proxy is not used. No production impact.

---

## POST-FUNDING INFRASTRUCTURE

1. **Supabase disk-full** — the `arc_rep` Postgres database is currently
   unavailable. The `GoldskyActivityProvider` cannot connect until storage
   is expanded. Application falls back cleanly to `ArcRpcProvider`. No code
   change needed; this is an infra-only issue.

2. **Goldsky pipeline** — the Turbo pipeline definition
   (`infra/goldsky/arc-rep-turbo.yaml`) is ready and validated for
   Arc Mainnet. It cannot run until Supabase storage is available.

3. **`ARC_EARLY_ADOPTER` credential** — requires full historical `firstSeen`
   from the Goldsky backfill. Currently returns `insufficient_data` for all
   wallets. Will auto-evaluate once backfill reaches block 14,722,074 with
   Supabase available.

4. **`ARC_BUILDER` credential** — requires `builderActivity` signal. Uses
   `isContractCreation` from `NormalizedTransaction`. Currently returns
   `insufficient_data` on partial history (no positive evidence from RPC
   window). Will auto-evaluate once full history is available.

5. **`ARC_LIQUIDITY_PARTICIPANT` credential** — `liquidityActivity` signal
   is `future`. Not evaluable until that signal is implemented.

---

## TEST RESULTS

- **Tests: 458 pass / 0 fail** (21 test files)
- **TypeScript: PASS** (0 errors)
- **Lint: PASS** (0 errors, 2 pre-existing test-only warnings)
- **Production build: PASS** (3 pre-existing chunk-size warnings from
  Circle SDK, not Arc Rep code)

---

## MAINNET CONFIGURATION

| Item | Current value | Mainnet-ready? |
|---|---|---|
| Backend chain ID | Not hardcoded — reads from `onchain-facts` | Yes |
| RPC (ArcRpcProvider) | `ARC_TESTNET_COMPASS_KEY = 'Arc_Testnet'` proxy key | Partial (falls back to public mainnet RPC) |
| RPC fallback | `https://rpc.mainnet.arc.io` (from onchain-facts chain 5042) | Yes |
| USDC contract | `0x3600000000000000000000000000000000000000` | Yes (same address on mainnet) |
| System emitter | `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` | Yes (same on mainnet) |
| Goldsky threshold | 14,722,074 (Arc Mainnet first activity block) | Yes |
| CCTP contracts (seed-data) | Both testnet and mainnet entries present | Yes |
| Gateway contracts (seed-data) | Both testnet and mainnet entries present | Yes |
| Frontend chain | `arcTestnet` (chain ID 5042002) | NO — needs change |
| Provider strategy | `ArcRpcProvider` (RPC window, partial history) | Yes for current state |
| Provider fallback | `GoldskyActivityProvider` when `GOLDSKY_POSTGRES_URL` is set | Yes (deferred) |

---

## CURRENT FUNCTIONALITY (what Arc Rep can demonstrate right now)

With `ArcRpcProvider` on Arc Mainnet:

| Feature | Status |
|---|---|
| Wallet lookup (any address) | Working |
| `GET /health` | Working — returns provider, startedAt, uptime |
| `GET /profile/:address` | Working — full profile with signals + credentials |
| `GET /signals/:address` | Working |
| `GET /credentials/:address` | Working |
| Invalid address → 400 | Working |
| `ARC_ACTIVE_WALLET` | Evaluates — uses nonce + 10,000-block scan |
| `ARC_MULTI_APP_USER` | Evaluates — uses contract interactions in scan window |
| `ARC_CONSISTENT_USER` | Evaluates — uses active days in scan window |
| `ARC_PAYMENTS_PARTICIPANT` | Evaluates — uses USDC Transfer logs in scan window |
| `ARC_BRIDGE_USER` | Evaluates from partial — non-zero evidence can issue |
| `ARC_EARLY_ADOPTER` | `insufficient_data` — requires full history |
| `ARC_BUILDER` | `insufficient_data` — requires full history |
| `ARC_LIQUIDITY_PARTICIPANT` | `insufficient_data` — signal future |
| `mayBeTruncated` caveat | Shown in UI when data is partial |
| Retry on error | Working |
| Profile refresh | Working |
| Invalid address guard | Working (frontend + backend) |
| USDC 6-decimal formatting | Working |

---

## DEPLOYMENT PLAN (minimum steps for mainnet deployment)

**Required code change (1 file):**
Change `src/config.ts` to reference Arc Mainnet chain ID 5042 instead of
`arcTestnet`. This is the only blocking code change.

**Environment variables for production:**
```
RPC_PROXY_BASE_URL=<your-rpc-proxy>
RPC_PROXY_TOKEN=<your-token>
RPC_PROXY_CHAINS=Arc_Mainnet       ← change from Arc_Testnet
PORT=3001
# GOLDSKY_POSTGRES_URL=           ← leave unset until Supabase is available
```

**Deployment sequence:**
1. Fix `src/config.ts` (swap arcTestnet → Arc Mainnet)
2. Run `bun test` — confirm 458 pass
3. Run `bunx vite build` — confirm build passes
4. Build Docker image: `docker build -t arc-rep .`
5. Deploy with production env vars
6. Confirm `GET /health` returns `"provider": "ArcRpcProvider"`
7. Test a real Arc Mainnet wallet address
8. When Supabase storage is expanded: set `GOLDSKY_POSTGRES_URL` and restart

---

## DO NOT TOUCH (intentionally frozen per audit instructions)

- `infra/goldsky/arc-rep-turbo.yaml` — Goldsky pipeline, not deployed
- `server/data/GoldskyActivityProvider.ts` — provider logic, no changes needed
- Supabase database schema or storage
- Goldsky pipeline deployment or backfill state
- `EARLY_ADOPTER_CUTOFF_UNIX` (1767225599 = 2025-12-31T23:59:59Z) — product decision
- `DEFAULT_BACKFILL_GENESIS_THRESHOLD` (14,722,074) — verified mainnet boundary
