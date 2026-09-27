/**
 * server/domain/signals/calculators/diversity.ts
 *
 * Diversity signal calculators:
 * - applicationDiversity: ratio of unique recognized applications to unique contracts
 * - activityConsistency: standard deviation of inter-transaction gaps (lower = more consistent)
 *
 * These signals are more derived than longevity/breadth and are marked accordingly.
 *
 * applicationDiversity:
 *   A ratio between 0 and 1.
 *   1.0 = every contract interaction mapped to a distinct recognized application.
 *   0.0 = no contracts mapped to recognized applications.
 *   null = insufficient data (fewer than 2 contract interactions).
 *   Status is 'partial' when snapshot is truncated.
 *
 * activityConsistency:
 *   Calculated as the coefficient of variation (stddev / mean) of gaps
 *   between consecutive outgoing transaction timestamps.
 *   Lower CV = more regular cadence.
 *   Status is 'partial' when < 5 outgoing transactions (low sample size).
 *   null when insufficient data.
 */

import type { ActivitySignal } from '../types.js';
import { SIGNAL_KEYS } from '../types.js';
import type { NormalizedActivity } from '../../../data/types.js';
import type { IApplicationRegistry } from '../../applications/ApplicationRegistry.js';

export function calculateApplicationDiversity(
  activity: NormalizedActivity,
  registry: IApplicationRegistry,
): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.APPLICATION_DIVERSITY,
    label: 'Application Diversity',
    description:
      'Ratio of unique recognized Arc applications interacted with to total unique contracts interacted with. ' +
      'Range 0–1. Requires at least 1 contract interaction. Not a measure of quality.',
    source: `${activity.providerName} + Application Registry`,
    calculationDefinition:
      'uniqueRecognizedApplications / uniqueContractAddresses. ' +
      'Returns null when uniqueContractAddresses === 0.',
    valueUnit: 'ratio_0_to_1',
  };

  const totalContracts = activity.contractAddressesInteracted.size;

  if (totalContracts === 0) {
    return {
      ...base,
      value: null,
      status: 'unavailable',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote: 'No contract interactions found in the snapshot.',
    };
  }

  const resolutions = registry.resolveContracts(activity.contractAddressesInteracted);
  const recognizedAppIds = new Set<string>();
  for (const r of resolutions.values()) {
    if (r.recognized) {
      recognizedAppIds.add(r.entry.application.id);
    }
  }

  const ratio =
    totalContracts > 0 ? recognizedAppIds.size / totalContracts : 0;

  return {
    ...base,
    value: Math.round(ratio * 1000) / 1000, // 3 decimal places
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? 'Snapshot may be truncated; ratio may differ from full history.'
      : '',
  };
}

export function calculateActivityConsistency(
  activity: NormalizedActivity,
): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.ACTIVITY_CONSISTENCY,
    label: 'Activity Consistency',
    description:
      'Coefficient of variation (CV = stddev / mean) of gaps (seconds) between consecutive outgoing transactions. ' +
      'Lower values indicate more regular transaction cadence. ' +
      'This is a raw behavioral measurement, not a trust signal.',
    source: `${activity.providerName} — timestamps of outgoing transactions`,
    calculationDefinition:
      'CV of gaps: stddev(gaps) / mean(gaps), where gaps = consecutive differences in outgoing tx timestamps (sorted ascending). ' +
      'Requires >= 2 outgoing transactions with valid timestamps. ' +
      'Value is rounded to 3 decimal places.',
    valueUnit: 'coefficient_of_variation',
  };

  const outgoing = activity.transactions
    .filter((t) => t.isOutgoing && t.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (outgoing.length < 2) {
    return {
      ...base,
      value: null,
      status: 'unavailable',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote:
        'Fewer than 2 outgoing transactions with valid timestamps in the snapshot. ' +
        'Cannot calculate consistency.',
    };
  }

  // Calculate gaps (seconds between consecutive txns)
  const gaps: number[] = [];
  for (let i = 1; i < outgoing.length; i++) {
    gaps.push(outgoing[i].timestamp - outgoing[i - 1].timestamp);
  }

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  if (mean === 0) {
    return {
      ...base,
      value: null,
      status: 'unavailable',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote:
        'Mean gap between transactions is zero (all transactions in the same block). ' +
        'CV is undefined in this case.',
    };
  }

  const variance =
    gaps.reduce((sum, g) => sum + Math.pow(g - mean, 2), 0) / gaps.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / mean;

  const isLowSample = outgoing.length < 5;

  return {
    ...base,
    value: Math.round(cv * 1000) / 1000,
    status:
      isLowSample || activity.mayBeTruncated
        ? 'partial'
        : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: isLowSample
      ? `Only ${outgoing.length} outgoing transactions in the snapshot. CV estimate may not be reliable with small samples.`
      : activity.mayBeTruncated
        ? 'Snapshot may be truncated; consistency estimate covers only the visible window.'
        : '',
  };
}
