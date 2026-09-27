/**
 * server/data/types.ts
 *
 * Raw and normalized types for the data access layer only.
 *
 * Nothing in this file touches application recognition, signal calculation,
 * credentials, or reputation. Those concerns live in server/domain/.
 *
 * Design rule: values here must be observable facts — block numbers,
 * timestamps, addresses, amounts from the chain. No derived quantities.
 */

// ---------------------------------------------------------------------------
// Raw types — exactly what comes back from the RPC, lightly typed
// ---------------------------------------------------------------------------

export interface RawTransaction {
  /** Transaction hash */
  hash: string;
  /** Block number as a hex string ("0x...") or decimal string */
  blockNumber: string;
  /** Unix timestamp (seconds) — may be absent if fetched separately */
  timestamp?: number;
  /** Sender address */
  from: string;
  /** Recipient / contract address; null for contract creations */
  to: string | null;
  /** Value transferred in the chain's native gas token, as a hex string */
  value: string;
  /** Whether the transaction succeeded (1 = success, 0 = failure) */
  status?: number;
  /** Gas used as a hex string */
  gasUsed?: string;
  /** Effective gas price as a hex string */
  effectiveGasPrice?: string;
  /** Input data hex */
  input?: string;
  /** Contract address created (only for contract-creation transactions) */
  contractAddress?: string | null;
}

export interface RawBlock {
  number: string;
  timestamp: string; // hex seconds since epoch
  hash: string;
  transactions?: RawTransaction[];
}

// ---------------------------------------------------------------------------
// Normalized types — what the domain layers receive
// ---------------------------------------------------------------------------

/**
 * A decoded ERC-20 Transfer event attached to a transaction.
 *
 * Transfer(address indexed from, address indexed to, uint256 value)
 *
 * Design rules:
 * - amountRaw is the exact raw uint256 from the log data. No decimal conversion.
 * - Token decimals are NOT applied here — this is the raw data layer.
 *   Callers that need a human-readable amount must apply token-specific decimals
 *   (e.g. 6 for USDC ERC-20) in the domain/signal layer.
 * - Addresses are lowercase.
 */
export interface DecodedErc20Transfer {
  /** The ERC-20 token contract address (log.address), lowercase */
  tokenAddress: string;
  /** Transfer sender (topic1, decoded), lowercase */
  from: string;
  /** Transfer recipient (topic2, decoded), lowercase */
  to: string;
  /**
   * Raw uint256 transfer amount from the log data field.
   * This is the exact value emitted by the contract; no decimal scaling applied.
   * For USDC (6 decimals): 1_000_000n = 1.000000 USDC.
   */
  amountRaw: bigint;
}

/**
 * A single normalized transaction for a wallet.
 *
 * All hex values are decoded. Amounts are BigInt to preserve precision.
 * Timestamps are Unix seconds (number).
 */
export interface NormalizedTransaction {
  hash: string;
  blockNumber: bigint;
  timestamp: number; // Unix seconds
  from: string; // lowercase
  to: string | null; // lowercase; null = contract creation
  /** Value in the chain native gas unit (18-decimal on Arc) */
  valueWei: bigint;
  /** True if the transaction status was success */
  succeeded: boolean;
  /** True if the wallet address was the sender */
  isOutgoing: boolean;
  /** True if this transaction created a contract */
  isContractCreation: boolean;
  /** Non-empty input data suggests a contract interaction */
  hasInputData: boolean;
  /** Contract address created by this tx, if any */
  createdContractAddress?: string;
  /**
   * Decoded ERC-20 Transfer events emitted by this transaction.
   *
   * Always present (empty array when no Transfer events were found).
   * Populated by the activity provider from eth_getLogs data.
   *
   * IMPORTANT: These are raw decoded events. The domain/signal layer is
   * responsible for filtering by token address, direction, and applying
   * token decimals.
   */
  erc20Transfers: DecodedErc20Transfer[];
}

/**
 * Full normalized activity record for a wallet.
 *
 * This is the output of IActivityProvider and the input to the domain layers.
 * It contains only observable, chain-sourced data.
 */
export interface NormalizedActivity {
  /** Wallet address, lowercase */
  address: string;
  /** Chain ID this activity was retrieved from */
  chainId: number;
  /**
   * Ordered list of transactions involving this wallet.
   * Ordering is earliest-first when available.
   */
  transactions: NormalizedTransaction[];
  /**
   * Set of unique contract addresses this wallet sent transactions to.
   * Does NOT include EOA-to-EOA transfers.
   * All lowercase.
   */
  contractAddressesInteracted: Set<string>;
  /**
   * Earliest transaction timestamp observed, Unix seconds.
   * Undefined if no transactions found.
   */
  earliestTimestamp?: number;
  /**
   * Latest transaction timestamp observed, Unix seconds.
   * Undefined if no transactions found.
   */
  latestTimestamp?: number;
  /**
   * Total number of transactions fetched.
   * This may be capped by the provider's page size limit.
   */
  totalFetched: number;
  /**
   * Whether the provider believes there may be more transactions
   * beyond what was returned (pagination limit reached).
   */
  mayBeTruncated: boolean;
  /** ISO timestamp when this activity snapshot was taken */
  fetchedAt: string;
  /** Which provider implementation produced this data */
  providerName: string;
  /**
   * The authoritative total number of outgoing transactions this account has
   * ever sent on this chain, obtained from the chain's nonce state via
   * `eth_getTransactionCount(address, "latest")`.
   *
   * KEY DISTINCTION:
   * This is an AGGREGATE COUNT from account state — it is NOT a list of
   * individually enumerated transaction records. Knowing the count does not mean
   * the provider has fetched, decoded, or made available any specific historical
   * transactions. The individual transaction details (timestamps, recipients,
   * values, contracts) are only available for transactions captured in
   * `transactions[]` (the current snapshot window).
   *
   * When present:
   * - `totalOutgoingTransactionCount > transactions.filter(t => t.isOutgoing).length`
   *   confirms that historical outgoing transactions exist outside the snapshot.
   * - This value accurately reflects the nonce at the `"latest"` block tag at
   *   the time the provider fetched activity, meaning it reflects the chain's
   *   canonical finalized nonce.
   *
   * When undefined:
   * - The provider could not obtain the nonce (RPC error or unsupported method).
   * - Callers must treat the absence as "nonce unknown", not "zero transactions".
   *
   * DO NOT:
   * - Use this field to infer historical timestamps, recipients, or amounts.
   * - Populate this field from `transactions.length` — that would defeat its purpose.
   * - Set this to zero without confirming `eth_getTransactionCount` actually
   *   returned zero (a genuine zero-transaction wallet is a special case).
   */
  totalOutgoingTransactionCount?: number;
  /**
   * Any data-quality notes the provider wants to surface.
   * Used to explain why certain signals may be unavailable or partial.
   */
  dataQualityNotes: string[];
}
