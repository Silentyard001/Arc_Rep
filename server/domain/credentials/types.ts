/**
 * server/domain/credentials/types.ts
 *
 * Types for the Credential layer.
 *
 * Design principles:
 * - Credentials are earned through deterministic, signal-based rules.
 * - Every credential traces back to the signals that supported it.
 * - Issuer type clearly distinguishes system/project/contract origins.
 * - No subjective judgment or reputation scoring is embedded here.
 * - Phase 1: system-derived credentials only.
 * - Future: project-issued, contract-attested.
 */

// ---------------------------------------------------------------------------
// CredentialIssuerType
// ---------------------------------------------------------------------------

export type CredentialIssuerType =
  /** Credential issued by the Arc Rep system based on on-chain signals */
  | 'system'
  /** Credential issued by a registered third-party project (future) */
  | 'project'
  /** Credential attested by a smart contract (future) */
  | 'contract';

// ---------------------------------------------------------------------------
// CredentialIssuer
// ---------------------------------------------------------------------------

export interface CredentialIssuer {
  id: string;
  /** Display name for the issuer */
  name: string;
  issuerType: CredentialIssuerType;
  /**
   * For project issuers: their registered identifier.
   * For contract issuers: the contract address.
   * For system: 'arc-rep-system'.
   */
  authorityId: string;
}

// ---------------------------------------------------------------------------
// CredentialStatus
// ---------------------------------------------------------------------------

export type CredentialStatus =
  /** Credential conditions met; credential is valid */
  | 'active'
  /**
   * Credential was issued but the underlying signal data is now stale
   * or the conditions may no longer hold.
   */
  | 'stale'
  /** Credential conditions were evaluated but not met */
  | 'not_earned'
  /**
   * Credential cannot be evaluated because the required data quality is
   * insufficient. The underlying signals exist but are provably incomplete
   * for this credential's evidence requirements.
   *
   * Distinct from 'not_earned': 'not_earned' means the threshold was not
   * reached; 'insufficient_data' means the threshold cannot be reliably
   * evaluated at all.
   *
   * Examples:
   * - A credential requiring full wallet history when the provider is
   *   window-limited and mayBeTruncated = true.
   * - A credential requiring a signal whose calculator is not yet implemented.
   */
  | 'insufficient_data';

// ---------------------------------------------------------------------------
// CredentialDefinition
// ---------------------------------------------------------------------------

/**
 * The definition of a credential type.
 * Definitions are registered in the system; instances are issued per wallet.
 */
export interface CredentialDefinition {
  /** Unique identifier for this credential type */
  typeId: string;
  /** Display name */
  name: string;
  /** What this credential means — no subjective claims */
  description: string;
  /**
   * Signal keys required to evaluate this credential.
   * The credential cannot be evaluated if any required signal is 'future'.
   */
  requiredSignalKeys: string[];
  /**
   * Plain-language rule that determines whether this credential is earned.
   * Deterministic and verifiable.
   */
  eligibilityRule: string;
  /**
   * When true, this credential requires complete (non-truncated) historical
   * data to be issued reliably. If the activity snapshot has
   * mayBeTruncated = true AND all required signals are only 'partial'
   * (none are 'available'), the credential returns 'insufficient_data'
   * rather than evaluating against an incomplete snapshot.
   *
   * When false (default), the credential can be evaluated against partial
   * signals — a partial result satisfying the threshold is treated as earned.
   */
  requiresFullHistory: boolean;
  /**
   * Human-readable note explaining what observation period or data quality
   * level is required for this credential to be reliably evaluated.
   * Shown to API consumers when status is 'insufficient_data'.
   */
  observationPeriodNote: string;
  issuerType: CredentialIssuerType;
  issuerId: string;
}

// ---------------------------------------------------------------------------
// Credential
// The per-wallet instance of a credential evaluation.
// ---------------------------------------------------------------------------

export interface Credential {
  /** The type of credential this is */
  typeId: string;
  /** Display name (copied from definition) */
  name: string;
  /** Description (copied from definition) */
  description: string;
  status: CredentialStatus;
  issuer: CredentialIssuer;
  /**
   * The signal keys and their values that supported or disqualified this credential.
   * Provides full explainability.
   */
  evidenceSignals: Array<{
    signalKey: string;
    signalLabel: string;
    value: number | string | null;
    signalStatus: string;
  }>;
  /** ISO timestamp when this credential was evaluated */
  evaluatedAt: string;
  /**
   * Human-readable explanation of why the credential was or was not earned.
   */
  evaluationNote: string;
  /**
   * What data quality or observation period is required to evaluate this
   * credential reliably. Present when status is 'insufficient_data'.
   * Empty string otherwise.
   */
  observationPeriodNote: string;
}
