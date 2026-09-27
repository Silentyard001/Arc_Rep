/**
 * server/domain/applications/types.ts
 *
 * Domain types for the Application Registry layer.
 *
 * Purpose: Map raw contract addresses to recognized Arc ecosystem applications.
 *
 * Design rules:
 * - Unknown contracts are never promoted to recognized applications.
 * - Multiple contract addresses can belong to one application.
 * - Application recognition is strictly a registry concern; the data layer
 *   and signal engine never perform their own address-to-app mapping.
 */

// ---------------------------------------------------------------------------
// ApplicationCategory
// ---------------------------------------------------------------------------

export type ApplicationCategoryId =
  | 'defi'
  | 'bridge'
  | 'payments'
  | 'nft'
  | 'infrastructure'
  | 'gaming'
  | 'identity'
  | 'dao'
  | 'other';

export interface ApplicationCategory {
  id: ApplicationCategoryId;
  /** Human-readable name */
  label: string;
  /** Brief description of what applications in this category do */
  description: string;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export interface Application {
  /** Stable identifier for this application */
  id: string;
  /** Display name */
  name: string;
  /** One-line description */
  description: string;
  /** Primary category */
  categoryId: ApplicationCategoryId;
  /**
   * Whether this application has been manually reviewed and confirmed.
   * Unverified applications are in the registry but flagged for review.
   */
  isVerified: boolean;
  /** URL for more information (optional) */
  websiteUrl?: string;
  /** ISO date this application was added to the registry */
  addedAt: string;
}

// ---------------------------------------------------------------------------
// ApplicationContract
// ---------------------------------------------------------------------------

/**
 * Classification of the evidence used to establish a contract's application identity.
 *
 * - 'official-docs':    Address appears in official documentation of Circle / the protocol.
 * - 'onchain-facts':   Address sourced directly from the Arc Studio onchain-facts registry,
 *                       which is maintained by Circle's engineering team.
 * - 'onchain-verified': Address confirmed by querying the live contract (e.g. `symbol()`,
 *                       `name()`, or protocol-specific view functions that returned the
 *                       expected values).
 * - 'team-confirmation': Address provided by the application team directly.
 * - 'unverified':       Plausible candidate but insufficient independent evidence.
 */
export type ContractSourceType =
  | 'official-docs'
  | 'onchain-facts'
  | 'onchain-verified'
  | 'team-confirmation'
  | 'unverified';

/**
 * A single contract address belonging to a recognized application.
 * One application can have many contracts (e.g. multiple pool contracts).
 */
export interface ApplicationContract {
  /** Lowercase EVM address */
  address: string;
  /** The application this contract belongs to */
  applicationId: string;
  /** Human-readable label for this specific contract */
  label: string;
  /**
   * Whether this contract has been independently verified as belonging
   * to the application (e.g. via source verification, official docs).
   */
  isVerified: boolean;
  /**
   * The type of evidence used to establish this contract belongs to this application.
   * Allows an engineer to answer: "Why do we believe this address belongs to this application?"
   */
  sourceType: ContractSourceType;
  /**
   * A short human-readable reference to the evidence source.
   * Examples: "docs.arc.io/arc/references/contract-addresses",
   *           "agent-standards SKILL.md (Arc Studio built-in skill)",
   *           "onchain-facts.ts getProtocolContractByName"
   * Not a live URL — a stable reference identifier.
   */
  sourceRef: string;
  /** ISO date this contract entry was added */
  addedAt: string;
}

// ---------------------------------------------------------------------------
// RegistryEntry
// Composite view returned by registry lookup
// ---------------------------------------------------------------------------

/**
 * The result of resolving a contract address via the registry.
 */
export interface RegistryEntry {
  contractAddress: string;
  application: Application;
  contract: ApplicationContract;
  category: ApplicationCategory;
}

/**
 * Result of resolving a contract address.
 * - recognized: true + entry when the address is in the registry
 * - recognized: false + null entry when not recognized
 */
export type ContractResolution =
  | { recognized: true; entry: RegistryEntry }
  | { recognized: false; entry: null };
