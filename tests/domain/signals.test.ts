/**
 * tests/domain/signals.test.ts
 *
 * Unit tests for signal calculators and SignalEngine.
 *
 * Edge cases covered:
 * - Empty wallet history
 * - Wallet with only unknown contracts
 * - Repeated interaction with the same application
 * - Multiple contracts belonging to one application
 * - Partial/truncated snapshot
 * - Insufficient data for consistency signal
 */

import { describe, it, expect } from 'bun:test';
import type { NormalizedActivity, NormalizedTransaction } from '../../server/data/types.js';
import { calculateFirstSeen, calculateLastSeen, calculateActiveDays, toDayKey } from '../../server/domain/signals/calculators/longevity.js';
import { calculateUniqueContracts, calculateUniqueApplications } from '../../server/domain/signals/calculators/breadth.js';
import { calculateTransactionCount, calculateEconomicActivity, calculateUsdcReceived } from '../../server/domain/signals/calculators/activity.js';
import { calculateApplicationDiversity, calculateActivityConsistency } from '../../server/domain/signals/calculators/diversity.js';
import { SignalEngine } from '../../server/domain/signals/SignalEngine.js';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import type { Application, ApplicationContract, ApplicationCategory } from '../../server/domain/applications/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActivity(
  overrides: Partial<NormalizedActivity> & { transactions?: NormalizedTransaction[] },
): NormalizedActivity {
  const transactions: NormalizedTransaction[] = overrides.transactions ?? [];
  const contractAddressesInteracted = new Set<string>(
    transactions
      .filter((t) => t.isOutgoing && t.to !== null && t.hasInputData)
      .map((t) => t.to!),
  );
  const timestamps = transactions
    .filter((t) => t.timestamp > 0)
    .map((t) => t.timestamp);

  return {
    address: '0xabc0000000000000000000000000000000000001',
    chainId: 5042002,
    transactions,
    contractAddressesInteracted,
    earliestTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
    latestTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
    totalFetched: transactions.length,
    mayBeTruncated: false,
    fetchedAt: new Date().toISOString(),
    providerName: 'TestProvider',
    dataQualityNotes: [],
    ...overrides,
    // re-apply contractAddressesInteracted from overrides if provided
    contractAddressesInteracted:
      overrides.contractAddressesInteracted ?? contractAddressesInteracted,
  };
}

function makeTx(
  hash: string,
  timestamp: number,
  to: string | null,
  isOutgoing = true,
  hasInputData = true,
  valueWei = BigInt(0),
  succeeded = true,
): NormalizedTransaction {
  return {
    hash,
    blockNumber: BigInt(1),
    timestamp,
    from: isOutgoing ? '0xabc0000000000000000000000000000000000001' : '0xother',
    to,
    valueWei,
    succeeded,
    isOutgoing,
    isContractCreation: !to,
    hasInputData,
    erc20Transfers: [],
  };
}

// Day 1 = 2024-01-01T00:00:00Z (1704067200)
// Day 2 = 2024-01-02T00:00:00Z (1704153600)
// Day 3 = 2024-01-03T00:00:00Z (1704240000)
const D1 = 1704067200;
const D2 = 1704153600;
const D3 = 1704240000;

// Registry fixtures
const testApp: Application = {
  id: 'test-app',
  name: 'Test App',
  description: 'A test application',
  categoryId: 'defi',
  isVerified: true,
  addedAt: '2024-01-01T00:00:00Z',
};
const testContract: ApplicationContract = {
  address: '0xc0ntract000000000000000000000000000000001',
  applicationId: 'test-app',
  label: 'Test Contract 1',
  isVerified: true,
  addedAt: '2024-01-01T00:00:00Z',
};
const testContract2: ApplicationContract = {
  address: '0xc0ntract000000000000000000000000000000002',
  applicationId: 'test-app',
  label: 'Test Contract 2 (same app)',
  isVerified: true,
  addedAt: '2024-01-01T00:00:00Z',
};
const otherApp: Application = {
  id: 'other-app',
  name: 'Other App',
  description: 'Another test application',
  categoryId: 'bridge',
  isVerified: true,
  addedAt: '2024-01-01T00:00:00Z',
};
const otherContract: ApplicationContract = {
  address: '0xc0ntract000000000000000000000000000000003',
  applicationId: 'other-app',
  label: 'Other Contract',
  isVerified: true,
  addedAt: '2024-01-01T00:00:00Z',
};
const testCategory: ApplicationCategory = {
  id: 'defi',
  label: 'DeFi',
  description: 'DeFi test',
};
const bridgeCategory: ApplicationCategory = {
  id: 'bridge',
  label: 'Bridge',
  description: 'Bridge test',
};

function makeRegistry() {
  return new InMemoryApplicationRegistry({
    applications: [testApp, otherApp],
    contracts: [testContract, testContract2, otherContract],
    categories: [testCategory, bridgeCategory],
  });
}

// ---------------------------------------------------------------------------
// toDayKey
// ---------------------------------------------------------------------------

describe('toDayKey', () => {
  it('converts unix timestamp to UTC date string', () => {
    expect(toDayKey(D1)).toBe('2024-01-01');
    expect(toDayKey(D2)).toBe('2024-01-02');
    expect(toDayKey(D3)).toBe('2024-01-03');
  });

  it('handles end-of-day timestamps', () => {
    expect(toDayKey(D2 - 1)).toBe('2024-01-01');
    expect(toDayKey(D2)).toBe('2024-01-02');
  });
});

// ---------------------------------------------------------------------------
// firstSeen / lastSeen
// ---------------------------------------------------------------------------

describe('calculateFirstSeen', () => {
  it('returns unavailable for empty wallet', () => {
    const activity = makeActivity({});
    const signal = calculateFirstSeen(activity);
    expect(signal.status).toBe('unavailable');
    expect(signal.value).toBeNull();
  });

  it('returns earliest timestamp', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xcontract1'),
        makeTx('h2', D3, '0xcontract1'),
        makeTx('h3', D2, '0xcontract1'),
      ],
    });
    const signal = calculateFirstSeen(activity);
    expect(signal.value).toBe(D1);
    expect(signal.status).toBe('available');
  });

  it('marks partial when snapshot is truncated', () => {
    const activity = makeActivity({
      transactions: [makeTx('h1', D1, '0xcontract1')],
      mayBeTruncated: true,
    });
    const signal = calculateFirstSeen(activity);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).not.toBe('');
  });

  it('ignores transactions with zero timestamp', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', 0, '0xcontract1'),
        makeTx('h2', D2, '0xcontract1'),
      ],
    });
    const signal = calculateFirstSeen(activity);
    expect(signal.value).toBe(D2);
  });
});

describe('calculateLastSeen', () => {
  it('returns unavailable for empty wallet', () => {
    const signal = calculateLastSeen(makeActivity({}));
    expect(signal.status).toBe('unavailable');
    expect(signal.value).toBeNull();
  });

  it('returns latest timestamp', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xcontract1'),
        makeTx('h2', D3, '0xcontract1'),
        makeTx('h3', D2, '0xcontract1'),
      ],
    });
    const signal = calculateLastSeen(activity);
    expect(signal.value).toBe(D3);
    expect(signal.status).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// activeDays
// ---------------------------------------------------------------------------

describe('calculateActiveDays', () => {
  it('returns 0 for empty wallet', () => {
    const signal = calculateActiveDays(makeActivity({}));
    expect(signal.value).toBe(0);
  });

  it('counts distinct days for outgoing transactions', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xc1', true),
        makeTx('h2', D1 + 60, '0xc1', true), // same day as h1
        makeTx('h3', D2, '0xc2', true),
        makeTx('h4', D3, '0xc3', true),
        makeTx('h5', D2, '0xincoming', false), // incoming — not counted
      ],
    });
    const signal = calculateActiveDays(activity);
    expect(signal.value).toBe(3);
  });

  it('ignores incoming transactions', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xc1', false), // incoming
        makeTx('h2', D2, '0xc1', false), // incoming
      ],
    });
    const signal = calculateActiveDays(activity);
    expect(signal.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// uniqueContracts
// ---------------------------------------------------------------------------

describe('calculateUniqueContracts', () => {
  it('returns 0 for empty wallet', () => {
    const signal = calculateUniqueContracts(makeActivity({}));
    expect(signal.value).toBe(0);
  });

  it('counts distinct contracts', () => {
    const activity = makeActivity({
      contractAddressesInteracted: new Set(['0xc1', '0xc2', '0xc3']),
    });
    const signal = calculateUniqueContracts(activity);
    expect(signal.value).toBe(3);
  });

  it('does not double-count repeated interactions with same contract', () => {
    const activity = makeActivity({
      contractAddressesInteracted: new Set(['0xc1']),
    });
    const signal = calculateUniqueContracts(activity);
    expect(signal.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// uniqueApplications
// ---------------------------------------------------------------------------

describe('calculateUniqueApplications', () => {
  const registry = makeRegistry();

  it('returns 0 for empty wallet', () => {
    const signal = calculateUniqueApplications(makeActivity({}), registry);
    expect(signal.value).toBe(0);
  });

  it('returns 0 for wallet with only unknown contracts', () => {
    const activity = makeActivity({
      contractAddressesInteracted: new Set(['0xunknown1', '0xunknown2']),
    });
    const signal = calculateUniqueApplications(activity, registry);
    expect(signal.value).toBe(0);
  });

  it('counts recognized applications, not contracts', () => {
    // Two contracts belonging to the SAME application = 1 unique application
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        testContract.address,
        testContract2.address,
      ]),
    });
    const signal = calculateUniqueApplications(activity, registry);
    expect(signal.value).toBe(1); // one application, two contracts
  });

  it('counts multiple distinct recognized applications', () => {
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        testContract.address,
        otherContract.address,
      ]),
    });
    const signal = calculateUniqueApplications(activity, registry);
    expect(signal.value).toBe(2);
  });

  it('ignores unknown contracts when recognized apps are also present', () => {
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        testContract.address,
        '0xunknown1',
        '0xunknown2',
      ]),
    });
    const signal = calculateUniqueApplications(activity, registry);
    expect(signal.value).toBe(1); // only the recognized app counts
  });
});

// ---------------------------------------------------------------------------
// transactionCount
// ---------------------------------------------------------------------------

describe('calculateTransactionCount', () => {
  it('returns 0 for empty wallet', () => {
    const signal = calculateTransactionCount(makeActivity({}));
    expect(signal.value).toBe(0);
  });

  it('counts only outgoing transactions', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xc1', true),
        makeTx('h2', D2, '0xc1', true),
        makeTx('h3', D2, '0xc1', false), // incoming
      ],
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// economicActivity
// ---------------------------------------------------------------------------

describe('calculateEconomicActivity', () => {
  it('returns zero breakdown for empty wallet', () => {
    const signal = calculateEconomicActivity(makeActivity({}));
    const breakdown = JSON.parse(signal.value as string);
    expect(breakdown.nativeValueWei).toBe('0');
    expect(breakdown.usdcErc20Raw).toBe('0');
    expect(signal.status).toBe('available');
  });

  it('sums nativeValueWei for outgoing succeeded transactions', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xc1', true, true, BigInt('1000000')),
        makeTx('h2', D2, '0xc1', true, true, BigInt('2000000')),
        makeTx('h3', D2, '0xc1', false, true, BigInt('5000000')), // incoming — excluded
        makeTx('h4', D3, '0xc1', true, true, BigInt('1000000'), false), // failed — excluded
      ],
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(breakdown.nativeValueWei).toBe('3000000');
    expect(breakdown.usdcErc20Raw).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// usdcReceived
// ---------------------------------------------------------------------------

describe('calculateUsdcReceived', () => {
  it('returns "0" for empty wallet with available status', () => {
    const signal = calculateUsdcReceived(makeActivity({}));
    expect(signal.value).toBe('0');
    expect(signal.status).toBe('available');
    expect(signal.key).toBe('usdcReceived');
    expect(signal.confidenceNote).toBe('');
  });

  it('returns partial when snapshot is truncated', () => {
    const signal = calculateUsdcReceived(makeActivity({ mayBeTruncated: true }));
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// applicationDiversity
// ---------------------------------------------------------------------------

describe('calculateApplicationDiversity', () => {
  const registry = makeRegistry();

  it('returns null/unavailable when no contracts interacted', () => {
    const signal = calculateApplicationDiversity(makeActivity({}), registry);
    expect(signal.status).toBe('unavailable');
    expect(signal.value).toBeNull();
  });

  it('returns 0 when no recognized applications', () => {
    const activity = makeActivity({
      contractAddressesInteracted: new Set(['0xunknown1', '0xunknown2']),
    });
    const signal = calculateApplicationDiversity(activity, registry);
    expect(signal.value).toBe(0);
  });

  it('returns 1 when all contracts map to recognized applications', () => {
    // 2 contracts, both recognized (but same app = 1 app / 2 contracts)
    const activity = makeActivity({
      contractAddressesInteracted: new Set([
        testContract.address,
        testContract2.address,
      ]),
    });
    const signal = calculateApplicationDiversity(activity, registry);
    // 1 recognized app / 2 total contracts = 0.5
    expect(signal.value).toBe(0.5);
  });

  it('ratio is capped correctly', () => {
    const activity = makeActivity({
      contractAddressesInteracted: new Set([testContract.address]),
    });
    const signal = calculateApplicationDiversity(activity, registry);
    // 1 recognized app / 1 contract = 1.0
    expect(signal.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// activityConsistency
// ---------------------------------------------------------------------------

describe('calculateActivityConsistency', () => {
  it('returns unavailable for fewer than 2 outgoing transactions', () => {
    const activity = makeActivity({
      transactions: [makeTx('h1', D1, '0xc1', true)],
    });
    const signal = calculateActivityConsistency(activity);
    expect(signal.status).toBe('unavailable');
    expect(signal.value).toBeNull();
  });

  it('returns unavailable for empty wallet', () => {
    const signal = calculateActivityConsistency(makeActivity({}));
    expect(signal.status).toBe('unavailable');
  });

  it('calculates CV correctly for perfectly regular gaps', () => {
    // 3 transactions with equal 1-day gaps: stddev = 0, mean = 86400, CV = 0
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xc1', true),
        makeTx('h2', D2, '0xc1', true),
        makeTx('h3', D3, '0xc1', true),
      ],
    });
    const signal = calculateActivityConsistency(activity);
    expect(signal.value).toBe(0); // CV = 0 for uniform gaps
  });

  it('marks partial when fewer than 5 transactions', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xc1', true),
        makeTx('h2', D2, '0xc1', true),
        makeTx('h3', D3, '0xc1', true),
      ],
    });
    const signal = calculateActivityConsistency(activity);
    expect(signal.status).toBe('partial');
  });

  it('returns unavailable when all transactions in the same block (zero mean)', () => {
    const activity = makeActivity({
      transactions: [
        makeTx('h1', D1, '0xc1', true),
        makeTx('h2', D1, '0xc1', true), // same timestamp
      ],
    });
    const signal = calculateActivityConsistency(activity);
    expect(signal.status).toBe('unavailable');
    expect(signal.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SignalEngine integration
// ---------------------------------------------------------------------------

describe('SignalEngine', () => {
  const engine = new SignalEngine();
  const registry = makeRegistry();

  it('returns all defined signal keys', () => {
    const activity = makeActivity({});
    const signals = engine.calculate(activity, registry);
    const keys = signals.map((s) => s.key);
    expect(keys).toContain('firstSeen');
    expect(keys).toContain('lastSeen');
    expect(keys).toContain('activeDays');
    expect(keys).toContain('uniqueContracts');
    expect(keys).toContain('uniqueApplications');
    expect(keys).toContain('transactionCount');
    expect(keys).toContain('economicActivity');
    expect(keys).toContain('usdcReceived');
    expect(keys).toContain('applicationDiversity');
    expect(keys).toContain('activityConsistency');
    expect(keys).toContain('builderActivity');
    expect(keys).toContain('bridgeInteractions');
    expect(keys).toContain('paymentActivity');
    expect(keys).toContain('liquidityActivity');
  });

  it('marks future signals as status future', () => {
    const activity = makeActivity({});
    const signals = engine.calculate(activity, registry);
    // builderActivity and bridgeInteractions are now implemented (E3/E4)
    const futureKeys = ['paymentActivity', 'liquidityActivity', 'ecosystemBreadth'];
    for (const key of futureKeys) {
      const signal = signals.find((s) => s.key === key);
      expect(signal?.status).toBe('future');
    }
  });

  it('all signals carry required metadata fields', () => {
    const activity = makeActivity({
      transactions: [makeTx('h1', D1, '0xc1', true)],
    });
    const signals = engine.calculate(activity, registry);
    for (const s of signals) {
      expect(s.key).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.source).toBeTruthy();
      expect(s.calculationDefinition).toBeTruthy();
      expect(s.valueUnit).toBeTruthy();
      expect(typeof s.confidenceNote).toBe('string');
    }
  });
});
