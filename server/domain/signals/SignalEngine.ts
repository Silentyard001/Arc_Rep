/**
 * server/domain/signals/SignalEngine.ts
 *
 * Orchestrates all signal calculators.
 *
 * Receives:
 *   - NormalizedActivity (from IActivityProvider)
 *   - IApplicationRegistry (for application-aware signals)
 *
 * Returns:
 *   - ActivitySignal[] — one entry per defined signal
 *
 * Boundary rules:
 * - No blockchain reads here.
 * - No credential logic here.
 * - No reputation scoring here.
 * - Future signals are included as stubs with status: 'future'.
 */

import type { NormalizedActivity } from '../../data/types.js';
import type { IApplicationRegistry } from '../applications/ApplicationRegistry.js';
import type { ActivitySignal } from './types.js';
import { SIGNAL_KEYS } from './types.js';
import { calculateFirstSeen, calculateLastSeen, calculateActiveDays } from './calculators/longevity.js';
import { calculateUniqueContracts, calculateUniqueApplications } from './calculators/breadth.js';
import { calculateTransactionCount, calculateEconomicActivity, calculateUsdcReceived } from './calculators/activity.js';
import { calculateApplicationDiversity, calculateActivityConsistency } from './calculators/diversity.js';
import { calculateBuilderActivity } from './calculators/builder.js';
import { calculateBridgeInteractions } from './calculators/bridge.js';

// ---------------------------------------------------------------------------
// Future signal stubs
// These are defined in the architecture but not yet calculable from available data.
// They are returned with status 'future' so consumers know they exist.
// ---------------------------------------------------------------------------

function futureSignal(
  key: string,
  label: string,
  description: string,
  calculationDefinition: string,
  requiredDataNote: string,
): ActivitySignal {
  return {
    key,
    label,
    description,
    source: 'Not yet implemented',
    calculationDefinition,
    valueUnit: 'tbd',
    value: null,
    status: 'future',
    confidenceNote: `Not implemented in Phase 1. ${requiredDataNote}`,
  };
}

// ---------------------------------------------------------------------------
// SignalEngine
// ---------------------------------------------------------------------------

export class SignalEngine {
  calculate(
    activity: NormalizedActivity,
    registry: IApplicationRegistry,
  ): ActivitySignal[] {
    const signals: ActivitySignal[] = [];

    // --- Longevity ---
    signals.push(calculateFirstSeen(activity));
    signals.push(calculateLastSeen(activity));
    signals.push(calculateActiveDays(activity));

    // --- Breadth ---
    signals.push(calculateUniqueContracts(activity));
    signals.push(calculateUniqueApplications(activity, registry));

    // --- Activity ---
    signals.push(calculateTransactionCount(activity));
    signals.push(calculateEconomicActivity(activity));
    signals.push(calculateUsdcReceived(activity));

    // --- Diversity ---
    signals.push(calculateApplicationDiversity(activity, registry));
    signals.push(calculateActivityConsistency(activity));

    // --- Builder activity (E3) ---
    signals.push(calculateBuilderActivity(activity));

    // --- Bridge interactions (E4) ---
    signals.push(calculateBridgeInteractions(activity, registry));

    // --- Payment activity (future) ---
    signals.push(
      futureSignal(
        SIGNAL_KEYS.PAYMENT_ACTIVITY,
        'Payment Activity',
        'Measurement of payment-specific behavior: USDC transfers to recognized payment applications or counterparts.',
        'Count and volume of USDC ERC-20 transfers categorized as payments via application registry.',
        'Requires ERC-20 Transfer event decoding and a richer application registry.',
      ),
    );

    // --- Liquidity activity (future) ---
    signals.push(
      futureSignal(
        SIGNAL_KEYS.LIQUIDITY_ACTIVITY,
        'Liquidity Activity',
        'Measurement of liquidity provision, staking, or yield farming activity.',
        'Count of interactions with recognized DeFi/liquidity protocols in the registry.',
        'Requires expanded application registry with DeFi protocol contracts.',
      ),
    );

    // --- Ecosystem breadth (future) ---
    signals.push(
      futureSignal(
        SIGNAL_KEYS.ECOSYSTEM_BREADTH,
        'Ecosystem Breadth',
        'Composite measurement of how broadly a wallet engages across Arc ecosystem categories.',
        'Count of distinct application categories interacted with, weighted by category diversity.',
        'Requires expanded registry and a defined composite formula.',
      ),
    );

    return signals;
  }
}
