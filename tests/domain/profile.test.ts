/**
 * tests/domain/profile.test.ts
 *
 * Unit tests for ProfileService.
 *
 * Uses a mock IActivityProvider to avoid live RPC calls.
 */

import { describe, it, expect } from 'bun:test';
import { ProfileService } from '../../server/domain/profile/ProfileService.js';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import { ActivityProviderError } from '../../server/data/IActivityProvider.js';
import type { IActivityProvider } from '../../server/data/IActivityProvider.js';
import type { NormalizedActivity } from '../../server/data/types.js';

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

class MockActivityProvider implements IActivityProvider {
  readonly name = 'MockProvider';
  private response: NormalizedActivity | null = null;
  private shouldThrow = false;

  setResponse(activity: NormalizedActivity) {
    this.response = activity;
    this.shouldThrow = false;
  }

  setThrow() {
    this.shouldThrow = true;
  }

  async getActivity(address: string): Promise<NormalizedActivity> {
    if (this.shouldThrow) {
      throw new ActivityProviderError('Mock provider error');
    }
    return (
      this.response ?? {
        address: address.toLowerCase(),
        chainId: 5042002,
        transactions: [],
        contractAddressesInteracted: new Set(),
        totalFetched: 0,
        mayBeTruncated: false,
        fetchedAt: new Date().toISOString(),
        providerName: 'MockProvider',
        dataQualityNotes: [],
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptyRegistry = new InMemoryApplicationRegistry({
  applications: [],
  contracts: [],
  categories: [],
});

const ADDRESS = '0xabc0000000000000000000000000000000000001';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileService', () => {
  it('builds a profile with the correct address', async () => {
    const provider = new MockActivityProvider();
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile(ADDRESS);
    expect(profile.address).toBe(ADDRESS.toLowerCase());
  });

  it('profile has the correct chain ID', async () => {
    const provider = new MockActivityProvider();
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile(ADDRESS);
    expect(profile.chainId).toBe(5042002);
  });

  it('profile has schemaVersion', async () => {
    const provider = new MockActivityProvider();
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile(ADDRESS);
    expect(profile.schemaVersion).toBeTruthy();
  });

  it('profile clearly separates activitySummary, signals, and credentials', async () => {
    const provider = new MockActivityProvider();
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile(ADDRESS);
    expect(Array.isArray(profile.signals)).toBe(true);
    expect(Array.isArray(profile.credentials)).toBe(true);
    expect(typeof profile.activitySummary).toBe('object');
  });

  it('profile has no score, rank, or trustworthiness field', async () => {
    const provider = new MockActivityProvider();
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile(ADDRESS);
    const profileKeys = Object.keys(profile);
    expect(profileKeys).not.toContain('score');
    expect(profileKeys).not.toContain('rank');
    expect(profileKeys).not.toContain('trustScore');
    expect(profileKeys).not.toContain('reputationScore');
  });

  it('empty wallet returns signals with appropriate statuses', async () => {
    const provider = new MockActivityProvider();
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile(ADDRESS);
    const txCountSignal = profile.signals.find((s) => s.key === 'transactionCount');
    expect(txCountSignal?.value).toBe(0);
  });

  it('propagates ActivityProviderError', async () => {
    const provider = new MockActivityProvider();
    provider.setThrow();
    const service = new ProfileService(provider, emptyRegistry);
    await expect(service.buildProfile(ADDRESS)).rejects.toThrow(ActivityProviderError);
  });

  it('activitySummary.dataQualityNotes is an array', async () => {
    const provider = new MockActivityProvider();
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile(ADDRESS);
    expect(Array.isArray(profile.activitySummary.dataQualityNotes)).toBe(true);
  });
});
