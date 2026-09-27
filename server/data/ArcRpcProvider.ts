/**
 * server/data/ArcRpcProvider.ts
 *
 * Arc RPC implementation of IActivityProvider.
 *
 * RPC endpoint resolution order:
 *  1. RPC_PROXY_BASE_URL + RPC_PROXY_TOKEN (when Arc_Testnet is in RPC_PROXY_CHAINS)
 *  2. Explicit config.rpcUrl passed to the constructor
 *  3. Falls back to the public Arc Testnet RPC URL from onchain-facts registry.
 *     When the fallback runs, a data-quality note is added explaining that the
 *     proxy was unavailable and the public endpoint may rate-limit under load.
 *
 * DATA LIMITATIONS (documented honestly):
 *
 * 1. Standard JSON-RPC does not expose a wallet's full transaction history
 *    natively. eth_getTransactionsByAddress is not a standard method.
 *    We build an activity picture by combining:
 *      - eth_getTransactionCount  (confirms the wallet has sent transactions)
 *      - eth_getLogs scanning for ERC-20 Transfer events involving the address
 *      - eth_getBlockByNumber with full tx objects for sampled recent blocks
 *
 * 2. Only transactions within the scanned block range are captured.
 *    Older activity outside that range is not visible.
 *    mayBeTruncated is set to true when this is detected.
 *
 * 3. Block timestamps come from block headers (eth_getBlockByNumber).
 *
 * 4. Value amounts are in the chain's native gas unit (18-decimal on Arc).
 *
 * Future: Replace with a full-history indexer (Goldsky, subgraph) that
 * implements IActivityProvider without changing any domain code.
 */

import { requireChain } from '../../src/onchain-facts.js';
import type { IActivityProvider, ActivityProviderOptions } from './IActivityProvider.js';
import type { NormalizedActivity, NormalizedTransaction, RawTransaction, DecodedErc20Transfer } from './types.js';
import { ActivityProviderError } from './IActivityProvider.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARC_TESTNET_CHAIN_ID = 5042002;
const ARC_MAINNET_CHAIN_ID = 5042;

/** Compass chain key for Arc Testnet (used for RPC proxy lookup) */
const ARC_TESTNET_COMPASS_KEY = 'Arc_Testnet';

/** Max blocks to scan in a single call */
const DEFAULT_BLOCK_SCAN_WINDOW = 10_000;

/** Max transactions to return by default */
const DEFAULT_MAX_TRANSACTIONS = 500;

/** ERC-20 Transfer event topic0 (keccak256 of "Transfer(address,address,uint256)") */
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Arc USDC ERC-20 contract address (6-decimal interface).
 * This is the only legitimate emitter of application-level USDC Transfer events.
 */
const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000'; // arc-studio-allow-onchain-literal

/**
 * Arc EIP-7708 system emitter address.
 *
 * Arc implements EIP-7708 (standard Transfer logs for native value movements).
 * When a native USDC transfer occurs, Arc emits a Transfer-shaped log from
 * BOTH the ERC-20 contract (0x3600...0000) AND this system-level address.
 *
 * The system emitter is a protocol-internal address defined by EIP-7708 and
 * the Arc EVM spec. It is NOT a token contract. Its Transfer logs must be
 * discarded before ERC-20 decoding to prevent:
 *   1. A second DecodedErc20Transfer with tokenAddress = SYSTEM_EMITTER
 *      appearing alongside the legitimate 0x3600... transfer.
 *   2. Future code iterating erc20Transfers[] without a tokenAddress filter
 *      accidentally double-counting native USDC transfers.
 *
 * Reference: https://docs.arc.io/arc/references/evm-differences (EIP-7708 section)
 *
 * This value is a fixed Arc protocol constant, equivalent to address(0) or
 * the ERC-20 Transfer topic — it cannot be sourced from any registry.
 */
const ARC_SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'.toLowerCase(); // arc-studio-allow-onchain-literal

// ---------------------------------------------------------------------------
// ERC-20 log shape (raw from eth_getLogs)
// ---------------------------------------------------------------------------

interface RawErc20Log {
  address: string;           // token contract address
  topics: string[];          // [topic0, topic1(from), topic2(to)]
  data: string;              // ABI-encoded uint256 amount
  transactionHash: string;
  blockNumber: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidEthAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x') return BigInt(0);
  return BigInt(hex);
}

function hexToNumber(hex: string): number {
  if (!hex || hex === '0x') return 0;
  return parseInt(hex, 16);
}

/**
 * Decode a raw eth_getLogs entry for a standard ERC-20 Transfer event.
 *
 * Transfer(address indexed from, address indexed to, uint256 value)
 *
 * ABI encoding:
 *   topics[0] = keccak256("Transfer(address,address,uint256)")  — event selector
 *   topics[1] = abi.encode(from)  — 32-byte padded address
 *   topics[2] = abi.encode(to)    — 32-byte padded address
 *   data      = abi.encode(uint256 value)  — 32-byte big-endian integer
 *
 * Returns null when the log is malformed (wrong topic count, missing data, etc.).
 * Callers must handle null to avoid silently missing or fabricating transfers.
 *
 * No external library is needed: the encoding is a fixed-layout struct.
 * Address topics are right-padded to 32 bytes with leading zeros; we take the
 * last 20 bytes (40 hex chars + '0x' prefix = index 26..66).
 * The data field is a 32-byte big-endian uint256; BigInt() handles arbitrary sizes.
 */
function decodeErc20TransferLog(log: RawErc20Log): DecodedErc20Transfer | null {
  // Must have exactly 3 topics: selector + from + to
  if (!log.topics || log.topics.length < 3) return null;
  if (!log.data || log.data.length < 66) return null; // "0x" + 64 hex chars

  try {
    // topic[1] = 32-byte padded address for `from`
    // Address occupies the last 20 bytes = rightmost 40 hex chars of the 64-char body
    const fromRaw = log.topics[1];
    const toRaw   = log.topics[2];

    if (!fromRaw || fromRaw.length < 42) return null;
    if (!toRaw   || toRaw.length   < 42) return null;

    // Each topic is "0x" + 64 hex chars. The address is the last 40 chars.
    const from = ('0x' + fromRaw.slice(-40)).toLowerCase();
    const to   = ('0x' + toRaw.slice(-40)).toLowerCase();

    // data is "0x" + 64 hex chars representing the uint256 amount
    const amountHex = log.data.startsWith('0x') ? log.data : '0x' + log.data;
    const amountRaw = BigInt(amountHex);

    const tokenAddress = log.address.toLowerCase();

    return { tokenAddress, from, to, amountRaw };
  } catch {
    // Any malformed hex / BigInt parse error → null
    return null;
  }
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new ActivityProviderError(
      `RPC request failed: HTTP ${response.status} for method ${method}`,
    );
  }

  const json = (await response.json()) as {
    result?: unknown;
    error?: { message: string };
  };

  if (json.error) {
    throw new ActivityProviderError(
      `RPC error for method ${method}: ${json.error.message}`,
    );
  }

  return json.result;
}

/**
 * Resolve the RPC URL to use, in priority order:
 * 1. Proxy env vars (preferred)
 * 2. Explicit override from config
 * 3. Public endpoint from onchain-facts registry
 *
 * Returns { url, usingProxy, usingFallback }.
 */
function resolveRpcUrl(
  chainId: number,
  configUrl: string | undefined,
): { url: string; usingProxy: boolean; usingFallback: boolean } {
  const proxyBase = process.env.RPC_PROXY_BASE_URL;
  const proxyToken = process.env.RPC_PROXY_TOKEN;
  const proxyChains = (process.env.RPC_PROXY_CHAINS ?? '').split(',').map((s) => s.trim());

  // Only use proxy for Arc Testnet (the supported chain key)
  const compassKey =
    chainId === ARC_TESTNET_CHAIN_ID
      ? ARC_TESTNET_COMPASS_KEY
      : null;

  if (
    compassKey &&
    proxyBase &&
    proxyToken &&
    proxyChains.includes(compassKey)
  ) {
    return {
      url: `${proxyBase}/api/rpc/${compassKey}?_rpc_token=${proxyToken}`,
      usingProxy: true,
      usingFallback: false,
    };
  }

  if (configUrl) {
    return { url: configUrl, usingProxy: false, usingFallback: false };
  }

  // Last resort: public endpoint from the onchain-facts registry
  const chain = requireChain(chainId);
  const publicUrl = chain.rpcUrls[0];
  return { url: publicUrl, usingProxy: false, usingFallback: true };
}

// ---------------------------------------------------------------------------
// ArcRpcProvider
// ---------------------------------------------------------------------------

export interface ArcRpcProviderConfig {
  /**
   * Explicit RPC endpoint URL override.
   * When absent the provider uses the proxy env vars, then the onchain-facts
   * registry public endpoint.
   */
  rpcUrl?: string;
  /** Chain ID. Defaults to Arc Testnet. */
  chainId?: number;
  /**
   * Number of recent blocks to scan for activity.
   * Larger windows find more history but take longer.
   */
  blockScanWindow?: number;
}

export class ArcRpcProvider implements IActivityProvider {
  readonly name = 'ArcRpcProvider';

  private readonly chainId: number;
  private readonly blockScanWindow: number;
  private readonly resolvedRpcUrl: string;
  private readonly usingFallbackRpc: boolean;

  constructor(config: ArcRpcProviderConfig = {}) {
    this.chainId = config.chainId ?? ARC_TESTNET_CHAIN_ID;
    this.blockScanWindow = config.blockScanWindow ?? DEFAULT_BLOCK_SCAN_WINDOW;

    const { url, usingFallback } = resolveRpcUrl(this.chainId, config.rpcUrl);
    this.resolvedRpcUrl = url;
    this.usingFallbackRpc = usingFallback;
  }

  async getActivity(
    address: string,
    options: ActivityProviderOptions = {},
  ): Promise<NormalizedActivity> {
    // Validate address before any RPC call
    if (!isValidEthAddress(address)) {
      throw new ActivityProviderError(
        `Invalid EVM address: "${address}". Expected 0x-prefixed 40 hex chars.`,
      );
    }

    const normalizedAddr = normalizeAddress(address);
    const maxTxns = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
    const fetchedAt = new Date().toISOString();
    const dataQualityNotes: string[] = [];

    if (this.usingFallbackRpc) {
      dataQualityNotes.push(
        'RPC proxy (RPC_PROXY_BASE_URL) was not configured for this chain. ' +
          'Using the public Arc RPC endpoint from the onchain-facts registry. ' +
          'Rate limits are unknown and may apply under load.',
      );
    }

    // Step 1: Check transaction count (confirms wallet has sent txns)
    let txCount = 0;
    try {
      const countResult = await rpcCall(
        this.resolvedRpcUrl,
        'eth_getTransactionCount',
        [normalizedAddr, 'latest'],
      );
      txCount = hexToNumber(countResult as string);
    } catch (err) {
      throw new ActivityProviderError(
        `Failed to fetch transaction count for ${normalizedAddr}`,
        err,
      );
    }

    // Step 2: Get the latest block number
    let latestBlockHex: string;
    let latestBlock: bigint;
    try {
      latestBlockHex = (await rpcCall(
        this.resolvedRpcUrl,
        'eth_blockNumber',
        [],
      )) as string;
      latestBlock = hexToBigInt(latestBlockHex);
    } catch (err) {
      throw new ActivityProviderError('Failed to fetch latest block number', err);
    }

    const fromBlock =
      latestBlock > BigInt(this.blockScanWindow)
        ? latestBlock - BigInt(this.blockScanWindow)
        : BigInt(0);

    dataQualityNotes.push(
      `Block scan window: ${fromBlock.toString()} – ${latestBlock.toString()} ` +
        `(${this.blockScanWindow} blocks). Transactions before block ` +
        `${fromBlock.toString()} are not included in this snapshot.`,
    );

    if (txCount === 0) {
      dataQualityNotes.push(
        'eth_getTransactionCount returned 0: this wallet has sent no outgoing ' +
          'transactions on this chain.',
      );
    }

    // Step 3: Scan for ERC-20 Transfer events involving this wallet.
    // We collect the full log objects (not just hashes) so we can decode
    // transfer amounts and attach them to normalized transactions in Step 7.
    const txHashSet = new Set<string>();
    // Map from txHash → decoded transfers for that transaction
    const transfersByTxHash = new Map<string, DecodedErc20Transfer[]>();

    try {
      const paddedAddr =
        '0x000000000000000000000000' + normalizedAddr.slice(2);

      const [logsFrom, logsTo] = await Promise.all([
        rpcCall(this.resolvedRpcUrl, 'eth_getLogs', [
          {
            fromBlock: '0x' + fromBlock.toString(16),
            toBlock: latestBlockHex,
            topics: [ERC20_TRANSFER_TOPIC, paddedAddr],
          },
        ]).catch(() => []) as Promise<RawErc20Log[]>,
        rpcCall(this.resolvedRpcUrl, 'eth_getLogs', [
          {
            fromBlock: '0x' + fromBlock.toString(16),
            toBlock: latestBlockHex,
            topics: [ERC20_TRANSFER_TOPIC, null, paddedAddr],
          },
        ]).catch(() => []) as Promise<RawErc20Log[]>,
      ]);

      const allLogs: RawErc20Log[] = [
        ...((logsFrom as RawErc20Log[]) ?? []),
        ...((logsTo as RawErc20Log[]) ?? []),
      ];

      // EIP-7708 FILTER: Remove logs emitted by the Arc system emitter address.
      //
      // Arc emits a Transfer-shaped log from BOTH the ERC-20 contract
      // (0x3600...0000) AND the system emitter (0xffff...FfFE) for every native
      // USDC transfer. The system emitter log is an Arc protocol event, not an
      // ERC-20 Transfer. Including it would create a DecodedErc20Transfer with
      // tokenAddress = SYSTEM_EMITTER, which is not a USDC token address and
      // would confuse any future code that iterates erc20Transfers[] without
      // an explicit tokenAddress filter.
      //
      // We filter by log.address.toLowerCase() === ARC_SYSTEM_EMITTER.
      // This does NOT filter non-USDC ERC-20 tokens — only the system emitter.
      const filteredLogs = allLogs.filter(
        (log) => log.address.toLowerCase() !== ARC_SYSTEM_EMITTER,
      );

      // Deduplicate by (txHash, tokenAddress, from, to, amountRaw) to avoid
      // double-counting the same event when a wallet appears in both log queries.
      const seenTransferKeys = new Set<string>();

      for (const log of filteredLogs) {
        if (!log.transactionHash) continue;
        txHashSet.add(log.transactionHash);

        const decoded = decodeErc20TransferLog(log);
        if (!decoded) continue;

        // Dedup key: txHash + all decoded fields
        const dedupKey = `${log.transactionHash}:${decoded.tokenAddress}:${decoded.from}:${decoded.to}:${decoded.amountRaw.toString()}`;
        if (seenTransferKeys.has(dedupKey)) continue;
        seenTransferKeys.add(dedupKey);

        const existing = transfersByTxHash.get(log.transactionHash) ?? [];
        existing.push(decoded);
        transfersByTxHash.set(log.transactionHash, existing);
      }
    } catch {
      dataQualityNotes.push(
        'ERC-20 Transfer log scan failed or returned no results. ' +
          'Token transfer transactions may be missing from this snapshot.',
      );
    }

    // Step 4: Scan sampled recent blocks for outgoing transactions
    // (catches native-value transfers and contract calls with no Transfer events)
    const recentScanWindow = Math.min(500, this.blockScanWindow);
    const recentFrom =
      latestBlock > BigInt(recentScanWindow)
        ? latestBlock - BigInt(recentScanWindow)
        : BigInt(0);

    try {
      const blockNumbers: bigint[] = [];
      for (
        let b = latestBlock;
        b >= recentFrom && blockNumbers.length < 50;
        b -= BigInt(10)
      ) {
        blockNumbers.push(b);
      }

      const blockResults = await Promise.allSettled(
        blockNumbers.map((bn) =>
          rpcCall(this.resolvedRpcUrl, 'eth_getBlockByNumber', [
            '0x' + bn.toString(16),
            true,
          ]),
        ),
      );

      for (const result of blockResults) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const block = result.value as {
          number: string;
          timestamp: string;
          transactions?: RawTransaction[];
        };

        for (const tx of block.transactions ?? []) {
          if (tx.from && normalizeAddress(tx.from) === normalizedAddr) {
            txHashSet.add(tx.hash);
          }
        }
      }
    } catch {
      dataQualityNotes.push(
        'Recent block scan failed or returned partial results.',
      );
    }

    // Step 5: Fetch full transaction data + receipts
    const txMap = new Map<string, NormalizedTransaction>();

    const hashes = [...txHashSet].slice(0, maxTxns);
    const receipts = await Promise.allSettled(
      hashes.map(async (hash) => {
        const [tx, receipt] = await Promise.all([
          rpcCall(this.resolvedRpcUrl, 'eth_getTransactionByHash', [hash]),
          rpcCall(this.resolvedRpcUrl, 'eth_getTransactionReceipt', [hash]),
        ]);
        return { tx, receipt, hash };
      }),
    );

    // Step 6: Batch-fetch block timestamps for all referenced blocks
    const blockNumbersNeeded = new Set<string>();
    for (const r of receipts) {
      if (r.status === 'fulfilled' && r.value.receipt) {
        const rec = r.value.receipt as { blockNumber: string };
        if (rec.blockNumber) blockNumbersNeeded.add(rec.blockNumber);
      }
    }

    const blockTimestamps = new Map<string, number>();
    await Promise.allSettled(
      [...blockNumbersNeeded].map(async (blockNum) => {
        const block = await rpcCall(this.resolvedRpcUrl, 'eth_getBlockByNumber', [
          blockNum,
          false,
        ]);
        if (block) {
          const b = block as { timestamp: string };
          blockTimestamps.set(blockNum, hexToNumber(b.timestamp));
        }
      }),
    );

    // Step 7: Normalize
    const contractAddressesInteracted = new Set<string>();

    for (const result of receipts) {
      if (result.status !== 'fulfilled') continue;
      const { tx, receipt } = result.value;
      if (!tx || !receipt) continue;

      const rawTx = tx as RawTransaction;
      const rawReceipt = receipt as {
        blockNumber: string;
        status: string;
        gasUsed: string;
        contractAddress?: string | null;
      };

      const blockNum = rawReceipt.blockNumber ?? rawTx.blockNumber;
      const timestamp = blockTimestamps.get(blockNum) ?? 0;
      const fromAddr = normalizeAddress(rawTx.from ?? '');
      const toAddr = rawTx.to ? normalizeAddress(rawTx.to) : null;
      const isOutgoing = fromAddr === normalizedAddr;
      const isContractCreation = !rawTx.to;
      const hasInputData =
        !!rawTx.input &&
        rawTx.input !== '0x' &&
        rawTx.input.length > 2;
      const succeeded = hexToNumber(rawReceipt.status ?? '0x1') === 1;
      const createdContract =
        rawReceipt.contractAddress
          ? normalizeAddress(rawReceipt.contractAddress)
          : undefined;

      if (isOutgoing) {
        if (toAddr && hasInputData) contractAddressesInteracted.add(toAddr);
        if (createdContract) contractAddressesInteracted.add(createdContract);
      }

      txMap.set(rawTx.hash, {
        hash: rawTx.hash,
        blockNumber: hexToBigInt(blockNum),
        timestamp,
        from: fromAddr,
        to: toAddr,
        valueWei: hexToBigInt(rawTx.value ?? '0x0'),
        succeeded,
        isOutgoing,
        isContractCreation,
        hasInputData,
        createdContractAddress: createdContract,
        // Attach decoded ERC-20 transfers collected from eth_getLogs (Step 3).
        // Always an array — empty when no Transfer events involve this tx.
        erc20Transfers: transfersByTxHash.get(rawTx.hash) ?? [],
      });
    }

    const transactions = [...txMap.values()].sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    const validTimestamps = transactions
      .filter((t) => t.timestamp > 0)
      .map((t) => t.timestamp);

    const earliestTimestamp =
      validTimestamps.length > 0 ? Math.min(...validTimestamps) : undefined;
    const latestTimestamp =
      validTimestamps.length > 0 ? Math.max(...validTimestamps) : undefined;

    const mayBeTruncated =
      (txCount > 0 && transactions.length < txCount) ||
      latestBlock > BigInt(this.blockScanWindow);

    if (mayBeTruncated) {
      dataQualityNotes.push(
        `Activity snapshot may be incomplete. ` +
          `eth_getTransactionCount = ${txCount}, ` +
          `transactions captured = ${transactions.length}. ` +
          `Historical transactions outside the block scan window are not included.`,
      );
    }

    return {
      address: normalizedAddr,
      chainId: this.chainId,
      transactions,
      contractAddressesInteracted,
      earliestTimestamp,
      latestTimestamp,
      totalFetched: transactions.length,
      mayBeTruncated,
      fetchedAt,
      providerName: this.name,
      dataQualityNotes,
      // Expose the account-level nonce as the authoritative total outgoing
      // transaction count. This is the result of eth_getTransactionCount at
      // the "latest" block tag — an aggregate from account state, NOT a count
      // of individually fetched transaction records. When txCount === 0, the
      // wallet has genuinely never sent a transaction (verified by the nonce).
      // When txCount > transactions.length, historical transactions exist
      // outside the scan window that are not in transactions[].
      totalOutgoingTransactionCount: txCount,
    };
  }
}

export { ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID, ARC_USDC_CONTRACT, ARC_SYSTEM_EMITTER };
