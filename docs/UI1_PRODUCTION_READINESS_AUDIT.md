# UI-1 Production Readiness Audit
**Date:** 2026-09-26  
**Scope:** Arc Rep frontend — read-only audit. No code was modified.  
**Backend state:** 407 tests passing, 0 failing. Phase 8 sign-off PASS.

---

## A. Current UI Architecture

### Routes / pages

| Route | Component | Status |
|---|---|---|
| `/` | `WalletLookup` | Full-stack working — address input, ConnectKit wallet shortcut, client-side validation, navigation to profile |
| `/profile/:address` | `ProfileShell` | Full-stack working — fetches live API, renders all three data panels |
| `/docs` | `DocsShell` | Static content only — endpoint listing + design principles |

### Components

| Component | Description |
|---|---|
| `Nav` | Sticky header with wordmark + Lookup / API Docs links |
| `WalletLookup` | Address input form + ConnectKit integration |
| `ProfileShell` | Root profile renderer; contains ActivityCard, SignalsCard, CredentialsCard |
| `ActivityCard` | Renders `WalletActivitySummary` — transaction count, contracts, timestamps, provider, truncation, data quality notes |
| `SignalsCard` | Renders all signals grouped into implemented / future |
| `SignalRow` | Single signal with value, status, confidence note, observation period |
| `CredentialsCard` | Groups credentials by earned / not_earned / insufficient_data with clear section headers |
| `CredentialRow` | Single credential with icon, name, evaluation note, period note, status pill |
| `DocsShell` | API reference, Phase 2 callout, design principles |
| `Stat` | Simple labeled stat cell used inside ActivityCard |

### Data layer

| File | Role |
|---|---|
| `src/hooks/useProfile.ts` | Fetch state machine: idle → loading → success/error. Correct reset method. |
| `src/types/api.ts` | Frontend-safe type mirror. All backend credential/signal types represented. |

### Design tokens

Custom CSS variables in `index.css` covering background, surface, ink, muted, border, success, danger. `DM Sans` body, `Space Grotesk` display, `JetBrains Mono` monospace. All Tailwind directives present.

### No mock/simulated data, no hardcoded test data, no debug controls. All data is live from the API.

---

## B. Production Blockers

### UI-B-01 — MEDIUM — `ProfileShell.tsx` — No retry mechanism on error

**Problem:** When the API call fails (provider error, 502, 500, network), the user sees the error state with no way to retry without manually refreshing the page. The error component has no retry button.

**User impact:** Any transient failure (RPC lag, cold server start) permanently strands the user on the error state within a session. On mobile especially, a user who lands on a profile URL and gets an error has no actionable path.

**Required fix:** Add a retry button in the error state that calls `fetchProfile(address)` again. One line of logic, one UI element.

**Code change required:** Yes — `ProfileShell.tsx`.

---

### UI-B-02 — MEDIUM — `ProfileShell.tsx` — Address in URL is not validated before the fetch

**Problem:** `WalletLookup` validates the address client-side before navigating. But `/profile/:address` can be reached directly (deep link, browser history, typed URL) with an invalid address string. The `fetchProfile` function passes the raw address string to the API which returns a 400 with `INVALID_ADDRESS`. The UI renders this as a generic error state — "Unable to load profile" — without telling the user the address itself is invalid.

**User impact:** Direct links to malformed addresses produce a confusing generic error rather than a clear "invalid address" message.

**Required fix:** Add address format validation in `ProfileShell` before calling `fetchProfile`. If the address is invalid, show a specific invalid-address state with a link back to the lookup, not a generic API error.

**Code change required:** Yes — `ProfileShell.tsx`.

---

## C. High-Priority UX Issues

### UI-C-01 — `SignalRow` — Raw status text exposed directly to users

**Problem:** `SignalRow` renders `signal.status` verbatim as `"available"`, `"partial"`, `"unavailable"`, `"future"`. These are internal API enum values. A production user should never see the string `"future"` or `"unavailable"` without explanation.

**User impact:** Confusing terminology for non-technical users. `"partial"` is especially misleading — it sounds like the signal is half-done rather than meaning the observation window is incomplete.

**Required fix:** Map status values to human-readable labels, e.g. `"partial"` → `"Partial history"`, `"unavailable"` → `"Not available"`, `"future"` → `"Coming soon"`.

---

### UI-C-02 — `ActivityCard` — `uniqueContractAddresses.length` displayed but addresses never shown

**Problem:** The card shows "Contracts interacted: 12" but the underlying addresses are never visible anywhere. A user cannot verify or explore which contracts contributed to this count.

**User impact:** The number is not actionable and cannot be verified by the user.

**Recommendation (should fix):** Either show the addresses in a collapsed/expandable list, or remove the count and substitute it with `uniqueApplications` from signals — which is more meaningful (named applications vs raw addresses).

---

### UI-C-03 — `CredentialRow` — `observationPeriodNote` only shown for `insufficient_data`

**Problem:** The `observationPeriodNote` field is populated for all credentials (including `active` and `not_earned`), but the component only renders it for `insufficient_data`. A user who earned a credential does not see which observation period it was based on.

**User impact:** No transparency about the time window for earned credentials.

**Recommendation (should fix):** Show `observationPeriodNote` for all credential statuses where it is non-empty.

---

### UI-C-04 — `SignalRow` — `json_economic_breakdown` value is raw internal notation

**Problem:** The economic activity signal renders as `"12345678 USDC (raw)"` — the word "(raw)" and the 6-decimal integer form are developer-facing. Users do not know that `1000000 raw = 1 USDC`.

**User impact:** An amount like `2500000` labeled "USDC (raw)" is meaningless to a regular user and may appear inflated.

**Required fix:** Convert the raw USDC amount to a human-readable form using 6-decimal division. Show `"2.50 USDC outgoing"` not `"2500000 USDC (raw)"`.

---

### UI-C-05 — No `retry` / `refresh` affordance anywhere in the profile view

**Problem:** There is no visible button or mechanism to re-fetch a profile once loaded. Data displayed may be from a previous request. The user cannot trigger a refresh within the same session without navigating away.

**Recommendation (should fix):** Add a small refresh action in the profile header or footer with a "Refresh" label.

---

## D. Backend / UI Contract Issues

### UI-D-01 — CONFIRMED CORRECT — `insufficient_data` correctly handled

`CredentialsCard` explicitly groups credentials into earned / not_earned / insufficient_data with distinct section headers. `CredentialRow` uses a distinct `Minus` icon and amber pill for `insufficient_data`. `credentialStatusLabel` returns `"Data needed"` for `insufficient_data`, never `"Not earned"`. This is correct.

### UI-D-02 — CONFIRMED CORRECT — Provider failure does not become zero activity

`useProfile` catches network errors as a string `"Network error..."`. A 502 from the API returns `{ error, detail, code: 'PROVIDER_ERROR' }` which renders in the error state. It does not fall through to an empty profile or zero-activity display.

### UI-D-03 — CONFIRMED CORRECT — Truncation is visible

`ActivityCard` shows `"Partial"` (amber) in "Snapshot complete" when `mayBeTruncated = true`. `SignalRow` renders `confidenceNote` from the API (which includes the partial-window caveat text). These surface the truncation clearly.

### UI-D-04 — MINOR ISSUE — `dataQualityNotes` may contain internal language

The `dataQualityNotes` array in `WalletActivitySummary` flows directly from the backend. The backend generates notes like `"Transaction history may be incomplete..."` which are user-appropriate, but there is no frontend filter in case a future backend note contains internal debug text. Low risk with current codebase; worth a comment in `ActivityCard`.

### UI-D-05 — CONFIRMED CORRECT — `stale` credential status

`credentialStatusIcon` and `credentialStatusLabel` handle `stale` (amber warning icon, `"Stale"` label). `CredentialsCard` groups `stale` with `not_earned` which is correct for display purposes — stale is not the same as insufficient data.

---

## E. Missing States

| Surface | Missing state | Severity |
|---|---|---|
| `ProfileShell` error state | No retry button | MEDIUM (see B-01) |
| `ProfileShell` | Invalid address from direct URL | MEDIUM (see B-02) |
| `ProfileShell` | No explicit "idle" state (never shown since fetch starts immediately on mount) | None — correct by design |
| `SignalsCard` | All signals `future` — shows empty implemented list with only the future pills | LOW — currently no signal is fully future; acceptable |
| `CredentialsCard` | Empty credentials array (no credentials defined) | Handled — "No credentials found for this address." exists |
| `ActivityCard` | `transactionCount = 0` with `mayBeTruncated = false` | Handled — renders "0", no special treatment needed |
| `ProfileShell` | 404 from API (address valid but no data) | The API currently never 404s — it returns an empty profile. No UI change needed but worth documenting. |

---

## F. Recommended Changes

### MUST FIX (before production)

| ID | File | Change |
|---|---|---|
| UI-B-01 | `ProfileShell.tsx` | Add retry button in error state |
| UI-B-02 | `ProfileShell.tsx` | Validate address format before fetch; show specific invalid-address state |
| UI-C-04 | `ProfileShell.tsx` (SignalRow) | Convert raw USDC amounts to human-readable (divide by 1,000,000) |

### SHOULD FIX (high value, low risk)

| ID | File | Change |
|---|---|---|
| UI-C-01 | `ProfileShell.tsx` (SignalRow) | Map signal status enum to human-readable labels |
| UI-C-03 | `ProfileShell.tsx` (CredentialRow) | Show `observationPeriodNote` for all credential statuses, not just `insufficient_data` |
| UI-C-05 | `ProfileShell.tsx` | Add refresh button in profile header/footer |

### OPTIONAL POLISH

| ID | File | Change |
|---|---|---|
| UI-C-02 | `ProfileShell.tsx` (ActivityCard) | Replace raw contract count with `uniqueApplications` signal value or expand to show named apps |
| UI-D-04 | `ProfileShell.tsx` (ActivityCard) | Add comment documenting that `dataQualityNotes` should remain user-appropriate |
| Nav.tsx | `Nav.tsx` | Active state for `/profile/*` — currently not highlighted in the nav |

---

## G. Files to Change

For the MUST FIX and SHOULD FIX items, only one file needs changes:

- `src/components/ProfileShell.tsx` — all six changes

No changes to backend, routes, types, hooks, CSS, or other components are required.

---

## H. Preserve

The following are production-quality and must not be changed:

- `src/App.tsx` — routing shell is correct and minimal
- `src/hooks/useProfile.ts` — state machine is correct; error handling is correct
- `src/types/api.ts` — accurate type mirror of backend contract
- `src/components/Nav.tsx` — clean, correct
- `src/components/WalletLookup.tsx` — validation, ConnectKit integration, navigation all correct
- `src/components/DocsShell.tsx` — accurate and appropriate
- `src/index.css` — design tokens and font stack are correct
- The three-way credential grouping (earned / not_earned / insufficient_data) in `CredentialsCard`
- The disclaimer banners in `WalletLookup` and `ProfileShell`
- The `dataQualityNotes` rendering in `ActivityCard`
- The `confidenceNote` rendering in `SignalRow`
- The `mayBeTruncated` caveat in `ActivityCard`

---

## I. Verdict

**UI READY WITH CONDITIONS**

The frontend correctly implements the core contract: `insufficient_data` never renders as `not_earned`, provider failure never renders as zero activity, truncation is visible, and all credential states are semantically distinguished.

Three issues must be fixed before production:

1. **No retry on error** — users can be permanently stranded by a transient failure
2. **No address validation on direct URL access** — deep links to invalid addresses produce a confusing generic error
3. **Raw USDC amounts displayed** — `2500000 USDC (raw)` is meaningless and potentially alarming to regular users

Three additional should-fix items improve clarity and trust. All six changes are isolated to `ProfileShell.tsx`.
