/**
 * server/domain/signals/calculators/bridge.ts
 *
 * Bridge interactions signal calculator.
 *
 * WHAT THIS MEASURES:
 * Count of distinct recognized bridge applications this wallet has interacted with,
 * where "bridge" is defined by `categoryId === 'bridge'` in the application registry.
 *
 * Only contracts verified in the Arc Rep application registry are counted.
 * Interactions with unrecognized contracts do not contribute to this signal.
 *
 * The registry is the single source of truth for which contracts are bridge contracts.
 * No contract address list is hardcoded in this calculator.
 *
 * WHAT THIS DOES NOT MEASURE:
 * - The number of bridge transactions (only distinct applications are counted).
 * - The direction of the bridge interaction (deposit vs. withdrawal).
 * - The amount bridged.
 * - Non-bridge contracts (DeFi, payments, etc.).
 * - Unrecognized contracts.
 *
 * HISTORICAL SAFETY:
 * This is a full-history signal (requiresFullHistory = true on the credential).
 * If `mayBeTruncated = true` and the count is 0, the credential returns
 * 'insufficient_data' rather than 'not_earned', because the wallet may have
 * bridged outside the current scan window.
 *
 * A non-zero count on a partial snapshot can produce a credential (it proves
 * bridge usage even without full history).
 *
 * SEMANTIC NOTE:
 * Bridge usage is a factual observation. It does not imply trustworthiness,
 * wealth, or the value of assets bridged.
 */

import type { ActivitySignal } from '../types.js';
import { SIGNAL_KEYS } from '../types.js';
import type { NormalizedActivity } from '../../../data/types.js';
import type { IApplicationRegistry } from '../../applications/ApplicationRegistry.js';

export function calculateBridgeInteractions(
  activity: NormalizedActivity,
  registry: IApplicationRegistry,
): ActivitySignal {
  const base = {
    key: SIGNAL_KEYS.BRIDGE_INTERACTIONS,
    label: 'Bridge Interactions',
    description:
      'Count of distinct recognized bridge applications this wallet has interacted with. ' +
      'Only contracts verified in the Arc Rep application registry with categoryId=bridge ' +
      'are counted. Unrecognized contracts are excluded. ' +
      'This is a raw observable count; it does not indicate the value bridged or trustworthiness.',
    source: `${activity.providerName} + Application Registry (bridge category)`,
    calculationDefinition:
      'count(distinct applicationId) for contractAddressesInteracted where ' +
      'registry.resolveContract(address).recognized === true AND ' +
      'application.categoryId === "bridge"',
    valueUnit: 'count',
  };

  if (activity.contractAddressesInteracted.size === 0) {
    return {
      ...base,
      value: 0,
      status: activity.mayBeTruncated ? 'partial' : 'available',
      observationStart: activity.earliestTimestamp,
      observationEnd: activity.latestTimestamp,
      confidenceNote: activity.mayBeTruncated
        ? 'The data snapshot may be truncated. A value of 0 does not mean the wallet has never used a bridge.'
        : '',
    };
  }

  const resolutions = registry.resolveContracts(
    activity.contractAddressesInteracted,
  );

  const bridgeAppIds = new Set<string>();
  for (const resolution of resolutions.values()) {
    if (
      resolution.recognized &&
      resolution.entry.application.categoryId === 'bridge'
    ) {
      bridgeAppIds.add(resolution.entry.application.id);
    }
  }

  const count = bridgeAppIds.size;

  return {
    ...base,
    value: count,
    status: activity.mayBeTruncated ? 'partial' : 'available',
    observationStart: activity.earliestTimestamp,
    observationEnd: activity.latestTimestamp,
    confidenceNote: activity.mayBeTruncated
      ? `${count} recognized bridge application(s) observed in the current snapshot window. ` +
        'The snapshot may be truncated; the true count may be higher.'
      : '',
  };
}
