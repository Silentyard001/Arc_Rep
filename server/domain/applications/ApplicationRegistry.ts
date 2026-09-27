/**
 * server/domain/applications/ApplicationRegistry.ts
 *
 * Interface and in-memory implementation for the application registry.
 *
 * The registry is the single authority for contract-address-to-application mapping.
 *
 * Interface design:
 * - resolveContract: single address lookup
 * - resolveContracts: bulk lookup, returns a Map keyed by address
 * - listApplications: enumerate registered applications
 * - getApplication: fetch a specific application by ID
 *
 * InMemoryApplicationRegistry:
 * - Initialized from static seed data.
 * - Address comparisons are always lowercase to prevent case mismatches.
 * - Unknown addresses always resolve to { recognized: false, entry: null }.
 * - Ready for replacement with a DB-backed implementation.
 *
 * Future: DatabaseApplicationRegistry, AdminManagedRegistry
 */

import type {
  Application,
  ApplicationCategory,
  ContractResolution,
  RegistryEntry,
} from './types.js';
import type { ApplicationContract } from './types.js';

// ---------------------------------------------------------------------------
// IApplicationRegistry
// ---------------------------------------------------------------------------

export interface IApplicationRegistry {
  /**
   * Resolve a single contract address.
   * Returns { recognized: false, entry: null } for unknown addresses.
   * Never throws for an unknown address.
   */
  resolveContract(address: string): ContractResolution;

  /**
   * Resolve multiple contract addresses in bulk.
   * Returns a Map keyed by lowercase address.
   * Unrecognized addresses are included with recognized: false.
   */
  resolveContracts(
    addresses: Iterable<string>,
  ): Map<string, ContractResolution>;

  /** Return all registered applications */
  listApplications(): Application[];

  /** Look up a specific application by ID */
  getApplication(id: string): Application | undefined;

  /** Return all registered categories */
  listCategories(): ApplicationCategory[];
}

// ---------------------------------------------------------------------------
// InMemoryApplicationRegistry
// ---------------------------------------------------------------------------

export class InMemoryApplicationRegistry implements IApplicationRegistry {
  private readonly applications: Map<string, Application>;
  private readonly contracts: Map<string, ApplicationContract>; // key: lowercase address
  private readonly categories: Map<string, ApplicationCategory>;

  constructor(seed: {
    applications: Application[];
    contracts: ApplicationContract[];
    categories: ApplicationCategory[];
  }) {
    this.applications = new Map(seed.applications.map((a) => [a.id, a]));
    this.contracts = new Map(
      seed.contracts.map((c) => [c.address.toLowerCase(), c]),
    );
    this.categories = new Map(seed.categories.map((cat) => [cat.id, cat]));
  }

  resolveContract(address: string): ContractResolution {
    const key = address.toLowerCase();
    const contract = this.contracts.get(key);
    if (!contract) return { recognized: false, entry: null };

    const application = this.applications.get(contract.applicationId);
    if (!application) return { recognized: false, entry: null };

    const category = this.categories.get(application.categoryId);
    if (!category) return { recognized: false, entry: null };

    const entry: RegistryEntry = {
      contractAddress: key,
      application,
      contract,
      category,
    };

    return { recognized: true, entry };
  }

  resolveContracts(
    addresses: Iterable<string>,
  ): Map<string, ContractResolution> {
    const result = new Map<string, ContractResolution>();
    for (const addr of addresses) {
      result.set(addr.toLowerCase(), this.resolveContract(addr));
    }
    return result;
  }

  listApplications(): Application[] {
    return [...this.applications.values()];
  }

  getApplication(id: string): Application | undefined {
    return this.applications.get(id);
  }

  listCategories(): ApplicationCategory[] {
    return [...this.categories.values()];
  }
}
