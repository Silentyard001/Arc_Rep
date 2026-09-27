# Phase 6: Credential System

## Summary

Phase 6 expanded and hardened the Arc Rep credential system. The architecture was not redesigned — the existing `CredentialDefinition` / `CredentialService` / `SYSTEM_CREDENTIAL_DEFINITIONS` separation was retained and extended.

---

## What Was Added

### New `CredentialStatus` value: `insufficient_data`

Previously, `CredentialStatus` had three values: `active`, `stale`, `not_earned`.

A fourth value, `insufficient_data`, has been added with a precise meaning distinct from `not_earned`:

| Status | Meaning |
|---|---|
| `active` | Credential conditions met |
| `not_earned` | Conditions evaluated; threshold not met |
| `insufficient_data` | Cannot evaluate reliably — required data quality is provably insufficient |
| `stale` | Reserved for future expiry logic |

`insufficient_data` is triggered by two situations:
1. A required signal has status `future` (the calculator is not yet implemented)
2. A credential has `requiresFullHistory = true` AND all required signals are only `partial` (none `available`)

This prevents a window-limited snapshot from accidentally producing definitive credentials for credentials that need complete history.

### New `CredentialDefinition` fields

- `requiresFullHistory: boolean` — when `true`, the credential uses the full-history gate described above
- `observationPeriodNote: string` — plain-English explanation of what data quality is required; surfaced in the API response when `status === 'insufficient_data'`

### New `Credential` instance field

- `observationPeriodNote: string` — non-empty only when `status === 'insufficient_data'`; empty string otherwise

---

## Credential Set (7 total)

| typeId | Name | Can evaluate now? | Status when conditions met |
|---|---|---|---|
| `ARC_ACTIVE_WALLET` | Active Arc Wallet | Yes | `active` |
| `ARC_EARLY_ADOPTER` | Arc Early Adopter | **No** (requiresFullHistory=true) | `insufficient_data` until full history |
| `ARC_MULTI_APP_USER` | Arc Multi-Application User | Yes | `active` |
| `ARC_CONSISTENT_USER` | Arc Consistent User | Yes | `active` |
| `ARC_PAYMENTS_PARTICIPANT` | Arc Payments Participant | Yes | `active` |
| `ARC_BUILDER` | Arc Builder | **No** (builderActivity signal is `future`) | `insufficient_data` |
| `ARC_LIQUIDITY_PARTICIPANT` | Arc Liquidity Participant | **No** (liquidityActivity signal is `future`) | `insufficient_data` |

---

## Deterministic Rules

### ARC_ACTIVE_WALLET
- **Rule:** `transactionCount.status in ['available', 'partial'] AND transactionCount.value >= 5`
- **requiresFullHistory:** false
- **Note:** Partial is acceptable because the nonce fallback (Phase 3B) makes `transactionCount` reliable even for truncated snapshots.

### ARC_EARLY_ADOPTER
- **Rule:** `firstSeen.status === 'available' AND firstSeen.value <= 1767225599` (2025-12-31)
- **requiresFullHistory:** true
- **Why blocked:** The RPC window provider always produces `partial` for `firstSeen`. A partial `firstSeen` that satisfies the cutoff date cannot be trusted — the wallet's real first transaction may predate the scan window. This credential is deferred until the Goldsky full-history provider marks `firstSeen` as `available`.

### ARC_MULTI_APP_USER
- **Rule:** `uniqueApplications.status in ['available', 'partial'] AND uniqueApplications.value >= 2`
- **requiresFullHistory:** false

### ARC_CONSISTENT_USER
- **Rule:** `activeDays.value >= 2 AND activityConsistency.status in ['available', 'partial'] AND activityConsistency.value !== null`
- **requiresFullHistory:** false

### ARC_PAYMENTS_PARTICIPANT
- **Rule:** `(outgoingUsdcErc20Raw >= 1_000_000 OR incomingUsdcRaw >= 1_000_000) AND at least one of [economicActivity, usdcReceived] is usable`
- **requiresFullHistory:** false
- **Threshold:** 1 USDC (1,000,000 raw 6-decimal units)
- **Evidence sources:** `economicActivity` (JSON breakdown, `usdcErc20Raw` field) for outgoing; `usdcReceived` for incoming
- **Safety:** Native wei (`nativeValueWei`) is explicitly NOT counted — it uses a different decimal scale (18 vs 6) and must never be interpreted as USDC ERC-20 value without conversion.

### ARC_BUILDER
- **Rule:** `builderActivity.status in ['available', 'partial'] AND builderActivity.value >= 1`
- **requiresFullHistory:** true
- **Why blocked:** `builderActivity` signal is `future`. Requires contract deployment detection from full transaction history.

### ARC_LIQUIDITY_PARTICIPANT
- **Rule:** `liquidityActivity.status in ['available', 'partial'] AND liquidityActivity.value >= 1`
- **requiresFullHistory:** true
- **Why blocked:** `liquidityActivity` signal is `future`. Requires DeFi protocol registry expansion and liquidity position tracking.

---

## Credentials Deliberately Not Implemented

### ARC_BRIDGE_USER (not in credential set)
This credential (wallet used Circle CCTP or Gateway) cannot be safely evaluated with the current signal set. `uniqueApplications` counts all recognized applications and cannot distinguish "used CCTP/Gateway" from "used any two apps." A safe implementation requires a dedicated `bridgeInteractions` signal, which would need to be added to the signal engine. This was not added because it involves new signal logic outside Phase 6's scope.

---

## API Response Semantics

`GET /credentials/:address` returns a `credentials` array. Frontend consumers can distinguish:

| `status` value | Meaning to display |
|---|---|
| `active` | Earned — conditions met in this snapshot |
| `not_earned` | Evaluated — threshold not met |
| `insufficient_data` | Cannot determine — data quality insufficient (see `observationPeriodNote`) |
| `stale` | Previously issued — data may no longer reflect current state |

The `observationPeriodNote` field explains exactly what data is missing and what is required.

---

## Files Changed

| File | Change |
|---|---|
| `server/domain/credentials/types.ts` | Added `insufficient_data` to `CredentialStatus`; added `requiresFullHistory` and `observationPeriodNote` to `CredentialDefinition`; added `observationPeriodNote` to `Credential` |
| `server/domain/credentials/system-credentials.ts` | Full rewrite: 4 → 7 credentials; all with `requiresFullHistory` and `observationPeriodNote`; `PAYMENTS_MIN_USDC_RAW` constant |
| `server/domain/credentials/CredentialService.ts` | Full rewrite: two-gate evaluation (future signals → `insufficient_data`; requiresFullHistory → `insufficient_data`); new `evaluatePaymentsParticipant`; `collectEvidence` extracted as shared helper |
| `src/types/api.ts` | Added `insufficient_data` to `CredentialStatus`; added `observationPeriodNote` to `Credential` |
| `src/components/ProfileShell.tsx` | Three-way credential display (earned / not earned / insufficient data); `observationPeriodNote` shown inline; new `credentialStatusLabel` and `credentialStatusPill` helpers |
| `tests/domain/credentials-phase6.test.ts` | New: 57 tests covering all Phase 6 rules |
| `tests/domain/credentials.test.ts` | Updated 2 tests to reflect correct `insufficient_data` semantics |
| `tests/domain/data-quality.test.ts` | Updated 2 tests to reflect correct `insufficient_data` semantics |

---

## Test Results

- **319 tests pass, 0 fail** across 13 test files
- **0 lint errors, 0 TypeScript errors**
- Phase 6 test file adds 57 new tests

---

## What Remains for Future Phases

1. **Goldsky full-history provider** (Phase 5, blocked on infra) — unblocks `ARC_EARLY_ADOPTER`
2. **`builderActivity` signal** — unblocks `ARC_BUILDER`
3. **`liquidityActivity` signal** — unblocks `ARC_LIQUIDITY_PARTICIPANT`
4. **`bridgeInteractions` signal** — enables a safe `ARC_BRIDGE_USER` credential
5. **Credential expiry / `stale` status** — for time-bounded credentials in future phases
