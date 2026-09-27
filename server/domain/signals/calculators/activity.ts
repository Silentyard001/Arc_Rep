/**
 * server/domain/signals/calculators/activity.ts
 *
 * Activity signal calculators:
 * - transactionCount: total outgoing transaction count in the snapshot
 * - economicActivity: total outgoing USDC economic activity in the snapshot
 *
 * IMPORTANT:
 * transactionCount is a raw count of observed transactions.
 * It is not a proxy for reputation, importance, or quality.
 *
 * economicActivity now measures OUTGOING USDC value from two sources:
 *
 *   1. Native gas token value (msg.value, 18-decimal):
 *      On Arc, the native gas token IS USDC but at 18 decimals.
 *      Captured from NormalizedTransaction.valueWei.
 *
 *   2. ERC-20 USDC Transfer events where this wallet is the sender (from):
 *      The USDC ERC-20 contract (Arc address: 0x3600...0000) emits
 *      Transfer(address indexed from, address indexed to, uint256 value).
 *      Amounts are at 6 decimals (the ERC-20 USDC precision).
 *      Captured from NormalizedTransaction.erc20Transfers, filtered to
 *      tokenAddress === USDC_CONTRACT and transfer.from === wallet address.
 *
 * DOUBLE-COUNTING AVOIDANCE:
 * On Arc, native value and ERC-20 USDC represent the SAME pool. A transaction
 * cannot carry both a non-zero native msg.value AND move USDC via ERC-20 for
 * the same economic event. In practice:
 *   - Native sends (msg.value > 0) have valueWei > 0 and no USDC ERC-20 transfer.
 *   - ERC-20 USDC transfers (transfer() calls) have msg.value = 0.
 *
 * We sum both contributions. Because Arc native and ERC-20 USDC use DIFFERENT
 * decimal scales (18 vs 6), the two BigInt values are NOT directly addable.
 * The signal therefore reports TWO separate amounts:
 *   - nativeValueWei: total outgoing native wei (18-decimal)
 *   - usdcErc20Raw:   total outgoing ERC-20 USDC (6-decimal raw integer)
 *
 * Serialized as a JSON string: {"nativeValueWei":"...","usdcErc20Raw":"..."}
 *
 * This avoids a decimal-mismatch bug that would arise from summing the two
 * directly. Consumers must apply chain-specific decimal knowledge to interpret
 * either component.
 *
 * SEMANTIC NOTE: "economicActivity" records OUTGOING value only — amounts sent
 * FROM this wallet. Incoming transfers are not included. This is consistent
 * with the existing transactionCount and activeDays signals (which also count
 * only outgoing transactions).
 */

import type { ActivitySignal } from '../types.js';
import { SIGNAL_KEYS } from '../types.js';
import type { NormalizedActivity } from '../../../data/types.js';
/**
 * ARC_USDC_CONTRACT imported from ArcRpcProvider to avoid a duplicate literal —
 * single source of truth for the USDC ERC-20 address on Arc.
 */
import { ARC_USDC_CONTRACT } from '../../../data/ArcRpcProvider.js';

export function calculateTransactionCount(
  activity: NormalizedActivity,
): ActivitySignal {
  /**
   * Three cases, ordered by data fidelity:
   *
   * Case A — Non-truncated snapshot:
   *   mayBeTruncated === false
   *   The snapshot covers the wallet's complete history (or the wallet is new
   *   enough to fit entirely within the scan window). The snapshot count is
   *   authoritative. Status: 'available'.
   *
   * Case B — Truncated snapshot AND account-level nonce available:
   *   mayBeTruncated === true AND totalOutgoingTransactionCount is defined
   *   The account nonce from eth_getTransactionCount("latest") is the ground-
   *   truth total outgoing transaction count — it is an account-state value,
   *   not derived from the snapshot. Use it as the signal value so that wallets
   *   with long histories report an accurate lifetime count rather than just the
   *   count visible in the scan window.
   *   Status: 'partial' — because the individual transaction records (timestamps,
   *   recipients, values, contracts) are still only available for the snapshot
   *   window. The COUNT is accurate; the per-transaction DETAIL is not complete.
   *
   * Case C — Truncated snapshot AND account-level nonce unavailable:
   *   mayBeTruncated === true AND totalOutgoingTransactionCount is undefined
   *   The nonce fetch failed or was not performed. Fall back to the snapshot
   *   count. This is a lower bound, not the true lifetime count.
   *   Status: 'partial' — snapshot is incomplete and the true count is unknown.
   *
   * In all cases: the value counts only OUTGOING transactions. Incoming
   * transactions are excluded, consistent with activeDays and economicActivity.
   *
   * DO NOT infer timestamps, recipients, contracts, or amounts from the nonce.
   * A high nonce tells us a wallet is experienced; it tells us nothing about
   * what those transactions did or when they happened.
   */

  const snapshotOutgoingCount = activity.transactions.filter((t) => t.isOutgoing).length;

  // Case A: non-truncated — snapshot is complete
  if (!activity.mayBeTruncated) {
    return {
      key: SIGNAL_KEYS.TRANSACTION_COUNT,
      label: 'Transaction Count',
      description:
        'Number of outgoing transactions sent by this wallet. ' +
        'The data snapshot covers the wallet\'s full on-chain history within the observed window. ' +
        'This is a raw observable count, not a measure of quality or importance.',
      source: `${activity.providerName} — outgoing transactions in snapshot`,
      calculationDefinition:
        'count(transactions where isOutgoing === true) within the complete snapshot',
      valueUnit: 'count',
      value: snapshotOutgoingCount,
      status: 'available',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote: '',
    };
  }

  // Case B: truncated + nonce available — use the authoritative account count
  if (activity.totalOutgoingTransactionCount !== undefined) {
    return {
      key: SIGNAL_KEYS.TRANSACTION_COUNT,
      label: 'Transaction Count',
      description:
        'Authoritative total number of outgoing transactions sent by this wallet on this chain, ' +
        'obtained from the account nonce (eth_getTransactionCount). ' +
        'This count is accurate at the account level — it reflects the wallet\'s complete ' +
        'transaction history as recorded in the chain\'s state. ' +
        'However, the individual transaction records available to other signals (timestamps, ' +
        'counterparties, contracts, amounts) are limited to the data snapshot window. ' +
        'This is a raw observable count, not a measure of quality or importance.',
      source:
        `${activity.providerName} — eth_getTransactionCount("latest") ` +
        `(account nonce, authoritative lifetime count)`,
      calculationDefinition:
        'eth_getTransactionCount(address, "latest"): the account nonce is the ' +
        'authoritative total outgoing transaction count. ' +
        'The aggregate count is accurate; the individual transaction details ' +
        'available to downstream signals remain window-limited.',
      valueUnit: 'count',
      value: activity.totalOutgoingTransactionCount,
      status: 'partial',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote:
        'Count is the authoritative account-level nonce ' +
        `(eth_getTransactionCount = ${activity.totalOutgoingTransactionCount}). ` +
        'Individual transaction records are window-limited: timestamps, recipients, ' +
        'and contract interactions are only available for transactions within the ' +
        'data snapshot. Other signals derived from per-transaction data remain partial.',
    };
  }

  // Case C: truncated + nonce unavailable — fall back to snapshot count
  return {
    key: SIGNAL_KEYS.TRANSACTION_COUNT,
    label: 'Transaction Count',
    description:
      'Number of outgoing transactions observed in the data snapshot window. ' +
      'The snapshot is truncated (the wallet has more history than was captured), ' +
      'and the authoritative account-level transaction count was not available. ' +
      'This value is a lower bound on the wallet\'s true lifetime transaction count. ' +
      'This is a raw observable count, not a measure of quality or importance.',
    source: `${activity.providerName} — outgoing transactions in snapshot (account nonce unavailable)`,
    calculationDefinition:
      'count(transactions where isOutgoing === true) within the snapshot. ' +
      'Snapshot is truncated; account nonce was not available. ' +
      'This is a lower bound, not the true lifetime count.',
    valueUnit: 'count',
    value: snapshotOutgoingCount,
    status: 'partial',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote:
      'Snapshot may be truncated and the authoritative account nonce was not available. ' +
      'The true lifetime transaction count may be higher than this value.',
  };
}

/**
 * Result shape for economicActivity.
 *
 * Two separate BigInt amounts because Arc native (18-decimal) and ERC-20 USDC
 * (6-decimal) cannot be summed without decimal conversion — which is a domain
 * concern, not a raw-data concern. Serialized as JSON in the signal value string.
 */
export interface EconomicActivityBreakdown {
  /**
   * Sum of msg.value (native wei, 18-decimal) for outgoing succeeded txns.
   * On Arc, this represents USDC transferred as the native gas asset.
   */
  nativeValueWei: string;
  /**
   * Sum of ERC-20 USDC Transfer amounts (6-decimal raw integer) where
   * this wallet is the sender (transfer.from === wallet address) in
   * outgoing succeeded transactions.
   */
  usdcErc20Raw: string;
}

export function calculateEconomicActivity(
  activity: NormalizedActivity,
): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.ECONOMIC_ACTIVITY,
    label: 'Economic Activity',
    description:
      'Total outgoing USDC economic activity observed in the snapshot. ' +
      'Includes two components: (1) native gas token value (18-decimal wei) sent ' +
      'via msg.value in outgoing transactions — on Arc the native gas token IS USDC; ' +
      '(2) ERC-20 USDC Transfer amounts (6-decimal raw integer) where this wallet ' +
      'is the sender. ' +
      'Reported as a JSON object with fields nativeValueWei and usdcErc20Raw. ' +
      'These two components use different decimal scales and cannot be directly summed. ' +
      'This is a raw observable sum; it does not constitute a measure of wealth or trustworthiness.',
    source:
      `${activity.providerName} — valueWei on outgoing transactions; ` +
      `ERC-20 Transfer events where wallet is sender (tokenAddress: ${ARC_USDC_CONTRACT})`,
    calculationDefinition:
      'nativeValueWei: sum(tx.valueWei) for isOutgoing && succeeded. ' +
      'usdcErc20Raw: sum(transfer.amountRaw) for isOutgoing && succeeded && ' +
      'transfer.tokenAddress === ARC_USDC_CONTRACT && transfer.from === walletAddress. ' +
      'Serialized as JSON string.',
    valueUnit: 'json_economic_breakdown',
  };

  const outgoingSucceeded = activity.transactions.filter(
    (t) => t.isOutgoing && t.succeeded,
  );

  const walletAddress = activity.address; // already lowercase

  // Sum native value (msg.value)
  const nativeValueWei = outgoingSucceeded.reduce(
    (sum, t) => sum + t.valueWei,
    BigInt(0),
  );

  // Sum outgoing ERC-20 USDC transfers
  // A transfer counts when:
  //   - The token is the Arc USDC ERC-20 contract
  //   - The transfer sender is this wallet (transfer.from === walletAddress)
  //   - The transaction was outgoing and succeeded (already filtered above)
  let usdcErc20Raw = BigInt(0);
  for (const tx of outgoingSucceeded) {
    for (const transfer of tx.erc20Transfers) {
      if (
        transfer.tokenAddress === ARC_USDC_CONTRACT &&
        transfer.from === walletAddress
      ) {
        usdcErc20Raw += transfer.amountRaw;
      }
    }
  }

  const breakdown: EconomicActivityBreakdown = {
    nativeValueWei: nativeValueWei.toString(),
    usdcErc20Raw: usdcErc20Raw.toString(),
  };

  return {
    ...base,
    value: JSON.stringify(breakdown),
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? 'Snapshot may be truncated; total economic activity in the full history may be higher.'
      : '',
  };
}

/**
 * calculateUsdcReceived
 *
 * Measures total incoming USDC received by this wallet during the observation
 * period, as decoded from ERC-20 Transfer events.
 *
 * WHAT THIS COUNTS:
 * Sum of transfer.amountRaw for all ERC-20 Transfer events satisfying ALL of:
 *   - transfer.tokenAddress === ARC_USDC_CONTRACT  (only USDC, not other tokens)
 *   - transfer.to === activity.address              (this wallet is the recipient)
 *   - tx.succeeded === true                         (only confirmed transfers)
 *
 * WHAT THIS DOES NOT COUNT:
 *   - Outgoing USDC transfers (those are in economicActivity.usdcErc20Raw)
 *   - Native USDC (msg.value) — that is a separate view of the same asset
 *   - Non-USDC ERC-20 tokens
 *   - Failed transactions
 *
 * DOUBLE-COUNTING GUARANTEE:
 * economicActivity counts transfer.from === walletAddress (sender).
 * usdcReceived counts transfer.to === walletAddress (recipient).
 * These conditions are mutually exclusive for the same transfer event:
 * a transfer cannot have the same address as both from and to.
 *
 * DECIMAL CONVENTION:
 * amountRaw is the raw uint256 from the ERC-20 Transfer event log.
 * USDC is 6-decimal on Arc. 1 USDC = 1_000_000 in amountRaw.
 * The signal does NOT convert to a floating-point human-readable number.
 * Consumers apply 6-decimal scaling for display.
 *
 * SEMANTIC NOTE:
 * This signal is a factual observation of on-chain transfer events within
 * the provider's scan window. It is NOT a measure of earnings, wealth,
 * financial strength, or user importance. A high received amount may reflect
 * any pattern: a payment recipient, a treasury address, a test wallet, etc.
 *
 * TRUNCATION:
 * If the snapshot is truncated (mayBeTruncated = true), the sum covers only
 * the visible observation window. The true lifetime USDC received is unknown
 * and may be higher. Status is 'partial' to reflect this.
 */
export function calculateUsdcReceived(
  activity: NormalizedActivity,
): ActivitySignal {
  const walletAddress = activity.address; // already lowercase

  // Sum amountRaw for incoming, successful USDC ERC-20 transfers only.
  // Iterate all transactions (not just outgoing) — incoming USDC can arrive
  // in transactions initiated by other wallets, where isOutgoing === false.
  let usdcReceivedRaw = BigInt(0);
  for (const tx of activity.transactions) {
    if (!tx.succeeded) continue;
    for (const transfer of tx.erc20Transfers) {
      if (
        transfer.tokenAddress === ARC_USDC_CONTRACT &&
        transfer.to === walletAddress
      ) {
        usdcReceivedRaw += transfer.amountRaw;
      }
    }
  }

  return {
    key: SIGNAL_KEYS.USDC_RECEIVED,
    label: 'USDC Received',
    description:
      'Total USDC received by this wallet via ERC-20 Transfer events, ' +
      'observed during the provider\'s scan window. ' +
      'Counts only incoming transfers (transfer.to === this wallet) ' +
      'for the Arc USDC ERC-20 contract, in succeeded transactions. ' +
      'Reported as a raw 6-decimal integer (1 USDC = 1000000). ' +
      'This is an observable on-chain activity fact only — it does not ' +
      'indicate earnings, wealth, financial strength, or user importance.',
    source:
      `${activity.providerName} — ERC-20 Transfer events where ` +
      `wallet is recipient (tokenAddress: ${ARC_USDC_CONTRACT})`,
    calculationDefinition:
      'sum(transfer.amountRaw) for all tx in activity.transactions where ' +
      'tx.succeeded === true AND transfer.tokenAddress === ARC_USDC_CONTRACT ' +
      'AND transfer.to === walletAddress. ' +
      'Covers both incoming transactions (isOutgoing === false) and ' +
      'outgoing transactions that also generate an incoming USDC transfer event. ' +
      'amountRaw is the raw uint256 from the ERC-20 Transfer log (6-decimal).',
    valueUnit: 'bigint_usdc_raw_6dec_string',
    value: usdcReceivedRaw.toString(),
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? 'Snapshot may be truncated; the total USDC received over the wallet\'s ' +
        'full history may be higher than this value. ' +
        'This observation covers only the provider\'s current scan window.'
      : '',
  };
}
