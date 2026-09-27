# Arc Rep — Architecture Reference

## Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                             │
│                                                                 │
│  src/components/         — React UI components                  │
│  src/hooks/useProfile.ts — fetch('/api/profile/:address')       │
│  src/types/api.ts        — Frontend-safe subset of domain types │
│                                                                 │
│  CONSTRAINT: No direct RPC calls. No import from server/.       │
│  All blockchain reads happen server-side.                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP JSON over Vite proxy /api
┌───────────────────────────▼─────────────────────────────────────┐
│  API LAYER  server/routes/                                      │
│                                                                 │
│  GET  /profile/:address    → WalletProfile                      │
│  GET  /signals/:address    → ActivitySignal[]                   │
│  GET  /credentials/:address → Credential[]                      │
│  POST /verify              → 501 (Phase 2 stub)                 │
│  GET  /health              → { status: 'ok' }                   │
│                                                                 │
│  Middleware: validateAddress (EVM format guard)                 │
│  Error handling: structured JSON, no stack trace exposure       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  PROFILE SERVICE  server/domain/profile/ProfileService.ts       │
│                                                                 │
│  Orchestrates the pipeline:                                     │
│  provider → registry → signal engine → credential service       │
│  Assembles WalletProfile.                                       │
│                                                                 │
│  Produces: WalletProfile                                        │
│  NEVER contains: score, rank, trustworthiness claim             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
          ┌────────────────┼──────────────────────┐
          │                │                      │
┌─────────▼──────┐ ┌───────▼──────────┐ ┌────────▼─────────────┐
│ SIGNAL ENGINE  │ │ CREDENTIAL SVC   │ │ VERIFICATION SVC     │
│                │ │                  │ │ (STUB — Phase 2)     │
│ server/domain/ │ │ server/domain/   │ │                      │
│ signals/       │ │ credentials/     │ │ VerificationRule     │
│                │ │                  │ │ VerificationResult   │
│ Inputs:        │ │ Inputs:          │ │                      │
│  NormalizedAct │ │  ActivitySignal[]│ │ Returns 501 in       │
│  IAppRegistry  │ │                  │ │ Phase 1.             │
│                │ │ Produces:        │ │                      │
│ Produces:      │ │  Credential[]    │ │ Phase 2 intent:      │
│  ActivitySignal│ │  (system-derived │ │ deterministic        │
│  []            │ │  only in Phase1) │ │ eligibility checks   │
└────────────────┘ └──────────────────┘ └──────────────────────┘
          │
┌─────────▼───────────────────────────────────────────────────────┐
│  APPLICATION REGISTRY  server/domain/applications/              │
│                                                                 │
│  IApplicationRegistry (interface)                               │
│  InMemoryApplicationRegistry (implementation)                   │
│                                                                 │
│  Responsibilities:                                              │
│  - Map contract address → Application + Category                │
│  - Distinguish recognized from unknown contracts                │
│  - Normalize address comparisons (lowercase)                    │
│  - Never treat unknown as recognized                            │
│                                                                 │
│  Extension: replace InMemory with a Postgres-backed impl        │
│  for admin-managed application entries.                         │
└─────────────────────────────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────────────────────┐
│  DATA PROVIDER ABSTRACTION  server/data/                        │
│                                                                 │
│  IActivityProvider (interface)                                  │
│  ArcRpcProvider (implementation)                                │
│                                                                 │
│  Sole responsibility: fetch and normalize wallet activity.      │
│  No application recognition. No signal calculation.             │
│                                                                 │
│  ArcRpcProvider:                                                │
│  - Uses RPC_PROXY_BASE_URL / RPC_PROXY_TOKEN env vars           │
│  - Falls back to public Arc Testnet RPC                         │
│  - Validates address format before any network call             │
│  - Returns NormalizedActivity                                   │
│  - Marks mayBeTruncated when snapshot may be incomplete         │
│                                                                 │
│  Future providers: GoldskyProvider, SubgraphProvider            │
│  (swap via DI in server/index.ts — no domain changes needed)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### NormalizedActivity (server/data/types.ts)
Raw blockchain facts only. Produced by the data provider.

| Field | Type | Description |
|---|---|---|
| `address` | `string` | Wallet address (lowercase) |
| `chainId` | `number` | Chain ID |
| `transactions` | `NormalizedTransaction[]` | All fetched transactions |
| `contractAddressesInteracted` | `Set<string>` | Deduplicated outgoing contract calls |
| `earliestTimestamp` | `number \| undefined` | Unix timestamp of earliest tx |
| `latestTimestamp` | `number \| undefined` | Unix timestamp of latest tx |
| `mayBeTruncated` | `boolean` | True if snapshot may be incomplete |
| `providerName` | `string` | Which provider produced this data |
| `dataQualityNotes` | `string[]` | Limitations and caveats |

### ActivitySignal (server/domain/signals/types.ts)
A derived behavioral measurement. NOT a reputation judgment.

| Field | Type | Description |
|---|---|---|
| `key` | `string` | Machine-readable signal identifier |
| `label` | `string` | Human-readable name |
| `value` | `number \| string \| null` | Measured value (null if unavailable) |
| `status` | `SignalStatus` | available / partial / unavailable / future |
| `source` | `string` | Which data was used |
| `calculationDefinition` | `string` | Exact formula/method in plain language |
| `valueUnit` | `SignalValueUnit` | Unit of the value |
| `confidenceNote` | `string` | Caveats about the measurement |

### WalletProfile (server/domain/types.ts)
Assembled by ProfileService. Clearly separates layers.

| Field | Type | Layer |
|---|---|---|
| `activitySummary` | `WalletActivitySummary` | Raw/observable |
| `signals` | `ActivitySignal[]` | Derived signals |
| `credentials` | `Credential[]` | Credentials |
| `profileBuiltAt` | `string` | ISO timestamp |
| `schemaVersion` | `string` | Schema version |

**No score. No rank. No trustworthiness claim.**

---

## Signal Definitions

### Implemented signals

| Key | Calculation | Unit | Notes |
|---|---|---|---|
| `firstSeen` | Min timestamp of outgoing txns | unix_seconds | Partial if snapshot truncated |
| `lastSeen` | Max timestamp of outgoing txns | unix_seconds | Partial if snapshot truncated |
| `activeDays` | Count distinct UTC days with outgoing txns | count | Incoming excluded |
| `uniqueContracts` | Size of contractAddressesInteracted set | count | |
| `uniqueApplications` | Count distinct app IDs among resolved contracts | count | Requires registry |
| `transactionCount` | Count outgoing transactions | count | |
| `economicActivity` | Sum valueWei of outgoing succeeded txns | bigint_wei_string | USDC on Arc |
| `applicationDiversity` | Recognized apps / total contract addresses | ratio_0_1 | Null if no contracts |
| `activityConsistency` | CV of inter-tx gap distribution (lower = more consistent) | coefficient_of_variation | Requires ≥2 outgoing txns; partial if <5 |

### Future signals (not yet implemented)

| Key | Reason not implemented |
|---|---|
| `builderActivity` | Requires deployed contract detection — needs block receipt scanning |
| `paymentActivity` | Requires ERC-20 Transfer event indexing |
| `liquidityActivity` | Requires DeFi protocol-specific decoding |
| `ecosystemBreadth` | Requires richer application category data |

---

## Credential Definitions

All Phase 1 credentials are system-derived (issuerType: 'system').

| Type ID | Condition | Signal Used |
|---|---|---|
| `ARC_ACTIVE_WALLET` | transactionCount ≥ threshold | transactionCount |
| `ARC_EARLY_ADOPTER` | firstSeen ≤ cutoff date | firstSeen |
| `ARC_MULTI_APP_USER` | uniqueApplications ≥ threshold | uniqueApplications |
| `ARC_CONSISTENT_USER` | activeDays ≥ 2 AND consistency available | activeDays + activityConsistency |

Thresholds are defined in `server/domain/credentials/system-credentials.ts` and exported for testing.

---

## Boundary Rules

| Module | Allowed inputs | Must NOT |
|---|---|---|
| `server/data/` | Chain RPC, env vars | Recognize apps, calculate signals |
| `server/domain/applications/` | Seed data, admin data | Make RPC calls |
| `server/domain/signals/` | NormalizedActivity, IApplicationRegistry | Make RPC calls, evaluate credentials |
| `server/domain/credentials/` | ActivitySignal[] | Make RPC calls, access registry |
| `server/domain/profile/` | All of the above | Expose score, rank, or trustworthiness |
| `src/` (frontend) | `/api/*` HTTP endpoints | Import server/ code, make RPC calls |

---

## Extension Points

### Swap the data provider
Change one line in `server/index.ts`:
```ts
// const provider = new ArcRpcProvider();
const provider = new GoldskyProvider({ apiKey: process.env.GOLDSKY_API_KEY });
```

### Add a database-backed registry
Implement `IApplicationRegistry` with a Postgres client. No domain code changes.

### Add project-issued credentials
Add `issuerType: 'project'` credentials in `CredentialService` with a project-provided signing key. The credential model supports this today.

### Add verification rules
Implement `VerificationService` in Phase 2. The `VerificationRule` and `VerificationResult` types are already defined.

---

## What Is Deliberately NOT Implemented

| Feature | Status | Notes |
|---|---|---|
| Reputation score | Never in Phase 1 | Product principle 9 |
| Wallet ranking | Never in Phase 1 | Not a leaderboard |
| Score formula | TBD for Phase 2+ | Requires public deliberation |
| Smart contract for scores | Out of scope | Principle 8: read-oriented |
| Project-issued credentials | Phase 2 | Model ready |
| Privacy-preserving verification | Phase 2+ | ZK or selective disclosure |
| Admin interface | Phase 2 | Types prepared |
| Sybil detection | Research phase | Not in Phase 1 |
| Goldsky/subgraph indexer | Phase 2 | IActivityProvider ready |
| Database persistence | Phase 2 | In-memory registry for now |
