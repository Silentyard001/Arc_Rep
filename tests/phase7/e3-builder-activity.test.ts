/**
 * tests/phase7/e3-builder-activity.test.ts
 *
 * E3 — builderActivity signal calculator and ARC_BUILDER credential.
 *
 * Tests:
 *   - Wallet with contract creation activity
 *   - Wallet with no contract creation activity
 *   - Multiple contract creations
 *   - Partial/incomplete historical data → insufficient_data on zero
 *   - Non-zero partial → active (positive evidence stands)
 *   - Failed contract creation does not count
 *   - Incoming txns with isContractCreation do not count
 *   - Existing transaction signals remain unaffected
 */

import { describe, it, expect } from 'bun:test';
import { calculateBuilderActivity } from '../../server/domain/signals/calculators/builder.js';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import type { NormalizedActivity } from '../../server/data/types.js';
import type { ActivitySignal } from '../../server/domain/signals/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeActivity(overrides: Partial<NormalizedActivity> = {}): NormalizedActivity {
  return {
    address: WALLET,
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

function makeContractCreationTx(overrides: {
  isOutgoing?: boolean;
  succeeded?: boolean;
  createdContractAddress?: string;
} = {}) {
  return {
    hash: '0x' + Math.random().toString(16).slice(2),
    blockNumber: BigInt(1000),
    timestamp: 1700000000,
    from: WALLET,
    to: null, // contract creation
    valueWei: BigInt(0),
    succeeded: overrides.succeeded ?? true,
    isOutgoing: overrides.isOutgoing ?? true,
    isContractCreation: true,
    hasInputData: true,
    createdContractAddress: overrides.createdContractAddress ?? '0xcccc',
    erc20Transfers: [],
  };
}

function makeRegularTx() {
  return {
    hash: '0x' + Math.random().toString(16).slice(2),
    blockNumber: BigInt(999),
    timestamp: 1699999999,
    from: WALLET,
    to: '0xbbbb',
    valueWei: BigInt(0),
    succeeded: true,
    isOutgoing: true,
    isContractCreation: false,
    hasInputData: false,
    erc20Transfers: [],
  };
}

// ---------------------------------------------------------------------------
// Signal calculator tests
// ---------------------------------------------------------------------------

describe('calculateBuilderActivity — no transactions', () => {
  it('returns value=0, status=available on non-truncated snapshot', () => {
    const signal = calculateBuilderActivity(makeActivity());
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('available');
    expect(signal.key).toBe('builderActivity');
  });

  it('returns value=0, status=partial on truncated snapshot', () => {
    const signal = calculateBuilderActivity(makeActivity({ mayBeTruncated: true }));
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toContain('truncated');
  });
});

describe('calculateBuilderActivity — with contract deployments', () => {
  it('counts one outgoing succeeded contract creation', () => {
    const activity = makeActivity({
      transactions: [makeContractCreationTx()],
    });
    const signal = calculateBuilderActivity(activity);
    expect(signal.value).toBe(1);
    expect(signal.status).toBe('available');
  });

  it('counts multiple contract creations', () => {
    const activity = makeActivity({
      transactions: [
        makeContractCreationTx({ createdContractAddress: '0xccc1' }),
        makeContractCreationTx({ createdContractAddress: '0xccc2' }),
        makeContractCreationTx({ createdContractAddress: '0xccc3' }),
      ],
    });
    const signal = calculateBuilderActivity(activity);
    expect(signal.value).toBe(3);
    expect(signal.status).toBe('available');
  });

  it('returns partial status when snapshot is truncated and deployment count > 0', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [makeContractCreationTx()],
    });
    const signal = calculateBuilderActivity(activity);
    expect(signal.value).toBe(1);
    expect(signal.status).toBe('partial');
  });

  it('does not count failed contract creation transactions', () => {
    const activity = makeActivity({
      transactions: [makeContractCreationTx({ succeeded: false })],
    });
    const signal = calculateBuilderActivity(activity);
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('available');
  });

  it('does not count incoming contract creation transactions', () => {
    const tx = {
      ...makeContractCreationTx(),
      isOutgoing: false,
      from: '0xother',
    };
    const activity = makeActivity({ transactions: [tx] });
    const signal = calculateBuilderActivity(activity);
    expect(signal.value).toBe(0);
  });

  it('does not count regular (non-creation) outgoing transactions', () => {
    const activity = makeActivity({
      transactions: [makeRegularTx(), makeRegularTx()],
    });
    const signal = calculateBuilderActivity(activity);
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('available');
  });

  it('counts only succeeded outgoing contract-creation txns in mixed batch', () => {
    const activity = makeActivity({
      transactions: [
        makeContractCreationTx({ succeeded: true }),        // counts
        makeContractCreationTx({ succeeded: false }),       // skipped (failed)
        makeContractCreationTx({ isOutgoing: false }),      // skipped (incoming)
        makeRegularTx(),                                    // skipped (not creation)
      ],
    });
    const signal = calculateBuilderActivity(activity);
    expect(signal.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Credential evaluation tests
// ---------------------------------------------------------------------------

describe('ARC_BUILDER credential — insufficient_data on zero partial', () => {
  it('is insufficient_data when builderActivity is partial with value 0', () => {
    const signal: ActivitySignal = {
      key: 'builderActivity',
      label: 'Builder Activity',
      value: 0,
      status: 'partial', // partial snapshot, no deployments seen
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: 'partial',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const builder = creds.find((c) => c.typeId === 'ARC_BUILDER');
    expect(builder).toBeDefined();
    expect(builder!.status).toBe('insufficient_data');
  });

  it('is not_earned when builderActivity is available with value 0', () => {
    const signal: ActivitySignal = {
      key: 'builderActivity',
      label: 'Builder Activity',
      value: 0,
      status: 'available', // complete snapshot, no deployments
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const builder = creds.find((c) => c.typeId === 'ARC_BUILDER');
    expect(builder).toBeDefined();
    expect(builder!.status).toBe('not_earned');
  });
});

describe('ARC_BUILDER credential — active on non-zero count', () => {
  it('is active when builderActivity is available with value >= 1', () => {
    const signal: ActivitySignal = {
      key: 'builderActivity',
      label: 'Builder Activity',
      value: 1,
      status: 'available',
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const builder = creds.find((c) => c.typeId === 'ARC_BUILDER');
    expect(builder!.status).toBe('active');
  });

  it('is active when builderActivity is partial with value >= 1 (non-zero partial is sufficient)', () => {
    const signal: ActivitySignal = {
      key: 'builderActivity',
      label: 'Builder Activity',
      value: 2,
      status: 'partial', // partial snapshot but positive evidence
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const builder = creds.find((c) => c.typeId === 'ARC_BUILDER');
    expect(builder!.status).toBe('active');
    // Note should mention partial
    expect(builder!.evaluationNote).toContain('partial snapshot');
  });

  it('is active with 3 deployments', () => {
    const signal: ActivitySignal = {
      key: 'builderActivity',
      label: 'Builder Activity',
      value: 3,
      status: 'available',
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const builder = creds.find((c) => c.typeId === 'ARC_BUILDER');
    expect(builder!.status).toBe('active');
    expect(builder!.evaluationNote).toContain('3');
  });
});

describe('ARC_BUILDER credential — existing credentials unaffected', () => {
  it('ARC_ACTIVE_WALLET still evaluates correctly when builderActivity is also present', () => {
    const signals: ActivitySignal[] = [
      {
        key: 'transactionCount',
        label: 'Transaction Count',
        value: 10,
        status: 'available',
        description: '', source: 'test', calculationDefinition: '', valueUnit: 'count', confidenceNote: '',
      },
      {
        key: 'builderActivity',
        label: 'Builder Activity',
        value: 1,
        status: 'available',
        description: '', source: 'test', calculationDefinition: '', valueUnit: 'count', confidenceNote: '',
      },
    ];

    const service = new CredentialService();
    const creds = service.evaluate(signals);
    const activeWallet = creds.find((c) => c.typeId === 'ARC_ACTIVE_WALLET');
    expect(activeWallet!.status).toBe('active');
    const builder = creds.find((c) => c.typeId === 'ARC_BUILDER');
    expect(builder!.status).toBe('active');
  });
});
