/**
 * server/domain/credentials/system-credentials.ts
 *
 * Definitions of system-derived credentials for Arc Rep.
 *
 * DESIGN RULES:
 * - Each credential must have a deterministic, verifiable eligibility rule.
 * - Thresholds are deliberately conservative.
 * - Credential names describe observable behavior, not subjective qualities.
 * - No credential implies that a wallet owner is trustworthy or valuable.
 * - requiresFullHistory = true means the credential must not be issued from
 *   a truncated snapshot when all required signals are only 'partial'.
 *   It will return 'insufficient_data' instead.
 *
 * CREDENTIAL SET:
 *
 * IMPLEMENTED (can evaluate with current RPC provider):
 *   1. ARC_ACTIVE_WALLET         — >= N outgoing transactions observed
 *   2. ARC_EARLY_ADOPTER         — first seen before a defined date
 *                                  NOTE: requiresFullHistory = true because
 *                                  firstSeen is always 'partial' on RPC.
 *                                  Promoted to 'active' only when the
 *                                  historical provider marks it 'available'.
 *   3. ARC_MULTI_APP_USER        — interacted with >= 2 recognized applications
 *   4. ARC_CONSISTENT_USER       — activity across multiple days with
 *                                  calculable consistency signal
 *   5. ARC_PAYMENTS_PARTICIPANT  — sent or received USDC via ERC-20 transfer
 *
 * INSUFFICIENT_DATA (cannot reliably evaluate until historical provider):
 *   6. ARC_BUILDER               — requires builderActivity signal (future)
 *   7. ARC_LIQUIDITY_PARTICIPANT — requires liquidityActivity signal (future)
 *
 * NOT YET IMPLEMENTED (architectural blocker — needs bridgeInteractions signal):
 *   8. ARC_BRIDGE_USER           — used Circle CCTP or Gateway
 *                                  (cannot safely evaluate without a per-app
 *                                  signal; uniqueApplications alone is
 *                                  insufficient)
 */

import type { CredentialDefinition, CredentialIssuer } from './types.js';
import { SIGNAL_KEYS } from '../signals/types.js';

// ---------------------------------------------------------------------------
// System Issuer
// ---------------------------------------------------------------------------

export const ARC_REP_SYSTEM_ISSUER: CredentialIssuer = {
  id: 'arc-rep-system',
  name: 'Arc Rep',
  issuerType: 'system',
  authorityId: 'arc-rep-system',
};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Minimum outgoing transaction count for ARC_ACTIVE_WALLET */
export const ACTIVE_WALLET_MIN_TXNS = 5;

/**
 * Maximum Unix timestamp (seconds) for ARC_EARLY_ADOPTER.
 * A wallet whose firstSeen <= this timestamp qualifies.
 * Set to 2025-12-31T23:59:59Z as initial early-adopter window.
 *
 * ⚠️  PRODUCT REVIEW REQUIRED before Goldsky goes live (P8-05):
 * This cutoff is 9 months in the past as of September 2026.
 * With full historical data, decide whether to:
 *   (a) keep the cutoff — rewards genuinely early Arc wallets,
 *   (b) extend the window — includes wallets from 2026,
 *   (c) retire the credential — if the early-adopter cohort is already known.
 * Do not change the constant without a deliberate product decision.
 * The credential is currently blocked by insufficient_data (no full history),
 * so this has no production impact until Goldsky backfill completes.
 */
export const EARLY_ADOPTER_CUTOFF_UNIX = 1767225599; // 2025-12-31T23:59:59Z

/** Minimum recognized applications for ARC_MULTI_APP_USER */
export const MULTI_APP_MIN_APPLICATIONS = 2;

/**
 * Minimum contract deployments (by this wallet) for ARC_BUILDER.
 * A single deployment is sufficient to confirm builder activity.
 */
export const BUILDER_MIN_DEPLOYMENTS = 1;

/**
 * Minimum distinct recognized bridge applications interacted with for ARC_BRIDGE_USER.
 * A single bridge interaction is sufficient.
 */
export const BRIDGE_MIN_APPLICATIONS = 1;

/**
 * Minimum raw USDC amount (6-decimal) for ARC_PAYMENTS_PARTICIPANT.
 * 1_000_000 = 1.000000 USDC.
 * Threshold is deliberately low: the credential confirms participation,
 * not any particular volume.
 */
export const PAYMENTS_MIN_USDC_RAW = BigInt(1_000_000); // 1 USDC

// ---------------------------------------------------------------------------
// Credential Definitions
// ---------------------------------------------------------------------------

export const SYSTEM_CREDENTIAL_DEFINITIONS: CredentialDefinition[] = [
  // -------------------------------------------------------------------------
  // 1. ARC_ACTIVE_WALLET
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_ACTIVE_WALLET',
    name: 'Active Arc Wallet',
    description:
      `This wallet has sent at least ${ACTIVE_WALLET_MIN_TXNS} outgoing transactions ` +
      `on Arc within the observed data snapshot. ` +
      `This credential describes observed transaction activity; it does not imply trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.TRANSACTION_COUNT],
    eligibilityRule:
      `transactionCount.status in ['available', 'partial'] AND transactionCount.value >= ${ACTIVE_WALLET_MIN_TXNS}`,
    requiresFullHistory: false,
    observationPeriodNote: '',
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },

  // -------------------------------------------------------------------------
  // 2. ARC_EARLY_ADOPTER
  // requiresFullHistory = true because firstSeen is always 'partial' under
  // the RPC window provider. A wallet whose true genesis transaction occurred
  // before the cutoff but outside the scan window would incorrectly fail.
  // This credential is only issued reliably once a full-history provider
  // marks firstSeen as 'available'.
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_EARLY_ADOPTER',
    name: 'Arc Early Adopter',
    description:
      `This wallet was first observed on Arc before ${new Date(EARLY_ADOPTER_CUTOFF_UNIX * 1000).toISOString().slice(0, 10)}. ` +
      `This credential describes when activity was first observed; it does not imply trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.FIRST_SEEN],
    eligibilityRule:
      `firstSeen.status === 'available' AND firstSeen.value <= ${EARLY_ADOPTER_CUTOFF_UNIX}`,
    requiresFullHistory: true,
    observationPeriodNote:
      `This credential requires complete wallet history to evaluate reliably. ` +
      `The current data snapshot is window-limited (~10,000 blocks). ` +
      `'firstSeen' may not reflect the wallet's actual first transaction. ` +
      `This credential will be evaluated once a full-history data provider is available.`,
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },

  // -------------------------------------------------------------------------
  // 3. ARC_MULTI_APP_USER
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_MULTI_APP_USER',
    name: 'Arc Multi-Application User',
    description:
      `This wallet has interacted with at least ${MULTI_APP_MIN_APPLICATIONS} distinct recognized Arc ecosystem applications. ` +
      `Only applications verified in the Arc Rep application registry are counted. ` +
      `This credential describes breadth of recognized application usage; it does not imply trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.UNIQUE_APPLICATIONS],
    eligibilityRule:
      `uniqueApplications.status in ['available', 'partial'] AND uniqueApplications.value >= ${MULTI_APP_MIN_APPLICATIONS}`,
    requiresFullHistory: false,
    observationPeriodNote: '',
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },

  // -------------------------------------------------------------------------
  // 4. ARC_CONSISTENT_USER
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_CONSISTENT_USER',
    name: 'Arc Consistent User',
    description:
      `This wallet has sent transactions across multiple days and has a calculable activity consistency signal. ` +
      `This credential describes observable regularity of activity; it does not imply trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.ACTIVE_DAYS, SIGNAL_KEYS.ACTIVITY_CONSISTENCY],
    eligibilityRule:
      `activeDays.value >= 2 AND activityConsistency.status in ['available', 'partial'] AND activityConsistency.value !== null`,
    requiresFullHistory: false,
    observationPeriodNote: '',
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },

  // -------------------------------------------------------------------------
  // 5. ARC_PAYMENTS_PARTICIPANT
  // Uses usdcReceived (Phase 4.1) and economicActivity (Phase 3A).
  // A wallet qualifies if it has sent OR received at least PAYMENTS_MIN_USDC_RAW
  // in USDC ERC-20 transfers within the observation window.
  // Native wei (economicActivity.nativeValueWei) is NOT included here because
  // it uses a different decimal scale (18 vs 6).
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_PAYMENTS_PARTICIPANT',
    name: 'Arc Payments Participant',
    description:
      `This wallet has sent or received USDC via ERC-20 Transfer events on Arc ` +
      `within the observed data snapshot. ` +
      `The minimum qualifying amount is ${Number(PAYMENTS_MIN_USDC_RAW) / 1_000_000} USDC. ` +
      `This credential describes observed USDC transfer activity; it does not imply trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.ECONOMIC_ACTIVITY, SIGNAL_KEYS.USDC_RECEIVED],
    eligibilityRule:
      `(economicActivity.usdcErc20Raw >= ${PAYMENTS_MIN_USDC_RAW.toString()} ` +
      `OR usdcReceived.value >= ${PAYMENTS_MIN_USDC_RAW.toString()}) ` +
      `AND signal.status in ['available', 'partial']`,
    requiresFullHistory: false,
    observationPeriodNote: '',
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },

  // -------------------------------------------------------------------------
  // 6. ARC_BUILDER (E3)
  //
  // requiresFullHistory = true: a zero deployment count on a partial snapshot
  // does not prove the wallet has never deployed. The credential is only issued
  // when builderActivity.status === 'available' OR when builderActivity.value > 0
  // even on a partial snapshot (a non-zero partial count proves deployment).
  //
  // The CredentialService evaluateBuilder() method handles the non-zero partial
  // case explicitly: if at least one deployment is visible, the credential
  // is earned regardless of snapshot completeness.
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_BUILDER',
    name: 'Arc Builder',
    description:
      `This wallet has deployed at least ${BUILDER_MIN_DEPLOYMENTS} smart contract(s) on Arc. ` +
      `Contract deployments are identified by outgoing transactions with to_address === null ` +
      `(contract-creation transactions) that succeeded. ` +
      `This credential describes observed deployment activity; it does not imply contract quality or trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.BUILDER_ACTIVITY],
    eligibilityRule:
      `builderActivity.status in ['available', 'partial'] AND builderActivity.value >= ${BUILDER_MIN_DEPLOYMENTS}`,
    requiresFullHistory: true,
    observationPeriodNote:
      `This credential requires complete wallet history to reliably determine that no deployments ` +
      `occurred outside the current data snapshot. ` +
      `A zero deployment count on a partial snapshot cannot be interpreted as 'never deployed'. ` +
      `The credential will be evaluated reliably once a full-history data provider is available. ` +
      `A non-zero deployment count on any snapshot (partial or complete) is sufficient to issue this credential.`,
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },

  // -------------------------------------------------------------------------
  // 7. ARC_BRIDGE_USER (E4)
  //
  // requiresFullHistory = true: a zero bridge interaction count on a partial
  // snapshot does not prove the wallet has never bridged. Only issued when
  // bridgeInteractions.value >= 1 (even on a partial snapshot), OR when the
  // snapshot is complete.
  //
  // Uses the application registry as the sole source of truth for bridge
  // contract addresses. No addresses are hardcoded in the credential.
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_BRIDGE_USER',
    name: 'Arc Bridge User',
    description:
      `This wallet has interacted with at least ${BRIDGE_MIN_APPLICATIONS} recognized bridge application(s) on Arc. ` +
      `Only contracts registered in the Arc Rep application registry under the 'bridge' category are counted. ` +
      `This credential describes observed bridge usage; it does not imply trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.BRIDGE_INTERACTIONS],
    eligibilityRule:
      `bridgeInteractions.status in ['available', 'partial'] AND bridgeInteractions.value >= ${BRIDGE_MIN_APPLICATIONS}`,
    requiresFullHistory: true,
    observationPeriodNote:
      `This credential requires complete wallet history to reliably determine that no bridge ` +
      `interactions occurred outside the current data snapshot. ` +
      `A zero count on a partial snapshot cannot be interpreted as 'never bridged'. ` +
      `A non-zero bridge interaction count on any snapshot is sufficient to issue this credential.`,
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },

  // -------------------------------------------------------------------------
  // 8. ARC_LIQUIDITY_PARTICIPANT — insufficient_data
  // Requires liquidityActivity signal which is 'future' (not yet implemented).
  // Needs: DeFi protocol registry expansion + protocol-specific interaction
  // decoding (liquidity deposits, LP token events, etc.).
  // -------------------------------------------------------------------------
  {
    typeId: 'ARC_LIQUIDITY_PARTICIPANT',
    name: 'Arc Liquidity Participant',
    description:
      `This wallet has provided liquidity to recognized Arc DeFi protocols. ` +
      `This credential describes observed liquidity provision activity; it does not imply trustworthiness.`,
    requiredSignalKeys: [SIGNAL_KEYS.LIQUIDITY_ACTIVITY],
    eligibilityRule:
      `liquidityActivity.status in ['available', 'partial'] AND liquidityActivity.value >= 1`,
    requiresFullHistory: true,
    observationPeriodNote:
      `This credential requires the 'liquidityActivity' signal which is not yet implemented. ` +
      `It will become available once full DeFi protocol registry expansion and ` +
      `liquidity position tracking are implemented.`,
    issuerType: 'system',
    issuerId: 'arc-rep-system',
  },
];
