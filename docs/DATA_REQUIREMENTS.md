# Arc Rep — Data Capability Audit

**Document version:** Phase 3A (ERC-20 Transfer Decoding)  
**Last updated:** September 2026  
**Scope:** ArcRpcProvider, NormalizedActivity, SignalEngine, CredentialService  
**Purpose:** Determine exactly what Arc Rep can and cannot reliably calculate from the current architecture, and specify the minimum provider contract for reliable historical data.

**Phase 5C change summary (2026-09-24):** `GoldskyActivityProvider` skeleton implemented in
`server/data/GoldskyActivityProvider.ts`. Fully implements `IActivityProvider`. Topics-column
format parsing is deliberately stubbed as `TOPICS_FORMAT = 'unknown'` with an `ActivityProviderError`
guard until empirically confirmed from the live Goldsky Postgres sink. Three human steps are
required to complete the provider: (1) `goldsky login`, (2) provision a Postgres database and
set `GOLDSKY_POSTGRES_URL`, (3) deploy the pipeline with
`bunx goldsky pipeline create arc-rep --definition-path infra/goldsky/arc-rep-pipeline.yaml`.
34 new tests in `tests/data/goldsky-provider.test.ts`. Full suite: 282/282 pass. 0 lint/TS errors.

**Phase 5B change summary (2026-09-24):** EIP-7708 dual-emitter safety fix in `ArcRpcProvider`.
`ARC_SYSTEM_EMITTER` constant added. System-emitter logs filtered before ERC-20 decoding.
22 regression tests in `tests/data/eip7708-system-emitter.test.ts`.

**Phase 3A change summary:** ERC-20 Transfer event amounts are now decoded in `ArcRpcProvider`. The `NormalizedTransaction` type now includes an `erc20Transfers: DecodedErc20Transfer[]` field. The `economicActivity` signal now reports a two-component JSON breakdown (native wei + USDC ERC-20 raw). See sections 1.5, 1.6, and §3 `economicActivity` for updated status.

**Phase 4.1 change summary:** `usdcReceived` signal added. `USDC_RECEIVED = 'usdcReceived'` key added to `SIGNAL_KEYS`. `calculateUsdcReceived` added to `server/domain/signals/calculators/activity.ts`. Wired into `SignalEngine`. 35 new tests in `tests/domain/usdc-received.test.ts`. Full suite: 226 pass. 0 lint/TS errors. See §3 (`usdcReceived`) for semantics.

**Phase 4 change summary:** Application registry expanded from 3 applications / 8 contracts to 9 applications / 17 contracts using exclusively verified Arc Testnet contract addresses. New `sourceType` and `sourceRef` provenance fields added to `ApplicationContract`. CCTP `MessageTransmitterV2` address typo corrected (was 39 hex chars; now correct 40 chars from `onchain-facts.ts`). Registry integrity tests added in `tests/domain/registry-integrity.test.ts`. See §2.3 for updated coverage.

**Phase 3B change summary:** The `transactionCount` signal now uses the account-level nonce from `eth_getTransactionCount` as the authoritative lifetime transaction count when `mayBeTruncated = true` and the nonce is available (Case B). `NormalizedActivity` now carries a `totalOutgoingTransactionCount?: number` field. The signal remains `status: 'partial'` because per-transaction detail (timestamps, recipients, contracts) is still window-limited. See §3 `transactionCount` for the three-case behavior.

---

## Definitions used in this document

| Term | Meaning |
|---|---|
| **Observable fact** | A value read directly from the chain without interpretation (block timestamp, transaction hash, sender address, value in wei) |
| **Derived measurement** | A value calculated from one or more observable facts by applying a defined algorithm (activeDays, CV of gaps) |
| **Interpretation** | A subjective or contextual judgment applied on top of derived measurements (this wallet is trustworthy, this activity is meaningful) |
| **Block scan window** | The range of blocks the ArcRpcProvider examines in a single call. Currently DEFAULT = 10,000 blocks |
| **Snapshot** | The set of transactions visible within a single block scan window |
| **Full history** | All transactions a wallet has ever sent on a chain since block 0 |

Arc Rep produces observable facts and derived measurements. It never produces interpretations.

---

## 1. Wallet Activity Capability Matrix

### 1.1 Native (gas-value) transactions

| Capability | Status | Notes |
|---|---|---|
| Detect that a wallet has sent native-value transactions | **IMPLEMENTED** | `valueWei` field on `NormalizedTransaction`; sourced from `eth_getTransactionByHash` |
| Sum of native value sent (within snapshot) | **IMPLEMENTED** | `economicActivity` signal: `sum(valueWei)` for outgoing succeeded txns |
| Full history of native value sent | **REQUIRES-INDEXER** | Only the current block scan window is visible. Historical native transfers outside the window are not captured. |
| Native value received | **RPC-CAPABLE-BUT-NOT-IMPLEMENTED** | Incoming transactions are in `NormalizedActivity.transactions` but are not summed. No signal exposes received value. |

**Data source used:** `eth_getTransactionByHash` (field: `value`), block scan via `eth_getBlockByNumber` (full tx objects).

---

### 1.2 Transaction timestamps

| Capability | Status | Notes |
|---|---|---|
| Block timestamp for any transaction within the scan window | **IMPLEMENTED** | `eth_getBlockByNumber` returns `timestamp` (hex seconds since epoch); decoded to `NormalizedTransaction.timestamp` |
| Timestamps for transactions outside the scan window | **REQUIRES-INDEXER** | Block header data is fetched for each block a captured transaction appeared in, but blocks outside the scan window are not fetched |
| Millisecond precision | **NOT-APPLICABLE** | Arc block timestamps are seconds. Millisecond precision is not available from block headers on EVM chains. |

---

### 1.3 Transaction success/failure

| Capability | Status | Notes |
|---|---|---|
| Per-transaction success/failure within snapshot | **IMPLEMENTED** | `eth_getTransactionReceipt` returns `status` (0x1 = success, 0x0 = failure); decoded to `NormalizedTransaction.succeeded` |
| Failure reason / revert message | **RPC-CAPABLE-BUT-NOT-IMPLEMENTED** | `eth_call` with state override can replay reverts but is not implemented. Revert reasons are not exposed in `NormalizedTransaction`. |

---

### 1.4 Historical activity (full wallet history)

| Capability | Status | Notes |
|---|---|---|
| Transactions within current 10,000-block window | **IMPLEMENTED** | `mayBeTruncated` flag signals when the wallet is older than the scan window |
| Transactions before the scan window | **REQUIRES-INDEXER** | Standard JSON-RPC provides no `eth_getTransactionsByAddress` method. `eth_getTransactionCount` confirms a nonce but does not expose individual historical transactions. There is no way to enumerate past transactions without either scanning every block or using an indexer. |
| Wallet's true first transaction (genesis on-chain) | **REQUIRES-INDEXER** | `firstSeen` is the earliest timestamp in the snapshot, not the chain-true first transaction. It is marked `partial` when `mayBeTruncated = true`. |
| Wallet age in days | **REQUIRES-INDEXER** | Calculable from `firstSeen`, but `firstSeen` is only accurate when the full history is indexed |

---

### 1.5 ERC-20 transfers

| Capability | Status | Notes |
|---|---|---|
| Detect ERC-20 Transfer events involving the wallet (within scan window) | **IMPLEMENTED** | `eth_getLogs` with `Transfer(address,address,uint256)` topic0, filtering by wallet as sender or recipient (topic1/topic2) |
| Identify the specific token transferred | **IMPLEMENTED** | `DecodedErc20Transfer.tokenAddress` = `log.address` (the token contract), lowercased. |
| Decode transfer amount from logs | **IMPLEMENTED** (Phase 3A) | `log.data` (32-byte big-endian uint256) decoded via `BigInt(amountHex)`. Result stored in `DecodedErc20Transfer.amountRaw`. No decimal conversion applied at this layer. |
| Decode transfer sender and recipient | **IMPLEMENTED** (Phase 3A) | `log.topics[1]` → `from`, `log.topics[2]` → `to`. Rightmost 20 bytes of each 32-byte padded address, lowercased. |
| ERC-20 transfers outside the scan window | **REQUIRES-INDEXER** | Same limitation as native transactions. The 10,000-block window applies. |
| ERC-20 transfers for non-USDC tokens | **DECODED-BUT-NOT-SIGNALED** | All ERC-20 Transfer events in the scan window are decoded into `erc20Transfers[]`. Only USDC (address `0x3600...`) is used in the current `economicActivity` calculation. Other token amounts are available in `NormalizedTransaction.erc20Transfers` for future signals. |
| Malformed / incomplete Transfer logs | **HANDLED** | `decodeErc20TransferLog()` returns `null` for logs with wrong topic count, missing data, or any parse error. Null results are silently dropped — they do not surface as partial transfers. |

**Phase 3A status:** The ERC-20 data gap from Phase 1 has been closed at the data layer. `NormalizedTransaction.erc20Transfers` is always present (empty array when no Transfer events). The signal layer now sums outgoing USDC ERC-20 transfers in `economicActivity`. The window-limitation gap (history before scan window) remains open and requires an indexer.

---

### 1.6 USDC transfers specifically

| Capability | Status | Notes |
|---|---|---|
| Detect transactions that touched the USDC contract | **IMPLEMENTED** | USDC contract address (`0x3600...`) is in the application registry. Transactions with `to = 0x3600...` and `hasInputData = true` are recognized as USDC contract interactions. |
| Decode the amount transferred in a USDC `transfer()` call | **IMPLEMENTED** (Phase 3A) | USDC Transfer events are decoded from `eth_getLogs` data. `DecodedErc20Transfer.amountRaw` is the raw 6-decimal integer. `economicActivity.usdcErc20Raw` sums outgoing USDC amounts where `transfer.from === walletAddress`. |
| Track USDC received from another wallet | **IMPLEMENTED** (Phase 4.1) | `usdcReceived` signal: sum of `transfer.amountRaw` for ERC-20 USDC transfers where `transfer.to === walletAddress` and `tx.succeeded`. 6-decimal raw integer, serialized as decimal string. |
| USDC transfer history before the scan window | **REQUIRES-INDEXER** | Full ERC-20 log history requires an indexer. The 10,000-block window limitation applies to ERC-20 log scans exactly as it does to native transactions. |

---

### 1.7 Contract interactions

| Capability | Status | Notes |
|---|---|---|
| Detect that a transaction called a contract (has non-empty calldata) | **IMPLEMENTED** | `NormalizedTransaction.hasInputData = (input !== '0x' && input.length > 2)` |
| Identify which contracts were called | **IMPLEMENTED** | `contractAddressesInteracted` set on `NormalizedActivity` |
| Identify the specific function called | **RPC-CAPABLE-BUT-NOT-IMPLEMENTED** | `input` field contains the 4-byte function selector + encoded parameters, but ABI decoding is not implemented. |
| Map contract interactions to recognized applications | **IMPLEMENTED** | `ApplicationRegistry.resolveContract()` |
| Contract interactions outside the scan window | **REQUIRES-INDEXER** | Same scan-window limitation applies. |

---

### 1.8 Contract deployments

| Capability | Status | Notes |
|---|---|---|
| Detect contract creation transactions by this wallet (within snapshot) | **IMPLEMENTED** | `NormalizedTransaction.isContractCreation = (tx.to === null)` and `createdContractAddress` from `eth_getTransactionReceipt.contractAddress` |
| Count contracts deployed | **RPC-CAPABLE-BUT-NOT-IMPLEMENTED** | The data is in `NormalizedTransaction.createdContractAddress` but no signal currently counts it. Planned for the `builderActivity` future signal. |
| Contract deployments outside the scan window | **REQUIRES-INDEXER** | |

---

### 1.9 First and last activity

| Capability | Status | Notes |
|---|---|---|
| First transaction within the current scan window | **IMPLEMENTED** | `firstSeen` signal: `min(timestamp)` in snapshot |
| True first-ever transaction on chain | **REQUIRES-INDEXER** | `firstSeen` is marked `partial` when `mayBeTruncated = true`. The actual genesis transaction is not visible without full history. |
| Last activity within the current scan window | **IMPLEMENTED** | `lastSeen` signal: `max(timestamp)` in snapshot |
| True last activity (same as latest block if wallet transacted recently) | **IMPLEMENTED** for recent wallets | If a wallet's most recent transaction is within the scan window, `lastSeen` is accurate. |

---

### 1.10 Active days over arbitrary historical periods

| Capability | Status | Notes |
|---|---|---|
| Active days within the scan window | **IMPLEMENTED** | `activeDays` signal: `count(distinct UTC calendar days)` for outgoing transactions in snapshot |
| Active days in a named period (e.g. "last 90 days", "last 12 months") | **RPC-CAPABLE-BUT-NOT-IMPLEMENTED** | Calculable if the scan window is adjusted to cover the target period. Not yet parameterized per request. |
| Active days over the wallet's full lifetime | **REQUIRES-INDEXER** | Requires full history. Marked `partial` when `mayBeTruncated = true`. |
| Gaps in activity (dormant periods) | **RPC-CAPABLE-BUT-NOT-IMPLEMENTED** | Derivable from sorted timestamps within the snapshot. Not currently calculated. |

---

## 2. Application Recognition Capability

### 2.1 What the application registry handles independently

The application registry operates entirely on normalized contract addresses. It requires no blockchain reads at query time. It can answer:

- Is this contract address in a recognized application? (`resolveContract`)
- What application does this address belong to? (`ApplicationEntry.application`)
- What category is that application? (`application.categoryId`)
- Are there multiple contracts for the same application? (yes: each `ApplicationContract` has an `applicationId`)
- Is the application verified? (`application.isVerified`, `contract.isVerified`)

**These capabilities are fully registry-driven and do not require indexing.**

### 2.2 What requires additional indexed data

| Requirement | Why it requires indexed data |
|---|---|
| Knowing which contracts a wallet has interacted with over full history | ArcRpcProvider sees only the scan window. A wallet that used Circle CCTP 18 months ago but not recently will not appear as a CCTP user. |
| Application-specific activity counts (e.g. "how many CCTP transfers") | Requires decoding function selectors or event logs per application, not just presence of interaction. |
| Time-series of application usage (e.g. "used Gateway in Q1 2026") | Requires timestamped full history per application. |
| Discovering new applications by observing what contracts wallets call | Requires observing the full contract call graph across all wallets, not one-at-a-time RPC queries. |

### 2.3 Registry completeness (Phase 4)

**Current registry:** 9 applications, 17 contracts (Arc Testnet).

| Application | Category | Contracts | Source |
|---|---|---|---|
| Arc USDC | infrastructure | 1 (USDC ERC-20 predeploy) | onchain-facts registry |
| Arc EURC | infrastructure | 1 (EURC token) | docs.arc.io + onchain-verified (symbol()="EURC") |
| Hashnote USYC | defi | 1 (USYC token) | docs.arc.io + onchain-verified (symbol()="USYC") |
| Circle CCTP | bridge | 5 (TokenMessengerV2, MessageTransmitterV2, TokenMinterV2, MessageV2, BridgingKitContract) | onchain-facts registry |
| Circle Gateway | bridge | 2 (GatewayWallet, GatewayMinter) | onchain-facts registry |
| Circle StableFX | defi | 1 (FxEscrow) | docs.arc.io |
| Arc Transaction Extensions | infrastructure | 2 (Memo, Multicall3From) | docs.arc.io |
| Arc Agent Registry (ERC-8004) | identity | 3 (IdentityRegistry, ReputationRegistry, ValidationRegistry) | agent-standards skill + onchain-verified (name()="AgentIdentity", getClients(), getAgentValidations()) |
| Arc Agentic Commerce (ERC-8183) | identity | 1 (AgenticCommerce) | agent-standards skill + onchain-verified (getJob() returned live job data) |

**Provenance fields:** Every `ApplicationContract` entry now carries `sourceType` (one of `official-docs`, `onchain-facts`, `onchain-verified`, `team-confirmation`, `unverified`) and `sourceRef` (a human-readable reference to the source). All Phase 4 entries are `isVerified: true`. No unverified candidates were added.

**Address bug fix:** The `circle-cctp` entry for `MessageTransmitterV2` had a pre-existing typo in the original seed data (only 39 hex chars). Corrected to the 40-char address from `onchain-facts.ts` in Phase 4.

**What remains unrecognized:** Any wallet interaction with an unregistered application is counted in `uniqueContracts` but does NOT contribute to `uniqueApplications`. Categories with zero coverage: payments, nft, gaming, dao, and any DeFi/DEX protocol that does not yet have verified Arc Testnet addresses in official documentation. This is correct behavior — the alternative (inventing registry entries) would be worse.

**What changed for signals:** A wallet that interacted with USDC + CCTP + Gateway can now score `uniqueApplications = 3`. `ARC_MULTI_APP_USER` is now meaningfully attainable. `applicationDiversity` is no longer systematically near-zero for users who interacted with multiple Circle infrastructure contracts.

---

## 3. Signal-by-Signal Audit

### `firstSeen`
- **Required raw data:** Transaction timestamps (block headers)
- **ArcRpcProvider supplies it:** Yes, within the scan window
- **Historical requirement:** Full history required for accuracy
- **Current limitation:** Reports earliest timestamp in snapshot only. When `mayBeTruncated = true`, the true first transaction may be earlier. Signal is marked `partial` in this case.
- **Indexer required for accuracy:** Yes, for wallets active before the scan window

### `lastSeen`
- **Required raw data:** Transaction timestamps
- **ArcRpcProvider supplies it:** Yes
- **Historical requirement:** Only recent history needed (if the wallet has been active recently)
- **Current limitation:** Accurate for recently active wallets. May be stale for dormant wallets.
- **Indexer required for accuracy:** No, for recently active wallets. Yes, for wallets that have been dormant longer than the scan window.

### `activeDays`
- **Required raw data:** Outgoing transaction timestamps
- **ArcRpcProvider supplies it:** Yes, within the scan window
- **Historical requirement:** Full history for complete count
- **Current limitation:** Counts only days within the scan window. Signal is marked `partial` when `mayBeTruncated = true`.
- **Indexer required for accuracy:** Yes, for total lifetime active days

### `uniqueContracts`
- **Required raw data:** `contractAddressesInteracted` (to-addresses on outgoing transactions with calldata)
- **ArcRpcProvider supplies it:** Yes, within the scan window
- **Historical requirement:** Full history for complete count
- **Current limitation:** Contracts interacted with outside the scan window are missed. Signal is marked `partial` when `mayBeTruncated = true`.
- **Indexer required for accuracy:** Yes, for lifetime unique contracts

### `uniqueApplications`
- **Required raw data:** `contractAddressesInteracted` + application registry
- **ArcRpcProvider supplies it:** Yes (addresses), registry supplies recognition
- **Historical requirement:** Full history + complete registry for accuracy
- **Current limitation:** Two compounding gaps: (1) scan-window truncation misses older interactions; (2) incomplete registry undercounts recognized applications even within the window. Both gaps cause undercounting — they do not cause overcounting.
- **Indexer required for accuracy:** Yes (for full history)

### `transactionCount`
- **Required raw data:** `eth_getTransactionCount(address, "latest")` — the account nonce. Also `transactions[]` for the snapshot count.
- **ArcRpcProvider supplies it:** Yes. The nonce is fetched in Step 1; the snapshot transaction list comes from Steps 3–7.
- **Historical requirement:** The COUNT is now accurate without an indexer. The per-transaction DETAIL (timestamps, recipients, contracts) still requires an indexer for full history.

**Three-case behavior (implemented in Phase 3B):**

| Case | Condition | Signal value | Status |
|---|---|---|---|
| A | `mayBeTruncated === false` | Snapshot outgoing count | `available` |
| B | `mayBeTruncated === true` AND `totalOutgoingTransactionCount` is set | Account nonce (authoritative lifetime count) | `partial` |
| C | `mayBeTruncated === true` AND `totalOutgoingTransactionCount` is undefined | Snapshot outgoing count (lower bound) | `partial` |

**Critical distinction:**
- The account nonce (Case B) tells us **how many** outgoing transactions exist in the wallet's full lifetime.
- It does NOT tell us **when** those transactions happened, **what** contracts they called, **how much** USDC they moved, or **which** applications were involved.
- All per-transaction signals (`firstSeen`, `activeDays`, `uniqueContracts`, `uniqueApplications`, `economicActivity`) remain window-limited and are NOT improved by the nonce. Only `transactionCount` uses it.

**Status rationale (Case B):** The count value is accurate and sourced from authoritative account state. However, the signal is marked `partial` (not `available`) because "transaction count" in context implies some ability to reason about the transactions themselves — and the individual transaction records are still limited to the snapshot window. A consumer of the `partial` signal sees an accurate lifetime count; the `confidenceNote` explicitly flags that per-transaction detail remains window-limited.

- **Indexer required for accuracy:** No longer required for the count itself. Still required for full per-transaction history.

**Phase 3B change:** Resolves the P1 gap. The `transactionCount` signal previously reported the snapshot count (a systematic undercount for old wallets). It now reports the nonce for Case B wallets, making the signal dramatically more accurate for experienced wallets even without an indexer.

### `economicActivity`
- **Required raw data:** (1) `valueWei` on outgoing succeeded transactions (native gas-token value, 18-decimal on Arc); (2) ERC-20 USDC Transfer events where the wallet is the sender.
- **ArcRpcProvider supplies it:** Yes, within the scan window. **As of Phase 3A, both components are captured.**
- **Historical requirement:** Full history for total.
- **Current limitation:** Scan window only. ERC-20 Transfer events outside the 10,000-block window are not decoded. Signal is marked `partial` when `mayBeTruncated = true`.
- **Signal value format (Phase 3A):** JSON string `{"nativeValueWei":"<bigint>","usdcErc20Raw":"<bigint>"}`. Two separate BigInt amounts because Arc native (18-decimal) and ERC-20 USDC (6-decimal) use different decimal scales and must NOT be summed directly.
- **Semantic definition:** Outgoing USDC economic activity only. Incoming transfers (where `transfer.to === walletAddress`) are decoded but not included in this signal's sum. The signal tracks what the wallet sent, not what it received.
- **Double-counting prevention:** Native value and ERC-20 amounts represent the same USDC pool but use different decimal views. They are kept separate and never summed. A transaction that sends native wei typically has no USDC Transfer event; a USDC `transfer()` call has `msg.value = 0`. In the unusual case where both are non-zero, both components are reported separately.
- **Indexer required for accuracy:** Yes, for full historical totals. ERC-20 log decoding within the window is now implemented.

**Phase 3A resolves the ERC-20 gap that was the most significant accuracy issue in Phase 1.** Wallets that move USDC via ERC-20 `transfer()` now have those amounts decoded and available in `usdcErc20Raw`. The remaining accuracy gap is the 10,000-block window limitation, which affects all historical signals equally.

### `usdcReceived` (added Phase 4.1)
- **Required raw data:** ERC-20 USDC Transfer events where `transfer.to === walletAddress` and `tx.succeeded === true`.
- **ArcRpcProvider supplies it:** Yes, within the scan window. ERC-20 Transfer log decoding implemented in Phase 3A.
- **Historical requirement:** Full history for lifetime totals.
- **Current limitation:** Scan window only. USDC transfers received before the 10,000-block window are not captured. Signal is marked `partial` when `mayBeTruncated = true`.
- **Signal value format:** Decimal string (serialized BigInt). Raw 6-decimal integer. A value of `'5000000'` represents 5.000000 USDC. No decimal conversion is performed at the signal layer.
- **Semantic definition:** **Incoming USDC only.** Counts `transfer.amountRaw` for all `DecodedErc20Transfer` entries where `transfer.to === activity.address` (lowercase) AND `transfer.tokenAddress === ARC_USDC_CONTRACT` AND `tx.succeeded === true`. Outgoing USDC (where `transfer.from === walletAddress`) is NOT included — that is tracked by `economicActivity.usdcErc20Raw`.
- **No double-counting with `economicActivity`:** `economicActivity` sums `transfer.from === walletAddress` (outgoing). `usdcReceived` sums `transfer.to === walletAddress` (incoming). These are mutually exclusive conditions. A transfer cannot simultaneously have the wallet as both sender and recipient.
- **Semantic note:** `usdcReceived` is an observable activity fact. It does NOT indicate trustworthiness, wealth, earning power, importance, quality, reputation, or social standing. It measures how much USDC arrived at this address via ERC-20 Transfer events during the observation period.
- **Indexer required for accuracy:** Yes, for full historical totals.
- **`valueUnit`:** `'bigint_usdc_raw_6dec_string'` — a decimal string representation of a BigInt at USDC's 6-decimal precision. Consumers must not parse this as a float.

### `applicationDiversity`
- **Required raw data:** `contractAddressesInteracted` + application registry
- **ArcRpcProvider supplies it:** Yes (addresses), registry supplies recognition
- **Historical requirement:** Same as `uniqueContracts` and `uniqueApplications`
- **Current limitation:** Ratio is over `uniqueRecognizedApps / uniqueContracts`. Both numerator and denominator are truncated by the scan window. The sparse registry also deflates the ratio. Signal is marked `partial` when truncated.
- **Indexer required for accuracy:** Yes

### `activityConsistency`
- **Required raw data:** Timestamps of outgoing transactions (sorted)
- **ArcRpcProvider supplies it:** Yes, within the scan window
- **Historical requirement:** Reliable consistency requires a long window (months, not days). A 10,000-block window on Arc covers approximately a short period and will typically contain too few transactions for a meaningful CV.
- **Current limitation:** Marked `partial` when fewer than 5 transactions or when `mayBeTruncated = true`. The CV calculation is mathematically correct but the sample window is likely too small for most wallets. This signal is the most interpretation-sensitive: a high CV in a small window is meaningless.
- **Indexer required for accuracy:** Yes. Meaningful consistency analysis requires months of history with at least 20–30 data points.

### `ecosystemBreadth` (future)
- **Required raw data:** Interactions per recognized application category, across full history
- **ArcRpcProvider supplies it:** No
- **Current limitation:** Not implemented. Requires: (1) full-history indexing; (2) richer registry with more applications per category; (3) a defined composite formula.
- **Indexer required:** Yes

### `builderActivity` (future)
- **Required raw data:** Contract creation transactions across full history; optionally contract verification data
- **ArcRpcProvider supplies it:** Partially — `isContractCreation` and `createdContractAddress` are captured within the scan window. Full history requires an indexer.
- **Current limitation:** Not implemented as a signal. `isContractCreation` data is present in `NormalizedTransaction`.
- **Indexer required:** Yes for lifetime builder activity

### `paymentActivity` (future)
- **Required raw data:** ERC-20 Transfer event logs, decoded with token address and amount; application registry categorization for payment apps
- **ArcRpcProvider supplies it:** No (does not decode log data)
- **Current limitation:** Not implemented. Requires log data decoding and expanded registry.
- **Indexer required:** Yes for full history; log decoding needed even in window

### `liquidityActivity` (future)
- **Required raw data:** Interactions with recognized DeFi/liquidity protocol contracts, including specific function calls (deposit, withdraw, stake, unstake)
- **ArcRpcProvider supplies it:** No (does not decode function selectors)
- **Current limitation:** Not implemented. Requires function selector decoding and expanded registry.
- **Indexer required:** Yes

---

## 4. Future Reputation Requirements (Data Only — No Scoring)

This section documents the raw data that would eventually be required to support richer signals. It does not define a scoring formula and does not implement anything.

**Distinction maintained throughout:**
- Observable fact = directly readable from the chain
- Derived measurement = computed from facts by an algorithm
- Interpretation = a contextual judgment that goes beyond the data

### Ecosystem longevity
- **Observable facts needed:** First transaction timestamp (chain-true, not snapshot), all transaction timestamps over full history
- **Derived measurement:** Wallet age in days; activity span (lastSeen - firstSeen); active months count
- **Not yet observable:** Arc network genesis date and first transaction date require a full block 0 → current scan
- **Provider requirement:** Full-history transaction enumeration

### Ecosystem breadth
- **Observable facts needed:** Set of all contract addresses interacted with over full history; category membership of each application
- **Derived measurement:** Count of distinct application categories interacted with
- **Not yet observable:** Registry is too sparse. Breadth is meaningless if most interactions map to "unknown".
- **Provider requirement:** Full-history interaction set + significantly expanded registry

### Activity consistency
- **Observable facts needed:** All outgoing transaction timestamps over full history (minimum 6–12 months)
- **Derived measurement:** Statistical regularity metrics (CV, IQR, Gini coefficient of gaps)
- **Not yet observable:** 10,000-block snapshot is insufficient sample size for most wallets
- **Provider requirement:** Full history with timestamp precision

### Application diversity
- **Observable facts needed:** Count of distinct recognized applications, count of distinct categories, full interaction history
- **Derived measurement:** Ratio of categories to total applications used; entropy of application usage distribution
- **Provider requirement:** Full history + expanded registry

### Meaningful economic participation
- **Observable facts needed:** ERC-20 Transfer event logs with decoded amounts (token address, from, to, amount); function selectors decoded to identify payment vs. contract-management calls
- **Derived measurement:** Total USDC transferred; number of distinct counterparties; payment vs. contract-call ratio
- **Important distinction:** Volume and counterparty count are observable facts. Whether a transaction is "meaningful" is an interpretation and must not be automated.
- **Provider requirement:** Full history, log decoding, ABI decoding

### Builder activity
- **Observable facts needed:** Contract creation transactions over full history; deployed contract addresses; optionally, whether those contracts have been verified
- **Derived measurement:** Count of contracts deployed; age of oldest deployed contract; whether deployed contracts have been called by other wallets
- **Provider requirement:** Full history; contract verification API (separate from chain data)

### Payment activity
- **Observable facts needed:** ERC-20 Transfer logs for USDC, decoded (from, to, amount, block timestamp); application registry must categorize payment protocols
- **Derived measurement:** Count of USDC transfer transactions; distinct recipient count; total USDC sent
- **Important distinction:** A USDC transfer is an observable fact. Whether it is a "payment" depends on the recipient context (application registry category), not on the amount or frequency.
- **Provider requirement:** Full ERC-20 event history with decoded log data

### Liquidity participation
- **Observable facts needed:** Interactions with DeFi protocol contracts (deposit/withdraw/stake/unstake function selectors); LP token transfers; reward claim events
- **Derived measurement:** Active DeFi protocols count; liquidity events count
- **Provider requirement:** Full history; function selector decoding; expanded registry with DeFi protocol contracts

### Project-issued credentials
- **Observable facts needed:** Defined by each issuing project. May include: NFT ownership, token holdings, specific contract interactions, off-chain attestation
- **Data model:** `Credential.issuerType = 'project'`; issuer provides the eligibility rule; Arc Rep evaluates it against normalized data or accepts an off-chain attestation
- **Provider requirement:** Depends on the project's criterion. May require cross-contract reads, NFT ownership queries, or off-chain data bridges.
- **Privacy consideration:** A project may want to verify eligibility without receiving the full wallet history. This requires a selective disclosure or ZK-proof mechanism (Phase 2+).

### Sybil analysis
- **Observable facts needed:** Graph of wallet-to-wallet transfers; timing correlations across wallets; shared contract creation patterns; funded-from relationships
- **Important distinction:** Sybil analysis is a statistical inference about wallet behavior relative to other wallets. It is NOT an individual reputation signal. It must not be presented as a fact about an individual wallet.
- **Provider requirement:** Cross-wallet graph data; full history for all wallets in a cohort
- **Architecture note:** Sybil analysis belongs in a separate analytical layer, not in the per-wallet signal engine. A sybil flag on a wallet profile must never be treated as proof of Sybil behavior — it is a probabilistic inference.

---

## 5. Minimum Provider Contract (IActivityProvider Extension)

This section defines the minimum normalized activity schema that any future provider (Goldsky, subgraph, internal indexer, etc.) must implement to unlock the full planned signal set.

This is not a new interface yet. It is the minimum specification that a future `IHistoricalActivityProvider` must satisfy. It remains vendor-neutral.

### 5.1 Required capabilities

Any future provider implementation MUST be able to supply:

```typescript
/**
 * Minimum contract for a full-history activity provider.
 * This extends IActivityProvider's per-snapshot model with complete history.
 */

interface HistoricalNormalizedActivity extends NormalizedActivity {
  // === Full history assurance ===
  
  /**
   * True ONLY when the provider has indexed the wallet's full history
   * from block 0 (or wallet genesis) to the current block.
   * false means the snapshot is partial — do not override mayBeTruncated.
   */
  isFullHistory: boolean;

  /**
   * The true first transaction timestamp, if the provider has full history.
   * Undefined when isFullHistory = false.
   */
  trueFirstTransactionTimestamp?: number;

  /**
   * The true total outgoing transaction count from genesis.
   * May equal NormalizedActivity.transactions.length when isFullHistory = true.
   * Providers MUST NOT set this unless isFullHistory = true.
   */
  trueTransactionCount?: number;

  // === ERC-20 transfer events (decoded) ===

  /**
   * Decoded ERC-20 Transfer events involving this wallet.
   * Each entry is a single Transfer event.
   */
  erc20Transfers: NormalizedErc20Transfer[];

  // === Application-level activity ===

  /**
   * For each recognized application, a summary of this wallet's interactions.
   * Keyed by applicationId from the registry.
   * Populated by the provider after registry resolution.
   */
  applicationActivity: Map<string, ApplicationActivitySummary>;
}

interface NormalizedErc20Transfer {
  transactionHash: string;
  blockNumber: bigint;
  timestamp: number;            // Unix seconds
  tokenAddress: string;         // lowercase
  from: string;                 // lowercase
  to: string;                   // lowercase
  amount: bigint;               // Raw token units (no decimal adjustment)
  tokenDecimals?: number;       // If known at index time
  tokenSymbol?: string;         // If known at index time
  isOutgoing: boolean;
  succeeded: boolean;
}

interface ApplicationActivitySummary {
  applicationId: string;
  firstInteraction: number;     // Unix seconds
  lastInteraction: number;      // Unix seconds
  interactionCount: number;     // Distinct outgoing transactions to this application
  contractsUsed: string[];      // Which contract addresses within the application
}
```

### 5.2 Minimum indexer capabilities

A compliant historical provider implementation MUST be able to:

1. **Enumerate all transactions** ever sent by a wallet (from = wallet address), from block 0 to current
2. **Enumerate all ERC-20 Transfer events** where the wallet is sender or recipient, across all blocks
3. **Decode** Transfer event log data (token address, from, to, amount)
4. **Return block timestamps** for every transaction (not just sampled blocks)
5. **Paginate** results when a wallet has more than a configurable limit of transactions
6. **Set `isFullHistory: true`** only when the above is confirmed for the full chain history
7. **Surface data quality notes** when any of the above is approximate or range-limited

A compliant historical provider MUST NOT:

- Set `isFullHistory: true` when using a block-range scan
- Return derived signals (those belong in the SignalEngine)
- Classify transactions as "meaningful" or "important" (that is an interpretation)
- Modify the `mayBeTruncated` flag to `false` unless the full history requirement above is satisfied

### 5.3 Vendor-neutral note

This specification deliberately avoids naming Goldsky, The Graph, Dune, or any other indexer. Any system that can satisfy the interface above — whether a managed indexer, a self-hosted subgraph, an Arc-native explorer API, or a custom event-log database — qualifies as a compliant provider.

The `IActivityProvider` interface requires no changes to support this. A new implementation class (e.g. `GoldskyProvider`, `SubgraphProvider`) would implement `IActivityProvider` and additionally expose the `HistoricalNormalizedActivity` shape. The domain layer (SignalEngine, CredentialService, ProfileService) receives only `NormalizedActivity` and operates identically regardless of provider.

---

## 6. Data Quality: The 10,000-Block Limitation

### What 10,000 blocks means on Arc

Arc targets approximately 1-second block times. At 1 block/second, 10,000 blocks = approximately **2.8 hours** of history. At a more conservative 2 seconds/block, it is approximately **5.5 hours**.

**This is a very short window.** A wallet that last transacted more than a few hours ago may have zero transactions in the current snapshot even if it has significant historical activity.

### Which signals the window limitation directly invalidates

| Signal | Impact when wallet activity exceeds window |
|---|---|
| `firstSeen` | Returns the earliest timestamp in the window, NOT the wallet's true first transaction. **Marked `partial`, not `available`**, but the gap between snapshot-first and true-first could be months or years. |
| `lastSeen` | Accurate only if the wallet has been active within the window. A dormant wallet may show no `lastSeen` at all. |
| `activeDays` | Counts only days within the window. A wallet active every day for a year but dormant for the last 3 hours shows `activeDays = 0`. **Marked `partial`** but this understates severity. |
| `uniqueContracts` | Counts only contracts within the window. **Marked `partial`**. |
| `uniqueApplications` | Counts only recognized applications within the window. **Marked `partial`**. |
| `transactionCount` | Counts only transactions within the window. `eth_getTransactionCount` (nonce) tells us the true count, but individual transactions cannot be enumerated. **Marked `partial`**. The nonce is the ground truth for total count even without full history. |
| `economicActivity` | Underestimates total economic activity even for wallets whose history fits in the window, due to the ERC-20 decoding gap. **Marked `partial` when truncated**. |
| `applicationDiversity` | Numerator (recognized apps) and denominator (total contracts) both truncated. Ratio may be meaningless. **Marked `partial`**. |
| `activityConsistency` | A 2.8–5.5 hour window almost never contains enough activity for a statistically meaningful CV. **Marked `partial` when < 5 transactions or when truncated**. |

### What the window does NOT invalidate

- `lastSeen` for a wallet that transacted within the window (accurate)
- Address validation (100% accurate, no window dependency)
- Registry lookups for contracts seen in the window (accurate)
- Credential evaluation correctness (evaluates against whatever signals are available, with honest status)

### Danger zone: zero-activity wallets vs. old wallets

The current architecture correctly distinguishes:
- `eth_getTransactionCount = 0` → the wallet has genuinely never sent a transaction
- `eth_getTransactionCount > 0` but `transactions captured = 0` → the wallet has sent transactions, but they are all outside the scan window

`mayBeTruncated = true` is set in both cases where `txCount > 0 && transactions.length < txCount` OR when `latestBlock > blockScanWindow`. The `dataQualityNotes` array explains which case applies.

**Critical rule enforced by design:** A wallet with `transactionCount = 0` in the signal AND `mayBeTruncated = true` must never be presented as "inactive." The zero is a snapshot artifact, not a fact about the wallet.

### Honest signal status propagation

The current architecture propagates limitations as follows:

```
mayBeTruncated = true
  → firstSeen.status = 'partial'
  → activeDays.status = 'partial'
  → uniqueContracts.status = 'partial'
  → uniqueApplications.status = 'partial'
  → transactionCount.status = 'partial'
  → economicActivity.status = 'partial'
  → applicationDiversity.status = 'partial'
  → activityConsistency.status = 'partial'

No transactions with valid timestamps
  → firstSeen.status = 'unavailable'
  → lastSeen.status = 'unavailable'

Fewer than 2 outgoing transactions
  → activityConsistency.status = 'unavailable'

Future signals
  → status = 'future'
```

This propagation is correct. A consumer that trusts only `available` signals will get honest data. A consumer that uses `partial` signals must understand the window limitation.

---

## 7. Testing Requirements

### What is now tested (Phase 1 + Phase 3A)

All previously listed test categories were implemented in Phase 1, Phase 3A, Phase 3B, Phase 4, 4.1, 5A/5B, and 5C. The full suite stands at **282 tests, 0 failures** across 12 test files.

**Phase 5C additions (tests/data/goldsky-provider.test.ts, 34 tests):**
- Interface conformance: name property, IActivityProvider shape, structural assignability
- Address validation: 5 invalid-address cases with error message content checked
- TOPICS_FORMAT guard: `getActivity` throws when format is `'unknown'` and transfers exist
- Normalization logic: BigInt precision for large values, zero value, timestamp parsing, receipt_status mapping, address lowercasing, contract-creation detection, hasInputData detection (10 tests)
- USDC constant: shared with `ArcRpcProvider` (no duplication), lowercase check
- Provider name: correct value, distinct from `ArcRpcProvider`
- `mayBeTruncated` semantics: false when synced, true when lagged, false when chain head unknown
- IActivityProvider contract: getActivity() method exists, name property exists, Promise return, error wrapping
- Setup blockers: `TOPICS_FORMAT === 'unknown'` confirmed, three-step human checklist documented
- Mock pool infrastructure: ready for Phase 5C integration tests

**Phase 5B additions (tests/data/eip7708-system-emitter.test.ts, 22 tests):**
- EIP-7708 constants, log-level filter (8 tests), economicActivity no double-count (4), usdcReceived no double-count (3), non-USDC preservation (3)

**Phase 4.1 additions (tests/domain/usdc-received.test.ts, 35 tests):**
- Core counting: empty wallet → "0" and `available`; incoming transfer counted; outgoing NOT counted; failed transfer NOT counted; failed tx with incoming transfer NOT counted (5 tests)
- Token address filtering: non-USDC token ignored; mixed USDC + non-USDC in same tx; exact `0x3600...0000` contract address check (3 tests)
- Summation: multiple incoming transfers in one tx; across multiple transactions; mix of incoming/outgoing/failed (3 tests)
- Incoming transfers on outgoing transactions: change-return pattern counted (1 test)
- Truncation/data quality: `available` when not truncated; `partial` when truncated; `confidenceNote` mentions truncation; non-zero value still reported when partial; zero value with truncation is `partial` not `available` (5 tests)
- No double-counting with `economicActivity`: 4 tests proving the two signals count disjoint sets (incoming vs. outgoing)
- Large uint256 precision: realistic amount; max uint256 (2 tests)
- Signal metadata: key, label, description, source, calculationDefinition, valueUnit, value type (7 tests)
- No reputation language: description contains "observable"; label has no reputation terms; key is not a reputation key (3 tests)

**Phase 4 additions (tests/domain/registry-integrity.test.ts, 29 tests):**
- Address normalization: every contract address is lowercase, 0x-prefixed, 40 hex chars (1 test that caught the existing CCTP typo)
- No duplicate contract addresses (1 test)
- Application and category reference integrity (2 tests)
- Provenance completeness: every contract has sourceType from allowed set, non-empty sourceRef, verified contracts have sourceType !== 'unverified' (3 tests)
- Resolved RegistryEntry carries sourceType and sourceRef (1 test)
- Registry counts: 9 applications, 17 contracts, 9 categories, all isVerified (5 tests)
- Case-insensitive lookup for all 17 seeded addresses (2 tests)
- Trust boundary: unknown addresses return recognized: false (2 tests)
- Many-to-one: CCTP (5 contracts → 1 app), ERC-8004 (3 contracts → 1 app), Gateway (2 → 1), TxExtensions (2 → 1) (4 tests)
- Signal integration: `uniqueApplications` correctly counts distinct apps, diversity ratio, unknown contract not promoted (7 tests)

**Phase 3B additions (tests/domain/transaction-count.test.ts, 24 tests):**
- Case A (non-truncated): snapshot count returned, `available`, nonce ignored when non-truncated (4 tests)
- Case B (truncated + nonce): nonce used as value, still `partial`, handles zero-snapshot correctly, confidenceNote and calculationDefinition mention `eth_getTransactionCount`, large nonce, nonce of 1 (7 tests)
- Case C (truncated + no nonce): fallback to snapshot count, `partial`, confidenceNote mentions unavailable nonce (3 tests)
- Credential impact: `ARC_ACTIVE_WALLET` earned via nonce >= threshold with zero snapshot txns, not earned when nonce below threshold, credential has partial evidence (3 tests)
- Isolation: `firstSeen`, `activeDays`, `uniqueContracts`, `SignalEngine` pass-through all unaffected by nonce (4 tests)
- Regression: zero-captured truncated wallet still `partial`, genuine zero-activity wallet still `available`, old wallet reports nonce not false zero (3 tests)

**Phase 3A additions (tests/data/erc20-decoding.test.ts):**
- `decodeErc20TransferLog` happy path: correct token address, from, to, amountRaw (3 tests)
- Large uint256 without precision loss (1 test)
- Realistic USDC amount: 100 USDC raw = 100_000_000 (1 test)
- Multiple Transfer events in one transaction (2 tests)
- No Transfer events → empty array (1 test)
- Malformed logs: no topics, only topic0, two topics, wrong topic0, empty data, null data, null log, short from-topic, short to-topic (9 tests)

**Phase 3A additions (tests/domain/data-quality.test.ts section 5):**
- Zero breakdown for empty wallet (1 test)
- Native value only, no ERC-20 (1 test)
- ERC-20 USDC transfer with msg.value = 0 (1 test — formerly the "ERC-20 gap" test)
- Multiple ERC-20 USDC transfers summed (1 test)
- Incoming ERC-20 transfer not counted (1 test)
- Non-USDC ERC-20 transfer ignored (1 test)
- Large uint256 USDC amount (1 test)
- Failed transaction not counted (1 test)
- Truncated provider data → partial status (1 test)
- Both native value AND ERC-20 transfer in one tx → reported separately, not summed (1 test)

### What tests still need to be written (future phases)

1. **Nonce-based transactionCount:** When `eth_getTransactionCount` (nonce) is used as the true count value, verify it is not confused with the snapshot transaction list length.
2. **Full-history provider contract:** When an `isFullHistory = true` provider is swapped in, verify all signals return `available` (not `partial`) and `firstSeen` reflects the true chain genesis.
3. **Incoming USDC signal (if added):** Verify `transfer.to === walletAddress` is correctly identified and that it is not counted in outgoing `economicActivity`.
4. **Non-USDC ERC-20 future signal:** When a signal for other ERC-20 tokens is added, verify it does not accidentally include USDC amounts that are already in `usdcErc20Raw`.

---

## Summary: Priority gaps after Phase 3A

| Priority | Gap | Impact | Status |
|---|---|---|---|
| **P0** | 10,000-block window too short for meaningful historical signals | All historical signals are partial; `firstSeen` may be months off | **Open** — requires historical indexer via IActivityProvider implementation |
| ~~P0~~ | ~~ERC-20 transfer amounts not decoded~~ | ~~`economicActivity` is near-zero for most USDC users~~ | **RESOLVED in Phase 3A** — `DecodedErc20Transfer` + `usdcErc20Raw` field |
| ~~P1~~ | ~~`transactionCount` uses snapshot count, not nonce~~ | ~~Signal understates activity for old wallets~~ | **RESOLVED in Phase 3B** — Case B uses nonce as authoritative count; status remains `partial` because per-transaction detail is still window-limited |
| ~~P1~~ | ~~Application registry too sparse~~ | ~~`uniqueApplications`, `applicationDiversity` systematically undercount~~ | **RESOLVED in Phase 4** — 9 apps / 17 contracts; CCTP address bug fixed; provenance fields added. Gaps remain in defi, payments, nft, gaming, dao. |
| **P2** | `activityConsistency` window too small | CV is statistically meaningless in short windows | **Open** — indexer + minimum sample-size gate before reporting |
| ~~P2~~ | ~~Incoming USDC ERC-20 transfers not signaled~~ | ~~Decoded but not exposed; no `usdcReceived` signal~~ | **RESOLVED in Phase 4.1** — `usdcReceived` signal added; sums `transfer.to === walletAddress` for USDC; still partial when window-limited |
| **P3** | Contract function selector not decoded | `builderActivity`, `liquidityActivity` cannot be implemented | **Open** — requires ABI decoding or function-selector registry |
