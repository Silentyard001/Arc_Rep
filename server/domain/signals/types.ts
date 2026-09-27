/**
 * server/domain/signals/types.ts
 *
 * Types for the Signal layer.
 *
 * Design principles:
 * - Signals describe observable wallet behavior. They are not reputation.
 * - Every signal carries enough metadata to explain what was measured,
 *   how it was calculated, and how confident we are in the result.
 * - Signals explicitly distinguish implemented, partial, and future status.
 * - Signal names are descriptive of the measurement, never of subjective
 *   qualities like "trust", "quality", or "value".
 */

// ---------------------------------------------------------------------------
// Signal status — tells consumers whether a value is usable
// ---------------------------------------------------------------------------

export type SignalStatus =
  /** Value is calculated and the underlying data is reliable */
  | 'available'
  /** Value is calculated but the underlying data may be incomplete (e.g. truncated snapshot) */
  | 'partial'
  /** The signal is defined but cannot be calculated from currently available data */
  | 'unavailable'
  /** The signal is defined but its calculator is not yet implemented */
  | 'future';

// ---------------------------------------------------------------------------
// SignalDefinition — metadata that explains how a signal is derived
// ---------------------------------------------------------------------------

export interface SignalDefinition {
  /** Unique key for this signal, e.g. "firstSeen" */
  key: string;
  /** Human-readable display name */
  label: string;
  /** What this signal measures — no subjective interpretation */
  description: string;
  /** What data source(s) feed this signal */
  source: string;
  /**
   * Plain-language definition of the calculation.
   * Precise enough that a reviewer can verify the result.
   */
  calculationDefinition: string;
  /**
   * The unit or type of the resulting value.
   * Examples: "unix_seconds", "count", "set_size", "bigint_wei", "days"
   */
  valueUnit: string;
}

// ---------------------------------------------------------------------------
// ActivitySignal — a computed signal for a specific wallet
// ---------------------------------------------------------------------------

export interface ActivitySignal {
  /** Key from SignalDefinition */
  key: string;
  /** Human-readable label from SignalDefinition */
  label: string;
  /**
   * The computed value.
   * Number, string, or null if unavailable.
   * BigInt values are serialized as strings.
   */
  value: number | string | null;
  status: SignalStatus;
  /** Plain-language explanation of what was measured */
  description: string;
  /** Data source for this signal */
  source: string;
  /** Plain-language definition of how the value was calculated */
  calculationDefinition: string;
  /** Unit or type of the value */
  valueUnit: string;
  /** Start of the observation period, Unix seconds */
  observationStart?: number;
  /** End of the observation period, Unix seconds */
  observationEnd?: number;
  /**
   * Human-readable note about data quality or why the signal is partial/unavailable.
   * Empty string when status is "available".
   */
  confidenceNote: string;
}

// ---------------------------------------------------------------------------
// Signal keys — exhaustive list of all defined signals
// (includes future signals that are not yet implemented)
// ---------------------------------------------------------------------------

export const SIGNAL_KEYS = {
  // Longevity
  FIRST_SEEN: 'firstSeen',
  LAST_SEEN: 'lastSeen',
  ACTIVE_DAYS: 'activeDays',

  // Breadth
  UNIQUE_CONTRACTS: 'uniqueContracts',
  UNIQUE_APPLICATIONS: 'uniqueApplications',

  // Activity
  TRANSACTION_COUNT: 'transactionCount',
  ECONOMIC_ACTIVITY: 'economicActivity',
  USDC_RECEIVED: 'usdcReceived',

  // Diversity
  APPLICATION_DIVERSITY: 'applicationDiversity',
  ACTIVITY_CONSISTENCY: 'activityConsistency',

  // Builder
  BUILDER_ACTIVITY: 'builderActivity',

  // Bridge interactions (E4)
  BRIDGE_INTERACTIONS: 'bridgeInteractions',

  // Payment (future)
  PAYMENT_ACTIVITY: 'paymentActivity',

  // Liquidity (future)
  LIQUIDITY_ACTIVITY: 'liquidityActivity',

  // Ecosystem breadth (future)
  ECOSYSTEM_BREADTH: 'ecosystemBreadth',
} as const;

export type SignalKey = (typeof SIGNAL_KEYS)[keyof typeof SIGNAL_KEYS];
