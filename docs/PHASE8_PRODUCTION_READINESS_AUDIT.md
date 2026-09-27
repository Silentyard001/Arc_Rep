# Phase 8 — Production Readiness Audit

**Audit date:** 2026-09-25  
**Codebase state:** 368 tests passing, 0 failing, 0 TypeScript errors, 0 lint errors.  
**Scope:** Read-only. No code was modified during this audit.

---

## Executive Summary

**Verdict: Production-ready with blockers.**

The credential system is architecturally sound and the core safety properties are correctly implemented. The data boundary model (provider → activity → signals → credentials), the `insufficient_data` gate, the `requiresFullHistory` mechanism, and the partial-positive-allowed exception all work as designed and are comprehensively tested.

Two concrete correctness issues were found that would cause incorrect behaviour in production:

1. **[CRITICAL] `contractAddressesInteracted` silently excludes contract-creation transactions** — A transaction with `to === null` (contract creation) adds the created address to `contractAddressesInteracted` only when `receipt_contract_address` is non-null. In `ArcRpcProvider` this is correct. In `GoldskyActivityProvider`, `receipt_contract_address` can be null for failed contract creations. This is intentional and correct. However, for `bridgeInteractions`: a wallet that deploys a new bridge proxy via a factory does not have `hasInputData` on the factory call's created address — but this scenario is sufficiently edge-case that the risk is low. **No action required on this specific sub-point.**

2. **[MEDIUM] `GoldskyActivityProvider.queryTransactions` has no row limit.** A wallet with a very large number of transactions (e.g. a high-frequency bot or exchange address) would return an unbounded result set into memory. There is no `LIMIT` clause. This is a production performance and memory risk.

3. **[MEDIUM] `evaluateConsistentUser` has a correctness gap** — it checks `activeDays >= 2` using `getNumericValue(activeDays)` but ignores whether `activeDays.status` is usable. A wallet with `activeDays.status = 'unavailable'` but `value = 0` would correctly return `not_earned`, but a wallet with `activeDays.status = 'future'` (impossible in the current signal engine, but a regression risk) would incorrectly reach the threshold check. This is low risk currently but should be hardened.

4. **[LOW] `server/index.ts` startup comment is stale** — it says "Goldsky Mirror pipeline" and "arc-rep-pipeline.yaml" but the active pipeline is Turbo (`arc-rep-turbo.yaml`). No runtime impact.

5. **[LOW] `activity.ts` has a second copy of `ARC_USDC_CONTRACT`** hardcoded at line 58. This is not imported from `ArcRpcProvider`/`GoldskyActivityProvider`. If the address ever changed, two places would need updating. The value is correct and authoritative (the predeploy address is invariant), so there is no current defect.

6. **[LOW] `ARC_EARLY_ADOPTER` cutoff date** (`EARLY_ADOPTER_CUTOFF_UNIX = 1767225599`) corresponds to 2025-12-31T23:59:59Z. At the current date (2026-09-25) this date is already in the past. Once full-history Goldsky data is available, nearly every wallet whose earliest on-chain transaction was before 2026-01-01 would qualify. The threshold may need reconsideration before the Goldsky provider goes live. This is a product decision, not a code defect.

No blocking security vulnerabilities were found.

---

## Critical Findings

| ID | Severity | File | Problem | Evidence | Recommended fix |
|---|---|---|---|---|---|
| P8-01 | MEDIUM | `GoldskyActivityProvider.ts:463` | `queryTransactions` has no LIMIT clause | `SELECT … FROM arc_rep.tx_activity WHERE lower(from_address) = $1 OR lower(to_address) = $1 ORDER BY block_number ASC` — no row cap. A bot wallet with 1M+ transactions loads everything into RAM in one query. | Add `LIMIT 50000` (or a configurable cap) and document the truncation semantics. Set `mayBeTruncated = true` when the returned row count equals the limit. |
| P8-02 | LOW | `server/index.ts:44` | Stale comment references Mirror pipeline | Comment says "Goldsky Mirror pipeline (infra/goldsky/arc-rep-pipeline.yaml)". Active pipeline is Turbo. | Update comment only. |
| P8-03 | LOW | `server/domain/signals/calculators/activity.ts:58` | Duplicate `ARC_USDC_CONTRACT` constant | Hardcoded `'0x3600000000000000000000000000000000000000'` is not imported from the shared export in `ArcRpcProvider.ts`. Two places to update if the constant ever changed. | Import from `ArcRpcProvider.ts` (already exported). |
| P8-04 | LOW | `CredentialService.ts:300–322` | `evaluateConsistentUser` does not guard `activeDays.status` | `days` is read from `getNumericValue(activeDays)` regardless of `activeDays.status`. If status is `unavailable`, `getNumericValue` returns `null`, so `daysOk = false` and the credential is not earned. Correct outcome. But future regressions are possible if a non-null unavailable value is introduced. | Add `isUsableStatus(activeDays.status)` check alongside the null check. |
| P8-05 | LOW | `system-credentials.ts:66` | `EARLY_ADOPTER_CUTOFF_UNIX` is already in the past | The cutoff 2025-12-31 is 9 months ago. Once Goldsky is live, the credential will be retroactively evaluable for any wallet active before that date. This may produce an unexpectedly large number of qualifying wallets. | Product decision required before Goldsky goes live. Not a code defect. |

---

## Credential Integrity

| Credential | Source | History Gate | Data Safety | Finding |
|---|---|---|---|---|
| `ARC_ACTIVE_WALLET` | `transactionCount` (nonce fallback) | `requiresFullHistory: false` | SAFE. Partial acceptable; nonce provides lifetime count even on RPC window. | No issues. |
| `ARC_EARLY_ADOPTER` | `firstSeen` (timestamp) | `requiresFullHistory: true` + explicit `status !== 'available'` guard in evaluator | SAFE. Double-guarded: Gate 2 catches partial snapshots; evaluator also explicitly requires `status === 'available'`. Cannot issue from partial. | No issues. |
| `ARC_MULTI_APP_USER` | `uniqueApplications` (registry) | `requiresFullHistory: false` | SAFE. Partial acceptable. Only counts registry-recognized applications. | No issues. |
| `ARC_CONSISTENT_USER` | `activeDays` + `activityConsistency` | `requiresFullHistory: false` | MOSTLY SAFE. Minor gap: `activeDays.status` not checked alongside value. Currently harmless because `unavailable → value = null → daysOk = false`. See P8-04. | Low risk; harden for regression safety. |
| `ARC_PAYMENTS_PARTICIPANT` | `economicActivity.usdcErc20Raw` + `usdcReceived` | `requiresFullHistory: false` | SAFE. Partial acceptable. USDC contract filter explicit. Direction correct (outgoing from `transfer.from === wallet`; incoming from `transfer.to === wallet`). Double-counting impossible (mutually exclusive conditions). Native wei explicitly excluded. | No issues. |
| `ARC_BUILDER` | `builderActivity` (`isContractCreation` flag) | `requiresFullHistory: true` + partial-positive bypass | SAFE. Non-zero partial → issued. Zero partial → `insufficient_data`. Zero available → `not_earned`. Three-way logic is correct and tested. | No issues. |
| `ARC_BRIDGE_USER` | `bridgeInteractions` (registry-filtered) | `requiresFullHistory: true` + partial-positive bypass | SAFE. Registry is sole source of truth. No hardcoded addresses in calculator. Same three-way logic as ARC_BUILDER. | No issues. |
| `ARC_LIQUIDITY_PARTICIPANT` | `liquidityActivity` (future) | Gate 1 (future signal) | SAFE. Correctly returns `insufficient_data` because `liquidityActivity` status is `future`. Cannot issue. | No issues. |

---

## A. Credential Pipeline Trace

### ARC_ACTIVE_WALLET
```
ArcRpcProvider.eth_getTransactionCount("latest")
  → totalOutgoingTransactionCount (account nonce)
  → calculateTransactionCount:
      Case A (mayBeTruncated=false): snapshot count, status='available'
      Case B (mayBeTruncated=true + nonce): nonce value, status='partial'
      Case C (mayBeTruncated=true, no nonce): snapshot count, status='partial'
  → CredentialService.evaluateActiveWallet:
      isUsableStatus check (available|partial)
      count >= ACTIVE_WALLET_MIN_TXNS (5)
  → active | not_earned
```
**Safety:** Nonce is lifetime-accurate for all RPC wallets. `requiresFullHistory: false` is correct — even a partial snapshot with count >= 5 is a valid confirmation.

### ARC_EARLY_ADOPTER
```
ArcRpcProvider.eth_getLogs + eth_getBlockByNumber
  → transactions[].timestamp (window-limited)
  → calculateFirstSeen:
      mayBeTruncated=true → status='partial'
      mayBeTruncated=false → status='available'
  → Gate 2 (requiresFullHistory=true):
      all signals partial, no partial-positive exception
      → insufficient_data (CORRECT — cannot issue from window)
  → evaluateEarlyAdopter (only reached when firstSeen='available'):
      status !== 'available' guard → insufficient_data
      firstSeen.value <= EARLY_ADOPTER_CUTOFF_UNIX → active | not_earned

GoldskyActivityProvider (when live):
  → MIN(block_timestamp) over all tx for wallet
  → calculateFirstSeen:
      backfill complete: status='available'
      backfill incomplete: status='partial' → Gate 2 → insufficient_data
      backfill complete: evaluator runs → active | not_earned
```
**Safety: Double-guarded.** Gate 2 catches partial status; evaluator has an independent `status !== 'available'` check. A partial firstSeen value satisfying the cutoff threshold cannot produce a credential.

### ARC_MULTI_APP_USER
```
contractAddressesInteracted (Set<string>) — outgoing txns with input data
  → registry.resolveContracts(addresses)
  → calculateUniqueApplications: count(distinct recognized applicationId)
  → status: partial (truncated) | available (complete)
  → evaluateMultiAppUser: count >= MULTI_APP_MIN_APPLICATIONS (2)
  → active | not_earned
```
**Safety:** Registry-gated. Only contracts in `SEED_CONTRACTS` contribute. Unrecognized contracts (bots, tokens not in registry, user-deployed contracts) do not inflate the count.

### ARC_CONSISTENT_USER
```
outgoing transactions with timestamps
  → calculateActiveDays: distinct UTC calendar days
  → calculateActivityConsistency: coefficient of variation of inter-transaction intervals
  → evaluateConsistentUser:
      days >= 2 AND consistency signal usable AND value non-null
  → active | not_earned
```
**Gap (P8-04):** `activeDays.status` is not explicitly checked with `isUsableStatus()`, only the value null check via `getNumericValue()`. Currently safe because unavailable yields null. Low regression risk.

### ARC_PAYMENTS_PARTICIPANT
```
ArcRpcProvider.eth_getLogs (ERC-20 Transfer events)
  → decodeErc20TransferLog → DecodedErc20Transfer[]
  → EIP-7708 filter (system emitter removed)
  → transfer dedup (txHash:tokenAddress:from:to:amountRaw)
  → calculateEconomicActivity:
      outgoing: transfer.tokenAddress === ARC_USDC (0x3600...) AND transfer.from === wallet
      → usdcErc20Raw (BigInt sum)
  → calculateUsdcReceived:
      incoming: transfer.tokenAddress === ARC_USDC AND transfer.to === wallet
      → usdcReceivedRaw (BigInt sum)
  → evaluatePaymentsParticipant:
      outgoingUsdcRaw >= PAYMENTS_MIN_USDC_RAW (1_000_000) OR
      incomingUsdcRaw >= PAYMENTS_MIN_USDC_RAW
  → active | not_earned

GoldskyActivityProvider (when live):
  → arc_rep.erc20_transfers WHERE address=ARC_USDC AND (sender=wallet OR recipient=wallet)
  → Goldsky pre-decoded: no topics parsing needed
  → same signal path above
```
**Safety:** USDC filter is explicit by contract address. Direction is correct and mutually exclusive (no double-counting). Native wei excluded by design (separate `nativeValueWei` field, not compared against `PAYMENTS_MIN_USDC_RAW`). Duplicate dedup key in ArcRpcProvider prevents double-counting from overlapping log queries.

### ARC_BUILDER
```
outgoing txns where isContractCreation === true AND succeeded === true
  → calculateBuilderActivity:
      count === 0 + available → value=0, status='available'
      count === 0 + truncated → value=0, status='partial'
      count > 0 → value=count, status=partial|available
  → Gate 2 (requiresFullHistory=true):
      PARTIAL_POSITIVE_ALLOWED includes ARC_BUILDER
      count > 0 + partial → bypass gate → evaluateBuilder → active
      count === 0 + partial → gate fires → insufficient_data
      count === 0 + available → gate bypassed → evaluateBuilder → not_earned
      count > 0 + available → gate bypassed → evaluateBuilder → active
```
**Safety:** Only outgoing + succeeded + isContractCreation. Failed deployments do not count. Incoming transactions (receiving a contract address) do not count. The four-case matrix is correct and fully tested.

### ARC_BRIDGE_USER
```
contractAddressesInteracted (Set<string>)
  → registry.resolveContracts
  → filter: application.categoryId === 'bridge'
  → calculateBridgeInteractions: count distinct bridge applicationId
  → same four-case matrix as ARC_BUILDER via Gate 2 + PARTIAL_POSITIVE_ALLOWED
```
**Safety:** Registry is sole source of truth. Current bridge entries: `circle-cctp` (5 contracts), `circle-gateway` (2 contracts). A wallet that interacts with ANY of those 7 addresses counts +1 application per bridge application (CCTP and Gateway count as 2 distinct applications). Distinct-application counting (not contract counting) prevents 5 CCTP contract interactions from inflating the count beyond 1.

---

## B. Historical Data Safety

### Summary matrix

| Condition | `mayBeTruncated` | Effect on credential |
|---|---|---|
| ArcRpcProvider, new wallet (fits in window) | `false` | Signals `available`, full evaluation |
| ArcRpcProvider, experienced wallet (nonce > window txns) | `true` | `transactionCount` partial-but-accurate; other signals partial |
| Goldsky: sync lag > 1000 blocks | `true` | All signals partial |
| Goldsky: MIN(block_number) > 100 | `true` | All signals partial |
| Goldsky: empty table | `true` | earliestBlock = null → isBackfillIncomplete = true → `mayBeTruncated = true` |
| Goldsky: null MIN result | `true` | Explicitly handled: `raw === null → return null → isBackfillIncomplete = true` |
| Goldsky: fully indexed, in sync | `false` | Signals `available`, full evaluation |

### RPC-only signals that do not depend on Goldsky

`transactionCount` (Case B) uses the nonce, which is always an RPC call in both providers. When Goldsky is active, `totalOutgoingTransactionCount` is derived from `COUNT(*) WHERE from_address = wallet` which counts all outgoing including failed. The comment in `GoldskyActivityProvider.ts` at line 418 acknowledges the semantic difference (nonce includes failed; Goldsky count currently counts all outgoing). This is documented and intentional.

### Mixed RPC/Goldsky signals

None of the calculators mix data from both providers — they operate only on `NormalizedActivity`, which comes from exactly one provider per request. The provider switch is at startup time via `GOLDSKY_POSTGRES_URL`.

---

## C. Goldsky Integration Audit

### Table and column correctness (E1)
- `arc_rep.tx_activity`: columns `hash`, `block_number`, `block_timestamp`, `from_address`, `to_address`, `value` (CAST AS text), `receipt_status`, `input`, `receipt_contract_address`. All match the expected Goldsky Turbo schema from the pipeline YAML.
- `arc_rep.erc20_transfers`: columns `address`, `sender`, `recipient`, `amount`. All correct after E1 fix. No `token_address` or `topics` or `data` reference remains anywhere in the production path.
- `arc_rep.tx_activity` for sync/backfill checks: `MIN(block_number)`, `MAX(block_number)`. Correct.

### Query construction
- All SQL parameters use `$1`, `$2` placeholders. No string interpolation anywhere.
- Address normalization: `lower(from_address) = $1`, `lower(address) = $1` — correct. The wallet address is lowercased before being passed as `walletAddress`.
- `COALESCE(input, '0x')` — prevents null input from being compared as non-null. Correct.
- `CAST(value AS text)` — prevents JavaScript number precision loss on large uint256 values. Correct.
- `amount::text` in the transfer query — same protection.

### Unbounded query (P8-01)
`queryTransactions` has no `LIMIT`. This is the only identified unbounded query. `queryUsdcTransfers` is limited by the USDC contract filter (only USDC events involving the wallet) which is naturally bounded in practice but has no hard limit. Both should have caps.

### Empty results
- Empty `tx_activity` → `transactions = []` → all signals zero/unavailable. `mayBeTruncated = true` (empty table → null MIN → backfill incomplete). Credential `not_earned` or `insufficient_data` as appropriate. Correct.
- Empty `erc20_transfers` → `erc20Transfers = []` → `usdcReceived = "0"`, `economicActivity.usdcErc20Raw = "0"`. `ARC_PAYMENTS_PARTICIPANT` correctly returns `not_earned`. Correct.

### Numeric/USDC handling
- `BigInt(row.amount)` on the text-cast column — safe, handles arbitrary-precision values.
- `BigInt(row.value ?? '0')` — safe, handles null value column.
- `BigInt(row.block_number)` — safe for block numbers in range.

### Query failures/timeouts
- `GoldskyActivityProvider.getActivity` wraps all `Promise.all` in a single `try/catch` and re-throws as `ActivityProviderError`. The route handler catches `ActivityProviderError` and returns HTTP 502. The error message is the `ActivityProviderError` detail, which does not expose the Postgres connection string because the connection string is only in the `Pool` constructor — not in error messages. Safe.

---

## D. Signal and Registry Correctness

### `builderActivity`
- Counts `isOutgoing && isContractCreation && succeeded`. Correct triple filter.
- `isContractCreation` is set in both providers: ArcRpcProvider from `!rawTx.to`; GoldskyActivityProvider from `row.to_address === null`. Consistent.
- `createdContractAddress` from `receipt_contract_address` is added to `contractAddressesInteracted` for outgoing contract creations. This means a wallet that deploys a contract at address X can later have X resolved against the registry. Correct.
- Failed contract creations (`receipt_status = '0'`) are excluded from the builder count. Correct.

### `bridgeInteractions`
- Uses `contractAddressesInteracted` which only contains addresses from **outgoing transactions with input data** (or created contract addresses). A wallet that merely _receives_ a call from a bridge contract does NOT get bridge credit. Correct by design.
- Distinct application counting: the `bridgeAppIds = new Set<string>()` collects `application.id`, not contract addresses. So 5 CCTP contracts → 1 unique CCTP application. Correct.
- No hardcoded addresses anywhere in the bridge calculator. Confirmed.

### Registry integrity
- 9 applications, 17 contracts.
- 7 contracts under `circle-cctp` + `circle-gateway` have `categoryId: 'bridge'`. These are the only bridge-category entries.
- `arc-usdc` is `categoryId: 'infrastructure'`, not `bridge`. Correct — USDC transfers should not count as bridge interactions.
- All addresses are lowercase. `ARC_USDC_CONTRACT` in `activity.ts` is lowercase. Contract addresses in seed-data are lowercase. Normalization is consistent.
- No duplicate addresses found in `SEED_CONTRACTS`.
- `MessageTransmitterV2` address typo corrected in Phase 4 (`0xe737e5cebeeba77...` — 40 hex chars). Confirmed correct.

---

## E. CredentialService and API

### Status transitions
All four valid credential statuses (`active`, `not_earned`, `insufficient_data`, `stale`) are correctly typed. `stale` is defined but never assigned in the current evaluation path — it is reserved for future expiry logic. No credential can accidentally become `stale`.

### Provider failures
`ActivityProviderError` thrown by either provider propagates through `ProfileService.buildProfile` to the route handler, which returns HTTP 502 with `code: 'PROVIDER_ERROR'`. The credential service is never called on a failed provider. A provider failure is never interpreted as "no activity" because the exception exits before `CredentialService.evaluate()` is called.

### Repeated evaluation / determinism
`CredentialService.evaluate()` is a pure function of `ActivitySignal[]`. Given the same signals, it always returns the same credentials. The `evaluatedAt` timestamp is the only non-deterministic field (intentionally). No global state.

### Missing signals
`signalMap.get(key)` returns `undefined` for any signal key not present. All evaluators handle the `undefined` case explicitly (returning `not_earned` or `insufficient_data`). The switch statement has a `default` case returning `not_earned`. No undefined signal causes a crash.

### Frontend API handling
`src/types/api.ts` mirrors server types correctly. `CredentialStatus` includes `'insufficient_data'`. The `ProfileShell.tsx` component handles all four statuses in rendering. `observationPeriodNote` is only shown when status is `insufficient_data`, consistent with the server which sets it to `''` otherwise.

### Serialization
All `BigInt` signal values are serialized as strings (`value.toString()`). The frontend receives JSON with string values for `usdcReceived` and `economicActivity`. No JSON serialization errors from BigInt.

---

## F. Performance and Failure Modes

### N+1 RPC calls (ArcRpcProvider)
The provider makes:
1. `eth_getTransactionCount` — 1 call
2. `eth_blockNumber` — 1 call
3. `eth_getLogs` (from) + `eth_getLogs` (to) — 2 calls in parallel
4. `eth_getBlockByNumber` sampled (≤50 blocks) — ≤50 calls in parallel via `Promise.allSettled`
5. Per hash: `eth_getTransactionByHash` + `eth_getTransactionReceipt` — 2N calls in parallel, capped at 500 hashes

Steps 4 and 5 are parallel but can still produce many RPC calls for active wallets. This is known and acceptable for the current scale.

### Redundant Goldsky queries
`GoldskyActivityProvider.getActivity` runs 5 queries in parallel via `Promise.all`. There is no query caching between requests for the same wallet. For a profile page refreshed repeatedly, the same 5 queries run each time. This is acceptable at low volume; add a short-lived TTL cache if query volume becomes significant.

### Unbounded queries (P8-01)
Documented above. `queryTransactions` has no LIMIT. Must fix before production.

### Empty / new wallets
Both providers handle the zero-transactions case correctly:
- `transactions = []` → signals have `value = 0` or `value = null` → credentials return `not_earned` (for threshold-based credentials) or `insufficient_data` (for full-history credentials on truncated snapshots).
- `eth_getTransactionCount = 0` → `totalOutgoingTransactionCount = 0` → `transactionCount = 0` → `ARC_ACTIVE_WALLET = not_earned`.

### Wallets with only failed transactions
`calculateBuilderActivity` and `calculateEconomicActivity` both filter `succeeded === true`. A wallet with only failed transactions correctly reports zero builder activity and zero economic activity. `transactionCount` (via nonce) counts all outgoing including failed — this is intentional (the nonce is the ground-truth total outgoing count).

---

## G. Test Assessment

### Current coverage: strong
368 tests across 17 files covering all credential paths, all signal edge cases, backfill completeness, ERC-20 decoding, EIP-7708 filtering, Goldsky column mapping, and the Phase 6/7 features.

### Missing test scenarios (identified, not yet added per audit-only constraint)

| Missing test | Risk level | File |
|---|---|---|
| `queryTransactions` returns `mayBeTruncated = true` when row count equals a future LIMIT | MEDIUM (P8-01) | `goldsky-provider.test.ts` |
| `ARC_CONSISTENT_USER` with `activeDays.status = 'unavailable'` but non-null value | LOW (P8-04) | `credentials-phase6.test.ts` |
| Provider failure (pool.query throws) propagates as HTTP 502, not as "no activity" | MEDIUM | `provider.test.ts` or integration |
| `economicActivity` JSON parse failure in `evaluatePaymentsParticipant` → treated as zero outgoing | LOW | `credentials-phase6.test.ts` |
| `incomingUsdcRaw` BigInt parse failure → treated as zero incoming | LOW | `credentials-phase6.test.ts` |
| Wallet with only incoming transactions (no outgoing) → `transactionCount = 0`, `ARC_ACTIVE_WALLET = not_earned` | LOW | `transaction-count.test.ts` |
| `ARC_BRIDGE_USER` with a contract address that is recognized but in a non-bridge category | LOW | `e4-bridge-interactions.test.ts` (partially present) |
| `GoldskyActivityProvider` when `queryEarliestIndexedBlock` throws (Postgres error) | MEDIUM | `e2-backfill-completeness.test.ts` |

---

## H. Deployment Checklist

Steps remaining once Goldsky authentication is available (in order):

1. **Human: `goldsky secret create arc-rep-pg-url`** with the Supabase connection string (local terminal, not in Arc Studio).
2. **Human: `bunx goldsky login --token YOUR_KEY`** in the Arc Studio Code panel terminal.
3. **Run: `/home/sandbox/.goldsky/bin/turbo validate /home/user/app/infra/goldsky/arc-rep-turbo.yaml`** — report all source, transform, and sink validation results.
4. **Human authorization:** Review validation output and explicitly approve `turbo apply`.
5. **Run: `turbo apply`** — deploys the pipeline.
6. **Monitor Goldsky dashboard:** confirm ingestion is progressing; watch for sink errors.
7. **Confirm `arc_rep.tx_activity` is being populated:** run `SELECT COUNT(*), MIN(block_number), MAX(block_number) FROM arc_rep.tx_activity` in Supabase.
8. **Set `GOLDSKY_POSTGRES_URL`** in the Arc Studio sandbox `.env` to the Supabase connection string.
9. **Restart the Express server** to pick up the new env var and activate `GoldskyActivityProvider`.
10. **Confirm backfill is making progress:** `MIN(block_number)` should decrease toward 0 over time.
11. **Confirm `ARC_EARLY_ADOPTER` still returns `insufficient_data`** until `MIN(block_number) <= 100`.
12. **Implement P8-01 fix** (LIMIT on `queryTransactions`) before handling production traffic.
13. **Product review:** Decide whether the `EARLY_ADOPTER_CUTOFF_UNIX` threshold (2025-12-31) is still appropriate given the current date (2026-09-25).
14. **Implement `TOPICS_FORMAT` update** in `GoldskyActivityProvider` (change `'unknown'` to `'comma'` — confirmed comma-delimited from Goldsky dataset inspection in Phase 5; note this only matters if the provider ever falls back to raw log parsing, which it currently does not since Goldsky pre-decodes transfers).

---

## Appendix: Files audited

- `server/data/GoldskyActivityProvider.ts`
- `server/data/ArcRpcProvider.ts`
- `server/data/IActivityProvider.ts`
- `server/domain/credentials/CredentialService.ts`
- `server/domain/credentials/system-credentials.ts`
- `server/domain/credentials/types.ts`
- `server/domain/signals/SignalEngine.ts`
- `server/domain/signals/calculators/activity.ts`
- `server/domain/signals/calculators/longevity.ts`
- `server/domain/signals/calculators/breadth.ts`
- `server/domain/signals/calculators/builder.ts`
- `server/domain/signals/calculators/bridge.ts`
- `server/domain/applications/seed-data.ts`
- `server/routes/credentials.ts`
- `server/index.ts`
