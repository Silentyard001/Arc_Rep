/**
 * server/domain/types.ts
 *
 * Canonical entity types for the Arc Rep domain.
 *
 * Design principles encoded here:
 * - WalletProfile has NO score, NO rank, NO trustworthiness claim.
 * - Raw activity, derived signals, and credentials are distinct sections.
 * - Every derived value traces back to its source and calculation definition.
 * - Credentials are typed by issuer so system/project/contract origins are clear.
 */

import type { ActivitySignal } from './signals/types.js';
import type { Credential } from './credentials/types.js';

// ---------------------------------------------------------------------------
// WalletActivitySummary
// Raw, observable activity facts — no derivation or interpretation.
// ---------------------------------------------------------------------------

export interface WalletActivitySummary {
  /** Wallet address, lowercase */
  address: string;
  /** Chain ID this summary was built from */
  chainId: number;
  /**
   * Total number of transactions captured in this snapshot.
   * This may be capped by the provider's page size.
   */
  transactionCount: number;
  /**
   * Set of unique contract addresses this wallet sent transactions to.
   * Only addresses with input data (i.e. contract calls) are included.
   */
  uniqueContractAddresses: string[];
  /** Earliest transaction timestamp observed, Unix seconds */
  earliestTimestamp?: number;
  /** Latest transaction timestamp observed, Unix seconds */
  latestTimestamp?: number;
  /** True if the provider indicates more transactions exist beyond the snapshot */
  mayBeTruncated: boolean;
  /** ISO timestamp when the on-chain data was fetched */
  fetchedAt: string;
  /** Provider that produced this data */
  providerName: string;
  /** Data quality / limitation notes from the provider */
  dataQualityNotes: string[];
}

// ---------------------------------------------------------------------------
// WalletProfile
// Top-level entity returned by ProfileService and the /profile API.
// ---------------------------------------------------------------------------

export interface WalletProfile {
  /** Wallet address, lowercase */
  address: string;
  /** Chain ID */
  chainId: number;
  /**
   * Raw, observable activity summary.
   * Contains only chain-observable facts.
   */
  activitySummary: WalletActivitySummary;
  /**
   * Derived behavioral signals.
   * Each signal carries its own source, formula, and confidence metadata.
   * These describe observable behavior; they do not constitute reputation.
   */
  signals: ActivitySignal[];
  /**
   * System-derived credentials earned by this wallet.
   * Phase 1: system-issued only.
   * Future: project-issued, contract-attested.
   */
  credentials: Credential[];
  /** ISO timestamp when this profile was assembled */
  profileBuiltAt: string;
  /**
   * Profile schema version for forward compatibility.
   */
  schemaVersion: string;
}

// ---------------------------------------------------------------------------
// VerificationRule (stub — full implementation in Phase 2)
// ---------------------------------------------------------------------------

/**
 * A rule a project can register to check wallet eligibility.
 * Stub type — the verification service is not implemented in Phase 1.
 */
export interface VerificationRule {
  ruleId: string;
  /** Human-readable description of what the rule checks */
  description: string;
  /** Signal key(s) this rule depends on */
  requiredSignals: string[];
  /** Predicate expression — format TBD in Phase 2 */
  predicate: string;
  createdAt: string;
  createdBy: string;
}

/**
 * The outcome of evaluating a VerificationRule against a wallet.
 * Stub type — not computed in Phase 1.
 */
export interface VerificationResult {
  ruleId: string;
  address: string;
  /** Whether the wallet satisfies the rule */
  satisfied: boolean;
  /**
   * Evidence used to reach the decision.
   * Intentionally minimal in Phase 1; privacy-preserving proofs are future work.
   */
  evidence: Record<string, unknown>;
  evaluatedAt: string;
}
