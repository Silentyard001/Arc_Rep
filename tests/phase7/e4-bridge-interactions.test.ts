/**
 * tests/phase7/e4-bridge-interactions.test.ts
 *
 * E4 — bridgeInteractions signal calculator and ARC_BRIDGE_USER credential.
 *
 * Tests:
 *   - Recognized bridge interaction
 *   - Non-bridge contract interaction
 *   - Multiple bridge interactions
 *   - Unknown/unregistered contract → does not count
 *   - Partial history with zero → insufficient_data
 *   - Non-zero partial → active
 *   - Partial history with non-bridge → insufficient_data (zero bridge count)
 *   - Existing credentials remain unaffected
 *   - Registry is the sole source of truth (no hardcoded addresses)
 */

import { describe, it, expect } from 'bun:test';
import { calculateBridgeInteractions } from '../../server/domain/signals/calculators/bridge.js';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import { SEED_APPLICATIONS, SEED_CONTRACTS, SEED_CATEGORIES } from '../../server/domain/applications/seed-data.js';
import type { NormalizedActivity } from '../../server/data/types.js';
import type { ActivitySignal } from '../../server/domain/signals/types.js';

// ---------------------------------------------------------------------------
// Known bridge contract addresses from seed data (CCTP)
// ---------------------------------------------------------------------------

/** CCTP TokenMessengerV2 — a registered bridge contract */
const CCTP_TOKEN_MESSENGER = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
/** CCTP MessageTransmitterV2 — another bridge contract */
const CCTP_MESSAGE_TRANSMITTER = '0xe737e5cebeeba77efe34d4aa090756590b1ce275';
/** Gateway Wallet — another bridge contract */
const GATEWAY_WALLET = '0x0077777d7eba4688bdef3e311b846f25870a19b9';
/** An unrecognized contract address */
const UNKNOWN_CONTRACT = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
/** A non-bridge recognized contract (USDC predeploy — infrastructure category) */
const USDC_PREDEPLOY = '0x3600000000000000000000000000000000000000';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeActivity(
  contracts: string[],
  mayBeTruncated = false,
): NormalizedActivity {
  return {
    address: WALLET,
    chainId: 5042002,
    transactions: [],
    contractAddressesInteracted: new Set(contracts.map((c) => c.toLowerCase())),
    totalFetched: 0,
    mayBeTruncated,
    fetchedAt: new Date().toISOString(),
    providerName: 'test',
    dataQualityNotes: [],
  };
}

function makeRegistry() {
  return new InMemoryApplicationRegistry({
    applications: SEED_APPLICATIONS,
    contracts: SEED_CONTRACTS,
    categories: SEED_CATEGORIES,
  });
}

// ---------------------------------------------------------------------------
// Signal calculator tests
// ---------------------------------------------------------------------------

describe('calculateBridgeInteractions — no interactions', () => {
  it('returns value=0, status=available with no contracts', () => {
    const activity = makeActivity([]);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('available');
    expect(signal.key).toBe('bridgeInteractions');
  });

  it('returns value=0, status=partial with no contracts on truncated snapshot', () => {
    const activity = makeActivity([], true);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('partial');
  });
});

describe('calculateBridgeInteractions — recognized bridge contracts', () => {
  it('counts 1 recognized bridge application (CCTP TokenMessengerV2)', () => {
    const activity = makeActivity([CCTP_TOKEN_MESSENGER]);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(1);
    expect(signal.status).toBe('available');
  });

  it('counts 1 distinct bridge application for two contracts from the same app (CCTP)', () => {
    // TokenMessengerV2 and MessageTransmitterV2 both belong to circle-cctp
    const activity = makeActivity([CCTP_TOKEN_MESSENGER, CCTP_MESSAGE_TRANSMITTER]);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    // Both are circle-cctp — should count as 1 distinct application
    expect(signal.value).toBe(1);
  });

  it('counts 2 distinct bridge applications (CCTP + Gateway)', () => {
    const activity = makeActivity([CCTP_TOKEN_MESSENGER, GATEWAY_WALLET]);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(2);
    expect(signal.status).toBe('available');
  });

  it('does not count unrecognized contract', () => {
    const activity = makeActivity([UNKNOWN_CONTRACT]);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(0);
  });

  it('does not count recognized non-bridge contract (USDC predeploy = infrastructure)', () => {
    const activity = makeActivity([USDC_PREDEPLOY]);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(0);
  });

  it('correctly separates bridge from non-bridge in mixed contract set', () => {
    const activity = makeActivity([
      CCTP_TOKEN_MESSENGER,  // bridge
      USDC_PREDEPLOY,         // infrastructure — not bridge
      UNKNOWN_CONTRACT,       // unknown — not bridge
    ]);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(1); // only CCTP
  });

  it('returns partial status on truncated snapshot with bridge interactions', () => {
    const activity = makeActivity([CCTP_TOKEN_MESSENGER], true);
    const signal = calculateBridgeInteractions(activity, makeRegistry());
    expect(signal.value).toBe(1);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toContain('snapshot');
  });
});

// ---------------------------------------------------------------------------
// Credential evaluation tests
// ---------------------------------------------------------------------------

describe('ARC_BRIDGE_USER credential — insufficient_data on zero partial', () => {
  it('is insufficient_data when bridgeInteractions is partial with value 0', () => {
    const signal: ActivitySignal = {
      key: 'bridgeInteractions',
      label: 'Bridge Interactions',
      value: 0,
      status: 'partial',
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    expect(bridgeUser).toBeDefined();
    expect(bridgeUser!.status).toBe('insufficient_data');
  });

  it('is not_earned when bridgeInteractions is available with value 0', () => {
    const signal: ActivitySignal = {
      key: 'bridgeInteractions',
      label: 'Bridge Interactions',
      value: 0,
      status: 'available',
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    expect(bridgeUser!.status).toBe('not_earned');
  });
});

describe('ARC_BRIDGE_USER credential — active on non-zero count', () => {
  it('is active when bridgeInteractions is available with value >= 1', () => {
    const signal: ActivitySignal = {
      key: 'bridgeInteractions',
      label: 'Bridge Interactions',
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
    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    expect(bridgeUser!.status).toBe('active');
  });

  it('is active when bridgeInteractions is partial with value >= 1 (positive evidence stands)', () => {
    const signal: ActivitySignal = {
      key: 'bridgeInteractions',
      label: 'Bridge Interactions',
      value: 2,
      status: 'partial',
      description: '',
      source: 'test',
      calculationDefinition: '',
      valueUnit: 'count',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const creds = service.evaluate([signal]);
    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    expect(bridgeUser!.status).toBe('active');
    expect(bridgeUser!.evaluationNote).toContain('partial snapshot');
  });
});

describe('ARC_BRIDGE_USER — registry is sole source of truth', () => {
  it('uses only registry-registered bridge contracts, no hardcoded addresses', () => {
    // Build a minimal registry with only one custom bridge contract
    const customBridgeAddress = '0xfeedbeeffeedbeeffeedbeeffeedbeeffeedbeef';
    const customApps = [
      {
        id: 'test-bridge',
        name: 'Test Bridge',
        description: 'Test',
        categoryId: 'bridge',
        isVerified: true,
        websiteUrl: '',
        addedAt: '2026-01-01T00:00:00Z',
      },
    ];
    const customContracts = [
      {
        address: customBridgeAddress,
        applicationId: 'test-bridge',
        label: 'Test Bridge Contract',
        isVerified: true,
        sourceType: 'official-docs' as const,
        sourceRef: 'test',
        addedAt: '2026-01-01T00:00:00Z',
      },
    ];
    const customCategories = [
      {
        id: 'bridge',
        label: 'Bridge',
        description: 'Bridge protocols',
      },
    ];

    const registry = new InMemoryApplicationRegistry({
      applications: customApps,
      contracts: customContracts,
      categories: customCategories,
    });

    // Only the custom bridge address should count
    const activity = makeActivity([
      customBridgeAddress,  // registered in this registry
      CCTP_TOKEN_MESSENGER, // NOT registered in this registry
    ]);

    const signal = calculateBridgeInteractions(activity, registry);
    expect(signal.value).toBe(1); // only the custom bridge
  });
});

describe('ARC_BRIDGE_USER — existing credentials unaffected', () => {
  it('ARC_MULTI_APP_USER still evaluates correctly when bridgeInteractions is also present', () => {
    const signals: ActivitySignal[] = [
      {
        key: 'uniqueApplications',
        label: 'Unique Applications',
        value: 3,
        status: 'available',
        description: '', source: 'test', calculationDefinition: '', valueUnit: 'count', confidenceNote: '',
      },
      {
        key: 'bridgeInteractions',
        label: 'Bridge Interactions',
        value: 1,
        status: 'available',
        description: '', source: 'test', calculationDefinition: '', valueUnit: 'count', confidenceNote: '',
      },
    ];

    const service = new CredentialService();
    const creds = service.evaluate(signals);

    const multiApp = creds.find((c) => c.typeId === 'ARC_MULTI_APP_USER');
    expect(multiApp!.status).toBe('active');

    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    expect(bridgeUser!.status).toBe('active');
  });

  it('ARC_PAYMENTS_PARTICIPANT is unaffected by bridgeInteractions evaluation', () => {
    const signals: ActivitySignal[] = [
      {
        key: 'economicActivity',
        label: 'Economic Activity',
        value: JSON.stringify({ nativeValueWei: '0', usdcErc20Raw: '5000000' }),
        status: 'available',
        description: '', source: 'test', calculationDefinition: '', valueUnit: 'json_economic_breakdown', confidenceNote: '',
      },
      {
        key: 'usdcReceived',
        label: 'USDC Received',
        value: '0',
        status: 'available',
        description: '', source: 'test', calculationDefinition: '', valueUnit: 'bigint_usdc_raw_6dec_string', confidenceNote: '',
      },
      {
        key: 'bridgeInteractions',
        label: 'Bridge Interactions',
        value: 0,
        status: 'available',
        description: '', source: 'test', calculationDefinition: '', valueUnit: 'count', confidenceNote: '',
      },
    ];

    const service = new CredentialService();
    const creds = service.evaluate(signals);

    const payments = creds.find((c) => c.typeId === 'ARC_PAYMENTS_PARTICIPANT');
    expect(payments!.status).toBe('active');

    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    expect(bridgeUser!.status).toBe('not_earned');
  });
});

describe('ARC_BRIDGE_USER — complete credential set includes ARC_BRIDGE_USER', () => {
  it('evaluate() includes ARC_BRIDGE_USER in the returned credential list', () => {
    const service = new CredentialService();
    const creds = service.evaluate([]);
    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    expect(bridgeUser).toBeDefined();
  });

  it('ARC_BRIDGE_USER is insufficient_data when bridgeInteractions signal is missing', () => {
    const service = new CredentialService();
    const creds = service.evaluate([]); // no signals at all
    const bridgeUser = creds.find((c) => c.typeId === 'ARC_BRIDGE_USER');
    // Missing signal → treated as 'unavailable' → allSignalsPartialNoAvailable → insufficient_data
    expect(bridgeUser!.status).toBe('insufficient_data');
  });
});
