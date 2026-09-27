/**
 * server/domain/profile/ProfileService.ts
 *
 * Assembles a WalletProfile from all domain layers in sequence:
 *
 *   IActivityProvider.getActivity(address)
 *     -> ApplicationRegistry.resolveContracts(addresses)
 *        -> SignalEngine.calculate(activity, registry)
 *           -> CredentialService.evaluate(signals)
 *              -> WalletProfile
 *
 * The WalletProfile explicitly separates:
 *   - activitySummary: raw observable facts
 *   - signals: derived behavioral measurements
 *   - credentials: earned credentials
 *
 * There is NO score, NO rank, NO trustworthiness claim in the output.
 */

import type { IActivityProvider } from '../../data/IActivityProvider.js';
import type { IApplicationRegistry } from '../applications/ApplicationRegistry.js';
import { SignalEngine } from '../signals/SignalEngine.js';
import { CredentialService } from '../credentials/CredentialService.js';
import type { WalletProfile, WalletActivitySummary } from '../types.js';

export class ProfileService {
  private readonly signalEngine = new SignalEngine();
  private readonly credentialService = new CredentialService();

  constructor(
    private readonly provider: IActivityProvider,
    private readonly registry: IApplicationRegistry,
  ) {}

  async buildProfile(address: string): Promise<WalletProfile> {
    // Step 1: Fetch normalized on-chain activity
    const activity = await this.provider.getActivity(address);

    // Step 2: Build raw activity summary (no derivation)
    const activitySummary: WalletActivitySummary = {
      address: activity.address,
      chainId: activity.chainId,
      transactionCount: activity.totalFetched,
      uniqueContractAddresses: [...activity.contractAddressesInteracted],
      earliestTimestamp: activity.earliestTimestamp,
      latestTimestamp: activity.latestTimestamp,
      mayBeTruncated: activity.mayBeTruncated,
      fetchedAt: activity.fetchedAt,
      providerName: activity.providerName,
      dataQualityNotes: activity.dataQualityNotes,
    };

    // Step 3: Calculate signals (activity + registry, no blockchain reads)
    const signals = this.signalEngine.calculate(activity, this.registry);

    // Step 4: Evaluate credentials (signals only, no blockchain reads)
    const credentials = this.credentialService.evaluate(signals);

    // Step 5: Assemble profile
    const profile: WalletProfile = {
      address: activity.address,
      chainId: activity.chainId,
      activitySummary,
      signals,
      credentials,
      profileBuiltAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
    };

    return profile;
  }
}
