# Phase 7 Audit: Credential Signal Architecture vs. Available Data

_Generated: 2026-09-25. Read-only audit. No code changed._

---

## A. Credential Signal Matrix

### Notation

- **Current source**: what feeds the signal today (RPC window provider)
- **Indexed source**: what the Goldsky pipeline provides (`arc_rep.*`)
- **Historical requirement**: does the signal need full chain history to be trustworthy?
- **Current safety**: is it safe to issue the credential _right now_?

---

### ARC_ACTIVE_WALLET

| Field | Value |
|---|---|
| Signal | `transactionCount` |
| Current source | `ArcRpcProvider`: outgoing tx count in latest ~10,000-block window; nonce fallback via `eth_getTransactionCount` for Case B |
| Indexed source | `arc_rep.tx_activity`: `COUNT(*)` where `from_address = $wallet` (all history) |
| Historical requirement | No — the nonce fallback already gives a lifetime count (Case B). The actual per-tx records are still window-limited, but the _count_ is accurate. |
| Current safety | **Safe to issue.** Case B nonce is authoritative for the count. A wallet with >= 5 outgoing txns in its lifetime cannot be missed. |
| Phase 7 action | When Goldsky is live: `totalOutgoingTransactionCount` in `GoldskyActivityProvider` becomes exact indexed count (not nonce). `mayBeTruncated` stays false when pipeline is synced. No credential logic change needed. |

---

### ARC_EARLY_ADOPTER

| Field | Value |
|---|---|
| Signal | `firstSeen` |
| Current source | `ArcRpcProvider`: `min(timestamp)` within the last ~10,000 blocks. Always `status: partial`. |
| Indexed source | `arc_rep.tx_activity`: `MIN(block_timestamp)` where `from_address = $wallet` — covers full chain history from genesis. |
| Historical requirement | **Yes — strictly.** The credential asks "was this wallet first seen before 2025-12-31?" A truncated scan may see the wallet's first activity _within the window_ but miss an earlier transaction. The credential must only issue when `firstSeen.status === 'available'`. |
| Current safety | **Not safe — correctly returning `insufficient_data`.** This is the right behavior. |
| Phase 7 action | When Goldsky pipeline is fully synced, `GoldskyActivityProvider` sets `mayBeTruncated = false`, so `firstSeen.status` becomes `'available'`. At that point `evaluateEarlyAdopter` will issue the credential with no code change. The gate is already correct. One risk: the pipeline must be confirmed synced from block 0 (not just "live"). See Section B. |

---

### ARC_MULTI_APP_USER

| Field | Value |
|---|---|
| Signal | `uniqueApplications` |
| Current source | `ArcRpcProvider`: `contractAddressesInteracted` (outgoing txns to contracts with input data in window), resolved against `InMemoryApplicationRegistry` (9 apps, 17 contracts). |
| Indexed source | `arc_rep.tx_activity`: same logic — outgoing txns where `to_address` is non-null and `input != '0x'`, distinct `to_address` values resolved against registry. Full history available. |
| Historical requirement | No. A partial snapshot that returns `uniqueApplications >= 2` is a confirmed lower bound — the wallet genuinely used at least 2 recognized apps. False negatives (window missed an interaction) are acceptable for this credential's partial mode. |
| Current safety | **Safe to issue with partial data.** `requiresFullHistory = false` is correct. |
| Phase 7 action | No credential logic change. With Goldsky, the signal improves from partial to available; more wallets may qualify. The `InMemoryApplicationRegistry` is the limiting factor — expand it to add more recognizable apps when verified addresses become available. |

**What constitutes an "app":** Any entry in `SEED_APPLICATIONS` matched via `InMemoryApplicationRegistry.resolveContracts()`. The 9 current apps are: arc-usdc, arc-eurc, arc-usyc, circle-cctp, circle-gateway, circle-stablefx, arc-tx-extensions, arc-agent-registry, arc-agentic-commerce. A wallet that only interacts with infrastructure contracts (USDC ERC-20 address by calling `transfer()`) counts as 1 app. The registry is the sole arbiter — no address heuristics.

---

### ARC_CONSISTENT_USER

| Field | Value |
|---|---|
| Signals | `activeDays` + `activityConsistency` |
| Current source | `ArcRpcProvider`: UTC calendar days with outgoing txns in window; CV of inter-transaction gaps in window. |
| Indexed source | `arc_rep.tx_activity`: same calculation over full history. Much larger sample → CV is far more reliable. |
| Historical requirement | No for issuance. But partial data can produce misleading consistency metrics — a wallet that sent 3 transactions in the last 200 blocks looks "consistent" even if it's normally inactive. This is an acceptable limitation given `requiresFullHistory = false`. |
| Current safety | **Safe to issue.** Two-day threshold and calculable CV are conservative enough that false positives from window effects are minimal. |
| Phase 7 action | No credential logic change. With Goldsky, `activityConsistency.status` upgrades from `partial` to `available` (>= 5 txns case), improving signal reliability. Consider whether to tighten the `activeDays >= 2` threshold post-Goldsky once full-history distributions are observable — but do not change threshold speculatively. |

**Time windows / UTC boundary note:** `toDayKey()` truncates to UTC date correctly. No wall-clock local-time risk. Reorg/replay: Goldsky uses idempotent upserts (`primary_key: id`) so replayed blocks overwrite rather than duplicate. The signal is replay-safe at the pipeline layer.

---

### ARC_PAYMENTS_PARTICIPANT

| Field | Value |
|---|---|
| Signals | `economicActivity` (outgoing USDC via ERC-20) + `usdcReceived` (incoming USDC via ERC-20) |
| Current source | `ArcRpcProvider`: ERC-20 Transfer events decoded from `eth_getLogs` for the wallet's transactions in window. |
| Indexed source | `arc_rep.erc20_transfers`: pre-decoded by Goldsky. Columns: `address` (token contract), `sender`, `recipient`, `amount`. |
| Historical requirement | No. A partial snapshot confirming >= 1 USDC (6-decimal raw) sent or received is a genuine lower bound. |
| Current safety | **Safe to issue.** Implementation is correct. |

**Detailed ARC_PAYMENTS_PARTICIPANT safety audit:**

1. **USDC contract identification:** `ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000'` is hardcoded in `activity.ts` and compared against `transfer.tokenAddress` (lowercase). The `erc20_transfers` Goldsky table has an `address` column (not `token_address`) which the pipeline passes through unchanged. In `GoldskyActivityProvider.queryUsdcTransfers`, the column alias `token_address` maps the Goldsky `address` to the `GoldskyTransferRow.token_address` field used in `decodeGoldskyTransferRow`. This is correct — the mapping is `SELECT address AS token_address` (implicit in the current code via `token_address` field in the row type). **Risk:** The current `queryUsdcTransfers` SQL selects `token_address` as a column name, but the Goldsky `erc20_transfers` table has `address` not `token_address`. This query will fail on the live table. **See Gap Analysis item 1.**

2. **Incoming vs outgoing distinction:** `economicActivity` uses `transfer.from === walletAddress` (outgoing). `usdcReceived` uses `transfer.to === walletAddress` (incoming). These are mutually exclusive per transfer event. Correct.

3. **Raw amount / decimal handling:** `amountRaw` is `BigInt` from the log data field. `PAYMENTS_MIN_USDC_RAW = BigInt(1_000_000)` = 1 USDC at 6 decimals. No float conversion until display. Correct.

4. **1 USDC threshold applied correctly:** `outgoingUsdcRaw >= PAYMENTS_MIN_USDC_RAW OR incomingUsdcRaw >= PAYMENTS_MIN_USDC_RAW`. Correct.

5. **Native token excluded:** `economicActivity.nativeValueWei` is explicitly not read by `evaluatePaymentsParticipant`. Only `usdcErc20Raw` from the JSON breakdown is used. Correct.

6. **Duplicate / replay inflation:** Goldsky upserts by `id` (primary key). The `arc_rep.erc20_transfers` table cannot have duplicate rows for the same transfer event. Replay-safe.

---

### ARC_BUILDER

| Field | Value |
|---|---|
| Signal | `builderActivity` (status: `future`) |
| Current source | None — signal not implemented |
| Indexed source | `arc_rep.tx_activity`: `receipt_contract_address IS NOT NULL` where `from_address = $wallet` identifies contract deployment transactions. |
| Historical requirement | Yes. A wallet that deployed a contract before the RPC window would be missed entirely. |
| Current safety | **Not safe — correctly returning `insufficient_data`.** |
| Phase 7 action | See Section C for the data contract. The signal CAN be implemented using `arc_rep.tx_activity` alone — no additional indexed data is needed. |

---

### ARC_LIQUIDITY_PARTICIPANT

| Field | Value |
|---|---|
| Signal | `liquidityActivity` (status: `future`) |
| Current source | None |
| Indexed source | Partially available — `arc_rep.erc20_transfers` can show token transfers to/from known liquidity pool contracts, but Arc has no deployed AMM/liquidity pool contracts in the verified registry yet. |
| Historical requirement | Yes |
| Current safety | **Not safe — correctly returning `insufficient_data`.** |
| Phase 7 action | See Section C for the data contract. Blocked on registry expansion (no verified liquidity pool contracts exist in the current seed data). |

---

### ARC_BRIDGE_USER (not yet implemented)

| Status | Not in `SYSTEM_CREDENTIAL_DEFINITIONS` — deferred by design |
| Blocker | `bridgeInteractions` signal does not exist |
| Phase 7 action | See Section C for minimum viable signal definition. |

---

## B. Historical Completeness Design

### The core problem

`start_at: earliest` in the Goldsky YAML means the pipeline _requests_ full history. It does not guarantee that indexing has _completed_. There are three distinct states that the application must model explicitly:

```
UNAVAILABLE    → INDEXING (partial backfill in progress)
INDEXING       → LIVE     (backfill complete; live blocks streaming)
LIVE           → LAGGED   (pipeline fell behind chain head by > threshold)
LAGGED         → LIVE     (pipeline caught up)
```

### Source of truth

There is exactly one source of truth available to the application without adding external infrastructure: **the Goldsky `arc_rep.tx_activity` table itself**.

Two queryable facts:

1. `MAX(block_number)` — the latest block the pipeline has indexed. If this is close to chain head, the pipeline is live.
2. `MIN(block_number)` — the earliest block indexed. This should approach 0 if backfill is running correctly. **However, Arc Testnet block 0 is a genesis block and may have no transactions, so `MIN(block_number)` may never be 0 even after complete backfill.** This metric is not reliable alone.

### How `GoldskyActivityProvider` currently models this

`GoldskyActivityProvider` already implements:
- `queryLatestIndexedBlock()` → `MAX(block_number)` from `arc_transactions`
- `fetchChainHead()` → `eth_blockNumber` RPC call
- `syncLag = chainHead - latestIndexedBlock`
- `mayBeTruncated = syncLag > syncLagThresholdBlocks` (default: 1000 blocks)

This correctly handles the **LIVE vs LAGGED** transition.

### What is missing: UNAVAILABLE and INDEXING states

When the Goldsky pipeline has not yet been deployed, or has been deployed but the backfill is not complete, `MAX(block_number)` may be low (e.g. 5,000,000 on a chain with 15,000,000 blocks). In this state, `mayBeTruncated` would be `false` (because the latest indexed block _is_ close to chain head for live blocks), but historical data from before the pipeline's current stream position would be absent.

This is a real risk for `ARC_EARLY_ADOPTER` specifically: the pipeline could be live-streaming new blocks while the backfill of historical blocks is still in progress or not started. The `syncLag` metric alone cannot detect this.

### Recommended completeness model

Add a `HistoricalIndexingState` concept to `GoldskyActivityProvider`:

```typescript
type HistoricalIndexingState =
  | 'unavailable'        // Pipeline not deployed or no rows yet
  | 'backfill_in_progress' // MIN(block_number) > 0 (backfill not at genesis)
  | 'live'               // Backfill complete; syncLag within threshold
  | 'lagged'             // syncLag > threshold (recent data may be missing)
```

**Source of truth query:**
```sql
SELECT
  COALESCE(MIN(block_number), -1)::bigint AS earliest_block,
  COALESCE(MAX(block_number), -1)::bigint AS latest_block,
  COUNT(*)::bigint                         AS total_rows
FROM arc_rep.tx_activity
```

**State determination logic:**
- `total_rows = 0` → `unavailable`
- `total_rows > 0 AND earliest_block > BACKFILL_GENESIS_THRESHOLD` → `backfill_in_progress`
- `total_rows > 0 AND earliest_block <= BACKFILL_GENESIS_THRESHOLD AND syncLag <= threshold` → `live`
- `total_rows > 0 AND earliest_block <= BACKFILL_GENESIS_THRESHOLD AND syncLag > threshold` → `lagged`

`BACKFILL_GENESIS_THRESHOLD`: the block number below which we consider the backfill "at genesis." Arc Testnet launched in late 2024; a reasonable threshold is block 10,000 (the chain's first ~10,000 blocks are unlikely to contain significant application activity). This threshold must be configurable and documented, not hardcoded without justification.

### How CredentialService consumes this state

`CredentialService` must NOT perform this check itself — that would violate the boundary rule (no blockchain reads in CredentialService).

The correct flow:

```
GoldskyActivityProvider.getActivity()
  → NormalizedActivity.historicalIndexingState (new field)
  → SignalEngine reads it and passes it down to relevant calculators
  → firstSeen calculator sets status: 'available' only when
    historicalIndexingState === 'live'
  → CredentialService reads firstSeen.status === 'available'
    and issues ARC_EARLY_ADOPTER
```

**Alternative (simpler):** `historicalIndexingState` is encoded into `mayBeTruncated` already. When backfill is in progress, `mayBeTruncated = true` (because the earliest indexed block is not at genesis). When live, `mayBeTruncated = false`. This works **if** `mayBeTruncated` is computed from both sync-lag AND backfill completeness — which it currently is not. The current implementation only checks sync-lag.

**Recommended resolution:** Expand `mayBeTruncated` semantics: set `mayBeTruncated = true` when EITHER `syncLag > threshold` OR `earliestBlock > BACKFILL_GENESIS_THRESHOLD`. No new field needed. This preserves the existing architecture cleanly.

### State transitions table for CredentialService

| `mayBeTruncated` | `firstSeen.status` | `ARC_EARLY_ADOPTER` result |
|---|---|---|
| `true` (backfill incomplete) | `partial` | `insufficient_data` |
| `true` (pipeline lagged) | `partial` | `insufficient_data` |
| `false` (live, synced, backfill complete) | `available` | evaluates normally |

This is already exactly what the existing `CredentialService.evaluateEarlyAdopter` does. No credential logic changes needed — only the `mayBeTruncated` computation in `GoldskyActivityProvider` needs to incorporate backfill completeness.

---

## C. Data Contracts for Future Signals

### `firstSeen` — data contract for Goldsky provider

**Signal key:** `firstSeen`
**Current status:** `partial` (always, under RPC provider)
**Goldsky source:** `arc_rep.tx_activity`

**Required query:**
```sql
SELECT MIN(block_timestamp)::text AS first_seen_timestamp
FROM arc_rep.tx_activity
WHERE lower(from_address) = $1
```

**Completeness gate:** Only return `status: 'available'` when `historicalIndexingState === 'live'` (i.e., `mayBeTruncated === false` under the expanded semantics). Otherwise `status: 'partial'`.

**No new tables needed.** `arc_rep.tx_activity` already contains `block_timestamp`.

---

### `builderActivity` — data contract

**Signal key:** `builderActivity`
**Meaning:** Count of smart contracts deployed by this wallet, confirmed by `receipt_contract_address IS NOT NULL`.
**Required data source:** `arc_rep.tx_activity` alone is sufficient.
**Required query:**
```sql
SELECT COUNT(*)::text AS contract_deployments
FROM arc_rep.tx_activity
WHERE lower(from_address) = $1
  AND receipt_contract_address IS NOT NULL
  AND receipt_status = '1'
```

**Signal value:** Integer count of successful contract deployment transactions.
**Credential rule:** `builderActivity.value >= 1 AND builderActivity.status === 'available'`
**Historical requirement:** Yes. A wallet that deployed contracts before the RPC window cannot be detected by the RPC provider. Must require `mayBeTruncated === false`.
**Does not require traces:** The `receipt_contract_address` field in `arc_rep.tx_activity` is sufficient to detect contract deployments. Traces are not needed.
**Does not require contract verification:** The credential only checks that the wallet sent a contract deployment transaction — not that the contract is verified or functional.
**Blocker:** Requires `mayBeTruncated === false` (Goldsky pipeline fully synced + backfill complete).

---

### `liquidityActivity` — data contract

**Signal key:** `liquidityActivity`
**Meaning:** Evidence that the wallet has interacted with a recognized liquidity protocol.
**Why generic token transfers are insufficient:** A token transfer to a liquidity pool contract can represent a swap, a deposit, a withdrawal, or a protocol fee payment. Without function-selector or trace-level evidence, a transfer alone does not confirm liquidity provision.

**Required data sources:**
1. `arc_rep.tx_activity`: transaction records with `to_address` and `input` (for function selector)
2. `arc_rep.erc20_transfers`: token movements (for LP token receipt as evidence of deposit)
3. `arc_rep.contract_traces`: internal calls (for protocols that route through intermediaries)

**Minimum viable signal definition:**
```
A wallet is a liquidity participant if:
  - It sent a transaction to a registered liquidity-pool contract address
    (address must be in the application registry with categoryId === 'defi')
  - AND the transaction input begins with a recognized liquidity-provision
    function selector (e.g. addLiquidity, deposit, mint on AMM contracts)
  - AND the transaction succeeded
```

**Blocker:** No AMM or liquidity pool contracts currently exist in `SEED_APPLICATIONS`. The credential cannot be implemented without at least one verified liquidity protocol contract address. This is a registry gap, not a data gap. When a protocol is deployed and verified on Arc Testnet, add it to `seed-data.ts` and implement the signal.

**Do not use:** ERC-20 transfers to a DeFi contract as a proxy. Too many false positives (simple swaps, fee payments, failed deposits that still emit Transfer events).

---

### `bridgeInteractions` — minimum viable signal definition

**Signal key:** `bridgeInteractions`
**Meaning:** Count of cross-chain USDC bridge transactions initiated by this wallet via Circle CCTP or Gateway.

**Why `uniqueApplications` is insufficient:** A wallet with `uniqueApplications >= 2` including a bridge contract has interacted with a bridge, but `CredentialService` receives only the `uniqueApplications` count — not which applications were included. The credential service would need to know "which apps did this wallet interact with?" not just the count. This requires either (a) a new signal exposing per-app interaction booleans, or (b) the registry-resolution being passed through to the credential layer. Both violate the current clean boundary.

**Required data sources:**
- `arc_rep.tx_activity`: `to_address` matched against known CCTP/Gateway contract addresses

**Required query (sketch):**
```sql
SELECT COUNT(*)::text AS bridge_interactions
FROM arc_rep.tx_activity
WHERE lower(from_address) = $1
  AND lower(to_address) = ANY($2::text[])   -- array of CCTP + Gateway addresses
  AND receipt_status = '1'
```
Where `$2` = `['0x8fe6b999...', '0xe737e5ce...', '0xb43db544...', '0xbac0179b...', '0xc5567a5e...', '0x0077777d...', '0x0022222a...']`

**Signal value:** Integer count of successful bridge-initiated transactions.
**Credential rule:** `bridgeInteractions.value >= 1 AND bridgeInteractions.status in ['available', 'partial']`
**Historical requirement:** No — partial is acceptable. A wallet that has bridged at least once in the visible window has genuinely bridged.
**Blocker:** Signal calculator not yet written. Data is available in `arc_rep.tx_activity`.

---

## D. Gap Analysis

### Safe to implement now (no new data required, no Goldsky dependency)

None. All currently-implemented credentials are correctly implemented. No speculative changes are justified.

---

### Requires Goldsky historical data first (pipeline must be deployed and `mayBeTruncated = false`)

1. **`ARC_EARLY_ADOPTER`** — needs `firstSeen.status === 'available'`, which requires `mayBeTruncated = false`. Currently correctly blocked.
2. **`ARC_BUILDER`** — needs `builderActivity` signal, which itself requires full history. Signal calculator can be written now but credential must require `requiresFullHistory = true`.

---

### Requires Goldsky + `GoldskyActivityProvider` backfill completeness fix

3. **`mayBeTruncated` expansion** — `GoldskyActivityProvider` must set `mayBeTruncated = true` when `MIN(block_number) > BACKFILL_GENESIS_THRESHOLD`, not only when `syncLag > threshold`. Without this fix, `ARC_EARLY_ADOPTER` could incorrectly issue during a partial backfill.

---

### Requires additional indexed data (registry expansion, new signal calculator)

4. **`ARC_LIQUIDITY_PARTICIPANT`** — blocked on verified liquidity protocol addresses in the registry.
5. **`ARC_BRIDGE_USER`** — needs new `bridgeInteractions` signal calculator using `arc_rep.tx_activity`.

---

### Existing implementation bug requiring a fix (query column name mismatch)

6. **`GoldskyActivityProvider.queryUsdcTransfers`** — the SQL selects `token_address` but the `arc_rep.erc20_transfers` table has `address` (not `token_address`). The query will fail on the live table. Must be corrected to `SELECT address AS token_address` or updated to match the actual column name.

---

### Intentionally deferred

- `ARC_BRIDGE_USER` credential — implementation plan exists but is not yet approved.
- `liquidityActivity` signal — registry gap; no verified pool contracts.
- Any credential expansion beyond the current 7 definitions — requires new verified evidence.

---

## E. Implementation Plan

The following code changes are justified by the audit findings above. Listed in dependency order. **Awaiting approval before implementation.**

---

### E1. Fix `GoldskyActivityProvider.queryUsdcTransfers` column name bug

**Files:** `server/data/GoldskyActivityProvider.ts`

**Change:** In `queryUsdcTransfers`, change the SQL column selection to correctly alias `address` to `token_address`:

```sql
-- Current (wrong):
SELECT
  transaction_hash,
  block_number::text   AS block_number,
  block_timestamp::text AS block_timestamp,
  token_address,   ← this column does not exist
  ...

-- Corrected:
SELECT
  transaction_hash,
  block_number::text    AS block_number,
  block_timestamp::text AS block_timestamp,
  address               AS token_address,   ← correct column name
  ...
```

Also update the `arc_transactions` alias used in `queryTransactions` (same file uses `arc_transactions` table name in the SQL; the actual table in the sink is `tx_activity`). The table references in the SQL currently say `arc_transactions` but the Goldsky sink writes to `arc_rep.tx_activity`. This must be cross-checked when the provider runs against the live DB.

**Tests required:** Update `tests/data/goldsky-provider.test.ts` to verify the corrected column alias.

---

### E2. Expand `mayBeTruncated` to include backfill completeness

**Files:** `server/data/GoldskyActivityProvider.ts`

**Change:** Add a `queryEarliestIndexedBlock()` method and expand the `mayBeTruncated` condition:

```typescript
// New constant — configurable
const BACKFILL_GENESIS_THRESHOLD_BLOCKS = 10_000;

// In getActivity():
const [txRows, transferRows, latestIndexedResult, earliestIndexedResult, currentChainHead] =
  await Promise.all([
    this.queryTransactions(walletAddress),
    this.queryUsdcTransfers(walletAddress),
    this.queryLatestIndexedBlock(),
    this.queryEarliestIndexedBlock(),   // NEW
    this.fetchChainHead(),
  ]);

// Expanded mayBeTruncated:
const backfillIncomplete = earliestIndexedResult > BACKFILL_GENESIS_THRESHOLD_BLOCKS;
const syncLagExceedsThreshold = syncLag !== null && syncLag > this.syncLagThresholdBlocks;
const mayBeTruncated = backfillIncomplete || syncLagExceedsThreshold;
```

**Why this is safe:** When `mayBeTruncated = true`, signal calculators return `status: 'partial'`. `ARC_EARLY_ADOPTER.evaluateEarlyAdopter` already checks `firstSeen.status !== 'available'` and returns `insufficient_data`. No credential logic changes needed.

**Tests required:** Add tests for `backfillIncomplete = true` when `MIN(block_number) > threshold`, and verify `mayBeTruncated = true` in that case.

---

### E3. Implement `builderActivity` signal calculator

**Files:**
- `server/domain/signals/calculators/builder.ts` (new)
- `server/domain/signals/SignalEngine.ts` (wire in)
- `server/data/GoldskyActivityProvider.ts` (add `isContractCreation` count to normalized activity, or derive from existing `NormalizedTransaction.isContractCreation` field)

**Signal definition:**
- Key: `builderActivity`
- Value: count of outgoing, succeeded contract-creation transactions
- Status: `available` when `mayBeTruncated === false`; `partial` otherwise
- Source: `NormalizedTransaction.isContractCreation === true AND isOutgoing AND succeeded`

**No new SQL query needed.** `isContractCreation` is already in `NormalizedTransaction` and populated by both providers. The signal calculator reads it from `activity.transactions`.

**Credential change:** Update `ARC_BUILDER` in `system-credentials.ts`:
- Remove `requiredSignalKeys: [SIGNAL_KEYS.BUILDER_ACTIVITY]` pointing to a `future` signal
- Once the calculator exists, it will be `partial` or `available` — Gate 1 in `CredentialService` will no longer fire
- The credential's `requiresFullHistory = true` will then activate Gate 2 (unless `mayBeTruncated = false`)

**Tests required:** Unit tests for `calculateBuilderActivity` covering: zero deployments, one deployment, multiple deployments, failed deployment (not counted), incoming contract-creation tx (not counted), partial (truncated) snapshot.

---

### E4. Implement `bridgeInteractions` signal calculator

**Files:**
- `server/domain/signals/calculators/bridge.ts` (new)
- `server/domain/signals/SignalEngine.ts` (wire in)
- `server/domain/applications/ApplicationRegistry.ts` (expose bridge contract address set)

**Signal definition:**
- Key: `bridgeInteractions`
- Value: count of outgoing, succeeded transactions to registered bridge-category contracts
- Status: `partial` (acceptable — no full-history requirement)
- Source: `contractAddressesInteracted` intersected with bridge-category contracts from registry

**No new SQL needed.** `contractAddressesInteracted` already contains all outgoing contracts. The signal reads from the registry which contracts belong to the `bridge` category.

**Note:** This requires the `SignalEngine` to pass a filtered registry view (bridge contracts only) to the signal calculator, OR the signal calculator to accept the full registry and filter itself. The existing pattern (`calculateUniqueApplications` takes `IApplicationRegistry`) is the right model.

**Add `ARC_BRIDGE_USER` credential definition** to `system-credentials.ts` once signal is implemented:
- `requiredSignalKeys: [SIGNAL_KEYS.BRIDGE_INTERACTIONS]`
- `requiresFullHistory: false`
- `eligibilityRule: bridgeInteractions.status in ['available', 'partial'] AND bridgeInteractions.value >= 1`

**Tests required:** Unit tests for `calculateBridgeInteractions` covering: wallet that used CCTP, wallet that used Gateway, wallet that used both, wallet that used no bridge contracts, wallet with only non-bridge DeFi activity.

---

### Summary of files to change

| File | Change | Requires Goldsky? |
|---|---|---|
| `server/data/GoldskyActivityProvider.ts` | Fix `token_address` column name bug; add backfill completeness to `mayBeTruncated` | Yes (only runs when Goldsky is live) |
| `server/domain/signals/calculators/builder.ts` | New file: `calculateBuilderActivity` | No (reads from `NormalizedTransaction`) |
| `server/domain/signals/SignalEngine.ts` | Wire in `calculateBuilderActivity` | No |
| `server/domain/credentials/system-credentials.ts` | Update `ARC_BUILDER` once signal is implemented; add `ARC_BRIDGE_USER` | Partial (builder needs full history; bridge does not) |
| `server/domain/signals/calculators/bridge.ts` | New file: `calculateBridgeInteractions` | No (reads from existing `contractAddressesInteracted`) |
| `tests/data/goldsky-provider.test.ts` | Tests for E1 + E2 fixes | No |
| `tests/domain/signals-builder.test.ts` | Tests for E3 | No |
| `tests/domain/signals-bridge.test.ts` | Tests for E4 | No |
| `tests/domain/credentials-phase7.test.ts` | Updated tests for `ARC_BUILDER` and `ARC_BRIDGE_USER` | No |

---

**STOP. No code has been changed. Awaiting approval before implementing.**
