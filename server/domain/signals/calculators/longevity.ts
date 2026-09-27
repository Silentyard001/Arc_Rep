/**
 * server/domain/signals/calculators/longevity.ts
 *
 * Longevity signal calculators:
 * - firstSeen: earliest transaction timestamp
 * - lastSeen: most recent transaction timestamp
 * - activeDays: count of distinct calendar days with at least one outgoing transaction
 *
 * All calculations operate on NormalizedActivity.
 * Timestamps are Unix seconds.
 */

import type { ActivitySignal } from '../types.js';
import { SIGNAL_KEYS } from '../types.js';
import type { NormalizedActivity } from '../../../data/types.js';

/** Milliseconds in a day */
const MS_PER_DAY = 86_400_000;

/**
 * Truncate a Unix-seconds timestamp to calendar day (UTC).
 */
function toDayKey(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function calculateFirstSeen(activity: NormalizedActivity): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.FIRST_SEEN,
    label: 'First Seen',
    description:
      'The Unix timestamp (seconds) of the earliest transaction observed for this wallet in the current data snapshot.',
    source: `${activity.providerName} — transaction timestamps from block headers`,
    calculationDefinition:
      'min(timestamp) across all transactions in the snapshot where timestamp > 0',
    valueUnit: 'unix_seconds',
  };

  // POLICY: Failed transactions intentionally count toward firstSeen.
  //
  // ARC_EARLY_ADOPTER is defined as "earliest on-chain presence during Arc's
  // initial testnet period", not "first successful outgoing transaction". A
  // failed transaction is still a verifiable, timestamped on-chain event that
  // proves the wallet was active on Arc during that block.
  //
  // Including failed transactions:
  //   (a) is consistent with the credential's "earliest presence" semantics,
  //   (b) avoids a success-filter that could silently exclude pre-launch
  //       setup/test transactions that happened to fail,
  //   (c) matches how ArcRpcProvider derives the RPC nonce (which also counts
  //       failed outgoing transactions).
  //
  // If the product ever requires "first successful outgoing transaction", a
  // separate signal with a filter on `t.succeeded && t.isOutgoing` should be
  // introduced rather than modifying this one. Do NOT add a success filter
  // here without an explicit product decision.
  const validTxs = activity.transactions.filter((t) => t.timestamp > 0);

  if (validTxs.length === 0) {
    return {
      ...base,
      value: null,
      status: 'unavailable',
      confidenceNote:
        'No transactions with valid timestamps were found in the snapshot.',
    };
  }

  const earliest = Math.min(...validTxs.map((t) => t.timestamp));

  return {
    ...base,
    value: earliest,
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: earliest,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? 'The activity snapshot may be truncated. The actual first transaction may be earlier than this value.'
      : '',
  };
}

export function calculateLastSeen(activity: NormalizedActivity): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.LAST_SEEN,
    label: 'Last Seen',
    description:
      'The Unix timestamp (seconds) of the most recent transaction observed for this wallet in the current data snapshot.',
    source: `${activity.providerName} — transaction timestamps from block headers`,
    calculationDefinition:
      'max(timestamp) across all transactions in the snapshot where timestamp > 0',
    valueUnit: 'unix_seconds',
  };

  const validTxs = activity.transactions.filter((t) => t.timestamp > 0);

  if (validTxs.length === 0) {
    return {
      ...base,
      value: null,
      status: 'unavailable',
      confidenceNote:
        'No transactions with valid timestamps were found in the snapshot.',
    };
  }

  const latest = Math.max(...validTxs.map((t) => t.timestamp));

  return {
    ...base,
    value: latest,
    status: 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: latest,
    confidenceNote: '',
  };
}

export function calculateActiveDays(activity: NormalizedActivity): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.ACTIVE_DAYS,
    label: 'Active Days',
    description:
      'Count of distinct UTC calendar days on which this wallet sent at least one outgoing transaction, within the data snapshot.',
    source: `${activity.providerName} — transaction timestamps from block headers, isOutgoing flag`,
    calculationDefinition:
      'count(distinct(date(timestamp))) for outgoing transactions where timestamp > 0, grouped by UTC calendar day',
    valueUnit: 'days',
  };

  const outgoingWithTimestamp = activity.transactions.filter(
    (t) => t.isOutgoing && t.timestamp > 0,
  );

  if (outgoingWithTimestamp.length === 0) {
    // When mayBeTruncated = true and no transactions are captured, the zero
    // reflects the scan window, not the wallet's true history. Report 'partial'
    // so consumers know this zero cannot be treated as "never active".
    return {
      ...base,
      value: 0,
      status: activity.mayBeTruncated ? 'partial' : 'available',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote: activity.mayBeTruncated
        ? 'The snapshot may be truncated; active days outside the scan window are not counted. ' +
          'A value of 0 here does not mean the wallet has never been active.'
        : '',
    };
  }

  const daySet = new Set(outgoingWithTimestamp.map((t) => toDayKey(t.timestamp)));

  return {
    ...base,
    value: daySet.size,
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? 'The snapshot may be truncated; active days outside the scan window are not counted.'
      : '',
  };
}

// Export the toDayKey helper for tests
export { toDayKey, MS_PER_DAY };
