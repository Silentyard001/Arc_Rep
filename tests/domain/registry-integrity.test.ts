/**
 * tests/domain/registry-integrity.test.ts
 *
 * Registry integrity and provenance tests (Phase 4).
 *
 * Tests validate:
 *  1. Address normalization — all registered addresses are valid EVM format
 *  2. No duplicate contract addresses
 *  3. Every contract references a valid application
 *  4. Every application references a valid category
 *  5. Provenance completeness — every verified entry has sourceType and sourceRef
 *  6. Case-insensitive lookup works for every seeded address
 *  7. Mixed-case lookup resolves correctly
 *  8. Unknown addresses return not-recognized
 *  9. Signal integration — uniqueApplications and applicationDiversity
 *     reflect the expanded registry correctly
 * 10. Isolation — an unknown contract does NOT become an application
 */

import { describe, it, expect } from 'bun:test';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import { SEED_APPLICATIONS, SEED_CONTRACTS, SEED_CATEGORIES } from '../../server/domain/applications/seed-data.js';
import { calculateUniqueApplications } from '../../server/domain/signals/calculators/breadth.js';
import { calculateApplicationDiversity } from '../../server/domain/signals/calculators/diversity.js';
import type { NormalizedActivity } from '../../server/data/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeedRegistry() {
  return new InMemoryApplicationRegistry({
    applications: SEED_APPLICATIONS,
    contracts: SEED_CONTRACTS,
    categories: SEED_CATEGORIES,
  });
}

/** Minimal NormalizedActivity for signal tests */
function makeActivity(overrides: Partial<NormalizedActivity> = {}): NormalizedActivity {
  return {
    address: '0xwallet00000000000000000000000000000000aa',
    chainId: 5042002,
    transactions: [],
    contractAddressesInteracted: new Set(),
    totalFetched: 0,
    mayBeTruncated: false,
    fetchedAt: new Date().toISOString(),
    providerName: 'test',
    dataQualityNotes: [],
    ...overrides,
  };
}

const EVM_ADDRESS_REGEX = /^0x[0-9a-f]{40}$/;
const VALID_SOURCE_TYPES = new Set([
  'official-docs',
  'onchain-facts',
  'onchain-verified',
  'team-confirmation',
  'unverified',
]);

// ---------------------------------------------------------------------------
// 1. Address normalization
// ---------------------------------------------------------------------------

describe('Registry integrity: address normalization', () => {
  it('every registered contract address is lowercase and matches EVM format', () => {
    for (const contract of SEED_CONTRACTS) {
      expect(EVM_ADDRESS_REGEX.test(contract.address)).toBe(true);
      expect(contract.address).toBe(contract.address.toLowerCase());
    }
  });

  it('every application has a non-empty id and name', () => {
    for (const app of SEED_APPLICATIONS) {
      expect(app.id.length).toBeGreaterThan(0);
      expect(app.name.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No duplicate addresses
// ---------------------------------------------------------------------------

describe('Registry integrity: no duplicate contract addresses', () => {
  it('no two contracts have the same address', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const contract of SEED_CONTRACTS) {
      if (seen.has(contract.address)) {
        duplicates.push(contract.address);
      }
      seen.add(contract.address);
    }
    expect(duplicates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Every contract references a valid application
// ---------------------------------------------------------------------------

describe('Registry integrity: application references', () => {
  it('every contract applicationId references a known application', () => {
    const appIds = new Set(SEED_APPLICATIONS.map((a) => a.id));
    const invalid: string[] = [];
    for (const contract of SEED_CONTRACTS) {
      if (!appIds.has(contract.applicationId)) {
        invalid.push(`${contract.address} -> ${contract.applicationId}`);
      }
    }
    expect(invalid).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Every application references a valid category
// ---------------------------------------------------------------------------

describe('Registry integrity: category references', () => {
  it('every application categoryId references a known category', () => {
    const catIds = new Set(SEED_CATEGORIES.map((c) => c.id));
    const invalid: string[] = [];
    for (const app of SEED_APPLICATIONS) {
      if (!catIds.has(app.categoryId)) {
        invalid.push(`${app.id} -> ${app.categoryId}`);
      }
    }
    expect(invalid).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Provenance completeness
// ---------------------------------------------------------------------------

describe('Registry integrity: provenance completeness', () => {
  it('every contract has a non-empty sourceType from the allowed set', () => {
    for (const contract of SEED_CONTRACTS) {
      expect(VALID_SOURCE_TYPES.has(contract.sourceType)).toBe(true);
    }
  });

  it('every contract has a non-empty sourceRef', () => {
    for (const contract of SEED_CONTRACTS) {
      expect(contract.sourceRef.length).toBeGreaterThan(0);
    }
  });

  it('every verified contract has sourceType !== "unverified"', () => {
    const badVerified: string[] = [];
    for (const contract of SEED_CONTRACTS) {
      if (contract.isVerified && contract.sourceType === 'unverified') {
        badVerified.push(contract.address);
      }
    }
    expect(badVerified).toEqual([]);
  });

  it('resolved RegistryEntry carries sourceType and sourceRef on the contract', () => {
    const registry = makeSeedRegistry();
    const first = SEED_CONTRACTS[0];
    const result = registry.resolveContract(first.address);
    expect(result.recognized).toBe(true);
    if (result.recognized) {
      expect(VALID_SOURCE_TYPES.has(result.entry.contract.sourceType)).toBe(true);
      expect(result.entry.contract.sourceRef.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Phase 4 counts — updated to reflect expanded registry
// ---------------------------------------------------------------------------

describe('Registry counts after Phase 4 expansion', () => {
  it('has exactly 9 applications registered', () => {
    const registry = makeSeedRegistry();
    expect(registry.listApplications().length).toBe(9);
  });

  it('has exactly 17 contracts registered', () => {
    // 1 USDC + 1 EURC + 1 USYC
    // + 5 CCTP (TokenMessengerV2, MessageTransmitterV2, TokenMinterV2, MessageV2, BridgingKitContract)
    // + 2 Gateway (Wallet, Minter)
    // + 1 StableFX (FxEscrow)
    // + 2 TxExtensions (Memo, Multicall3From)
    // + 3 AgentRegistry (IdentityRegistry, ReputationRegistry, ValidationRegistry)
    // + 1 AgenticCommerce
    // = 17 total
    expect(SEED_CONTRACTS.length).toBe(17);
  });

  it('has exactly 9 categories registered', () => {
    const registry = makeSeedRegistry();
    expect(registry.listCategories().length).toBe(9);
  });

  it('all 9 applications are isVerified: true', () => {
    for (const app of SEED_APPLICATIONS) {
      expect(app.isVerified).toBe(true);
    }
  });

  it('all 17 contracts are isVerified: true', () => {
    for (const contract of SEED_CONTRACTS) {
      expect(contract.isVerified).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Case-insensitive lookup for all seeded contracts
// ---------------------------------------------------------------------------

describe('Registry lookup: case-insensitive for all seeded contracts', () => {
  it('every seeded address resolves correctly in uppercase', () => {
    const registry = makeSeedRegistry();
    for (const contract of SEED_CONTRACTS) {
      const upper = contract.address.toUpperCase();
      const result = registry.resolveContract(upper);
      expect(result.recognized).toBe(true);
    }
  });

  it('every seeded address resolves correctly in mixed case', () => {
    const registry = makeSeedRegistry();
    // Alternate upper/lower chars
    for (const contract of SEED_CONTRACTS) {
      const mixed = contract.address
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join('');
      const result = registry.resolveContract(mixed);
      expect(result.recognized).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Unknown addresses return not-recognized
// ---------------------------------------------------------------------------

describe('Registry trust boundary: unknown addresses', () => {
  it('a completely unknown address returns recognized: false', () => {
    const registry = makeSeedRegistry();
    const result = registry.resolveContract('0xdeadbeef00000000000000000000000000000000');
    expect(result.recognized).toBe(false);
    expect(result.entry).toBeNull();
  });

  it('bulk resolution of unknown addresses all return recognized: false', () => {
    const registry = makeSeedRegistry();
    const unknowns = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
    ];
    const results = registry.resolveContracts(unknowns);
    for (const [, resolution] of results) {
      expect(resolution.recognized).toBe(false);
      expect(resolution.entry).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Multiple contracts resolve to the same application
// ---------------------------------------------------------------------------

describe('Registry: multiple contracts map to same application', () => {
  it('all 5 CCTP contracts resolve to circle-cctp', () => {
    const registry = makeSeedRegistry();
    const cctpContracts = SEED_CONTRACTS.filter(
      (c) => c.applicationId === 'circle-cctp',
    );
    expect(cctpContracts.length).toBe(5);
    for (const contract of cctpContracts) {
      const result = registry.resolveContract(contract.address);
      expect(result.recognized).toBe(true);
      if (result.recognized) {
        expect(result.entry.application.id).toBe('circle-cctp');
      }
    }
  });

  it('all 3 ERC-8004 registries resolve to arc-agent-registry', () => {
    const registry = makeSeedRegistry();
    const agentContracts = SEED_CONTRACTS.filter(
      (c) => c.applicationId === 'arc-agent-registry',
    );
    expect(agentContracts.length).toBe(3);
    for (const contract of agentContracts) {
      const result = registry.resolveContract(contract.address);
      expect(result.recognized).toBe(true);
      if (result.recognized) {
        expect(result.entry.application.id).toBe('arc-agent-registry');
      }
    }
  });

  it('both Gateway contracts resolve to circle-gateway', () => {
    const registry = makeSeedRegistry();
    const gwContracts = SEED_CONTRACTS.filter(
      (c) => c.applicationId === 'circle-gateway',
    );
    expect(gwContracts.length).toBe(2);
    for (const contract of gwContracts) {
      const result = registry.resolveContract(contract.address);
      expect(result.recognized).toBe(true);
      if (result.recognized) {
        expect(result.entry.application.id).toBe('circle-gateway');
      }
    }
  });

  it('both tx-extension contracts resolve to arc-tx-extensions', () => {
    const registry = makeSeedRegistry();
    const txContracts = SEED_CONTRACTS.filter(
      (c) => c.applicationId === 'arc-tx-extensions',
    );
    expect(txContracts.length).toBe(2);
    for (const contract of txContracts) {
      const result = registry.resolveContract(contract.address);
      expect(result.recognized).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Signal integration: uniqueApplications and applicationDiversity
// ---------------------------------------------------------------------------

describe('Signal integration with expanded registry', () => {
  it('wallet that interacted with USDC + CCTP TokenMessenger + Gateway = 3 unique applications', () => {
    const registry = makeSeedRegistry();
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        '0x3600000000000000000000000000000000000000', // arc-usdc
        '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // circle-cctp
        '0x0077777d7eba4688bdef3e311b846f25870a19b9', // circle-gateway
      ]),
    });
    const signal = calculateUniqueApplications(activity, registry);
    expect(signal.value).toBe(3);
    expect(signal.status).toBe('available');
  });

  it('wallet that used two CCTP contracts counts as 1 application, not 2', () => {
    const registry = makeSeedRegistry();
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // circle-cctp TokenMessengerV2
        '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // circle-cctp MessageTransmitterV2
      ]),
    });
    const signal = calculateUniqueApplications(activity, registry);
    // Both contracts belong to circle-cctp → 1 unique application
    expect(signal.value).toBe(1);
  });

  it('applicationDiversity with 1 recognized out of 1 contract = 1.0', () => {
    const registry = makeSeedRegistry();
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        '0x3600000000000000000000000000000000000000', // arc-usdc
      ]),
    });
    const signal = calculateApplicationDiversity(activity, registry);
    expect(signal.value).toBe(1.0);
  });

  it('applicationDiversity with 0 recognized out of 1 unknown contract = 0.0', () => {
    const registry = makeSeedRegistry();
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        '0xdeadbeef00000000000000000000000000000001',
      ]),
    });
    const signal = calculateApplicationDiversity(activity, registry);
    expect(signal.value).toBe(0.0);
  });

  it('applicationDiversity correctly mixes recognized and unknown contracts', () => {
    const registry = makeSeedRegistry();
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        '0x3600000000000000000000000000000000000000', // arc-usdc (recognized)
        '0xdeadbeef00000000000000000000000000000001', // unknown
        '0xdeadbeef00000000000000000000000000000002', // unknown
      ]),
    });
    const signal = calculateApplicationDiversity(activity, registry);
    // 1 recognized app / 3 total contracts ≈ 0.333
    expect(typeof signal.value).toBe('number');
    expect((signal.value as number)).toBeCloseTo(1 / 3, 3);
  });

  it('unknown contract does NOT become an application in uniqueApplications', () => {
    const registry = makeSeedRegistry();
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        '0xdeadbeef00000000000000000000000000000001',
        '0xdeadbeef00000000000000000000000000000002',
      ]),
    });
    const signal = calculateUniqueApplications(activity, registry);
    // Unknown contracts must never be promoted to recognized applications
    expect(signal.value).toBe(0);
  });

  it('wallet interacting with all three ERC-8004 registries counts as 1 application', () => {
    const registry = makeSeedRegistry();
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        '0x8004a818bfb912233c491871b3d84c89a494bd9e', // IdentityRegistry
        '0x8004b663056a597dffe9eccc1965a193b7388713', // ReputationRegistry
        '0x8004cb1bf31daf7788923b405b754f57aceb4272', // ValidationRegistry
      ]),
    });
    const signal = calculateUniqueApplications(activity, registry);
    // All three belong to arc-agent-registry → 1 unique application
    expect(signal.value).toBe(1);
  });
});
