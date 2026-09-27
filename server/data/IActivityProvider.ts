/**
 * server/data/IActivityProvider.ts
 *
 * The single interface between the domain layer and any blockchain data source.
 *
 * Sole responsibility: fetch and normalize wallet activity.
 *
 * This interface must NOT:
 * - recognize applications
 * - calculate signals
 * - evaluate credentials
 * - make reputation judgments
 *
 * Implementations may use Arc RPC, Goldsky, a subgraph, or any other source
 * without requiring changes to the domain layer.
 */

import type { NormalizedActivity } from './types.js';

export interface ActivityProviderOptions {
  /**
   * Maximum number of transactions to retrieve per request.
   * Providers may enforce their own lower cap.
   */
  maxTransactions?: number;
}

export interface IActivityProvider {
  /** Human-readable name for this provider (used in providerName field) */
  readonly name: string;

  /**
   * Retrieve and normalize all available on-chain activity for a wallet address.
   *
   * @param address - EVM wallet address (checksummed or lowercase)
   * @param options - Optional retrieval parameters
   * @returns Normalized activity snapshot
   * @throws ActivityProviderError if the address is invalid or the provider is unreachable
   */
  getActivity(
    address: string,
    options?: ActivityProviderOptions,
  ): Promise<NormalizedActivity>;
}

/**
 * Thrown when the activity provider cannot fulfil a request.
 */
export class ActivityProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ActivityProviderError';
  }
}
