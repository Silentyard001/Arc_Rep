# Arc Rep — Phase 5: Historical Data Provider Architecture Audit

**Status:** Implementation-ready specification. Nothing in this document has been implemented.
**Date produced:** 2026-09-23
**Scope:** Research and architecture only. No code changes. No new files in `server/`.

---

## 1. CURRENT PROVIDER ARCHITECTURE

### The abstraction layer (confirmed from source)

```
ProfileService
    ↓
IActivityProvider  (server/data/IActivityProvider.ts)
    ↓
ArcRpcProvider     (server/data/ArcRpcProvider.ts)
    ↓
Arc Testnet RPC   (https://rpc.testnet.arc.io or RPC proxy)
```

### What `IActivityProvider` currently requires

The interface is two members:

```typescript
interface IActivityProvider {
  readonly name: string;
  getActivity(address: string, options?: ActivityProviderOptions): Promise<NormalizedActivity>;
}
```

`getActivity()` receives a validated EVM address, and must return a `NormalizedActivity` object. It throws `ActivityProviderError` on invalid address or provider failure. Nothing else — no chain-specific methods, no pagination handle, no streaming interface. The interface is already fully vendor-neutral.

### What `NormalizedActivity` currently requires (every field)

| Field | Type | Required | Set by ArcRpcProvider |
|---|---|---|---|
| `address` | `string` (lowercase) | yes | `normalizeAddress(address)` |
| `chainId` | `number` | yes | `this.chainId` |
| `transactions` | `NormalizedTransaction[]` | yes | Step 7 normalization |
| `contractAddressesInteracted` | `Set<string>` | yes | Step 7 normalization |
| `earliestTimestamp` | `number?` | no | `min(tx.timestamp)` |
| `latestTimestamp` | `number?` | no | `max(tx.timestamp)` |
| `totalFetched` | `number` | yes | `transactions.length` |
| `mayBeTruncated` | `boolean` | yes | `txCount > captured OR latestBlock > window` |
| `fetchedAt` | `string` (ISO) | yes | `new Date().toISOString()` |
| `providerName` | `string` | yes | `'ArcRpcProvider'` |
| `totalOutgoingTransactionCount` | `number?` | no | `eth_getTransactionCount` result |
| `dataQualityNotes` | `string[]` | yes | accumulated notes |

### What `NormalizedTransaction` currently requires (every field)

| Field | Type | Required | Set by ArcRpcProvider |
|---|---|---|---|
| `hash` | `string` | yes | `rawTx.hash` |
| `blockNumber` | `bigint` | yes | `hexToBigInt(blockNum)` |
| `timestamp` | `number` | yes | `blockTimestamps.get(blockNum) ?? 0` |
| `from` | `string` (lowercase) | yes | `normalizeAddress(rawTx.from)` |
| `to` | `string \| null` (lowercase) | yes | `rawTx.to ? normalize(rawTx.to) : null` |
| `valueWei` | `bigint` | yes | `hexToBigInt(rawTx.value)` |
| `succeeded` | `boolean` | yes | `hexToNumber(rawReceipt.status) === 1` |
| `isOutgoing` | `boolean` | yes | `from === normalizedAddr` |
| `isContractCreation` | `boolean` | yes | `!rawTx.to` |
| `hasInputData` | `boolean` | yes | `input !== '0x' && input.length > 2` |
| `createdContractAddress` | `string?` | no | `rawReceipt.contractAddress` |
| `erc20Transfers` | `DecodedErc20Transfer[]` | yes | decoded from `eth_getLogs` Step 3 |

### What `DecodedErc20Transfer` requires

| Field | Type | Source in ArcRpcProvider |
|---|---|---|
| `tokenAddress` | `string` (lowercase) | `log.address.toLowerCase()` |
| `from` | `string` (lowercase) | `topics[1]` last 40 chars |
| `to` | `string` (lowercase) | `topics[2]` last 40 chars |
| `amountRaw` | `bigint` | `BigInt(log.data)` |

### Current ArcRpcProvider limitations (confirmed, not estimated)

The provider makes 7 categories of RPC calls per request:

1. `eth_getTransactionCount` — nonce / total outgoing count
2. `eth_blockNumber` — latest block (establishes scan window)
3. `eth_getLogs` × 2 — ERC-20 Transfer events where wallet is `from`, and where wallet is `to`
4. `eth_getBlockByNumber(true)` × up to 50 — sampled blocks for outgoing tx discovery
5. `eth_getTransactionByHash` × N — full tx data for each discovered hash
6. `eth_getTransactionReceipt` × N — receipt status for each tx
7. `eth_getBlockByNumber(false)` × M — block timestamps for all tx blocks

Default scan window: **10,000 blocks** (~2.8 hours at Arc Testnet's ~1 block/second rate).

What this means for each signal:

| Signal | Limitation |
|---|---|
| `firstSeen` | Always `partial`. Window may not include wallet's genesis transaction. |
| `lastSeen` | Accurate if wallet transacted in the window. |
| `activeDays` | At most 2–3 distinct days in a 2.8-hour window. Systematically `partial`. |
| `transactionCount` | Value is the nonce (accurate count). Per-tx detail is window-limited. |
| `uniqueContracts` | Window-bounded undercount. |
| `uniqueApplications` | Window-bounded undercount. |
| `economicActivity` | Window-bounded. ERC-20 amounts outside window not captured. |
| `usdcReceived` | Window-bounded. Incoming transfers outside window not captured. |
| `activityConsistency` | Statistically meaningless on 2.8-hour sample for most wallets. |
| `applicationDiversity` | Both numerator and denominator are window-bounded. |

---

## 2. HISTORICAL DATA REQUIREMENTS

### Required for current signals (all 10 implemented signals)

| Data point | Signal(s) it feeds |
|---|---|
| Transaction hash | All signals (dedup, lookup) |
| Block number | Ordering, range filtering |
| Block timestamp (Unix seconds) | `firstSeen`, `lastSeen`, `activeDays`, `activityConsistency` |
| `from` address (lowercase) | `isOutgoing`, all outgoing-only signals |
| `to` address (lowercase, null for contract creation) | `uniqueContracts`, `uniqueApplications`, `applicationDiversity`, `economicActivity` |
| `value` / `valueWei` (native wei, bigint) | `economicActivity.nativeValueWei` |
| Receipt `status` (success/fail) | `economicActivity`, `usdcReceived`, `transactionCount` |
| `input` / calldata (non-empty = contract interaction) | `uniqueContracts`, `contractAddressesInteracted` |
| `receipt_contractAddress` (contract creation) | `contractAddressesInteracted` |
| ERC-20 Transfer event `address` (token contract) | `economicActivity.usdcErc20Raw`, `usdcReceived` |
| ERC-20 Transfer event `topics[1]` (from address) | `economicActivity.usdcErc20Raw` |
| ERC-20 Transfer event `topics[2]` (to address) | `usdcReceived` |
| ERC-20 Transfer event `data` (uint256 amount) | `economicActivity.usdcErc20Raw`, `usdcReceived` |
| Account nonce (`eth_getTransactionCount`) | `transactionCount` Case B (authoritative count) |

### Required for current signals but NOT currently obtained reliably

| Data point | Gap | Impact |
|---|---|---|
| All outgoing transactions (lifetime) | RPC scan covers only recent blocks. Discovery relies on ERC-20 logs + sampled blocks — contracts called with no ERC-20 Transfer events in unsampled blocks are invisible. | `uniqueContracts`, `applicationDiversity`, `activityConsistency` are undercounts. |
| All incoming ERC-20 Transfer events (lifetime) | Log scan covers only 10,000-block window. | `usdcReceived` is window-limited. |
| All block timestamps (lifetime) | Only fetched for blocks containing discovered transactions. | `firstSeen` is window-bounded. |

### Useful for future signals (not currently required)

| Data point | Future signal it would enable |
|---|---|
| Transaction `input` decoded (ABI selector) | `builderActivity` (contract deployments), `paymentActivity` (decoded transfer calls), `liquidityActivity` (DEX pool interactions) |
| ERC-20 Transfer events for non-USDC tokens | Multi-token economic activity signal |
| Gas used per transaction | Gas efficiency / fee payment signal |
| Contract creation bytecode hash | Builder activity — contract type fingerprinting |
| Internal traces (call stack) | Complex protocol interactions, delegate calls |
| Token balances over time | Time-weighted average balance signal |
| Cross-chain CCTP events (burn / mint) | Bridge activity signal |

### Not currently required (explicitly out of scope)

- Token prices (fiat valuation of USDC amounts)
- Social graph data (follows, connections)
- Off-chain identity data
- ZK proofs of any kind
- Governance vote data
- NFT metadata or transfer history

---

## 3. CANDIDATE PROVIDER COMPARISON

### Option A: Goldsky

**Arc Testnet support — CONFIRMED.**

From Goldsky's supported networks documentation (verified 2026-09-23):
- Arc Testnet is listed with slug `arc-testnet`
- All 4 standard EVM datasets are available: Blocks, Logs, Enriched Transactions, Traces
- No "Fast Scan" support for Arc Testnet (Fast Scan column = ✗ for Arc Testnet)
- Mainnet (Arc) status: not confirmed from public docs; only testnet listed explicitly

From Goldsky's dataset explorer (verified 2026-09-23):
- `arc_testnet.raw_logs` — confirmed live dataset
- `arc_testnet.receipt_transactions` — confirmed live dataset

**Available datasets and their schemas (Arc Testnet):**

`arc_testnet.receipt_transactions` (Enriched Transactions):
```
hash, nonce, block_hash, block_number, transaction_index,
from_address, to_address, value (decimal), gas, gas_price,
input, max_fee_per_gas, max_priority_fee_per_gas, transaction_type,
block_timestamp (long, Unix seconds), receipt_cumulative_gas_used,
receipt_gas_used, receipt_contract_address, receipt_status (long: 0/1),
receipt_effective_gas_price, receipt_root_hash, ...
```

Every `NormalizedTransaction` field maps directly:

| `NormalizedTransaction` field | Goldsky `receipt_transactions` column | Notes |
|---|---|---|
| `hash` | `hash` | Direct |
| `blockNumber` | `block_number` | Long → BigInt conversion |
| `timestamp` | `block_timestamp` | Unix seconds, already numeric |
| `from` | `from_address` | Already lowercase in Goldsky |
| `to` | `to_address` | Null for contract creation |
| `valueWei` | `value` | Decimal → BigInt (18-decimal wei on Arc) |
| `succeeded` | `receipt_status` | `1` = success, `0` = failure |
| `isOutgoing` | Derived: `from_address === walletAddress` | Simple comparison |
| `isContractCreation` | Derived: `to_address IS NULL` | Simple null check |
| `hasInputData` | Derived: `input != '0x' AND length(input) > 2` | SQL expression |
| `createdContractAddress` | `receipt_contract_address` | Null when not a creation |
| `erc20Transfers` | Populated from `arc_testnet.raw_logs` join | See below |

`arc_testnet.raw_logs` (Raw Logs):
```
id, block_number, block_hash, transaction_hash, transaction_index,
log_index, address, data, topics (string), block_timestamp
```

The `topics` field is stored as a string in Goldsky's schema — it must be split/parsed (comma-separated or JSON array, depending on Goldsky's encoding convention). The `address`, `data`, and parsed `topics` fields map directly to the `RawErc20Log` type in the existing `ArcRpcProvider`.

**Query model:** Goldsky supports three product surfaces relevant to Arc Rep:

1. **Mirror** — SQL-based pipeline that streams chain data into a developer-owned Postgres/ClickHouse database. Optimal for Arc Rep: the `HistoricalActivityProvider` queries a local Postgres view of the indexed data, not a remote API.
2. **Turbo** — More powerful pipeline, same datasets, supports multi-source joins and SQL transforms. Not required for Arc Rep's use case, but available.
3. **Subgraphs** — GraphQL API backed by WASM event handlers. Optimal for known contract events. Less suitable for wallet-centric full-history queries.

For Arc Rep, **Mirror** is the right product: it mirrors `arc_testnet.receipt_transactions` and `arc_testnet.raw_logs` (filtered to the wallet's address) into a Postgres table that the Express server queries directly, eliminating the per-request RPC round-trips.

**Pagination:** The raw Goldsky datasets do not paginate in the traditional sense — Mirror/Turbo pipelines stream all historical data from genesis and stay in sync in real time. A `HistoricalActivityProvider` that queries a local Postgres sink does standard SQL `WHERE from_address = $1 OR to_address = $1 ORDER BY block_number`, which Postgres handles natively with B-tree index.

**Historical depth:** Full chain history from genesis (block 0) to real-time. No gap.

**Latency:** Mirror pipelines maintain approximate real-time sync. From Goldsky's reliability SLA: 99.9%+ uptime. Latency between block finalization and data availability in the Postgres sink is typically seconds, not minutes. For Arc Rep's use case (profile lookup, not real-time alerting) this is more than sufficient.

**Rate limits:** Mirror pipeline queries are executed against a developer-owned Postgres database. There are no RPC rate limits. The only limits are Postgres query throughput, which is the developer's own infrastructure.

**Operational complexity:**
- One Goldsky CLI install (`npm install -g @goldsky/cli`)
- One `mirror pipeline create` command with a definition YAML file
- One Postgres instance (Goldsky-hosted or bring-your-own)
- One environment variable for the Postgres connection string
- No webhook setup required for Arc Rep

**Arc-specific EIP-7708 dual-emitter issue:**
The Arc EVM differences documentation states that Arc implements EIP-7708, which causes native USDC value transfers to emit a `Transfer` log from BOTH the ERC-20 contract (`0x3600000000000000000000000000000000000000`) AND a system emitter (`0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`).

This means a Goldsky `raw_logs` query for the Transfer event topic that does NOT filter by `address` will return **two log entries for the same native transfer event** — one from the ERC-20 address, one from the system emitter. A `GoldskyActivityProvider` must filter to `address = '0x3600000000000000000000000000000000000000'` to avoid counting each native transfer twice.

The current `ArcRpcProvider`'s `eth_getLogs` queries also use the ERC-20 Transfer topic (`0xddf252ad...`) and the wallet's address as a topic filter. Because `eth_getLogs` filters by both `address` and `topics` simultaneously, the ArcRpcProvider naturally receives only logs from contracts where the wallet appears in topics[1] or topics[2]. For native transfers where the system emitter emits the same event, the filter on `topics[1/2] = walletAddress` would return both the ERC-20 and system-emitter copies. The existing `ArcRpcProvider` does NOT currently filter out the system emitter — this is a latent double-counting bug for native USDC transfers decoded as ERC-20 events.

This must be fixed in both the current provider and designed explicitly into the `GoldskyActivityProvider`.

**Can it support wallet-centric queries efficiently?** Yes, with a Postgres index on `from_address` and a separate index on `to_address` (or a composite index on `(from_address, to_address)`), plus a GIN index on `topics` in the logs table. Standard SQL pattern:

```sql
-- All transactions involving a wallet (either direction)
SELECT * FROM arc_transactions
WHERE from_address = $1 OR to_address = $1
ORDER BY block_timestamp ASC;

-- All ERC-20 USDC transfers involving a wallet
SELECT * FROM arc_logs
WHERE address = '0x3600000000000000000000000000000000000000'
  AND topics LIKE '%' || $1 || '%';  -- simplified; use proper topic extraction
```

---

### Option B: Arc/Circle-native indexing infrastructure

**General transaction history API:** No Circle-managed general-purpose transaction history API for Arc is publicly documented as of 2026-09-23. The Circle developer platform (`developers.circle.com`) covers wallets, CCTP, Gateway, and SCP — all forward-looking APIs, not historical chain indexers.

**USDC/CCTP-specific indexing:** Circle's Smart Contract Platform (SCP) provides event monitoring via webhooks for specific contracts. This covers:
- CCTP `DepositForBurn` and `MintAndWithdraw` events
- SCP contract events for developer-deployed contracts

This is NOT suitable as a general transaction history source for Arc Rep because:
1. It covers only contracts you register — not arbitrary wallet interactions
2. It provides push-based event notification, not a queryable historical record
3. It does not cover the full `from_address` outgoing transaction history

**Arc explorer API:** The Arc block explorer (`explorer.testnet.arc.io`) is running. Standard Blockscout-compatible explorers provide a REST API that can return transaction history by address. However:
- Blockscout's rate limits for public APIs are typically restrictive (5 req/s or lower)
- The explorer API is not a guaranteed service level; it is a development tool
- Using an explorer API as a production data backend creates a fragile dependency
- The Arc explorer API was not confirmed as a supported integration path in the Arc documentation

**Verdict:** No Circle/Arc-native general transaction history API suitable for production use is currently documented. Circle SCP webhooks partially cover USDC/CCTP events but are insufficient for full wallet activity history.

---

### Option C: Wider `eth_getLogs` / RPC scan window

**Technical feasibility of expanding the scan window:**

The current `blockScanWindow` is a configurable parameter on `ArcRpcProviderConfig`. Expanding it to 100,000 or 500,000 blocks requires no code changes — only a configuration change.

At Arc Testnet's current rate of approximately 1 block/second:
- 10,000 blocks ≈ 2.8 hours (current)
- 100,000 blocks ≈ 27.8 hours (1 day)
- 500,000 blocks ≈ 5.8 days
- 1,000,000 blocks ≈ 11.6 days
- 8,000,000 blocks ≈ 92.6 days (Arc Testnet genesis range)

**Expected response size:**
The `eth_getLogs` call for a wallet with moderate activity over 500,000 blocks would return hundreds to thousands of log entries. The JSON body could be 1–20 MB. This is technically feasible for Fetch but pushes response-time into 5–30 seconds per profile request depending on network and node performance.

**RPC limitations:**
- The Arc Studio RPC proxy (`RPC_PROXY_BASE_URL`) has an unknown block-range cap. Most EVM RPC providers impose a cap of 1,000–10,000 blocks per `eth_getLogs` call. The public Arc RPC endpoint (`https://rpc.testnet.arc.io`) has an unknown cap.
- Even if the range cap is generous, a single `eth_getLogs` request over 500,000 blocks could time out or return an oversized response that requires chunking.
- The `eth_getBlockByNumber(true)` block scan in Step 4 of `ArcRpcProvider` would need to be redesigned entirely for wider windows (the current approach samples 50 blocks from the recent 500). With a 500,000-block window, sampling 50 blocks out of 500,000 captures less than 0.01% of transactions.

**Timeout risk:** A 500,000-block `eth_getLogs` call on a public RPC endpoint is likely to exceed a 30-second timeout under load. This risk is unacceptable for a synchronous profile API endpoint.

**Rate-limit risk:** The RPC proxy has unknown rate limits. The current provider already makes 50+ concurrent `eth_getBlockByNumber` calls per request. Scaling to a wider window multiplies this proportionally.

**Verdict on wider RPC scan:**
- 100,000 blocks (≈1 day) is technically feasible as a first improvement with careful chunking of `eth_getLogs` into 10,000-block segments. This would require 10 serial or parallel `eth_getLogs` calls. Latency: 5–15 seconds per request. Unreliable for production without caching.
- 500,000 blocks (≈5.8 days) pushes into territory where timeouts and oversized responses are likely without a known RPC endpoint behavior.
- Full history requires chunking across potentially millions of blocks — not feasible as a synchronous API call regardless of endpoint quality.
- **Conclusion: wider RPC scan is not suitable as the primary approach.** It is an acceptable short-term improvement to reduce the window from 2.8 hours to 1–2 days, but it cannot replace a real indexer.

---

### Option D: Other viable Arc-compatible indexers

**TheGraph:** TheGraph supports custom chain deployment via node operation. It does not have a managed hosted service for Arc Testnet as of 2026-09-23. Custom subgraph deployment for a new chain requires deploying and maintaining a Graph Node, which has substantial operational overhead.

**Envio HyperIndex:** Envio is a high-performance indexing framework. It supports custom EVM chains. It is not mentioned in Arc documentation. Operational overhead similar to custom subgraph.

**Ponder:** A TypeScript-based indexing framework (ponder.sh). It runs locally and supports custom EVM chains via RPC. It would require running a persistent indexer process alongside the Arc Rep Express server. This is a viable architecture but significantly increases operational complexity compared to Goldsky Mirror.

**Self-hosted Postgres + event scanner:** The Arc Rep codebase could implement its own persistent event scanner (a background process that walks blocks from genesis, collecting all transactions for all wallets, and stores them in Postgres). This is a valid approach but requires building and maintaining a production-quality blockchain scanner — a substantial engineering investment that is far larger than integrating Goldsky Mirror.

**Verdict on other options:** None offer a materially better combination of Arc Testnet support, operational simplicity, data completeness, and integration complexity than Goldsky for the current phase of Arc Rep.

---

## 4. EXACT CAPABILITY GAPS

### Current `ArcRpcProvider` capability gaps, mapped to signals:

| Gap | Affected signals | Goldsky closes it | Notes |
|---|---|---|---|
| Only 10,000-block window | All historical signals | Yes — full history from genesis | Primary gap |
| Sampled block scan (50 of 500 recent blocks) | `uniqueContracts`, `activityConsistency` | Yes — full tx enumeration | Causes silent misses |
| ERC-20 Transfer events outside window | `economicActivity.usdcErc20Raw`, `usdcReceived` | Yes | |
| `firstSeen` window-bounded | `firstSeen`, `ARC_EARLY_ADOPTER` credential | Yes | The single most important credential fix |
| `activeDays` covers only 2–3 days | `activeDays`, `ARC_CONSISTENT_USER` | Yes | |
| `activityConsistency` statistically useless | `activityConsistency` | Yes | Requires months of history |
| EIP-7708 dual-emitter double-counting (latent bug) | `economicActivity.usdcErc20Raw`, `usdcReceived` | Yes, with filter | Must be fixed in both providers |

### What a Goldsky provider would NOT close:

| Remaining gap | Reason |
|---|---|
| `builderActivity` signal (future) | Requires ABI decoding of input data |
| `paymentActivity` signal (future) | Requires ABI decoding of input data |
| `liquidityActivity` signal (future) | Requires DeFi protocol registry expansion |
| Non-USDC ERC-20 incoming signals | Data available; no signal defined yet |
| Cross-chain activity | Requires multi-chain indexing |
| Goldsky Arc mainnet support | Not confirmed in public docs (testnet only confirmed) |

---

## 5. RECOMMENDED ARCHITECTURE

### Primary recommendation: Goldsky Mirror → Postgres → `GoldskyActivityProvider`

The recommended architecture for Phase 5 implementation is:

```
ProfileService
    ↓
IActivityProvider
    ├── ArcRpcProvider       (keep, use as fallback or for sub-minute recency)
    └── GoldskyActivityProvider  (new, queries local Postgres sink of Goldsky Mirror)
            ↓
        Postgres (Goldsky-managed or self-hosted)
            ↑
        Goldsky Mirror Pipeline
            ↑
        Arc Testnet (arc_testnet.receipt_transactions + arc_testnet.raw_logs)
```

### Provider selection

Provider selection should be **configuration-driven** with a **fallback chain**:

```
PRIMARY:   GoldskyActivityProvider (if Postgres sink is available)
FALLBACK:  ArcRpcProvider          (if Goldsky/Postgres is unavailable)
```

A `CompositeActivityProvider` wrapper (not part of Phase 5 implementation) could handle this automatically: attempt Goldsky, fall back to RPC on error or timeout. For Phase 5, the provider is selected by configuration at startup:

```typescript
const provider: IActivityProvider =
  process.env.GOLDSKY_POSTGRES_URL
    ? new GoldskyActivityProvider({ postgresUrl: process.env.GOLDSKY_POSTGRES_URL })
    : new ArcRpcProvider();
```

### Why NOT automatic/composite selection in Phase 5

- Composite selection adds complexity. For Phase 5, explicit configuration is safer — it makes the data source visible in logs and `providerName` field.
- The `ArcRpcProvider` fallback ensures zero-downtime when Goldsky sync is being set up. It can be removed once `GoldskyActivityProvider` is stable.
- The `mayBeTruncated` and `dataQualityNotes` fields make the data source choice transparent to API consumers without changing the API shape.

### Why not RPC-only going forward

The 10,000-block window is a fundamental limitation of the RPC approach, not a tuning problem. Even with chunking to 100,000 blocks, the approach is:
- Too slow for synchronous profile requests
- Dependent on public RPC endpoint quality
- Cannot provide the `firstSeen` accuracy needed for `ARC_EARLY_ADOPTER`
- Cannot provide the temporal breadth needed for `activityConsistency`

Goldsky Mirror eliminates all of these constraints at low operational cost.

---

## 6. PROPOSED PROVIDER INTERFACE CHANGES

### `IActivityProvider` — no changes required

The existing interface is correct and sufficient. Its single method `getActivity(address): Promise<NormalizedActivity>` is fully vendor-neutral. No new methods should be added.

### `ActivityProviderOptions` — no changes required

`maxTransactions?: number` is the only option. A Goldsky provider may choose to implement it (SQL `LIMIT`) or ignore it when returning full history.

### `NormalizedActivity` — one new field required

```typescript
/**
 * When available, the provider's estimate of historical coverage depth.
 * This is informational metadata — it does not change signal calculation.
 * Provides consumers additional context about what "mayBeTruncated: false" means.
 */
historicalCoverageNote?: string;
```

Example values:
- RPC provider: `"10,000-block scan window (~2.8 hours)"`
- Goldsky provider: `"Full chain history from block 0 to block N (Goldsky Mirror)"`

This field is purely informational and does NOT change any signal logic. It is surfaced in `WalletActivitySummary.dataQualityNotes` if desired.

### `NormalizedTransaction` — one new field to fix the dual-emitter bug

```typescript
/**
 * Whether any Transfer log for this transaction came from the Arc
 * system emitter (0xffff...FfFE) rather than the ERC-20 contract.
 * Used to flag potential double-counting when both emitters fire.
 * Populated only when the provider has access to the raw log source address.
 */
hasSystemEmitterTransfer?: boolean;
```

This field is optional (not breaking) and enables the signal layer to detect and filter duplicate Transfer events from the EIP-7708 system emitter. However, the simpler fix (filter `log.address === ARC_USDC_CONTRACT` in both providers) makes this field unnecessary if filtering is applied consistently.

**Recommended:** do NOT add `hasSystemEmitterTransfer` to `NormalizedTransaction`. Instead, enforce `log.address === ARC_USDC_CONTRACT` filtering in both `ArcRpcProvider` (bug fix) and `GoldskyActivityProvider` (by design). The filtering rule is: **only accept Transfer events from `0x3600000000000000000000000000000000000000`; discard events from `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`.**

### `DecodedErc20Transfer` — no changes required

The type is correct. Token address filtering happens before construction of this type.

---

## 7. DATA-QUALITY MODEL

### Existing fields (keep all, semantics unchanged)

**`mayBeTruncated: boolean`**
- `ArcRpcProvider`: `true` when `txCount > captured` OR `latestBlock > blockScanWindow`. Almost always `true` on a live chain.
- `GoldskyActivityProvider`: `false` when the Goldsky Mirror pipeline has reached sync with the current chain head AND the query returned all transactions for the address. `true` only during initial sync (when Goldsky is still indexing historical blocks) or if the Postgres query was interrupted.

**`dataQualityNotes: string[]`**
- Preserved. A `GoldskyActivityProvider` adds notes such as "Full history from block 0. Goldsky Mirror last synced at block N (timestamp T)."
- If the Goldsky pipeline has a sync lag > some threshold (e.g. 60 seconds), add a note: "Goldsky Mirror sync lag: X seconds. Recent transactions may be absent."

**`providerName: string`**
- `ArcRpcProvider` → `'ArcRpcProvider'`
- `GoldskyActivityProvider` → `'GoldskyActivityProvider'`
Surfaced in API response and in signal `source` fields. Consumers can distinguish data source from the API response.

**`totalOutgoingTransactionCount?: number`**
- A `GoldskyActivityProvider` can populate this from `SELECT COUNT(*) FROM arc_transactions WHERE from_address = $1 AND succeeded = true` — it is exact and efficient with an index. It should ALSO validate against the chain nonce to detect any sync lag.
- When Goldsky is fully synced: `totalOutgoingTransactionCount = nonce (from Goldsky count)`. When partially synced: `totalOutgoingTransactionCount` is from Goldsky and may be < the actual nonce. The `mayBeTruncated` flag handles this.

### Additional data-quality concepts needed for historical provider

**Sync lag / indexer delay:**
A Goldsky Mirror pipeline lags real-time by seconds, not minutes. For Arc Rep, this is acceptable. However, the `GoldskyActivityProvider` should record the pipeline's last-synced block number in its `dataQualityNotes` so API consumers know how fresh the data is.

Implementation: query `SELECT max(block_number) FROM arc_transactions` at activity fetch time. If `latestIndexedBlock < currentChainHead - 10`, add a data quality note.

**Missing receipts:**
Goldsky's `receipt_transactions` dataset includes `receipt_status`. Missing receipts are a Goldsky pipeline responsibility, not an Arc Rep responsibility. If `receipt_status IS NULL` for a transaction in Goldsky's data, treat it as `succeeded: false` (conservative) and add a data quality note.

**Missing logs:**
If a transaction's `receipt_status = 1` but the corresponding `arc_logs` entry has no matching Transfer events, this is expected (not every succeeded transaction involves a Transfer event). This is not a data quality issue.

**Provider errors / Goldsky outage:**
On `GoldskyActivityProvider` error (Postgres unreachable, query timeout), throw `ActivityProviderError`. The Express route catches this and returns 502. The ArcRpcProvider fallback (if configured) handles the retry.

**Stale indexer data (pipeline stopped):**
If `latestIndexedBlock` is more than, say, 1000 blocks behind the chain head (approximately 16 minutes at 1 block/second), set `mayBeTruncated: true` and add a data quality note. This prevents a stale pipeline from silently producing `mayBeTruncated: false` profiles with missing recent activity.

### Signal-level status rules after migration to full-history provider

| Signal | Current status (ArcRpcProvider) | Status after `GoldskyActivityProvider` (synced) |
|---|---|---|
| `firstSeen` | Always `partial` | `available` for wallets whose genesis is in Goldsky's index |
| `lastSeen` | `available` if wallet transacted in window | `available` |
| `activeDays` | `partial` | `available` |
| `transactionCount` | `partial` (Case B) | `available` |
| `uniqueContracts` | `partial` | `available` |
| `uniqueApplications` | `partial` | `available` |
| `economicActivity` | `partial` | `available` |
| `usdcReceived` | `partial` | `available` |
| `activityConsistency` | `partial` (almost always) | `available` when sufficient data |
| `applicationDiversity` | `partial` | `available` |

**Important:** `available` does NOT mean "this signal is accurate." It means "the provider supplied complete data for the observation period." `activityConsistency` from a wallet with only 3 lifetime transactions is `available` but still statistically low-confidence. The `confidenceNote` field handles this distinction.

---

## 8. MIGRATION STRATEGY

### Phase 5A: Infrastructure setup (no domain changes)

1. Set up a Goldsky account and install the Goldsky CLI.
2. Define a Mirror pipeline YAML that sinks `arc_testnet.receipt_transactions` and `arc_testnet.raw_logs` to Postgres.
3. Provision a Postgres database (Goldsky-hosted or self-hosted).
4. Let the pipeline backfill from genesis. At Arc Testnet's genesis, this may take minutes to hours depending on chain age and Goldsky's indexing speed.
5. Write a `GoldskyActivityProvider` that queries the Postgres sink.
6. Wire it into `server/index.ts` behind a `GOLDSKY_POSTGRES_URL` environment variable check.
7. Keep `ArcRpcProvider` as the fallback.

**No domain layer changes required at this step.** `ProfileService`, `SignalEngine`, `CredentialService`, and all calculators are unchanged.

### Phase 5B: Bug fix (applies to both providers simultaneously)

Fix the EIP-7708 dual-emitter issue in `ArcRpcProvider`:
- In Step 3, after collecting all Transfer logs, add a filter: `log.address.toLowerCase() === ARC_USDC_CONTRACT`.
- This removes any log emitted by the system emitter (`0xffff...FfFE`) before decoding.
- This is a correctness fix with no behavioral change for wallets whose activity does not involve native USDC transfers. For wallets that DO make native USDC transfers, `economicActivity.usdcErc20Raw` and `usdcReceived` may decrease (previously double-counting system-emitter Transfer events).
- Add a test for this: a native USDC transfer must produce exactly one `DecodedErc20Transfer`, not two.

### Phase 5C: Signal status changes after migration

Once `GoldskyActivityProvider` is the primary provider and Goldsky is fully synced, the following tests need updating:

| Test | Current assertion | New assertion |
|---|---|---|
| `calculateFirstSeen` truncated wallet | `status: 'partial'` | `status: 'available'` for a fully-synced Goldsky wallet |
| `calculateActiveDays` truncated wallet | `status: 'partial'` | `status: 'available'` |
| `calculateTransactionCount` (Case B) | `status: 'partial'` (nonce used) | `status: 'available'` (Goldsky full count) |
| All signals with truncated fixture | `status: 'partial'` | `status: 'available'` (when `mayBeTruncated: false`) |

**Important:** These test changes are NOT breaking changes to the domain layer. Every signal calculator already has a branch `status: activity.mayBeTruncated ? 'partial' : 'available'`. When a `GoldskyActivityProvider` sets `mayBeTruncated: false`, the existing calculators automatically return `available`. No calculator logic needs to change.

The test fixtures that currently force `mayBeTruncated: true` are unit tests for the partial-status behavior, which remains correct. New integration tests with `mayBeTruncated: false` fixtures should be added to verify the `available` path for a fully-synced provider.

### Phase 5D: Credential reliability improvement

After migration:
- `ARC_EARLY_ADOPTER` becomes reliable: `firstSeen` is no longer window-bounded.
- `ARC_CONSISTENT_USER` becomes meaningful: `activityConsistency` has sufficient sample data for most wallets.
- `ARC_ACTIVE_WALLET` no longer needs the nonce fallback (Case B) for most wallets.
- `ARC_MULTI_APP_USER` remains limited by registry sparsity (not a data gap).

No credential definition changes are required. Eligibility rules are unchanged.

### Phase 5E: Cleanup (optional, post-stability)

Once `GoldskyActivityProvider` has been in production for a sufficient period:
1. Demote `ArcRpcProvider` to explicit "recent activity supplement" role — still useful for checking the last few minutes of activity that Goldsky has not yet indexed.
2. Consider a `CompositeActivityProvider` that merges Goldsky historical data with a 5-minute RPC recency window.
3. Remove the nonce-based `totalOutgoingTransactionCount` fallback from `calculateTransactionCount` (Case B) — when Goldsky is synced, the nonce IS the Goldsky count.

---

## 9. GOLDSKY MIRROR PIPELINE SPECIFICATION

This section defines the exact Mirror pipeline configuration required for Phase 5.

### Pipeline YAML (to be created as `infra/goldsky-arc-rep-pipeline.yaml`)

```yaml
name: arc-rep-historical-data
resource_size: s

sources:
  arc_transactions:
    type: dataset
    dataset_name: arc_testnet.receipt_transactions
    version: 1.2.0
    start_at: genesis           # Full history from block 0

  arc_logs:
    type: dataset
    dataset_name: arc_testnet.raw_logs
    version: 1.2.0
    start_at: genesis           # Full history from block 0

transforms:
  # Filter logs to only ERC-20 Transfer events from the USDC contract.
  # CRITICAL: Filter to address = ARC_USDC_CONTRACT to exclude the
  # EIP-7708 system emitter (0xffff...FfFE), which emits duplicate Transfer
  # events for native USDC transfers. Without this filter, transfers would
  # be double-counted in economicActivity.usdcErc20Raw and usdcReceived.
  usdc_transfers:
    type: sql
    primary_key: id
    sql: |
      SELECT *
      FROM arc_logs
      WHERE lower(address) = '0x3600000000000000000000000000000000000000'
        AND topics LIKE '%ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef%'

sinks:
  transactions_sink:
    type: postgres
    from: arc_transactions
    table: arc_transactions
    schema: public
    secret_name: ARC_REP_POSTGRES
    primary_key: id

  usdc_transfers_sink:
    type: postgres
    from: usdc_transfers
    table: arc_usdc_transfers
    schema: public
    secret_name: ARC_REP_POSTGRES
    primary_key: id
```

**Notes on the pipeline:**
- `start_at: genesis` ensures full historical backfill.
- `resource_size: s` is the smallest pipeline size; increase to `m` if backfill is slow.
- The `usdc_transfers` transform filters to exactly the USDC ERC-20 Transfer events, excluding the system emitter. This is the dual-emitter fix applied at the pipeline layer.
- The Postgres secret `ARC_REP_POSTGRES` must be registered with `goldsky secret create ARC_REP_POSTGRES` before deploying the pipeline.

### Required Postgres indexes

```sql
-- For transaction lookups by wallet address
CREATE INDEX idx_arc_transactions_from ON arc_transactions(from_address);
CREATE INDEX idx_arc_transactions_to ON arc_transactions(to_address);
CREATE INDEX idx_arc_transactions_block ON arc_transactions(block_number);
CREATE INDEX idx_arc_transactions_ts ON arc_transactions(block_timestamp);

-- For USDC transfer lookups
-- topics is a string; we need to parse it to extract individual topic values.
-- Goldsky's topics encoding should be verified: is it a comma-separated string,
-- a JSON array, or a | delimited string? This affects index design.
-- Safest initial approach: GIN index for text search, replace with array index
-- after confirming Goldsky's topics encoding format.
CREATE INDEX idx_arc_usdc_transfers_topics ON arc_usdc_transfers USING gin(to_tsvector('simple', topics));
CREATE INDEX idx_arc_usdc_transfers_block ON arc_usdc_transfers(block_number);
```

---

## 10. `GoldskyActivityProvider` INTERFACE SPECIFICATION

### File location
`server/data/GoldskyActivityProvider.ts`

### Constructor

```typescript
interface GoldskyActivityProviderConfig {
  postgresUrl: string;    // Connection string: postgres://user:pass@host/db
  chainId?: number;       // Defaults to ARC_TESTNET_CHAIN_ID (5042002)
  syncLagThresholdBlocks?: number;  // Default: 1000 blocks
}
```

### Query strategy

The provider must perform 3 SQL queries per `getActivity(address)` call:

**Query 1: All transactions involving the wallet**
```sql
SELECT
  hash, block_number, block_timestamp, from_address, to_address,
  value, receipt_status, input, receipt_contract_address
FROM arc_transactions
WHERE lower(from_address) = $1 OR lower(to_address) = $1
ORDER BY block_number ASC, transaction_index ASC;
```

**Query 2: All USDC Transfer events involving the wallet**
```sql
-- Exact implementation depends on Goldsky's topics encoding format.
-- The Goldsky dataset explorer shows topics as a string column.
-- The following assumes comma-separated or space-separated topic strings.
-- Verify before implementation.
SELECT
  transaction_hash, block_number, block_timestamp,
  address AS token_address, topics, data
FROM arc_usdc_transfers
WHERE topics LIKE '%' || lower($1) || '%';
-- Note: $1 is the wallet address with '0x' prefix, as it appears in topics[1] or topics[2]
-- after ABI-encoding (12 bytes of leading zeros + 20-byte address).
```

**Query 3: Current chain head for sync-lag detection**
```sql
SELECT max(block_number) AS latest_block FROM arc_transactions;
```

### Normalization

The `GoldskyActivityProvider` normalizes query results into `NormalizedTransaction[]` and `DecodedErc20Transfer[]` using the same field mapping defined in section 4 above.

Key differences from `ArcRpcProvider`:
1. `block_timestamp` from Goldsky is already a Unix-seconds integer — no hex conversion.
2. `value` from Goldsky `receipt_transactions` is a `decimal` type — must be converted to BigInt without precision loss (use `BigInt(Math.round(Number(value)))` or, better, have the query return it as a string with `CAST(value AS text)`).
3. `receipt_status` is already an integer (0 or 1) — no hex conversion.
4. `topics` is a string — must be split and trimmed to extract individual topic values. The exact delimiter must be verified empirically against Goldsky's data before implementation.
5. No `eth_getTransactionCount` call needed for `totalOutgoingTransactionCount` — derive it from `SELECT COUNT(*) FROM arc_transactions WHERE lower(from_address) = $1 AND receipt_status = 1`.

### `mayBeTruncated` logic for Goldsky provider

```typescript
const latestIndexedBlock = queryResult3.latestBlock;
const currentChainHead = /* from a lightweight eth_blockNumber RPC call */;

mayBeTruncated = latestIndexedBlock < currentChainHead - syncLagThresholdBlocks;
```

If the sync lag RPC call fails, default to `mayBeTruncated: true` (conservative).

When `mayBeTruncated: false` (fully synced), `dataQualityNotes` should include:
`"Full chain history from block 0. Goldsky Mirror last synced at block ${latestIndexedBlock} (${new Date(latestBlockTimestamp * 1000).toISOString()})."`

---

## 11. OPERATIONAL CONSIDERATIONS

### Postgres maintenance

- Goldsky Mirror pipelines handle their own writes. No manual Postgres writes from Arc Rep.
- Standard Postgres maintenance (vacuum, analyze) applies. With millions of Arc transactions, autovacuum defaults should be sufficient for initial deployment.
- The `arc_transactions` table will grow approximately 1 row per ~1 second on Arc Testnet. At 86,400 seconds/day, this is ~86,400 rows/day. A Postgres instance with 1 GB storage handles years of Arc Testnet history.

### Connection pooling

The `GoldskyActivityProvider` should use a connection pool (e.g. `pg-pool` for Node.js) rather than per-request connections. A pool of 5–10 connections is sufficient for Arc Rep's expected request volume.

### Pipeline monitoring

Goldsky provides pipeline status via their dashboard. Key metrics to monitor:
- `latestIndexedBlock` lag
- Pipeline error rate
- Backfill progress (on initial deployment)

### Cost

Goldsky pricing is based on pipeline resource size and data volume. An `s`-size pipeline on Arc Testnet at ~1 block/second is minimal. Exact pricing is at `docs.goldsky.com/pricing/summary`.

### Dependency chain

```
Arc Rep API ← Postgres ← Goldsky Pipeline ← Arc Testnet RPC
```

At each layer: if Arc Testnet RPC goes down, the Goldsky pipeline stops producing new blocks but historical data remains queryable. If Goldsky goes down, the pipeline stalls and `mayBeTruncated` kicks in after the lag threshold. If Postgres goes down, the API falls back to `ArcRpcProvider`.

---

## 12. SECURITY CONSIDERATIONS

### Postgres connection string

The `GOLDSKY_POSTGRES_URL` environment variable contains the Postgres password. It must:
- Never be logged
- Never appear in error messages
- Be handled via environment variable only, not hardcoded
- Use `VITE_`-prefix ONLY if the frontend needs it (it does not — this is server-only)

### SQL injection

All wallet address parameters in SQL queries must be parameterized (`$1`, `$2` — not string interpolation). The wallet address is validated by `validateAddress` middleware before reaching the provider. Defense in depth: validate again inside `GoldskyActivityProvider.getActivity()` before constructing any SQL.

### Goldsky pipeline write permissions

The Goldsky pipeline writes to the `arc_transactions` and `arc_usdc_transfers` tables. The Arc Rep Express server reads from these tables. These should be separate database roles:
- `goldsky_writer`: `INSERT`, `UPDATE`, `DELETE` on pipeline tables
- `arc_rep_reader`: `SELECT` only on pipeline tables

This limits blast radius if the Arc Rep connection string is leaked.

### EIP-7708 filtering

The pipeline YAML explicitly filters to `address = '0x3600...'` before sinking to Postgres. This ensures the system emitter's duplicate Transfer events never enter the database. Even if the system emitter's behavior changes, the Postgres sink is clean.

---

## 13. WHAT SHOULD NOT BE CHANGED

The following are explicitly out of scope for Phase 5 and must not be changed:

1. **`IActivityProvider` interface** — no methods added. The interface is already correct.
2. **`NormalizedActivity` fields** — `historicalCoverageNote` may optionally be added; no required fields are removed or renamed.
3. **`NormalizedTransaction` fields** — no changes. All downstream code that builds `NormalizedTransaction` objects (tests, mock providers) must not be broken.
4. **Signal calculators** — no changes. The `mayBeTruncated` flag drives status transitions automatically.
5. **Credential definitions** — no changes. Credentials become more reliable automatically as `mayBeTruncated` drops to `false`.
6. **`ArcRpcProvider`** — only one change: fix the EIP-7708 dual-emitter filter (add `log.address.toLowerCase() === ARC_USDC_CONTRACT` after log collection in Step 3). This is a correctness fix, not a behavioral change for standard ERC-20 transfers.
7. **API routes** — no changes. The existing 5 routes are unchanged.
8. **Frontend** — no changes.
9. **Tests** — no existing tests are removed. New tests for `GoldskyActivityProvider` are added in `tests/data/goldsky-provider.test.ts`. Signal-status tests may need `mayBeTruncated: false` variants added, but the existing `mayBeTruncated: true` tests remain.

---

## 14. EXACT PHASE 5 IMPLEMENTATION PLAN

This section specifies the exact steps for an engineer implementing Phase 5.

### Step 1: Goldsky setup (infrastructure, not code)

1. Create a Goldsky account at `goldsky.com`.
2. Install the Goldsky CLI: `npm install -g @goldsky/cli`.
3. Run `goldsky login`.
4. Create a Postgres database. Options:
   a. Goldsky-hosted: `goldsky hosted-sink create --type postgres --name ARC_REP_POSTGRES`
   b. Neon (serverless Postgres, generous free tier): create at neon.tech
   c. Supabase, RDS, Cloud SQL: any standard Postgres
5. Register the connection string as a Goldsky secret: `goldsky secret create ARC_REP_POSTGRES`
6. Create the pipeline definition file at `/home/user/app/infra/goldsky-arc-rep-pipeline.yaml` using the YAML from section 9.
7. Deploy the pipeline: `goldsky pipeline create arc-rep-historical-data --definition-path infra/goldsky-arc-rep-pipeline.yaml`
8. Monitor backfill progress in the Goldsky dashboard.

### Step 2: Verify Goldsky topics encoding

Before writing the `GoldskyActivityProvider`, verify the exact format of the `topics` column:
```sql
SELECT topics FROM arc_usdc_transfers LIMIT 5;
```
Determine if topics are: comma-separated, pipe-separated, JSON array, or space-separated. Update the SQL queries and the provider's topic-parsing logic accordingly.

### Step 3: Implement `GoldskyActivityProvider`

Create `server/data/GoldskyActivityProvider.ts` implementing `IActivityProvider`.

Key implementation notes:
- Use `pg` (node-postgres) with a connection pool.
- Add `GOLDSKY_POSTGRES_URL` to `.env` (not `VITE_`-prefixed — server-only).
- Validate address before any SQL (defense in depth).
- All SQL parameters use `$N` placeholders.
- Parse `topics` using the format verified in Step 2.
- Decode ERC-20 Transfer log fields using the same logic as `decodeErc20TransferLog` in `ArcRpcProvider` — or move that function to a shared utility.
- Set `mayBeTruncated: false` when `latestIndexedBlock >= currentChainHead - syncLagThresholdBlocks`.
- Make a single `eth_blockNumber` RPC call to get `currentChainHead` (lightweight, cached for 15 seconds).
- `providerName: 'GoldskyActivityProvider'`.

### Step 4: Fix EIP-7708 dual-emitter bug in `ArcRpcProvider`

In Step 3 of `ArcRpcProvider.getActivity()`, after building `allLogs`, add:
```typescript
const filteredLogs = allLogs.filter(
  (log) => log.address.toLowerCase() === ARC_USDC_CONTRACT
);
// Use filteredLogs instead of allLogs for decoding
```

Add a test: a native USDC transfer (where both the ERC-20 contract and the system emitter fire Transfer events) must produce exactly one `DecodedErc20Transfer` in the normalized transaction.

### Step 5: Wire into `server/index.ts`

```typescript
const provider: IActivityProvider =
  process.env.GOLDSKY_POSTGRES_URL
    ? new GoldskyActivityProvider({ postgresUrl: process.env.GOLDSKY_POSTGRES_URL })
    : new ArcRpcProvider();

const profileService = new ProfileService(provider, registry);
```

### Step 6: Add environment variable documentation

Add to `.env.example` (create if absent):
```
# Historical activity provider (Goldsky Mirror → Postgres)
# When set, GoldskyActivityProvider is used; otherwise falls back to ArcRpcProvider.
GOLDSKY_POSTGRES_URL=postgres://user:pass@host/db
```

### Step 7: Tests

Create `tests/data/goldsky-provider.test.ts`. Since the test environment has no live Postgres, tests should use:
- A mock Postgres client injected via the constructor (or dependency injection).
- Pre-canned query result fixtures for typical wallets.
- Tests covering: address validation, `mayBeTruncated` when sync-lagged, full history returns `available` signals, ERC-20 Transfer decoding with the actual topics format from Goldsky, error propagation on Postgres failure.

Do not use a live Goldsky/Postgres connection in tests. The existing `ArcRpcProvider` test strategy (mock-free, validates address parsing and provider contract) serves as a template.

### Step 8: Update `docs/DATA_REQUIREMENTS.md`

Add a Phase 5 summary section documenting:
- Goldsky is now the primary provider
- `ArcRpcProvider` is the fallback
- `mayBeTruncated` semantics for `GoldskyActivityProvider`
- EIP-7708 dual-emitter fix
- Which signals now return `available`

---

## 15. RISKS AND UNRESOLVED QUESTIONS

### R1: Goldsky topics column format (BLOCKER for Query 2)

**Risk:** The `topics` field in `arc_testnet.raw_logs` is documented as type `string`. The exact delimiter format (comma, pipe, JSON array) is not confirmed in the Goldsky dataset schema pages reviewed. If it is not comma-separated, the SQL `LIKE '%walletAddress%'` filter and the topic-parsing code must be adjusted.

**Resolution:** Step 2 of the implementation plan (verify format empirically before writing provider code) is mandatory. This is not implementable from the spec alone.

### R2: Arc Testnet topics include EIP-7708 system emitter topics

**Risk:** The system emitter fires Transfer events with `address = 0xffff...FfFE`. If the Goldsky pipeline YAML `topics LIKE` filter matches these before the `address` filter, the `usdc_transfers` transform may include system-emitter events before they are excluded. The YAML in section 9 applies both `address` AND `topics` filters — verify that the `WHERE` clause order produces a correct filter in the deployed pipeline.

**Resolution:** Confirm SQL filter semantics with a test query after pipeline deployment. If system-emitter entries appear in `arc_usdc_transfers`, tighten the filter.

### R3: Arc mainnet Goldsky support not confirmed

**Risk:** Arc mainnet (chain ID 5042) is not listed explicitly in Goldsky's supported networks documentation as of 2026-09-23. The Phase 5 architecture assumes testnet for now. If Arc Rep is to support mainnet, a separate confirmation is needed.

**Resolution:** Check Goldsky's Arc chain page (`docs.goldsky.com/chains/arc`) for mainnet support before any mainnet deployment. Do not assume testnet availability implies mainnet availability.

### R4: `value` column type precision

**Risk:** Goldsky's `receipt_transactions.value` is typed as `decimal`. JavaScript BigInt cannot directly represent a Postgres `decimal` type without a string conversion intermediate. If `pg` (node-postgres) returns `value` as a JavaScript `number` (floated), precision is lost for large transfer amounts.

**Resolution:** In SQL Query 1, cast `value` to text: `CAST(value AS text) AS value_str`. Use `BigInt(valueStr)` in the provider. Add a test for a large `value` (e.g. `10000000000000000000n` = 10 USDC native).

### R5: Goldsky backfill time

**Risk:** The Goldsky pipeline backfill from Arc Testnet genesis to current may take a significant amount of time depending on chain history length and Goldsky's indexing speed. During backfill, `mayBeTruncated: true` applies and Arc Rep operates in partial mode.

**Resolution:** This is acceptable behavior. The fallback to `ArcRpcProvider` during the backfill period means zero-downtime. Monitor backfill progress via the Goldsky dashboard.

### R6: Postgres connection leak

**Risk:** If the `GoldskyActivityProvider` does not properly release connections on error, the connection pool can exhaust.

**Resolution:** Use `pg.Pool` with explicit `pool.query()` (auto-releases connections) rather than `pool.connect()` + manual release. Add integration tests that exercise error paths (query failure, connection failure).

---

## 16. NEXT RECOMMENDED STEP

Implement Phase 5 following the exact plan in section 14. Start with Step 1 (Goldsky setup) and Step 2 (verify topics format) before writing any code, because the `GoldskyActivityProvider` implementation depends on the empirically confirmed `topics` column format.

Phase 5 is the single highest-leverage improvement to the entire Arc Rep system. It changes the status of 8 out of 10 implemented signals from `partial` to `available`, makes `ARC_EARLY_ADOPTER` reliable, makes `activityConsistency` statistically meaningful, and permanently closes the data-quality gap that the audit has documented across Phases 1–4.
