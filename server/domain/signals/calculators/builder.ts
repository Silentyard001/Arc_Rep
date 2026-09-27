/**
 * server/domain/signals/calculators/builder.ts
 *
 * Builder activity signal calculator.
 *
 * WHAT THIS MEASURES:
 * Count of outgoing contract-creation transactions observed in the data snapshot.
 * A contract-creation transaction has `isContractCreation === true` in the
 * normalized transaction, which corresponds to `to === null` in the raw
 * transaction and a non-null `receipt_contract_address` in the receipt.
 *
 * WHAT THIS DOES NOT MEASURE:
 * - Contract interactions (calling an existing contract).
 * - Incoming transactions.
 * - Failed transactions (only `succeeded === true` rows count).
 * - Proxy deployments or factory-pattern deployments initiated by another
 *   contract — only direct EOA-to-null deployments are counted here.
 * - Code quality, verification status, or contract content.
 *
 * HISTORICAL SAFETY:
 * This is a full-history signal. If `mayBeTruncated = true`, the result is
 * 'partial' — a value of 0 does NOT mean the wallet has never deployed.
 * The credential layer's `requiresFullHistory` gate prevents ARC_BUILDER from
 * issuing when the result is partial with a zero count.
 *
 * A non-zero count on a partial snapshot CAN produce a credential (it proves
 * deployment even without full history). The status remains 'partial' to
 * reflect that the full deployment count may be higher.
 *
 * SEMANTIC NOTE:
 * A high builder activity count does not imply contract quality, verification,
 * or trustworthiness. It is a raw observable count of on-chain deployment events.
 */

import type { ActivitySignal } from '../types.js';
import { SIGNAL_KEYS } from '../types.js';
import type { NormalizedActivity } from '../../../data/types.js';

export function calculateBuilderActivity(
  activity: NormalizedActivity,
): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.BUILDER_ACTIVITY,
    label: 'Builder Activity',
    description:
      'Count of outgoing contract-creation transactions observed in the data snapshot. ' +
      'A contract-creation transaction has to_address === null and a non-null ' +
      'receipt_contract_address. Only succeeded transactions are counted. ' +
      'This is a raw observable count; it does not indicate contract quality or trustworthiness.',
    source: `${activity.providerName} — isContractCreation flag on outgoing succeeded transactions`,
    calculationDefinition:
      'count(transactions where isOutgoing === true AND isContractCreation === true AND succeeded === true)',
    valueUnit: 'count',
  };

  const deployments = activity.transactions.filter(
    (t) => t.isOutgoing && t.isContractCreation && t.succeeded,
  );

  const count = deployments.length;

  if (count === 0 && !activity.mayBeTruncated) {
    // Non-truncated snapshot with zero deployments: definitively zero.
    return {
      ...base,
      value: 0,
      status: 'available',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote: '',
    };
  }

  if (count === 0 && activity.mayBeTruncated) {
    // Truncated snapshot with zero observed deployments: cannot prove
    // the wallet has never deployed. Return 'partial' with value 0.
    // The credential layer's requiresFullHistory gate will catch this.
    return {
      ...base,
      value: 0,
      status: 'partial',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote:
        'The data snapshot may be truncated. A value of 0 does not mean this wallet ' +
        'has never deployed a contract — deployments outside the scan window are not visible.',
    };
  }

  // count > 0: deployment(s) observed. Status is partial if snapshot is truncated
  // (the true deployment count may be higher), available if snapshot is complete.
  return {
    ...base,
    value: count,
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? `${count} contract deployment(s) observed in the current snapshot window. ` +
        'The snapshot may be truncated; the true lifetime deployment count may be higher.'
      : '',
  };
}
