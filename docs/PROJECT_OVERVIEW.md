# Arc Rep — Project Overview

> Version: September 2026  
> Test status: 458 passing / 0 failing  
> TypeScript: PASS | Lint: PASS | Production build: PASS

---

## 1. What Arc Rep Is

Arc Rep is an on-chain wallet activity reputation infrastructure for the Arc blockchain ecosystem. It produces deterministic, explainable signals and verifiable credentials derived exclusively from observed on-chain behavior.

**Arc Rep does not determine, imply, or assert the trustworthiness of any wallet owner.** Wallets represent people, DAOs, protocols, bots, exchanges, treasuries, and smart contracts. Arc Rep does not know which. Every credential description in the codebase explicitly states: "this credential describes observed activity; it does not imply trustworthiness."

The system is designed so that:

- Every signal has a precise, auditable calculation definition.
- Every credential has a deterministic, documented eligibility rule.
- Incomplete or unavailable data propagates visibly through the entire stack — it is never silently converted to zero activity or a negative result.
- The data quality of every result is communicated to consumers.

---

## 2. Core Concept

The data model has four distinct layers. They must not be conflated:

```
raw on-chain activity
        ↓
   ActivitySignal   (a measured, observable fact about a wallet)
        ↓
   Credential       (a verifiable statement that a threshold was met)
        ↓
   reputation       (NOT IMPLEMENTED — deliberately out of scope)
```

Arc Rep does not produce numerical reputation scores, rankings, or leaderboards. Those are explicitly out of scope.

### Credential statuses

Every credential returns exactly one of four statuses:

| Status | Meaning |
|---|---|
| `active` | Sufficient evidence satisfies the eligibility rule |
| `not_earned` | Sufficient usable evidence exists but the threshold was not met |
| `insufficient_data` | The system cannot reliably determine eligibility — evidence is missing, unavailable, or historically incomplete |
| `stale` | Credential was previously earned but the underlying data has expired |

`insufficient_data` is semantically distinct from `not_earned`. Provider failure, truncated history, and future/unimplemented signals all produce `insufficient_data` — never `not_earned`.

---

## 3. Architecture

### Data flow

```
Browser (React/Vite)
        ↓  HTTP /api/*
Express API (Node/Bun, port 3001)
        ↓
ProfileService
        ↓
IActivityProvider (interface)
     ↙          ↘
ArcRpcProvider   GoldskyActivityProvider
(live RPC)       (Postgres/Supabase — requires GOLDSKY_POSTGRES_URL)
        ↓
NormalizedActivity
        ↓
SignalEngine  ←  ApplicationRegistry (in-memory, 9 apps / 17 contracts)
        ↓
ActivitySignal[]
        ↓
CredentialService
        ↓
WalletProfile  { signals, credentials, dataQualityNotes, mayBeTruncated }
        ↓
API JSON response
        ↓
ProfileShell.tsx (React frontend)
```

### Provider selection

`server/index.ts` selects the provider at startup:

- If `GOLDSKY_POSTGRES_URL` is set: `GoldskyActivityProvider` (Postgres-backed, full historical data)
- Otherwise: `ArcRpcProvider` (live RPC, approximately 10,000-block window)

This selection requires a server restart to take effect; it is not hot-reloaded.

---

## 4. Technology Stack

### Frontend
- React 18 + TypeScript
- Vite (build tool and dev server)
- Tailwind CSS (utility classes, Arc design tokens)
- React Router v6 (client-side routing, `/` and `/profile/:address`)
- wagmi v2 + ConnectKit (wallet connection, Arc Mainnet chain ID 5042)
- viem (chain/RPC types)

### Backend
- Bun runtime (TypeScript, no compilation step in development)
- Express 5 (HTTP server)
- `pg` (PostgreSQL client for `GoldskyActivityProvider`)
- CORS enabled (open — suitable for a public read-only API)

### Testing
- Bun's built-in test runner
- 458 tests across 21 files
- No external test database required — all Postgres interactions are tested via injected mock pools

### Infrastructure
- Goldsky Turbo pipeline (Arc Mainnet → Supabase Postgres, `arc_rep` schema)
- Supabase PostgreSQL (historical data sink)
- Vercel (frontend + API serverless deployment)
- Docker (self-hosted deployment alternative via `Dockerfile` + `start.sh`)

---

## 5. Repository Structure

```
/
├── src/                          # React frontend
│   ├── App.tsx                   # BrowserRouter shell, two routes
│   ├── config.ts                 # wagmi/ConnectKit config (Arc Mainnet)
│   ├── components/
│   │   ├── Nav.tsx               # Top navigation bar
│   │   ├── WalletLookup.tsx      # Address input / search
│   │   ├── ProfileShell.tsx      # Main profile display (signals, credentials)
│   │   └── DocsShell.tsx         # Documentation tab
│   ├── hooks/
│   │   └── useProfile.ts         # State machine for profile fetch lifecycle
│   └── types/
│       └── api.ts                # Frontend-safe type mirror (no server imports)
│
├── server/                       # Express backend
│   ├── index.ts                  # Entry point; provider selection; route wiring
│   ├── data/
│   │   ├── IActivityProvider.ts  # Provider interface + ActivityProviderError
│   │   ├── types.ts              # NormalizedActivity, NormalizedTransaction, etc.
│   │   ├── ArcRpcProvider.ts     # Live RPC provider (10,000-block window)
│   │   └── GoldskyActivityProvider.ts  # Postgres provider (requires env var)
│   ├── domain/
│   │   ├── applications/         # ApplicationRegistry (9 apps, 17 contracts)
│   │   ├── signals/
│   │   │   ├── SignalEngine.ts   # Orchestrates all signal calculators
│   │   │   ├── types.ts          # SignalStatus, ActivitySignal, SIGNAL_KEYS
│   │   │   └── calculators/      # One file per signal group
│   │   ├── credentials/
│   │   │   ├── types.ts          # CredentialStatus, CredentialDefinition, Credential
│   │   │   ├── system-credentials.ts  # 8 credential definitions + thresholds
│   │   │   └── CredentialService.ts   # Evaluates all credentials
│   │   ├── profile/
│   │   │   └── ProfileService.ts # Pipeline: provider → signals → credentials
│   │   └── verification/
│   │       └── VerificationService.ts  # Stub (501 Not Implemented)
│   ├── middleware/
│   │   └── validate-address.ts   # EVM address regex validation
│   └── routes/                   # profile, signals, credentials, verify, health
│
├── api/
│   └── index.ts                  # Vercel serverless entry point
│
├── tests/                        # 21 test files, 458 tests
│   ├── domain/                   # Signal, credential, profile, registry tests
│   ├── data/                     # Provider, ERC-20 decoding, backfill tests
│   ├── phase7/                   # E1–E4 integration tests
│   ├── phase8/                   # Production-hardening regression tests
│   └── ui/                       # UI remediation tests
│
├── infra/goldsky/
│   ├── arc-rep-turbo.yaml        # Goldsky Turbo pipeline (Arc Mainnet → Supabase)
│   └── arc-rep-pipeline.yaml     # Superseded Mirror pipeline (reference only)
│
├── docs/                         # Architecture and audit documentation
├── contracts/                    # Foundry scaffold (no contracts deployed by Arc Rep)
├── Dockerfile                    # Self-hosted two-process deployment
├── start.sh                      # Supervisor script (restart-on-crash, env validation)
├── vercel.json                   # Vercel routing (API + SPA fallback)
└── .env.example                  # Required environment variables (no values)
```

---

## 6. API Routes

All routes are mounted under `/api` in production (Vercel serverless) and proxied from the Vite dev server in development.

| Route | Method | Description |
|---|---|---|
| `GET /api/health` | GET | Returns `{ status, provider, startedAt, uptimeSeconds }`. Lightweight — does not query the chain. |
| `GET /api/profile/:address` | GET | Returns the full `WalletProfile` including signals, credentials, data quality notes, and `mayBeTruncated`. |
| `GET /api/signals/:address` | GET | Returns `ActivitySignal[]` for the address without credential evaluation. |
| `GET /api/credentials/:address` | GET | Returns `Credential[]` for the address without the full signal set. |
| `GET /api/verify` | GET | Returns `501 Not Implemented`. Verification service is a stub. |

All routes validate the address against an EVM address regex before querying any provider. Invalid addresses return `400` without a provider call.

Provider errors return `502` with `code: 'PROVIDER_ERROR'`. Internal errors return `500`. Stack traces are never exposed in API responses.

---

## 7. Signals

14 signals are defined. 11 are currently implemented; 3 are future stubs.

### Implemented signals

| Key | Description | Status on RPC | Unit |
|---|---|---|---|
| `firstSeen` | Earliest transaction timestamp observed for this wallet | `partial` (window-limited) | `unix_seconds` |
| `lastSeen` | Most recent transaction timestamp observed | `partial` | `unix_seconds` |
| `activeDays` | Count of distinct UTC days with at least one transaction | `partial` | `days` |
| `uniqueContracts` | Count of distinct contract addresses interacted with | `partial` | `count` |
| `uniqueApplications` | Count of distinct recognized Arc ecosystem applications interacted with | `partial` | `count` |
| `transactionCount` | Outgoing transaction count; uses nonce as authoritative fallback when snapshot is truncated | `partial` (value from nonce when Case B) | `count` |
| `economicActivity` | JSON breakdown: `{ nativeValueWei, usdcErc20Raw }` — total native value sent and USDC ERC-20 sent | `partial` | `json_economic_breakdown` |
| `usdcReceived` | Total USDC ERC-20 received by this wallet (incoming transfers) | `partial` | `usdc_raw_units` |
| `applicationDiversity` | Ratio of unique applications to unique contracts (breadth relative to raw contract usage) | `partial` | `ratio` |
| `activityConsistency` | Ratio of active days to total elapsed days in the observed window | `partial` | `ratio` |
| `builderActivity` | Count of successful contract-creation transactions sent by this wallet | `partial` | `count` |
| `bridgeInteractions` | Count of distinct recognized bridge applications interacted with | `partial` | `count` |

### Future signals (not yet implemented)

| Key | Blocker |
|---|---|
| `paymentActivity` | Requires protocol-level payment decoding |
| `liquidityActivity` | Requires DeFi protocol registry expansion and LP event decoding |
| `ecosystemBreadth` | Definition pending |

### Signal status semantics

- `available`: value is calculated from complete, reliable data
- `partial`: value is calculated but the underlying history may be incomplete (e.g., 10,000-block RPC window)
- `unavailable`: signal is defined but cannot be calculated (provider error, empty data)
- `future`: signal calculator is not yet implemented

---

## 8. Credentials

8 credentials are defined. All are evaluated by `CredentialService` using only the signal layer — no blockchain or database calls are made in `CredentialService`.

### Implemented — evaluates with current RPC provider

#### ARC_ACTIVE_WALLET — Active Arc Wallet
- **Rule:** `transactionCount >= 5` (from partial or available snapshot)
- **Data:** `transactionCount` signal (nonce fallback for experienced wallets)
- **Requires full history:** No
- **Notes:** Uses nonce-based fallback (`eth_getTransactionCount`) when RPC window is truncated. Nonce counts outgoing transactions including failed ones.

#### ARC_MULTI_APP_USER — Arc Multi-Application User
- **Rule:** `uniqueApplications >= 2` (from partial or available snapshot)
- **Data:** `uniqueApplications` signal + in-memory application registry
- **Requires full history:** No
- **Registry:** Only contracts in the 9-application, 17-contract seed registry count. No arbitrary contracts.

#### ARC_CONSISTENT_USER — Arc Consistent User
- **Rule:** `activeDays >= 2` AND `activityConsistency` is calculable
- **Data:** `activeDays` + `activityConsistency` signals
- **Requires full history:** No

#### ARC_PAYMENTS_PARTICIPANT — Arc Payments Participant
- **Rule:** Outgoing USDC ERC-20 sent ≥ 1 USDC OR incoming USDC received ≥ 1 USDC
- **Data:** `economicActivity.usdcErc20Raw` OR `usdcReceived` signal
- **Requires full history:** No
- **Notes:** Native wei (Arc's gas) is excluded. Only USDC ERC-20 (`0x3600000000000000000000000000000000000000`) counts. 6-decimal: 1 USDC = 1,000,000 raw units.

### Implemented — issues when positive evidence exists on partial snapshot

#### ARC_BUILDER — Arc Builder
- **Rule:** `builderActivity >= 1` (count of successful contract deployments)
- **Data:** `builderActivity` signal (`isContractCreation` from `NormalizedTransaction`)
- **Requires full history:** Yes, with exception: a non-zero count on a partial snapshot is sufficient to earn the credential. A zero count on a partial snapshot returns `insufficient_data`.

#### ARC_BRIDGE_USER — Arc Bridge User
- **Rule:** `bridgeInteractions >= 1` (distinct recognized bridge applications)
- **Data:** `bridgeInteractions` signal (registry-filtered, `categoryId === 'bridge'`)
- **Requires full history:** Yes, with same exception as ARC_BUILDER.
- **Notes:** Only contracts in the application registry under the `bridge` category count. No hardcoded addresses in the credential.

### Insufficient data — returns `insufficient_data` for all wallets currently

#### ARC_EARLY_ADOPTER — Arc Early Adopter
- **Rule:** `firstSeen <= 2025-12-31T23:59:59Z`
- **Data:** `firstSeen` signal
- **Requires full history:** Yes — strictly. A partial `firstSeen` that numerically satisfies the cutoff is not sufficient. The credential will only issue once a full-history provider marks `firstSeen` as `available`.
- **Current status:** `insufficient_data` for all wallets. The RPC provider always produces `firstSeen` with `partial` status.
- **Product decision pending:** Cutoff date was set during development. Requires deliberate confirmation before Goldsky backfill completes.

#### ARC_LIQUIDITY_PARTICIPANT — Arc Liquidity Participant
- **Rule:** `liquidityActivity >= 1`
- **Data:** `liquidityActivity` signal — **not yet implemented**
- **Current status:** `insufficient_data` for all wallets. Requires DeFi protocol registry expansion and LP position decoding.

---

## 9. Partial-Data Behavior

### mayBeTruncated

Every `WalletProfile` and `NormalizedActivity` carries `mayBeTruncated: boolean`.

Set to `true` when any of the following conditions hold:
- The RPC scan window did not capture the full wallet history (detected via nonce comparison)
- The Goldsky provider's sync lag exceeds the configured threshold
- `MIN(block_number)` in the indexed data is above `backfillGenesisThreshold` (Arc Mainnet: block 14,722,074)
- The indexed transaction or transfer row count reached the configured query limit (`maxTransactionsPerWallet = 50,000`, `maxUsdcTransfersPerWallet = 50,000`)

### insufficient_data

A credential returns `insufficient_data` (not `not_earned`) when:
- A required signal is `unavailable`, `future`, or missing
- A required signal is `partial` AND the credential definition has `requiresFullHistory: true` AND no positive evidence exists in the partial snapshot
- The provider returned an error

`insufficient_data` is never equivalent to a negative result. It means: "the system does not have enough reliable evidence to evaluate this credential."

### dataQualityNotes

Every profile response includes a `dataQualityNotes` array describing known data limitations, including truncation reasons, row-limit warnings, and sync-lag information.

---

## 10. Arc Mainnet Configuration

| Parameter | Value |
|---|---|
| Chain ID | 5042 |
| Chain name | Arc Mainnet |
| Native asset | USDC (Arc's native gas token is USDC — one pool, two views) |
| USDC ERC-20 contract | `0x3600000000000000000000000000000000000000` |
| Frontend chain | `arc` from `viem/chains` |
| RPC fallback | `https://rpc.mainnet.arc.io` |
| First activity block | 14,722,074 (verified 2026-09-26 via live RPC binary search) |
| Backfill genesis threshold | 14,722,074 |

**Important:** On Arc, the native gas asset and USDC are the same underlying pool exposed two ways. Arc Rep counts USDC via the ERC-20 view only. Native wei and USDC ERC-20 raw units use different decimal scales (18 vs 6) and are never summed or conflated.

---

## 11. RPC Fallback Behavior

When `GOLDSKY_POSTGRES_URL` is not set (current production state), `ArcRpcProvider` provides all activity data:

- Scans the most recent `DEFAULT_BLOCK_SCAN_WINDOW = 10_000` blocks
- Fetches transaction receipts for the wallet's address as sender
- Decodes ERC-20 Transfer logs to identify USDC transfers
- Calls `eth_getTransactionCount` to get the authoritative lifetime outgoing transaction nonce
- Filters out the Arc EIP-7708 system emitter (`0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`) to avoid double-counting native USDC sends

All signals derived from this provider will have `status: 'partial'`. Credentials that `requiresFullHistory` will return `insufficient_data`.

Provider failures throw `ActivityProviderError`. These are surfaced as HTTP 502 responses — never silently converted to empty activity.

---

## 12. Goldsky / Supabase Architecture

The Goldsky pipeline (`infra/goldsky/arc-rep-turbo.yaml`) is designed to replicate three Arc Mainnet chain-level datasets into a Supabase PostgreSQL database under the `arc_rep` schema:

| Goldsky dataset | Destination table | Purpose |
|---|---|---|
| `arc_mainnet.receipt_transactions` v1.1.0 | `arc_rep.tx_activity` | Full transaction history |
| `arc_mainnet.erc20_transfers` v1.1.0 | `arc_rep.erc20_transfers` | Pre-decoded ERC-20 transfer events |
| `arc_mainnet.raw_traces` v1.0.0 | `arc_rep.contract_traces` | Call traces (for future signal derivation) |

Pipeline configuration:
- Pipeline name: `arc-rep-historical`
- Start: `earliest` (full historical backfill from genesis)
- Postgres secret: `POSTGRES_SECRET_CMUGXQ2B80` (registered in Goldsky)
- Primary key: `id` (idempotent upserts; safe on chain reorgs)
- Batch size: 1,000

When `GoldskyActivityProvider` is active:
- `mayBeTruncated` is `false` only when both sync lag is within threshold AND `MIN(block_number) <= 14_722_074`
- Full-history credentials become evaluable once backfill is confirmed complete
- Query limits prevent unbounded memory use for high-volume wallets

---

## 13. Current Goldsky / Supabase Status

**The Goldsky historical backfill is not currently available.**

The Supabase PostgreSQL instance hosting the `arc_rep` tables is currently unavailable due to a storage capacity issue. This is a known infrastructure limitation that is intentionally deferred.

Impact on the application:
- `GOLDSKY_POSTGRES_URL` is not set in the production environment
- The application falls back to `ArcRpcProvider` automatically
- All signals evaluate against the ~10,000-block RPC window
- Credentials that require full history (`ARC_EARLY_ADOPTER`, zero-count `ARC_BUILDER`, zero-count `ARC_BRIDGE_USER`) return `insufficient_data`
- The frontend correctly displays all relevant caveats via `mayBeTruncated`, `dataQualityNotes`, and `confidenceNote`
- No functionality is broken — the application is fully operational with reduced historical coverage

Resolution requires: Supabase storage expansion → Goldsky pipeline authentication → pipeline deployment → backfill completion.

---

## 14. Vercel Deployment Architecture

Arc Rep is deployed to Vercel as a combined frontend + serverless API:

### Frontend (Static)
- Built by `vite build` → output to `dist/`
- Vercel serves `dist/` as static assets
- React Router handles client-side navigation
- All unknown routes fall back to `dist/index.html` (SPA routing)

### API (Serverless)
- Entry point: `api/index.ts`
- Imports and re-exports the Express `app` from `server/index.ts`
- Vercel invokes the Express app as a serverless function handler per request
- `server/index.ts` guards `app.listen()` with `if (process.env.VERCEL !== '1')` — the listen call is skipped in the serverless environment

### Routing (`vercel.json`)
```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api" },
    { "source": "/(.*)",     "destination": "/index.html" }
  ]
}
```

All `/api/*` requests are routed to the serverless function. All other requests serve the SPA.

### Self-hosted alternative
For non-Vercel deployment, `Dockerfile` and `start.sh` provide a two-process model: Express API on port 3001 and a static file server on port 8080. `start.sh` validates required environment variables at startup and restarts the API automatically on non-zero exit.

---

## 15. Local Development

### Prerequisites
- Bun runtime (`bun.sh`)
- Node.js (for some build tooling)
- Arc Mainnet RPC access (public endpoint: `https://rpc.mainnet.arc.io`)

### Setup
```bash
bun install
cp .env.example .env
# Edit .env with required values (see .env.example)
```

### Required environment variables

| Variable | Required | Description |
|---|---|---|
| `RPC_PROXY_BASE_URL` | No | Arc Studio RPC proxy base URL (optional performance improvement) |
| `RPC_PROXY_TOKEN` | No | Auth token for RPC proxy |
| `RPC_PROXY_CHAINS` | No | Comma-separated chain keys covered by the proxy |
| `PORT` | No | API server port (default: 3001) |
| `GOLDSKY_POSTGRES_URL` | No | Postgres connection string; enables `GoldskyActivityProvider` |

### Run development servers

```bash
# Terminal 1: Vite frontend (port 5173, proxies /api/* to port 3001)
bun run dev

# Terminal 2: Express API
bun run server/index.ts
```

### Tests, lint, typecheck

```bash
bun test tests/
bash /path/to/check.sh   # lint + typecheck
bunx vite build          # production build
```

---

## 16. Production Deployment (Vercel)

1. Connect the GitHub repository to Vercel
2. Framework preset: Vite
3. Build command: `npm run build` (or `bun run build`)
4. Output directory: `dist`
5. Root directory: `/`
6. Add environment variables in Vercel dashboard (see list above)
7. Deploy

Vercel automatically sets `VERCEL=1` in the serverless environment, which suppresses `app.listen()`.

---

## 17. Test / Build Status

| Check | Result |
|---|---|
| Test suite | 458 pass / 0 fail |
| Test files | 21 |
| TypeScript | PASS (0 errors, 2 pre-existing test-only warnings) |
| Lint (oxlint) | PASS (0 errors) |
| Production build | PASS |

---

## 18. Known Limitations

1. **Historical data unavailable**: The Goldsky/Supabase backfill is not currently operational. All signals are derived from an approximately 10,000-block RPC window.

2. **ARC_EARLY_ADOPTER blocked**: Returns `insufficient_data` for all wallets until a full-history provider is available and the `EARLY_ADOPTER_CUTOFF_UNIX` product decision is confirmed.

3. **ARC_LIQUIDITY_PARTICIPANT blocked**: Returns `insufficient_data` for all wallets. The `liquidityActivity` signal requires DeFi protocol registry expansion and is not yet implemented.

4. **Application registry is hand-curated**: The 9-application, 17-contract registry (`server/domain/applications/seed-data.ts`) contains only addresses with verified on-chain provenance. New applications require manual addition with source citations.

5. **Verification endpoint is a stub**: `GET /api/verify` returns `501 Not Implemented`.

6. **CORS is fully open**: Appropriate for a public read-only API but should be scoped in a production multi-tenant context.

7. **No rate limiting**: The API has no per-IP rate limiting. Each profile request may make multiple RPC calls.

8. **Large-chunk build warning**: The Vite production build emits warnings for chunks over 500 kB. These originate from ConnectKit/wagmi dependencies and are pre-existing; they do not affect functionality.

---

## 19. Phase 2 / Future Work

The following items are documented in the codebase but not yet implemented:

| Item | Location | Blocker |
|---|---|---|
| `liquidityActivity` signal | `SIGNAL_KEYS.LIQUIDITY_ACTIVITY` | DeFi protocol registry expansion; LP event decoding |
| `paymentActivity` signal | `SIGNAL_KEYS.PAYMENT_ACTIVITY` | Protocol-level payment decoding |
| `ecosystemBreadth` signal | `SIGNAL_KEYS.ECOSYSTEM_BREADTH` | Definition pending |
| `VerificationService` | `server/domain/verification/VerificationService.ts` | Not specified |
| Goldsky historical backfill | `infra/goldsky/arc-rep-turbo.yaml` | Supabase storage expansion; Goldsky authentication |
| `ARC_EARLY_ADOPTER` evaluation | `CredentialService` | Full-history provider + product cutoff decision |
| Rate limiting | Not implemented | Infrastructure decision |

No speculative roadmap items are included. Only items with existing code stubs or documented decisions are listed.

---

## 20. Current Status

### Production-ready now

- Full-stack Arc Rep application (frontend + API + credential system)
- 8 credential definitions with hardened data-quality semantics
- 5 credentials actively evaluating from live RPC data
- Complete partial-data safety model (`mayBeTruncated`, `insufficient_data`, `dataQualityNotes`)
- Vercel deployment configuration
- Self-hosted Docker deployment configuration
- 458 passing tests, TypeScript clean, lint clean, production build clean
- Arc Mainnet configuration (chain ID 5042, USDC `0x3600...`)

### Infrastructure / scaling work remaining

- Supabase storage expansion (to restore Goldsky sink availability)
- Goldsky pipeline authentication and deployment
- Arc Mainnet historical backfill completion
- Post-backfill: `ARC_EARLY_ADOPTER` product decision and activation
- Post-backfill: `ARC_LIQUIDITY_PARTICIPANT` signal implementation
- Optional: CORS scoping, rate limiting, observability tooling
