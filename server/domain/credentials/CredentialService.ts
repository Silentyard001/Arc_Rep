/**
 * server/domain/credentials/CredentialService.ts
 *
 * Evaluates system-derived credentials for a wallet based on computed signals.
 *
 * Boundary rules:
 * - Receives ActivitySignal[] only (no blockchain reads, no registry access).
 * - Evaluates each credential definition against the provided signals.
 * - Returns Credential[] containing all evaluations (earned, not_earned,
 *   and insufficient_data).
 * - All rules are deterministic — no random, time-dependent, or opaque logic.
 *
 * Status semantics:
 * - 'active'             — credential conditions are met
 * - 'not_earned'         — conditions were evaluated and not met
 * - 'insufficient_data'  — cannot evaluate reliably due to data quality
 * - 'stale'              — (unused in evaluation; reserved for future expiry)
 *
 * insufficient_data rules:
 * A credential definition with requiresFullHistory = true returns
 * 'insufficient_data' when ALL of its required signals are 'partial'
 * (none are 'available'). This prevents window-limited snapshots from
 * accidentally producing definitive credentials.
 *
 * A credential whose required signals include any 'future' signal always
 * returns 'insufficient_data' (the signal calculator is not yet implemented).
 */

import type { ActivitySignal } from '../signals/types.js';
import type { Credential, CredentialDefinition } from './types.js';
import {
  ARC_REP_SYSTEM_ISSUER,
  SYSTEM_CREDENTIAL_DEFINITIONS,
  ACTIVE_WALLET_MIN_TXNS,
  EARLY_ADOPTER_CUTOFF_UNIX,
  MULTI_APP_MIN_APPLICATIONS,
  PAYMENTS_MIN_USDC_RAW,
  BUILDER_MIN_DEPLOYMENTS,
  BRIDGE_MIN_APPLICATIONS,
} from './system-credentials.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSignalMap(signals: ActivitySignal[]): Map<string, ActivitySignal> {
  return new Map(signals.map((s) => [s.key, s]));
}

function getNumericValue(signal: ActivitySignal | undefined): number | null {
  if (!signal) return null;
  if (signal.value === null || signal.value === undefined) return null;
  const n = typeof signal.value === 'string' ? parseFloat(signal.value) : signal.value;
  return isNaN(n as number) ? null : (n as number);
}

function isUsableStatus(status: string): boolean {
  return status === 'available' || status === 'partial';
}

/**
 * Returns true when every required signal for a credential is only 'partial'
 * and none is 'available'. Used for requiresFullHistory gate.
 */
function allSignalsPartialNoAvailable(
  definition: CredentialDefinition,
  signalMap: Map<string, ActivitySignal>,
): boolean {
  const statuses = definition.requiredSignalKeys.map(
    (key) => signalMap.get(key)?.status ?? 'unavailable',
  );
  // If any required signal is 'available', full history is satisfied
  if (statuses.some((s) => s === 'available')) return false;
  // If all are partial (or worse), history is incomplete
  return statuses.every((s) => s === 'partial' || s === 'unavailable');
}

/**
 * Credentials where a non-zero value on a partial snapshot is sufficient
 * to issue the credential even without full history.
 *
 * For these credential types, the requiresFullHistory gate is bypassed when
 * all required signals are partial BUT at least one signal has a non-zero value.
 *
 * Rationale: if a wallet has demonstrably deployed a contract or used a bridge,
 * that evidence stands regardless of snapshot completeness.
 */
const PARTIAL_POSITIVE_ALLOWED = new Set(['ARC_BUILDER', 'ARC_BRIDGE_USER']);

// ---------------------------------------------------------------------------
// CredentialService
// ---------------------------------------------------------------------------

export class CredentialService {
  evaluate(signals: ActivitySignal[]): Credential[] {
    const signalMap = buildSignalMap(signals);
    const evaluatedAt = new Date().toISOString();
    const results: Credential[] = [];

    for (const definition of SYSTEM_CREDENTIAL_DEFINITIONS) {
      const credential = this.evaluateDefinition(definition, signalMap, evaluatedAt);
      results.push(credential);
    }

    return results;
  }

  private evaluateDefinition(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evaluatedAt: string,
  ): Credential {
    // Gate 1: required signals with 'future' status mean the calculator is
    // not yet implemented — return insufficient_data.
    const futureSignals = definition.requiredSignalKeys.filter((key) => {
      const signal = signalMap.get(key);
      return !signal || signal.status === 'future';
    });

    if (futureSignals.length > 0) {
      return this.buildCredential(
        definition,
        'insufficient_data',
        [],
        evaluatedAt,
        `Required signal(s) not yet implemented: ${futureSignals.join(', ')}.`,
      );
    }

    // Gate 2: requiresFullHistory — if the definition requires complete data
    // and all required signals are only 'partial' (none 'available'), the
    // credential cannot be evaluated reliably.
    //
    // Exception: for credentials where a non-zero count on a partial snapshot
    // IS sufficient evidence (ARC_BUILDER, ARC_BRIDGE_USER), the individual
    // evaluator methods check the count first and bypass this gate if value > 0.
    // The gate is only triggered when the credential would produce a zero result
    // (which cannot be interpreted as "never" without full history).
    // For credentials in PARTIAL_POSITIVE_ALLOWED, check if any required signal
    // already has a non-zero value on the partial snapshot. If so, bypass the
    // insufficient_data gate — positive evidence stands without full history.
    const allowPartialPositive =
      PARTIAL_POSITIVE_ALLOWED.has(definition.typeId) &&
      definition.requiredSignalKeys.some((key) => {
        const sig = signalMap.get(key);
        if (!sig || !isUsableStatus(sig.status)) return false;
        const n = getNumericValue(sig);
        return n !== null && n > 0;
      });

    if (
      definition.requiresFullHistory &&
      allSignalsPartialNoAvailable(definition, signalMap) &&
      !allowPartialPositive
    ) {
      return this.buildCredential(
        definition,
        'insufficient_data',
        this.collectEvidence(definition, signalMap),
        evaluatedAt,
        `Requires complete wallet history. All supporting signals are partial ` +
          `(window-limited snapshot). ${definition.observationPeriodNote}`,
      );
    }

    // Collect evidence signals for all required keys
    const evidenceSignals = this.collectEvidence(definition, signalMap);

    // Evaluate the specific rule for each credential type
    switch (definition.typeId) {
      case 'ARC_ACTIVE_WALLET':
        return this.evaluateActiveWallet(definition, signalMap, evidenceSignals, evaluatedAt);
      case 'ARC_EARLY_ADOPTER':
        return this.evaluateEarlyAdopter(definition, signalMap, evidenceSignals, evaluatedAt);
      case 'ARC_MULTI_APP_USER':
        return this.evaluateMultiAppUser(definition, signalMap, evidenceSignals, evaluatedAt);
      case 'ARC_CONSISTENT_USER':
        return this.evaluateConsistentUser(definition, signalMap, evidenceSignals, evaluatedAt);
      case 'ARC_PAYMENTS_PARTICIPANT':
        return this.evaluatePaymentsParticipant(definition, signalMap, evidenceSignals, evaluatedAt);
      case 'ARC_BUILDER':
        return this.evaluateBuilder(definition, signalMap, evidenceSignals, evaluatedAt);
      case 'ARC_BRIDGE_USER':
        return this.evaluateBridgeUser(definition, signalMap, evidenceSignals, evaluatedAt);
      // ARC_LIQUIDITY_PARTICIPANT has 'future' required signals —
      // caught by Gate 1 above and never reaches this switch.
      default:
        // P8S-05: an unrecognised typeId means this code predates the credential
        // definition or received an unexpected type. We cannot evaluate it, so
        // returning not_earned would be semantically wrong — the correct status
        // is insufficient_data (evaluation was not possible, not "threshold not met").
        return this.buildCredential(
          definition,
          'insufficient_data',
          evidenceSignals,
          evaluatedAt,
          `Unknown credential type '${definition.typeId}': no evaluator is registered for this type. ` +
            `This credential cannot be evaluated by the current version of CredentialService.`,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Individual evaluators
  // -------------------------------------------------------------------------

  private evaluateActiveWallet(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
  ): Credential {
    const txCount = signalMap.get('transactionCount');
    if (!txCount || !isUsableStatus(txCount.status)) {
      return this.buildCredential(
        definition,
        'not_earned',
        evidenceSignals,
        evaluatedAt,
        `transactionCount signal is not usable (status: ${txCount?.status ?? 'missing'}).`,
      );
    }
    const count = getNumericValue(txCount);
    const earned = count !== null && count >= ACTIVE_WALLET_MIN_TXNS;
    return this.buildCredential(
      definition,
      earned ? 'active' : 'not_earned',
      evidenceSignals,
      evaluatedAt,
      earned
        ? `${count} outgoing transactions observed (threshold: >= ${ACTIVE_WALLET_MIN_TXNS}).`
        : `Only ${count ?? 0} outgoing transactions observed (threshold: >= ${ACTIVE_WALLET_MIN_TXNS}).`,
    );
  }

  private evaluateEarlyAdopter(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
  ): Credential {
    const firstSeen = signalMap.get('firstSeen');
    // requiresFullHistory gate already handled: if we reach here, firstSeen
    // must be 'available' (not partial). Verify explicitly.
    if (!firstSeen || firstSeen.status !== 'available') {
      return this.buildCredential(
        definition,
        'insufficient_data',
        evidenceSignals,
        evaluatedAt,
        `firstSeen must be 'available' (not partial) to issue this credential reliably. ` +
          `Current status: ${firstSeen?.status ?? 'missing'}. ` +
          definition.observationPeriodNote,
      );
    }
    const ts = getNumericValue(firstSeen);
    const cutoffDate = new Date(EARLY_ADOPTER_CUTOFF_UNIX * 1000).toISOString().slice(0, 10);
    const earned = ts !== null && ts <= EARLY_ADOPTER_CUTOFF_UNIX;
    return this.buildCredential(
      definition,
      earned ? 'active' : 'not_earned',
      evidenceSignals,
      evaluatedAt,
      earned
        ? `First observed on ${new Date(ts! * 1000).toISOString().slice(0, 10)}, before the early-adopter cutoff of ${cutoffDate}.`
        : `First observed after the early-adopter cutoff of ${cutoffDate} (or firstSeen timestamp unavailable).`,
    );
  }

  private evaluateMultiAppUser(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
  ): Credential {
    const uniqueApps = signalMap.get('uniqueApplications');
    if (!uniqueApps || !isUsableStatus(uniqueApps.status)) {
      return this.buildCredential(
        definition,
        'not_earned',
        evidenceSignals,
        evaluatedAt,
        `uniqueApplications signal is not usable (status: ${uniqueApps?.status ?? 'missing'}).`,
      );
    }
    const count = getNumericValue(uniqueApps);
    const earned = count !== null && count >= MULTI_APP_MIN_APPLICATIONS;
    return this.buildCredential(
      definition,
      earned ? 'active' : 'not_earned',
      evidenceSignals,
      evaluatedAt,
      earned
        ? `Interacted with ${count} recognized Arc applications (threshold: >= ${MULTI_APP_MIN_APPLICATIONS}).`
        : `Interacted with ${count ?? 0} recognized Arc applications (threshold: >= ${MULTI_APP_MIN_APPLICATIONS}).`,
    );
  }

  private evaluateConsistentUser(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
  ): Credential {
    const activeDays = signalMap.get('activeDays');
    const consistency = signalMap.get('activityConsistency');

    // P8S-01: if activeDays is missing or has an unusable status (unavailable,
    // future, or missing entirely), we cannot evaluate this credential — return
    // insufficient_data rather than collapsing provider failure into not_earned.
    // A usable signal that simply has a low value (0 or 1) is genuinely not_earned.
    if (!activeDays || !isUsableStatus(activeDays.status)) {
      return this.buildCredential(
        definition,
        'insufficient_data',
        evidenceSignals,
        evaluatedAt,
        `activeDays signal is not usable (status: ${activeDays?.status ?? 'missing'}). ` +
          `Cannot evaluate ARC_CONSISTENT_USER without this signal.`,
      );
    }

    const days = getNumericValue(activeDays);
    const cv = consistency?.value !== null ? consistency?.value : null;

    const daysOk = days !== null && days >= 2;
    const consistencyOk =
      consistency !== undefined &&
      isUsableStatus(consistency.status) &&
      cv !== null;

    const earned = daysOk && consistencyOk;

    return this.buildCredential(
      definition,
      earned ? 'active' : 'not_earned',
      evidenceSignals,
      evaluatedAt,
      earned
        ? `Activity observed across ${days} distinct days with a calculable consistency signal (CV: ${cv}).`
        : `Conditions not met: activeDays = ${days ?? 0} (need >= 2), consistencySignalAvailable = ${consistencyOk}.`,
    );
  }

  private evaluatePaymentsParticipant(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
  ): Credential {
    const economicActivity = signalMap.get('economicActivity');
    const usdcReceived = signalMap.get('usdcReceived');

    // Parse outgoing USDC from economicActivity JSON breakdown
    let outgoingUsdcRaw = BigInt(0);
    if (economicActivity && isUsableStatus(economicActivity.status) && economicActivity.value) {
      try {
        const breakdown = JSON.parse(economicActivity.value as string) as {
          nativeValueWei: string;
          usdcErc20Raw: string;
        };
        outgoingUsdcRaw = BigInt(breakdown.usdcErc20Raw ?? '0');
      } catch {
        // malformed breakdown — treat as zero outgoing USDC
      }
    }

    // Parse incoming USDC from usdcReceived signal
    let incomingUsdcRaw = BigInt(0);
    if (usdcReceived && isUsableStatus(usdcReceived.status) && usdcReceived.value !== null) {
      try {
        incomingUsdcRaw = BigInt(usdcReceived.value as string);
      } catch {
        // malformed value — treat as zero incoming USDC
      }
    }

    // P8S-02: if neither signal is usable (both missing, unavailable, or future),
    // we cannot evaluate this credential — return insufficient_data rather than
    // collapsing provider failure into not_earned.
    // A usable signal that merely has a zero balance IS genuinely not_earned.
    const eitherSignalUsable =
      (economicActivity && isUsableStatus(economicActivity.status)) ||
      (usdcReceived && isUsableStatus(usdcReceived.status));

    if (!eitherSignalUsable) {
      return this.buildCredential(
        definition,
        'insufficient_data',
        evidenceSignals,
        evaluatedAt,
        `Neither economicActivity nor usdcReceived signals are usable ` +
          `(economicActivity: ${economicActivity?.status ?? 'missing'}, ` +
          `usdcReceived: ${usdcReceived?.status ?? 'missing'}). ` +
          `Cannot evaluate ARC_PAYMENTS_PARTICIPANT without at least one usable signal.`,
      );
    }

    const sentMeetsThreshold = outgoingUsdcRaw >= PAYMENTS_MIN_USDC_RAW;
    const receivedMeetsThreshold = incomingUsdcRaw >= PAYMENTS_MIN_USDC_RAW;
    const earned = sentMeetsThreshold || receivedMeetsThreshold;

    const thresholdUsdc = Number(PAYMENTS_MIN_USDC_RAW) / 1_000_000;
    const sentUsdc = Number(outgoingUsdcRaw) / 1_000_000;
    const receivedUsdc = Number(incomingUsdcRaw) / 1_000_000;

    return this.buildCredential(
      definition,
      earned ? 'active' : 'not_earned',
      evidenceSignals,
      evaluatedAt,
      earned
        ? `USDC activity observed: sent ${sentUsdc.toFixed(6)} USDC, received ${receivedUsdc.toFixed(6)} USDC ` +
            `(threshold: >= ${thresholdUsdc} USDC sent or received).`
        : `Insufficient USDC activity: sent ${sentUsdc.toFixed(6)} USDC, received ${receivedUsdc.toFixed(6)} USDC ` +
            `(threshold: >= ${thresholdUsdc} USDC sent or received).`,
    );
  }

  private evaluateBuilder(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
  ): Credential {
    const builderActivity = signalMap.get('builderActivity');
    if (!builderActivity || !isUsableStatus(builderActivity.status)) {
      return this.buildCredential(
        definition,
        'not_earned',
        evidenceSignals,
        evaluatedAt,
        `builderActivity signal is not usable (status: ${builderActivity?.status ?? 'missing'}).`,
      );
    }

    const count = getNumericValue(builderActivity);

    // Non-zero count on ANY snapshot (partial or complete) confirms deployment.
    if (count !== null && count >= BUILDER_MIN_DEPLOYMENTS) {
      return this.buildCredential(
        definition,
        'active',
        evidenceSignals,
        evaluatedAt,
        `${count} contract deployment(s) observed ` +
          `(threshold: >= ${BUILDER_MIN_DEPLOYMENTS}). ` +
          (builderActivity.status === 'partial'
            ? 'Count is from a partial snapshot; true lifetime count may be higher.'
            : ''),
      );
    }

    // Zero count: the evaluateDefinition Gate 2 already handled the
    // partial-zero case (returning insufficient_data). If we reach here with
    // a zero count, the snapshot is complete (available), so it IS not_earned.
    return this.buildCredential(
      definition,
      'not_earned',
      evidenceSignals,
      evaluatedAt,
      `No contract deployments observed in complete snapshot (count: ${count ?? 0}).`,
    );
  }

  private evaluateBridgeUser(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
  ): Credential {
    const bridgeInteractions = signalMap.get('bridgeInteractions');
    if (!bridgeInteractions || !isUsableStatus(bridgeInteractions.status)) {
      return this.buildCredential(
        definition,
        'not_earned',
        evidenceSignals,
        evaluatedAt,
        `bridgeInteractions signal is not usable (status: ${bridgeInteractions?.status ?? 'missing'}).`,
      );
    }

    const count = getNumericValue(bridgeInteractions);

    // Non-zero count on ANY snapshot confirms bridge usage.
    if (count !== null && count >= BRIDGE_MIN_APPLICATIONS) {
      return this.buildCredential(
        definition,
        'active',
        evidenceSignals,
        evaluatedAt,
        `Interacted with ${count} recognized bridge application(s) ` +
          `(threshold: >= ${BRIDGE_MIN_APPLICATIONS}). ` +
          (bridgeInteractions.status === 'partial'
            ? 'Count is from a partial snapshot; true lifetime count may be higher.'
            : ''),
      );
    }

    // Zero on complete snapshot: genuinely not earned.
    return this.buildCredential(
      definition,
      'not_earned',
      evidenceSignals,
      evaluatedAt,
      `No recognized bridge interactions observed in complete snapshot (count: ${count ?? 0}).`,
    );
  }

  // -------------------------------------------------------------------------
  // Shared builder
  // -------------------------------------------------------------------------

  private collectEvidence(
    definition: CredentialDefinition,
    signalMap: Map<string, ActivitySignal>,
  ): Credential['evidenceSignals'] {
    return definition.requiredSignalKeys
      .map((key) => signalMap.get(key))
      .filter((s): s is ActivitySignal => s !== undefined)
      .map((s) => ({
        signalKey: s.key,
        signalLabel: s.label,
        value: s.value,
        signalStatus: s.status,
      }));
  }

  private buildCredential(
    definition: CredentialDefinition,
    status: Credential['status'],
    evidenceSignals: Credential['evidenceSignals'],
    evaluatedAt: string,
    evaluationNote: string,
  ): Credential {
    return {
      typeId: definition.typeId,
      name: definition.name,
      description: definition.description,
      status,
      issuer: ARC_REP_SYSTEM_ISSUER,
      evidenceSignals,
      evaluatedAt,
      evaluationNote,
      observationPeriodNote:
        status === 'insufficient_data' ? definition.observationPeriodNote : '',
    };
  }
}
