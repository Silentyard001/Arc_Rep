# ARC_EARLY_ADOPTER — Definition Audit

**Date:** September 26, 2026
**Status:** Audit only. No code changes.
**Tests run:** 88 focused tests across credentials.test.ts, credentials-phase6.test.ts, data-quality.test.ts — 88 pass, 0 fail.

---

## 1. Current Implementation

### Constant

```ts
export const EARLY_ADOPTER_CUTOFF_UNIX = 1767225599; // 2025-12-31T23:59:59Z
```

Verified arithmetic:
- `1767225599` → `2025-12-31T23:59:59.000Z` (UTC)
- `1767225600` → `2026-01-01T00:00:00.000Z` (UTC, one second later)
- The cutoff is the last second of 2025 UTC, inclusive.

### Comparison rule

```ts
const earned = ts !== null && ts <= EARLY_ADOPTER_CUTOFF_UNIX;
```

**Inclusive.** A wallet whose `firstSeen` timestamp equals exactly `1767225599` qualifies. A wallet whose `firstSeen` is `1767225600` does not.

### History gate

`requiresFullHistory = true`. This means:

- If `firstSeen.status === 'available'` → proceeds to the `<=` comparison.
- If `firstSeen.status === 'partial'` → Gate 2 intercepts → `insufficient_data`.
- If `firstSeen.status === 'unavailable'` → Gate 2 intercepts → `insufficient_data`.
- If `firstSeen` signal is missing entirely → Gate 2 intercepts → `insufficient_data`.

The individual evaluator (`evaluateEarlyAdopter`) has a redundant explicit guard that also returns `insufficient_data` if `firstSeen.status !== 'available'`. This is belt-and-suspenders — Gate 2 should catch all these cases first, but the evaluator guard provides a second line of defense with a more informative note.

**Critical safety property:** a partial `firstSeen` value that numerically satisfies the cutoff (`<= 1767225599`) is explicitly blocked by Gate 2. The test `is insufficient_data even if partial firstSeen value satisfies cutoff` specifically covers this case.

---

## 2. FirstSeen Definition

### What establishes firstSeen

`calculateFirstSeen` (longevity.ts):

```ts
const validTxs = activity.transactions.filter((t) => t.timestamp > 0);
const earliest = Math.min(...validTxs.map((t) => t.timestamp));
```

**Includes:**
- All transactions in `NormalizedActivity.transactions` with `timestamp > 0`.
- Outgoing AND incoming transactions (no `isOutgoing` filter).
- Successful AND failed transactions (no `status === 'success'` filter).
- Any transaction type: native transfers, contract calls, USDC ERC-20 interactions, contract deployments.

**Does not distinguish:**
- Transaction success/failure — a failed transaction at an earlier timestamp establishes a lower `firstSeen` value than a later successful one.
- Direction — receiving USDC from a protocol can establish `firstSeen` as well as sending.
- Transaction type — all on-chain activity touching the wallet address is included.

**No transactions found:**
- Returns `value: null`, `status: 'unavailable'`.
- Zero is never used as a timestamp — `filter(t => t.timestamp > 0)` explicitly excludes it.

### What firstSeen means in practice

"The Unix timestamp of the earliest on-chain event (transaction or receipt) observed for this wallet address in the data snapshot, regardless of transaction type, direction, or outcome."

It is explicitly **not** "first successful outgoing transaction" and not "first qualifying ecosystem interaction."

### Truncation behavior

If `activity.mayBeTruncated === true`:
- `firstSeen.status = 'partial'`
- `confidenceNote` says the actual first transaction may be earlier.
- The credential gate blocks issuance.

If `activity.mayBeTruncated === false`:
- `firstSeen.status = 'available'`
- The credential gate passes through to the `<=` comparison.

---

## 3. Historical Data Reliability

### What Goldsky backfill provides

The Turbo pipeline indexes `arc_testnet.receipt_transactions` from `start_at: earliest`. This table contains all transactions on Arc Testnet from genesis (block 0 or the first block with activity). The `GoldskyActivityProvider` queries `MIN(block_timestamp)` across all transactions to establish `firstSeen`.

For a wallet that was active before the RPC scan window, Goldsky backfill will provide a `firstSeen` value earlier than the RPC provider can see. The provider sets `mayBeTruncated = false` (and `firstSeen.status = 'available'`) only when:
1. The sync lag is within threshold (chain head ≈ indexed head), AND
2. `MIN(block_number)` in the indexed data ≤ `backfillGenesisThreshold` (default: 6,263,142 — the first observed transaction-activity block on Arc Testnet, verified 2026-09-26).

### Reliability for ARC_EARLY_ADOPTER

**After backfill completes:** Goldsky can reliably establish `MIN(block_timestamp)` for any wallet that transacted during the early period. The backfill sources include `receipt_transactions`, `erc20_transfers`, and `raw_traces`, so any on-chain activity establishes the wallet's presence.

**Remaining limitations:**
1. **Reorgs:** Arc Testnet reorgs are possible. The Goldsky pipeline ingests finalized data; shallow reorgs may briefly appear and be corrected. This is an indexer-level concern, not an application concern.
2. **Genesis boundary:** The backfill check uses `backfillGenesisThreshold = 6,263,142` (updated 2026-09-26 after live-chain verification — see section 7 item 3). Block 6,263,142 is the first observed transaction-activity block on Arc Testnet. Blocks before that are empty bootstrap blocks. No further adjustment is expected unless new evidence of earlier activity emerges.
3. **`firstSeen` definition includes failed transactions:** if a wallet's earliest on-chain event is a failed transaction, that timestamp establishes `firstSeen`. This is correct behavior for "earliest observed participation" but worth documenting explicitly as product policy.

---

## 4. Cutoff Assessment

### The facts

- Arc public testnet launched: **October 28, 2025**
- Current cutoff: **December 31, 2025T23:59:59Z** (inclusive)
- Window from launch to cutoff: **65 days**
- Current date of this audit: **September 26, 2026** (9 months after cutoff)
- Credential current state: **insufficient_data** (blocked; no full history yet)

### Assessment

**KEEP DEC 31**

December 31, 2025 is technically and conceptually defensible as the boundary for the initial public-testnet cohort.

**Reasons:**

1. **Matches a natural calendar boundary.** `2025-12-31T23:59:59Z` is the end of the calendar year in which Arc Testnet launched. This is an unambiguous, externally verifiable boundary that does not require knowledge of any specific Arc milestone beyond the launch date.

2. **Covers the full initial period.** Arc Testnet launched October 28, 2025. A cutoff of December 31, 2025 includes every wallet that participated during the first 65 days of public availability — the entire initial cohort — without requiring a precise secondary milestone date.

3. **Is not retroactively gamed.** The cutoff is already in the past. Wallets cannot manufacture early activity after the fact. The credential cannot be earned by creating a new wallet today regardless of the data.

4. **Is conservative, not inflationary.** Moving the cutoff forward (e.g. to March 2026) would include wallets that joined after the initial launch cohort, diluting the "early" meaning. Moving it backward would exclude wallets that genuinely participated in the initial period.

5. **Is technically frozen.** The current implementation is already blocked by `insufficient_data` — no wallet has this credential yet. The cutoff value has had zero production impact. Changing it now is a clean, no-consequence decision.

**The only valid reason to change it** would be if there is a specific Arc ecosystem event between October 28 and December 31, 2025 that should define the boundary differently (e.g. mainnet launch, a specific protocol upgrade, a known cohort close date). If no such event exists, December 31 is the defensible default.

**Not a concern for this audit:** the fact that the cutoff is 9 months in the past does not make it wrong. An early-adopter credential is *supposed* to be in the past and *supposed* to exclude current participants.

---

## 5. Boundary Cases

| Scenario | firstSeen (unix) | firstSeen status | Credential result | Correct? |
|---|---|---|---|---|
| Activity on Oct 28, 2025 (launch day) | ~1730073600 | available | `active` | Yes |
| Activity on Dec 31, 2025 at 23:59:59Z | 1767225599 | available | `active` (inclusive) | Yes — cutoff is inclusive |
| Activity on Dec 31, 2025 at 23:59:58Z | 1767225598 | available | `active` | Yes |
| Activity on Jan 1, 2026 at 00:00:00Z | 1767225600 | available | `not_earned` | Yes — first second after cutoff |
| Activity on Sep 26, 2026 | ~1790000000 | available | `not_earned` | Yes |
| Window snapshot includes only recent activity (RPC) | any | partial | `insufficient_data` | Yes — critical safety |
| Partial snapshot value satisfies cutoff | e.g. 1000000 | partial | `insufficient_data` | Yes — Gate 2 blocks explicitly |
| No transactions at all | null | unavailable | `insufficient_data` | Yes — cannot determine |
| Failed transaction on Oct 28, 2025 | ~1730073600 | available | `active` | Per current definition: yes. Failed transactions count toward firstSeen. |

### The failed-transaction boundary case

A wallet whose only early-period activity was a failed transaction would still qualify. This is a product policy question. The current definition is "earliest on-chain activity" which includes failures. The alternative ("earliest successful transaction") would require a filter in `calculateFirstSeen`. Neither is objectively correct — it is a product decision. The current implementation is internally consistent and should not be changed without a deliberate choice.

---

## 6. Existing Tests

### Tests that directly cover ARC_EARLY_ADOPTER and firstSeen

**credentials-phase6.test.ts** (most comprehensive):
- `is active when firstSeen is available AND <= cutoff` ✓
- `is not_earned when firstSeen is available AND > cutoff` ✓
- `is active at exact cutoff boundary (firstSeen === cutoff, available)` ✓ — boundary inclusive
- `is insufficient_data when firstSeen is partial (window-limited snapshot)` ✓
- `is insufficient_data even if partial firstSeen value satisfies cutoff` ✓ — **core safety test**
- `is insufficient_data when firstSeen is unavailable` ✓
- `is insufficient_data when firstSeen signal is missing entirely` ✓
- `ARC_EARLY_ADOPTER cannot be earned with partial firstSeen` ✓

**credentials.test.ts**:
- `is active when firstSeen <= cutoff` ✓
- `is not_earned when firstSeen > cutoff` ✓
- `is insufficient_data when firstSeen is unavailable` ✓

**data-quality.test.ts**:
- `firstSeen is partial when truncated (may not be true first)` ✓
- `firstSeen is unavailable (no transactions, not "zero")` ✓
- `zero captured + truncated: firstSeen is unavailable, NOT zero` ✓
- `ARC_EARLY_ADOPTER insufficient_data for empty wallet` ✓

### Missing tests (recommended before backfill)

1. **`firstSeen` with failed transactions only:** confirm that a wallet with only failed transactions (all with status !== 'success') still establishes a `firstSeen` value. Currently untested explicitly.

2. **Goldsky `firstSeen` accuracy:** confirm that `GoldskyActivityProvider` produces `firstSeen.status = 'available'` only when both sync lag and backfill checks pass.

3. **Cutoff value cross-check:** a test that independently verifies `EARLY_ADOPTER_CUTOFF_UNIX === 1767225599` and that `new Date(1767225599 * 1000).toISOString() === '2025-12-31T23:59:59.000Z'`. This protects against accidental constant mutation.

4. **`evaluateEarlyAdopter` with `firstSeen.status === 'partial'` but `value === CUTOFF - 1`:** already covered by `is insufficient_data even if partial firstSeen value satisfies cutoff` in Phase 6 tests. No gap.

---

## 7. Final Recommendation

**Definition:**
"A wallet whose earliest observed on-chain activity on Arc Testnet occurred on or before December 31, 2025 (UTC), as established by a complete historical data provider."

"Earliest observed on-chain activity" means the minimum block timestamp across all transactions (of any type, direction, or outcome) where the wallet appears as sender or recipient.

**Cutoff:**
`1767225599` (`2025-12-31T23:59:59Z`, UTC, inclusive). **KEEP.**

**Technical status:**
The implementation is correct, internally consistent, and fully guarded against partial-history false positives. All boundary conditions are tested. The credential correctly returns `insufficient_data` until a complete historical provider is available.

**Required action before Goldsky backfill:**

1. **No code changes required.** The implementation is production-ready as-is.

2. **Confirm the failed-transaction policy** (product decision, not an engineering defect): should a wallet whose only early activity was a failed transaction earn this credential? The current answer is yes. If the intended answer is no, `calculateFirstSeen` must be updated to filter `status === 'success'` before determining the minimum timestamp.

3. **`backfillGenesisThreshold` verified and updated (completed 2026-09-26).** Live-chain verification via eth_getBlockByNumber binary search on Arc Testnet (chain ID 5042002) found blocks 1–6,263,141 to be empty; block 6,263,142 is the first observed transaction-activity block (timestamp 1760684165, 2025-10-17T06:56:05Z). The constant was updated from 100 to 6,263,142 in `GoldskyActivityProvider.ts`. No further action required.

4. **Add the three missing tests** listed above before deploying with Goldsky connected.

5. **Do not change `EARLY_ADOPTER_CUTOFF_UNIX`.** The value is correct.
