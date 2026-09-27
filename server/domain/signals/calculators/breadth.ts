/**
 * server/domain/signals/calculators/breadth.ts
 *
 * Breadth signal calculators:
 * - uniqueContracts: count of distinct contract addresses interacted with
 * - uniqueApplications: count of distinct RECOGNIZED applications interacted with
 *
 * uniqueApplications intentionally requires registry resolution.
 * A wallet that interacted with 12 contract addresses but only 2 recognized
 * applications reports uniqueApplications = 2, not 12.
 * Unrecognized contracts are counted separately in uniqueContracts.
 */

import type { ActivitySignal } from '../types.js';
import { SIGNAL_KEYS } from '../types.js';
import type { NormalizedActivity } from '../../../data/types.js';
import type { IApplicationRegistry } from '../../applications/ApplicationRegistry.js';

export function calculateUniqueContracts(
  activity: NormalizedActivity,
): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.UNIQUE_CONTRACTS,
    label: 'Unique Contracts',
    description:
      'Count of distinct contract addresses this wallet sent transactions to (any contract, recognized or not).',
    source: `${activity.providerName} — contractAddressesInteracted`,
    calculationDefinition:
      'count(distinct contract addresses where wallet sent a transaction with input data, within the snapshot)',
    valueUnit: 'count',
  };

  return {
    ...base,
    value: activity.contractAddressesInteracted.size,
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? 'Snapshot may be truncated; contracts outside the scan window are not counted.'
      : '',
  };
}

export function calculateUniqueApplications(
  activity: NormalizedActivity,
  registry: IApplicationRegistry,
): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.UNIQUE_APPLICATIONS,
    label: 'Unique Applications',
    description:
      'Count of distinct Arc ecosystem applications this wallet interacted with. ' +
      'Only recognized applications (verified in the application registry) are counted. ' +
      'Unknown contract addresses do not contribute to this count.',
    source: `${activity.providerName} + Application Registry`,
    calculationDefinition:
      'count(distinct applicationId) for contractAddressesInteracted where registry.resolveContract(address).recognized === true',
    valueUnit: 'count',
  };

  if (activity.contractAddressesInteracted.size === 0) {
    return {
      ...base,
      value: 0,
      status: 'available',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote: '',
    };
  }

  const resolutions = registry.resolveContracts(
    activity.contractAddressesInteracted,
  );

  const recognizedAppIds = new Set<string>();
  for (const resolution of resolutions.values()) {
    if (resolution.recognized) {
      recognizedAppIds.add(resolution.entry.application.id);
    }
  }

  return {
    ...base,
    value: recognizedAppIds.size,
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? 'Snapshot may be truncated; applications outside the scan window are not counted.'
      : '',
  };
}
