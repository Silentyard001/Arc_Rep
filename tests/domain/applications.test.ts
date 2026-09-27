/**
 * tests/domain/applications.test.ts
 *
 * Unit tests for the application registry.
 *
 * Edge cases:
 * - Recognized contract lookup
 * - Unknown contract
 * - Case-insensitive address matching
 * - Multiple contracts per application
 * - Bulk resolution
 * - Registry enumeration
 */

import { describe, it, expect } from 'bun:test';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import type { Application, ApplicationContract, ApplicationCategory } from '../../server/domain/applications/types.js';
import type { ContractSourceType } from '../../server/domain/applications/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const categories: ApplicationCategory[] = [
  { id: 'defi', label: 'DeFi', description: 'DeFi protocols' },
  { id: 'bridge', label: 'Bridge', description: 'Bridge protocols' },
];

const applications: Application[] = [
  {
    id: 'app-one',
    name: 'App One',
    description: 'First app',
    categoryId: 'defi',
    isVerified: true,
    addedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'app-two',
    name: 'App Two',
    description: 'Second app',
    categoryId: 'bridge',
    isVerified: false,
    addedAt: '2024-01-02T00:00:00Z',
  },
];

// Suppress unused import warning — ContractSourceType is used inline below
const _sourceTypeCheck: ContractSourceType = 'official-docs';
void _sourceTypeCheck;

const contracts: ApplicationContract[] = [
  {
    address: '0xaaaa000000000000000000000000000000000001',
    applicationId: 'app-one',
    label: 'App One Main Contract',
    isVerified: true,
    sourceType: 'official-docs',
    sourceRef: 'test fixture',
    addedAt: '2024-01-01T00:00:00Z',
  },
  {
    address: '0xaaaa000000000000000000000000000000000002',
    applicationId: 'app-one',
    label: 'App One Secondary Contract',
    isVerified: true,
    sourceType: 'official-docs',
    sourceRef: 'test fixture',
    addedAt: '2024-01-01T00:00:00Z',
  },
  {
    address: '0xbbbb000000000000000000000000000000000001',
    applicationId: 'app-two',
    label: 'App Two Contract',
    isVerified: false,
    sourceType: 'unverified',
    sourceRef: 'test fixture — unverified candidate',
    addedAt: '2024-01-02T00:00:00Z',
  },
];

function makeRegistry() {
  return new InMemoryApplicationRegistry({ applications, contracts, categories });
}

// ---------------------------------------------------------------------------
// resolveContract
// ---------------------------------------------------------------------------

describe('InMemoryApplicationRegistry.resolveContract', () => {
  it('resolves a known contract', () => {
    const registry = makeRegistry();
    const result = registry.resolveContract(contracts[0].address);
    expect(result.recognized).toBe(true);
    if (result.recognized) {
      expect(result.entry.application.id).toBe('app-one');
      expect(result.entry.contract.address).toBe(contracts[0].address);
      expect(result.entry.category.id).toBe('defi');
    }
  });

  it('returns not-recognized for an unknown contract', () => {
    const registry = makeRegistry();
    const result = registry.resolveContract('0xdeadbeef00000000000000000000000000000000');
    expect(result.recognized).toBe(false);
    expect(result.entry).toBeNull();
  });

  it('is case-insensitive (checksummed address)', () => {
    const registry = makeRegistry();
    // Use mixed-case version of the first contract address
    const checksummed = contracts[0].address.replace(/a/g, 'A');
    const result = registry.resolveContract(checksummed);
    expect(result.recognized).toBe(true);
  });

  it('two contracts of the same application both resolve', () => {
    const registry = makeRegistry();
    const r1 = registry.resolveContract(contracts[0].address);
    const r2 = registry.resolveContract(contracts[1].address);
    expect(r1.recognized).toBe(true);
    expect(r2.recognized).toBe(true);
    if (r1.recognized && r2.recognized) {
      expect(r1.entry.application.id).toBe(r2.entry.application.id);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveContracts (bulk)
// ---------------------------------------------------------------------------

describe('InMemoryApplicationRegistry.resolveContracts', () => {
  it('resolves a mix of known and unknown addresses', () => {
    const registry = makeRegistry();
    const addresses = [
      contracts[0].address,
      '0xunknown0000000000000000000000000000000a',
      contracts[2].address,
    ];
    const result = registry.resolveContracts(addresses);

    expect(result.get(contracts[0].address)?.recognized).toBe(true);
    expect(result.get('0xunknown0000000000000000000000000000000a')?.recognized).toBe(false);
    expect(result.get(contracts[2].address)?.recognized).toBe(true);
  });

  it('returns an entry for every input address', () => {
    const registry = makeRegistry();
    const addresses = ['0xabc', '0xdef'];
    const result = registry.resolveContracts(addresses);
    expect(result.size).toBe(2);
  });

  it('empty input returns empty map', () => {
    const registry = makeRegistry();
    const result = registry.resolveContracts([]);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listApplications / getApplication
// ---------------------------------------------------------------------------

describe('InMemoryApplicationRegistry.listApplications', () => {
  it('returns all registered applications', () => {
    const registry = makeRegistry();
    const list = registry.listApplications();
    expect(list.length).toBe(2);
    const ids = list.map((a) => a.id);
    expect(ids).toContain('app-one');
    expect(ids).toContain('app-two');
  });
});

describe('InMemoryApplicationRegistry.getApplication', () => {
  it('returns application by id', () => {
    const registry = makeRegistry();
    const app = registry.getApplication('app-one');
    expect(app?.name).toBe('App One');
  });

  it('returns undefined for unknown id', () => {
    const registry = makeRegistry();
    const app = registry.getApplication('nonexistent');
    expect(app).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listCategories
// ---------------------------------------------------------------------------

describe('InMemoryApplicationRegistry.listCategories', () => {
  it('returns all registered categories', () => {
    const registry = makeRegistry();
    const list = registry.listCategories();
    expect(list.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Trust boundary: unknown contracts never become recognized applications
// ---------------------------------------------------------------------------

describe('Application registry trust boundary', () => {
  it('does not treat an unknown contract as a recognized application even under bulk lookup', () => {
    const registry = makeRegistry();
    const unknownAddresses = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
    ];
    const results = registry.resolveContracts(unknownAddresses);
    for (const [, resolution] of results) {
      expect(resolution.recognized).toBe(false);
    }
  });
});
