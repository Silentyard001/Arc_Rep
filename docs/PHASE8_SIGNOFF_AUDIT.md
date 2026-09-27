# Phase 8 — Production Readiness Sign-Off Audit

**Date:** September 26, 2026  
**Auditor:** Arc Studio  
**Status at time of audit:** 383 tests passing, 0 failing, 0 lint errors, 0 TypeScript errors  
**Scope:** Full read-only audit of credential pipeline, data boundaries, provider failure semantics, signal calculators, API/frontend contract, security/abuse cases, and deployment readiness.

---

## Findings

### BLOCKER

None.

---

### HIGH

#### P8S-01 | HIGH | `server/domain/credentials/CredentialService.ts:303–325`
**Problem:** `evaluateConsistentUser` returns `not_earned` when `activeDays` or `activityConsistency` are `unavailable`, but it does not return `insufficient_data`. For a credential that depends on having *any* activity data at all, a completely unavailable signal is a data quality issue, not a confirmed negative.  
**Why it matters:** A wallet whose `activeDays` is `unavailable` due to a provider error or empty snapshot gets `not_earned`, which implies evaluation happened and the threshold wasn't met. The correct status is `not_earned` for `activeDays=0` in a complete snapshot, but `insufficient_data` when the signal is `unavailable` (meaning evaluation never ran). The distinction is subtle but matters for API consumers that surface `not_earned` as evidence of absence.  
**Severity note:** This is HIGH, not BLOCKER, because `activeDays.unavailable` only occurs when there are genuinely zero transactions with valid timestamps — in which case `not_earned` is arguably correct. The risk is narrow but real for the error path.  
**Recommended fix:** In `evaluateConsistentUser`, return `insufficient_data` when `activeDays.status === 'unavailable'` rather than `not_earned`. Preserve `not_earned` for when the signal is usable but the threshold isn't met.  
**Code change required:** Yes — 3-line change to `evaluateConsistentUser`.

---

### MEDIUM

#### P8S-02 | MEDIUM | `server/domain/credentials/CredentialService.ts:360–373`
**Problem:** `evaluatePaymentsParticipant` returns `not_earned` when neither signal is usable, using the message `"Neither economicActivity nor usdcReceived signals are usable."`. This is semantically `insufficient_data`, not `not_earned`.  
**Why it matters:** A Goldsky provider error would make both `economicActivity` and `usdcReceived` `partial` with value 0 (or unavailable). The credential would return `not_earned` when the correct answer is "cannot evaluate." Unlike `evaluateConsistentUser`, this one has a direct path from provider failure to `not_earned`.  
**Recommended fix:** When neither signal is usable, return `insufficient_data` with the reason. Return `not_earned` only when at least one signal is usable and the threshold is not met.  
**Code change required:** Yes — change one `not_earned` to `insufficient_data` with a matching note.

#### P8S-03 | MEDIUM | `server/data/GoldskyActivityProvider.ts:558–568`
**Problem:** `queryUsdcTransfers` has no LIMIT clause. A whale wallet receiving millions of USDC transfers from many senders would load all rows. Unlike transactions, there is no `maxTransactionsPerWallet` equivalent for the transfer query.  
**Why it matters:** The `arc_rep.erc20_transfers` table grows independently of `tx_activity`. A wallet receiving many small USDC transfers (payment processor, treasury, airdrop target) could produce an unbounded transfer result set even if its transaction count is within the row limit.  
**Evidence:** `queryTransactions` has `LIMIT $2`; `queryUsdcTransfers` does not.  
**Recommended fix:** Add a `maxTransfersPerWallet` config (default 100,000) and `LIMIT $3` to `queryUsdcTransfers`. When the limit is hit, set `mayBeTruncated = true` with a note. Wire the same truncation detection logic used in `queryTransactions`.  
**Code change required:** Yes.

---

### LOW

#### P8S-04 | LOW | `server/data/GoldskyActivityProvider.ts:464–466`
**Problem:** `totalOutgoingTransactionCount` counts ALL outgoing transactions (including failed). The comment says this is intentional for consistency with the RPC nonce semantics. However, when the Goldsky provider is active and `mayBeTruncated = false`, `transactionCount` is also derived from ALL outgoing (including failed) — consistent. But `economicActivity` only counts `succeeded`. This is correct and intentional, but it creates a subtle semantic difference between `transactionCount` (all outgoing) and `economicActivity` (succeeded outgoing only) that is not surfaced in the signal labels. No fix required; the behaviour is documented. Calling it out for awareness.  
**Code change required:** No — documentation only.

#### P8S-05 | LOW | `server/domain/credentials/CredentialService.ts:167`
**Problem:** The `default` case in the `evaluateDefinition` switch returns `not_earned` with message `"Unknown credential type"`. An unknown type should arguably return `insufficient_data` or throw, not `not_earned`, since `not_earned` implies evaluation ran and the threshold was not met.  
**Why it matters:** Minimal — this path is only hit if a definition is added to `SYSTEM_CREDENTIAL_DEFINITIONS` without a matching case. Since TypeScript has no exhaustive switch check here, a future developer could add a credential definition and get silent `not_earned` from the default case without noticing.  
**Recommended fix:** Add a comment noting this is a safety fallback for unimplemented cases; optionally return `insufficient_data`.  
**Code change required:** Optional — comment improvement only.

#### P8S-06 | LOW | `server/domain/credentials/CredentialService.ts:252–263`
**Problem:** `evaluateEarlyAdopter` computes a human-readable `cutoffDate` string using `new Date(EARLY_ADOPTER_CUTOFF_UNIX * 1000).toISOString().slice(0, 10)` on every evaluation call. This is not a bug but is wasteful when called in a loop and timezone-safe only because `.toISOString()` always returns UTC. No risk, minor overhead.  
**Code change required:** No.

#### P8S-07 | LOW | `server/domain/credentials/CredentialService.ts` — `buildCredential`
**Problem:** `observationPeriodNote` is set to `''` (empty string) when status is not `insufficient_data`. This means even credentials with a `requiresFullHistory = true` definition that ARE issued (e.g., `ARC_BUILDER` with non-zero partial count) will have an empty `observationPeriodNote` in the response. The definition's note is only surfaced when the credential cannot issue.  
**Why it matters:** API consumers receiving an `active` `ARC_BUILDER` credential from a partial snapshot get no indication that the count may be a lower bound. The note "Count is from a partial snapshot; true lifetime count may be higher" exists in the `evaluationNote` field, so it is present — just not in `observationPeriodNote`. This is an API clarity issue, not a correctness issue.  
**Code change required:** No — the `evaluationNote` carries the caveat.

---

## Credential Integrity Matrix

| Credential | Source | Full-history gate | Partial snapshot safe? | Finding |
|---|---|---|---|---|
| `ARC_ACTIVE_WALLET` | `transactionCount` (nonce fallback) | No | Yes | Clean |
| `ARC_EARLY_ADOPTER` | `firstSeen` | Yes — double-guarded (Gate 2 + explicit `available` check) | `insufficient_data` on partial | Clean |
| `ARC_MULTI_APP_USER` | `uniqueApplications` | No | Yes | Clean |
| `ARC_CONSISTENT_USER` | `activeDays` + `activityConsistency` | No | Yes — but `unavailable` produces `not_earned` not `insufficient_data` | **P8S-01** |
| `ARC_PAYMENTS_PARTICIPANT` | `economicActivity` + `usdcReceived` | No | Yes — but both-unusable returns `not_earned` | **P8S-02** |
| `ARC_BUILDER` | `builderActivity` | Yes — partial-positive bypass for non-zero | `insufficient_data` on zero-partial | Clean |
| `ARC_BRIDGE_USER` | `bridgeInteractions` | Yes — partial-positive bypass for non-zero | `insufficient_data` on zero-partial | Clean |
| `ARC_LIQUIDITY_PARTICIPANT` | `liquidityActivity` (future) | Gate 1 (future signal) | Always `insufficient_data` | Clean |

---

## Historical Data Safety

The two-gate model (sync lag + backfill completeness) is correctly implemented and tested. Specifically verified:

- `ARC_EARLY_ADOPTER` has a secondary explicit guard in `evaluateEarlyAdopter`: `firstSeen.status !== 'available'` → `insufficient_data`. This is belt-and-suspenders and correct.
- `MIN(block_number) === null` (empty table) → `isBackfillIncomplete = true` → `mayBeTruncated = true`. Correct.
- Row-limit truncation → `mayBeTruncated = true` → all signals `partial` → all `requiresFullHistory` credentials → `insufficient_data`. Correct.
- The `fetchChainHead()` RPC timeout (5s AbortSignal) returns `null` on failure → `syncLag = null` → `isLagged = false` (optimistic). This is the correct default: a transient RPC failure should not degrade all profile lookups.

One gap: if `fetchChainHead()` fails permanently (RPC is down), the sync lag is never detected, and a stale-but-non-backfilling Goldsky pipeline would not set `mayBeTruncated`. This is an acceptable tradeoff (optimistic on RPC failure) but should be documented.

---

## Goldsky Data Boundary

- **`queryTransactions`:** Bounded by `LIMIT $2`. Truncation detection wired. ✓
- **`queryUsdcTransfers`:** No LIMIT. **P8S-03.**
- **`queryLatestIndexedBlock`:** Returns a single aggregate row. ✓
- **`queryEarliestIndexedBlock`:** Returns a single aggregate row. ✓
- **`fetchChainHead`:** 5-second AbortSignal timeout. ✓
- **SQL injection:** All parameters use `$N` placeholders. ✓
- **Address normalization:** `address.toLowerCase()` before SQL. ✓
- **`ARC_USDC_CONTRACT`:** Single source of truth in `ArcRpcProvider.ts`, imported everywhere. ✓ (P8-03 fix confirmed.)

---

## Provider Failure Semantics

The five states are distinguishable:

| State | Representation | Correct? |
|---|---|---|
| Valid positive evidence | Signal `available`/`partial`, value > threshold → credential `active` | ✓ |
| Valid negative evidence | Signal `available`, value < threshold → credential `not_earned` | ✓ |
| Insufficient data | Signal `partial` with value 0 on `requiresFullHistory` → `insufficient_data` | ✓ |
| Provider error | `ActivityProviderError` thrown → HTTP 502 `PROVIDER_ERROR` | ✓ |
| Truncated data | `mayBeTruncated = true` → signals `partial` → credential `insufficient_data` or `active` (positive bypass) | ✓ |

**One partial collapse identified (P8S-02):** Both-unusable signals in `ARC_PAYMENTS_PARTICIPANT` → `not_earned` instead of `insufficient_data`. The provider error case (which makes signals unusable) collapses into `not_earned`.

---

## Security / Abuse Cases

| Scenario | Outcome | Safe? |
|---|---|---|
| Wallet with millions of transactions | Row limit 50,000 → truncated → partial signals → `insufficient_data` for full-history credentials | ✓ |
| Wallet with millions of USDC transfers | No limit on transfer query → unbounded memory | **P8S-03** |
| Wallet with zero transactions | Empty transactions → signals `unavailable`/`available=0` → `not_earned` or `insufficient_data` | ✓ |
| Wallet at exactly the row limit | Exactly 50,000 rows → `mayBeTruncated = true` | ✓ |
| Wallet exceeding the row limit | Returns exactly 50,000 → truncated | ✓ |
| Repeated provider failures | Each call throws `ActivityProviderError` → 502 each time, no stale data | ✓ |
| Malformed transfer row | `decodeGoldskyTransferRow` returns `null` → skipped | ✓ |
| Malformed `value` in tx row | `BigInt()` try/catch → falls back to `BigInt(0)` | ✓ |
| Future timestamps | Included in calculations — no future-timestamp filter | Low risk; no credential issues |
| Negative/invalid block numbers | `parseInt` returns `NaN` → `isNaN(NaN) > threshold` → true → `mayBeTruncated` | ✓ |
| Concurrent requests for same wallet | No shared state; each request builds fresh profile | ✓ |
| Duplicate transactions in Goldsky result | No deduplication on hash; duplicate rows inflate all counts | LOW risk — Goldsky reorg handling should prevent this at pipeline level |
| `economicActivity` JSON parse failure | `try/catch` → `BigInt(0)` outgoing USDC | ✓ |

---

## Configuration & Deployment Safety

- `GoldskyActivityProviderConfig`: all dangerous defaults are conservative (backfill threshold 100, row limit 50,000, lag threshold 1,000).
- `backfillGenesisThreshold: null` is only possible in tests (requires explicit `null`; default is 100).
- `GOLDSKY_POSTGRES_URL` never appears in error messages (the `ActivityProviderError` wraps the Postgres error string, which does not include the connection string).
- `EARLY_ADOPTER_CUTOFF_UNIX` is annotated with a product-review warning.
- No secrets are hardcoded.
- Server-side config is not serialized in any API response.

---

## API / Frontend Contract

All credential statuses (`active`, `not_earned`, `insufficient_data`, `stale`) are represented in `src/types/api.ts`. The `insufficient_data` state is handled in `ProfileShell.tsx`. The `mayBeTruncated` field surfaces in `activitySummary`. No collapse to `verified`/`zero`/`no activity` is possible given the current route handler.

One note: `CredentialStatus = 'stale'` is defined but never produced. This is fine — forward compatibility.

---

## Test Assessment

The 383 existing tests protect the following invariants:

- All 8 credential boundary conditions (threshold - 1 / threshold / threshold + 1)
- `insufficient_data` propagation from partial signals
- Provider failure → `ActivityProviderError` (not empty activity)
- Row-limit truncation → `mayBeTruncated`
- Backfill incompleteness → `mayBeTruncated`
- `ARC_EARLY_ADOPTER` double-gate (Gate 2 + status check)
- `ARC_BUILDER` and `ARC_BRIDGE_USER` partial-positive bypass
- `decodeGoldskyTransferRow` malformed row → null
- `ARC_USDC_CONTRACT` single source of truth

**Missing tests for P8S-01 and P8S-02 specifically:**
- `evaluateConsistentUser` with `activeDays.status = 'unavailable'` → should return `insufficient_data` (after fix)
- `evaluatePaymentsParticipant` with both signals `unavailable` → should return `insufficient_data` (after fix)
- `queryUsdcTransfers` unbounded result (after P8S-03 fix)

---

## Final Verdict

### GO WITH CONDITIONS

No architectural blocker remains. The implementation is correctly designed and the historical data safety model is sound. Two HIGH/MEDIUM findings require code changes before production:

**Required before production:**
1. **P8S-01** — `evaluateConsistentUser` with `unavailable` signal returns `not_earned` instead of `insufficient_data`
2. **P8S-02** — `evaluatePaymentsParticipant` with both signals unusable returns `not_earned` instead of `insufficient_data`
3. **P8S-03** — `queryUsdcTransfers` has no LIMIT; unbounded for high-transfer wallets

**Non-blocking:**
- P8S-04 through P8S-07: documentation/clarity improvements; no correctness risk

**Required product decision:**
- **P8-05 (carried forward):** `EARLY_ADOPTER_CUTOFF_UNIX = 2025-12-31` is 9 months in the past. Decision needed before Goldsky backfill completes and the credential becomes evaluable.

---

## Deployment Sequence (once Goldsky auth is available)

1. Run `goldsky secret create arc-rep-pg-url` with Supabase connection string
2. Run `bunx goldsky login --token <key>` in sandbox terminal
3. Run `turbo validate infra/goldsky/arc-rep-turbo.yaml` — review output
4. Await explicit authorization, then `turbo apply`
5. Monitor Goldsky pipeline status for first rows
6. Confirm `MIN(block_number)` in `arc_rep.tx_activity` approaches 0
7. Once `MIN(block_number) <= 100`: `GoldskyActivityProvider` marks backfill complete
8. Confirm `ARC_EARLY_ADOPTER` evaluates (not `insufficient_data`) for a known early wallet
9. Review and resolve `EARLY_ADOPTER_CUTOFF_UNIX` product decision
10. Deploy Express server with `GOLDSKY_POSTGRES_URL` set
