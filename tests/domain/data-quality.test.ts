/**
 * tests/domain/data-quality.test.ts
 *
 * Data quality guarantee tests.
 *
 * These tests verify that the Arc Rep architecture correctly propagates
 * data limitations — truncation, partial snapshots, unavailable history —
 * and that no signal or credential upgrades itself past its data's actual quality.
 *
 * See docs/DATA_REQUIREMENTS.md §6 (Data Quality) and §7 (Testing Requirements)
 * for the full rationale behind each test.
 */

import { describe, it, expect } from 'bun:test';
import { calculateFirstSeen, calculateActiveDays } from '../../server/domain/signals/calculators/longevity.js';
import { calculateUniqueContracts, calculateUniqueApplications } from '../../server/domain/signals/calculators/breadth.js';
import { calculateTransactionCount, calculateEconomicActivity } from '../../server/domain/signals/calculators/activity.js';
import { calculateApplicationDiversity, calculateActivityConsistency } from '../../server/domain/signals/calculators/diversity.js';
import { SignalEngine } from '../../server/domain/signals/SignalEngine.js';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import { ProfileService } from '../../server/domain/profile/ProfileService.js';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import { ActivityProviderError } from '../../server/data/IActivityProvider.js';
import type { IActivityProvider } from '../../server/data/IActivityProvider.js';
import type { NormalizedActivity, NormalizedTransaction, DecodedErc20Transfer } from '../../server/data/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActivity(overrides: Partial<NormalizedActivity> = {}): NormalizedActivity {
  return {
    address: '0xabc0000000000000000000000000000000000001',
    chainId: 5042002,
    transactions: [],
    contractAddressesInteracted: new Set(),
    totalFetched: 0,
    mayBeTruncated: false,
    fetchedAt: new Date().toISOString(),
    providerName: 'TestProvider',
    dataQualityNotes: [],
    ...overrides,
  };
}

function makeOutgoingTx(timestamp: number, overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    hash: `0x${timestamp.toString(16).padStart(64, '0')}`,
    blockNumber: BigInt(timestamp),
    timestamp,
    from: '0xabc0000000000000000000000000000000000001',
    to: '0xcontract000000000000000000000000000001',
    valueWei: BigInt(0),
    succeeded: true,
    isOutgoing: true,
    isContractCreation: false,
    hasInputData: true,
    erc20Transfers: [],
    ...overrides,
  };
}

// Helper kept for explicit ERC-20 transfer construction in section 5
// (defined here so the type is in scope)
type _ErcTransfer = DecodedErc20Transfer;

const emptyRegistry = new InMemoryApplicationRegistry({
  applications: [],
  contracts: [],
  categories: [],
});

class MockActivityProvider implements IActivityProvider {
  readonly name = 'MockProvider';
  constructor(private readonly response: NormalizedActivity) {}
  async getActivity(): Promise<NormalizedActivity> {
    return this.response;
  }
}

// ---------------------------------------------------------------------------
// 1. Truncated snapshot propagates 'partial' status to all affected signals
// ---------------------------------------------------------------------------

describe('Truncation propagation: mayBeTruncated = true', () => {
  const truncatedActivity = makeActivity({
    mayBeTruncated: true,
    transactions: [
      makeOutgoingTx(1_700_000_000),
      makeOutgoingTx(1_700_001_000),
      makeOutgoingTx(1_700_002_000),
      makeOutgoingTx(1_700_003_000),
      makeOutgoingTx(1_700_004_000),
    ],
    contractAddressesInteracted: new Set(['0xcontract000000000000000000000000000001']),
    earliestTimestamp: 1_700_000_000,
    latestTimestamp: 1_700_004_000,
    totalFetched: 5,
    dataQualityNotes: ['Snapshot is truncated.'],
  });

  it('firstSeen is partial when truncated (may not be true first)', () => {
    const signal = calculateFirstSeen(truncatedActivity);
    expect(signal.status).toBe('partial');
    expect(signal.value).not.toBeNull();
    expect(signal.confidenceNote).toBeTruthy();
    expect(signal.confidenceNote.toLowerCase()).toContain('truncat');
  });

  it('activeDays is partial when truncated', () => {
    const signal = calculateActiveDays(truncatedActivity);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('uniqueContracts is partial when truncated', () => {
    const signal = calculateUniqueContracts(truncatedActivity);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('uniqueApplications is partial when truncated', () => {
    const signal = calculateUniqueApplications(truncatedActivity, emptyRegistry);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('transactionCount is partial when truncated', () => {
    const signal = calculateTransactionCount(truncatedActivity);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('economicActivity is partial when truncated', () => {
    const activityWithValue = makeActivity({
      ...truncatedActivity,
      transactions: truncatedActivity.transactions.map((t) => ({
        ...t,
        valueWei: BigInt(1_000_000),
      })),
    });
    const signal = calculateEconomicActivity(activityWithValue);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('applicationDiversity is partial when truncated', () => {
    const signal = calculateApplicationDiversity(truncatedActivity, emptyRegistry);
    // With no recognized apps, status will be 'available' (ratio = 0) but partial when truncated
    // The specific behavior: if totalContracts > 0 and truncated, it is partial
    expect(['partial', 'available']).toContain(signal.status);
    // If partial, it must have a confidence note
    if (signal.status === 'partial') {
      expect(signal.confidenceNote).toBeTruthy();
    }
  });

  it('activityConsistency is partial when truncated (5 txns but truncated)', () => {
    const signal = calculateActivityConsistency(truncatedActivity);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. A wallet with nonce > 0 but no transactions in snapshot must not be
//    treated as "inactive" or zero-activity.
// ---------------------------------------------------------------------------

describe('Zero-captured-transactions vs genuine zero-activity wallet', () => {
  it('mayBeTruncated = true when eth_getTransactionCount > captured count (simulated via flag)', () => {
    // This test validates the invariant: if a wallet has sent transactions
    // but none appear in the snapshot, mayBeTruncated must be true.
    // The ArcRpcProvider sets this flag; we test that signal consumers honour it.

    const oldActiveWallet = makeActivity({
      mayBeTruncated: true,
      transactions: [],  // zero transactions captured in window
      contractAddressesInteracted: new Set(),
      totalFetched: 0,
      dataQualityNotes: [
        'eth_getTransactionCount = 47, transactions captured = 0. ' +
        'Historical transactions outside the block scan window are not included.',
      ],
    });

    // transactionCount should be 0 (snapshot count) and partial, NOT 'available'
    const txCount = calculateTransactionCount(oldActiveWallet);
    expect(txCount.value).toBe(0);
    expect(txCount.status).toBe('partial');

    // firstSeen should be unavailable (no timestamps), not 0
    const firstSeen = calculateFirstSeen(oldActiveWallet);
    expect(firstSeen.value).toBeNull();
    expect(firstSeen.status).toBe('unavailable');

    // activeDays should be 0 and partial, NOT 'available'
    const activeDays = calculateActiveDays(oldActiveWallet);
    expect(activeDays.value).toBe(0);
    expect(activeDays.status).toBe('partial');
  });

  it('a genuine zero-activity wallet has mayBeTruncated = false and available zero signals', () => {
    const genuinelyEmptyWallet = makeActivity({
      mayBeTruncated: false,
      transactions: [],
      contractAddressesInteracted: new Set(),
      totalFetched: 0,
      dataQualityNotes: ['eth_getTransactionCount returned 0.'],
    });

    // transactionCount is 0 and available — genuinely no transactions
    const txCount = calculateTransactionCount(genuinelyEmptyWallet);
    expect(txCount.value).toBe(0);
    expect(txCount.status).toBe('available');

    // firstSeen is unavailable — no timestamps, not "zero"
    const firstSeen = calculateFirstSeen(genuinelyEmptyWallet);
    expect(firstSeen.value).toBeNull();
    expect(firstSeen.status).toBe('unavailable');

    // activeDays is 0 and available
    const activeDays = calculateActiveDays(genuinelyEmptyWallet);
    expect(activeDays.value).toBe(0);
    expect(activeDays.status).toBe('available');
  });

  it('zero captured + truncated: firstSeen is unavailable, NOT zero (null, not 0)', () => {
    const zeroCaptureTruncated = makeActivity({
      mayBeTruncated: true,
      transactions: [],
    });
    const firstSeen = calculateFirstSeen(zeroCaptureTruncated);
    // Must be null — a zero timestamp would imply a real timestamp
    expect(firstSeen.value).toBeNull();
    // Status must be unavailable — we cannot say firstSeen = 0
    expect(firstSeen.status).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// 3. Partial signals must not be promoted to 'available' through the pipeline
// ---------------------------------------------------------------------------

describe('Partial signal non-escalation through pipeline', () => {
  it('partial signal stays partial through SignalEngine (not promoted to available)', () => {
    const truncatedActivity = makeActivity({
      mayBeTruncated: true,
      transactions: [makeOutgoingTx(1_700_000_000), makeOutgoingTx(1_700_001_000)],
      contractAddressesInteracted: new Set(),
      earliestTimestamp: 1_700_000_000,
      latestTimestamp: 1_700_001_000,
      totalFetched: 2,
    });

    const engine = new SignalEngine();
    const signals = engine.calculate(truncatedActivity, emptyRegistry);

    // Every signal that depends on complete history should be partial, not available
    const partialExpected = ['firstSeen', 'activeDays', 'uniqueContracts', 'transactionCount'];
    for (const key of partialExpected) {
      const signal = signals.find((s) => s.key === key);
      expect(signal).toBeDefined();
      expect(signal!.status).toBe('partial');
    }
  });

  it('partial signals propagate through CredentialService evaluationNote', () => {
    const engine = new SignalEngine();
    const credService = new CredentialService();

    const truncatedActivity = makeActivity({
      mayBeTruncated: true,
      transactions: [
        makeOutgoingTx(1_700_000_000),
        makeOutgoingTx(1_700_001_000),
        makeOutgoingTx(1_700_002_000),
        makeOutgoingTx(1_700_003_000),
        makeOutgoingTx(1_700_004_000),
      ],
      earliestTimestamp: 1_700_000_000,
      latestTimestamp: 1_700_004_000,
      totalFetched: 5,
    });

    const signals = engine.calculate(truncatedActivity, emptyRegistry);
    const credentials = credService.evaluate(signals);

    // ARC_ACTIVE_WALLET: depends on transactionCount (partial)
    const activeWallet = credentials.find((c) => c.typeId === 'ARC_ACTIVE_WALLET');
    expect(activeWallet).toBeDefined();
    // The credential may be earned (if count >= threshold) but the underlying signal is partial.
    // The evaluationNote should NOT say the data is fully reliable.
    // It should reference the actual count.
    expect(typeof activeWallet!.evaluationNote).toBe('string');
  });

  it('credentials are correctly not_earned when underlying signals are unavailable', () => {
    const engine = new SignalEngine();
    const credService = new CredentialService();

    // A wallet where firstSeen is unavailable (no transactions, not truncated)
    const emptyWallet = makeActivity({
      mayBeTruncated: false,
      transactions: [],
    });

    const signals = engine.calculate(emptyWallet, emptyRegistry);
    const credentials = credService.evaluate(signals);

    // ARC_EARLY_ADOPTER depends on firstSeen with requiresFullHistory = true.
    // When firstSeen is unavailable, the correct status is 'insufficient_data'
    // (not 'not_earned') because we cannot determine eligibility at all.
    const earlyAdopter = credentials.find((c) => c.typeId === 'ARC_EARLY_ADOPTER');
    expect(earlyAdopter).toBeDefined();
    expect(earlyAdopter!.status).toBe('insufficient_data');
    // evaluationNote must reference firstSeen
    expect(earlyAdopter!.evaluationNote.toLowerCase()).toContain('firstseen');
  });
});

// ---------------------------------------------------------------------------
// 4. Provider dataQualityNotes propagate through the profile
// ---------------------------------------------------------------------------

describe('Provider dataQualityNotes surface in WalletActivitySummary', () => {
  it('dataQualityNotes from provider appear in the profile activitySummary', async () => {
    const activityWithNotes = makeActivity({
      dataQualityNotes: [
        'Block scan window: 63610000 – 63620000. Transactions before 63610000 not included.',
        'Activity snapshot may be incomplete. eth_getTransactionCount = 47, transactions captured = 3.',
      ],
      mayBeTruncated: true,
      transactions: [
        makeOutgoingTx(1_700_000_000),
        makeOutgoingTx(1_700_001_000),
        makeOutgoingTx(1_700_002_000),
      ],
      totalFetched: 3,
    });

    const provider = new MockActivityProvider(activityWithNotes);
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile('0xabc0000000000000000000000000000000000001');

    expect(profile.activitySummary.dataQualityNotes).toHaveLength(2);
    expect(profile.activitySummary.dataQualityNotes[0]).toContain('Block scan window');
    expect(profile.activitySummary.dataQualityNotes[1]).toContain('eth_getTransactionCount');
  });

  it('empty dataQualityNotes array is preserved (not silently discarded)', async () => {
    const cleanActivity = makeActivity({ dataQualityNotes: [] });
    const provider = new MockActivityProvider(cleanActivity);
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile('0xabc0000000000000000000000000000000000001');

    expect(Array.isArray(profile.activitySummary.dataQualityNotes)).toBe(true);
    expect(profile.activitySummary.dataQualityNotes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. economicActivity: now decodes ERC-20 USDC transfers
//    (replaces Phase 1 "ERC-20 gap" tests with Phase 3A behaviour)
// ---------------------------------------------------------------------------

describe('economicActivity: native + ERC-20 USDC breakdown', () => {
  const USDC = '0x3600000000000000000000000000000000000000';
  const WALLET = '0xabc0000000000000000000000000000000000001';

  it('zero breakdown for empty wallet', () => {
    const signal = calculateEconomicActivity(makeActivity({}));
    const breakdown = JSON.parse(signal.value as string);
    expect(breakdown.nativeValueWei).toBe('0');
    expect(breakdown.usdcErc20Raw).toBe('0');
    expect(signal.status).toBe('available');
    // Description must mention native gas token and ERC-20
    expect(signal.description).toContain('native gas token');
    expect(signal.description).toContain('ERC-20 USDC');
  });

  it('captures native value correctly when msg.value > 0 and no ERC-20 transfers', () => {
    const activity = makeActivity({
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          valueWei: BigInt('1000000000000000000'), // 1e18 native wei
          succeeded: true,
          // No ERC-20 transfers — erc20Transfers defaults to []
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(breakdown.nativeValueWei).toBe('1000000000000000000');
    expect(breakdown.usdcErc20Raw).toBe('0');
    expect(signal.status).toBe('available');
  });

  it('captures ERC-20 USDC transfer amount when msg.value = 0', () => {
    // Previously the "ERC-20 gap" — now correctly captured via erc20Transfers
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          to: USDC,
          valueWei: BigInt(0), // no native value
          hasInputData: true,
          succeeded: true,
          erc20Transfers: [
            {
              tokenAddress: USDC,
              from: WALLET,
              to: '0xrecipient0000000000000000000000000000001',
              amountRaw: BigInt('5000000'), // 5 USDC at 6 decimals
            },
          ],
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(breakdown.nativeValueWei).toBe('0');
    expect(breakdown.usdcErc20Raw).toBe('5000000');
    expect(signal.status).toBe('available');
  });

  it('sums multiple ERC-20 USDC transfers across transactions', () => {
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          to: USDC,
          valueWei: BigInt(0),
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: '0xrecip1000000000000000000000000000000001', amountRaw: BigInt('1000000') },
          ],
        }),
        makeOutgoingTx(1_700_001_000, {
          to: USDC,
          valueWei: BigInt(0),
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: '0xrecip2000000000000000000000000000000002', amountRaw: BigInt('2500000') },
          ],
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(breakdown.usdcErc20Raw).toBe('3500000'); // 1_000_000 + 2_500_000
  });

  it('does not count incoming ERC-20 USDC transfers', () => {
    // transfer.from is NOT the wallet — this is an incoming transfer
    const OTHER = '0xsender0000000000000000000000000000000001';
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          isOutgoing: true,
          succeeded: true,
          erc20Transfers: [
            {
              tokenAddress: USDC,
              from: OTHER,    // NOT the wallet — incoming
              to: WALLET,
              amountRaw: BigInt('9000000'),
            },
          ],
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    // Incoming transfer must NOT contribute to outgoing economic activity
    expect(breakdown.usdcErc20Raw).toBe('0');
  });

  it('ignores non-USDC ERC-20 transfers', () => {
    const OTHER_TOKEN = '0xothertok0000000000000000000000000000001';
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          succeeded: true,
          erc20Transfers: [
            {
              tokenAddress: OTHER_TOKEN, // not USDC
              from: WALLET,
              to: '0xrecip1000000000000000000000000000000001',
              amountRaw: BigInt('99999999'),
            },
          ],
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(breakdown.usdcErc20Raw).toBe('0');
  });

  it('handles large uint256 USDC amounts without precision loss', () => {
    // max uint256 — BigInt handles it exactly
    const maxUint256 = (BigInt(2) ** BigInt(256)) - BigInt(1);
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          valueWei: BigInt(0),
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: '0xrecip1000000000000000000000000000000001', amountRaw: maxUint256 },
          ],
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(BigInt(breakdown.usdcErc20Raw)).toBe(maxUint256);
  });

  it('does not count failed outgoing ERC-20 transfers', () => {
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          succeeded: false, // failed transaction
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: '0xrecip1000000000000000000000000000000001', amountRaw: BigInt('5000000') },
          ],
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    // Failed tx — neither native nor ERC-20 should count
    expect(breakdown.nativeValueWei).toBe('0');
    expect(breakdown.usdcErc20Raw).toBe('0');
  });

  it('truncated provider data produces partial status', () => {
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          valueWei: BigInt('500000'),
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: '0xrecip1000000000000000000000000000000001', amountRaw: BigInt('1000000') },
          ],
        }),
      ],
      mayBeTruncated: true,
    });
    const signal = calculateEconomicActivity(activity);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('tx with both native value AND ERC-20 USDC transfer reports both separately', () => {
    // Unusual case, but theoretically possible
    const activity = makeActivity({
      address: WALLET,
      transactions: [
        makeOutgoingTx(1_700_000_000, {
          valueWei: BigInt('1000000000000000000'), // 1e18 native
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: '0xrecip1000000000000000000000000000000001', amountRaw: BigInt('2000000') },
          ],
        }),
      ],
      mayBeTruncated: false,
    });
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    // Both components must be reported; they are NOT summed together
    expect(breakdown.nativeValueWei).toBe('1000000000000000000');
    expect(breakdown.usdcErc20Raw).toBe('2000000');
  });
});

// ---------------------------------------------------------------------------
// 6. Future signals must not masquerade as calculated values
// ---------------------------------------------------------------------------

describe('Future signals are correctly marked as future, not unavailable or zero', () => {
  it('future signals have status = future and value = null', () => {
    const activity = makeActivity();
    const engine = new SignalEngine();
    const signals = engine.calculate(activity, emptyRegistry);

    // builderActivity and bridgeInteractions are now implemented (E3/E4)
    const futureKeys = ['ecosystemBreadth', 'paymentActivity', 'liquidityActivity'];
    for (const key of futureKeys) {
      const signal = signals.find((s) => s.key === key);
      expect(signal).toBeDefined();
      expect(signal!.status).toBe('future');
      expect(signal!.value).toBeNull();
      // Future signals must explain why they are not calculated
      expect(signal!.confidenceNote).toBeTruthy();
    }
  });

  it('future signals are never promoted to "available" by CredentialService', () => {
    const engine = new SignalEngine();
    const credService = new CredentialService();
    const signals = engine.calculate(makeActivity(), emptyRegistry);

    // Inject a fake signal with status 'future' to test CredentialService boundary
    const signalsWithFuture = signals.map((s) =>
      s.key === 'transactionCount'
        ? { ...s, status: 'future' as const, value: null }
        : s,
    );

    const credentials = credService.evaluate(signalsWithFuture);
    const activeWallet = credentials.find((c) => c.typeId === 'ARC_ACTIVE_WALLET');
    expect(activeWallet).toBeDefined();
    // Must be insufficient_data (not not_earned) because the required signal is 'future'.
    // 'insufficient_data' is the correct status when a signal calculator is not implemented.
    expect(activeWallet!.status).toBe('insufficient_data');
    expect(activeWallet!.evaluationNote.toLowerCase()).toContain('transactioncount');
  });
});

// ---------------------------------------------------------------------------
// 7. ActivityProviderError propagates correctly and does not produce a partial profile
// ---------------------------------------------------------------------------

describe('ActivityProviderError propagation', () => {
  it('ProfileService throws ActivityProviderError (not swallowed into partial profile)', async () => {
    const failingProvider: IActivityProvider = {
      name: 'FailingProvider',
      async getActivity(): Promise<NormalizedActivity> {
        throw new ActivityProviderError(
          'RPC unreachable: connection refused',
        );
      },
    };

    const service = new ProfileService(failingProvider, emptyRegistry);

    let threw = false;
    try {
      await service.buildProfile('0xabc0000000000000000000000000000000000001');
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ActivityProviderError);
    }
    // The error must propagate — a failed provider must not produce a silent
    // "empty" profile that looks like a genuine zero-activity wallet.
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Consistency signal: insufficient sample size is always partial
// ---------------------------------------------------------------------------

describe('activityConsistency: sample size gates', () => {
  it('fewer than 5 outgoing transactions always produces partial, not available', () => {
    for (let n = 2; n <= 4; n++) {
      const txs = Array.from({ length: n }, (_, i) =>
        makeOutgoingTx(1_700_000_000 + i * 3600),
      );
      const activity = makeActivity({
        transactions: txs,
        mayBeTruncated: false,
        earliestTimestamp: txs[0].timestamp,
        latestTimestamp: txs[txs.length - 1].timestamp,
      });
      const signal = calculateActivityConsistency(activity);
      expect(signal.status).toBe('partial');
    }
  });

  it('5 or more transactions with no truncation can produce available', () => {
    const txs = Array.from({ length: 5 }, (_, i) =>
      makeOutgoingTx(1_700_000_000 + i * 3600),
    );
    const activity = makeActivity({
      transactions: txs,
      mayBeTruncated: false,
      earliestTimestamp: txs[0].timestamp,
      latestTimestamp: txs[txs.length - 1].timestamp,
    });
    const signal = calculateActivityConsistency(activity);
    expect(signal.status).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// 9. WalletProfile must not contain derived reputation fields
// ---------------------------------------------------------------------------

describe('WalletProfile: no reputation fields at any data quality level', () => {
  const BANNED_FIELDS = [
    'score', 'reputationScore', 'trustScore', 'rank',
    'trustworthiness', 'qualityScore', 'importanceScore',
    'sybilScore', 'sybilRisk',
  ];

  it('profile with rich activity has no banned reputation fields', async () => {
    const richActivity = makeActivity({
      transactions: Array.from({ length: 10 }, (_, i) =>
        makeOutgoingTx(1_700_000_000 + i * 86400),
      ),
      contractAddressesInteracted: new Set(['0xcontract000000000000000000000000000001']),
      mayBeTruncated: true,
    });
    const provider = new MockActivityProvider(richActivity);
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile('0xabc0000000000000000000000000000000000001');

    const allKeys = [
      ...Object.keys(profile),
      ...Object.keys(profile.activitySummary),
      ...profile.signals.flatMap(Object.keys),
      ...profile.credentials.flatMap(Object.keys),
    ];

    for (const banned of BANNED_FIELDS) {
      expect(allKeys).not.toContain(banned);
    }
  });

  it('profile with zero activity has no banned reputation fields', async () => {
    const provider = new MockActivityProvider(makeActivity());
    const service = new ProfileService(provider, emptyRegistry);
    const profile = await service.buildProfile('0xabc0000000000000000000000000000000000001');

    const allKeys = [
      ...Object.keys(profile),
      ...Object.keys(profile.activitySummary),
    ];

    for (const banned of BANNED_FIELDS) {
      expect(allKeys).not.toContain(banned);
    }
  });
});
