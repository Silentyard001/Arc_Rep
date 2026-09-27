/**
 * tests/domain/transaction-count.test.ts
 *
 * Phase 3B: Nonce-based transactionCount signal tests.
 *
 * Covers all three cases in calculateTransactionCount:
 *
 *   Case A: Non-truncated snapshot — snapshot count is authoritative.
 *   Case B: Truncated snapshot + nonce available — nonce is authoritative count.
 *   Case C: Truncated snapshot + nonce unavailable — snapshot count as lower bound.
 *
 * Also verifies:
 *   - The count field is never used to infer per-transaction details in other signals.
 *   - Large valid nonce values are handled without precision loss.
 *   - ARC_ACTIVE_WALLET credential accuracy improves automatically via Case B.
 *   - No other signal is changed by the presence of totalOutgoingTransactionCount.
 */

import { describe, it, expect } from 'bun:test';
import { calculateTransactionCount } from '../../server/domain/signals/calculators/activity.js';
import { calculateFirstSeen, calculateActiveDays } from '../../server/domain/signals/calculators/longevity.js';
import { calculateUniqueContracts } from '../../server/domain/signals/calculators/breadth.js';
import { SignalEngine } from '../../server/domain/signals/SignalEngine.js';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import type { NormalizedActivity, NormalizedTransaction } from '../../server/data/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActivity(overrides: Partial<NormalizedActivity> = {}): NormalizedActivity {
  return {
    address: '0xwallet0000000000000000000000000000000001',
    chainId: 5042002,
    transactions: [],
    contractAddressesInteracted: new Set(),
    totalFetched: 0,
    mayBeTruncated: false,
    fetchedAt: new Date().toISOString(),
    providerName: 'TestProvider',
    dataQualityNotes: [],
    // totalOutgoingTransactionCount intentionally absent by default
    // (tests that need it set it explicitly in overrides)
    ...overrides,
  };
}

function makeOutgoingTx(timestamp: number): NormalizedTransaction {
  return {
    hash: `0x${timestamp.toString(16).padStart(64, '0')}`,
    blockNumber: BigInt(timestamp),
    timestamp,
    from: '0xwallet0000000000000000000000000000000001',
    to: '0xcontract000000000000000000000000000001',
    valueWei: BigInt(0),
    succeeded: true,
    isOutgoing: true,
    isContractCreation: false,
    hasInputData: true,
    erc20Transfers: [],
  };
}

const emptyRegistry = new InMemoryApplicationRegistry({
  applications: [],
  contracts: [],
  categories: [],
});

const D1 = 1704067200; // 2024-01-01T00:00:00Z
const D2 = 1704153600; // 2024-01-02T00:00:00Z

// ---------------------------------------------------------------------------
// Case A: Non-truncated snapshot
// ---------------------------------------------------------------------------

describe('Case A — non-truncated snapshot', () => {
  it('returns snapshot outgoing count when mayBeTruncated = false', () => {
    const activity = makeActivity({
      mayBeTruncated: false,
      transactions: [makeOutgoingTx(D1), makeOutgoingTx(D2)],
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(2);
    expect(signal.status).toBe('available');
  });

  it('returns 0 and available for a genuine zero-transaction wallet', () => {
    // mayBeTruncated = false, no transactions — wallet has genuinely never sent
    const activity = makeActivity({
      mayBeTruncated: false,
      transactions: [],
      totalOutgoingTransactionCount: 0, // nonce = 0 confirms it
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('available');
  });

  it('ignores totalOutgoingTransactionCount when non-truncated (snapshot is authoritative)', () => {
    // Even if totalOutgoingTransactionCount is set and differs, Case A uses the snapshot
    const activity = makeActivity({
      mayBeTruncated: false,
      transactions: [makeOutgoingTx(D1), makeOutgoingTx(D2)],
      // Contrived: set the nonce to something different to confirm it is ignored in Case A
      totalOutgoingTransactionCount: 999,
    });
    const signal = calculateTransactionCount(activity);
    // Case A: snapshot is complete — snapshot count wins
    expect(signal.value).toBe(2);
    expect(signal.status).toBe('available');
  });

  it('confidenceNote is empty for available signal', () => {
    const activity = makeActivity({ mayBeTruncated: false });
    const signal = calculateTransactionCount(activity);
    expect(signal.confidenceNote).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Case B: Truncated snapshot + nonce available
// ---------------------------------------------------------------------------

describe('Case B — truncated snapshot with account-level nonce', () => {
  it('uses the account-level nonce as the signal value when truncated', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [makeOutgoingTx(D1), makeOutgoingTx(D2)], // only 2 in window
      totalOutgoingTransactionCount: 47, // nonce = 47: wallet has sent 47 txns total
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(47);
    expect(signal.status).toBe('partial');
  });

  it('status remains partial even though the count is now accurate', () => {
    // The count is authoritative, but individual tx details are still window-limited.
    // Status must be 'partial' — not 'available' — because per-transaction data
    // (timestamps, recipients, contracts) is incomplete.
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 10,
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.status).toBe('partial');
  });

  it('uses nonce value even when zero captured transactions in snapshot', () => {
    // Wallet has old history but nothing in the recent scan window.
    // The nonce confirms it has sent 47 transactions — must NOT report zero.
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 47,
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(47);
    expect(signal.value).not.toBe(0); // explicitly: must NOT report zero
    expect(signal.status).toBe('partial');
  });

  it('confidenceNote mentions eth_getTransactionCount and the nonce value', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 23,
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.confidenceNote).toContain('eth_getTransactionCount');
    expect(signal.confidenceNote).toContain('23');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('calculationDefinition mentions eth_getTransactionCount and nonce', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 5,
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.calculationDefinition).toContain('eth_getTransactionCount');
  });

  it('handles large nonce values without precision loss', () => {
    // A very active wallet with a large nonce
    const largeNonce = 1_000_000;
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [makeOutgoingTx(D1)],
      totalOutgoingTransactionCount: largeNonce,
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(largeNonce);
    expect(signal.status).toBe('partial');
  });

  it('nonce of 1 reports 1, not snapshot count of 0', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [], // nothing captured in window
      totalOutgoingTransactionCount: 1,
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(1);
    expect(signal.status).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// Case C: Truncated snapshot + nonce unavailable
// ---------------------------------------------------------------------------

describe('Case C — truncated snapshot without account-level nonce', () => {
  it('falls back to snapshot count when totalOutgoingTransactionCount is undefined', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [makeOutgoingTx(D1), makeOutgoingTx(D2)],
      // totalOutgoingTransactionCount intentionally absent
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(2); // snapshot count
    expect(signal.status).toBe('partial');
  });

  it('returns 0 as lower bound when truncated, no nonce, and zero captured', () => {
    // This is a truncated wallet with nothing in the snapshot.
    // We cannot tell the true count. 0 is the lower bound, not the true count.
    // The key invariant: status is 'partial', not 'available'.
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      // totalOutgoingTransactionCount: undefined — nonce unavailable
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('partial'); // MUST be partial, not available
    // The zero here does NOT mean "wallet has never transacted"
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('confidenceNote mentions that nonce was not available', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.confidenceNote).toBeTruthy();
    // Must distinguish this from Case B (which mentions the exact nonce)
    expect(signal.confidenceNote.toLowerCase()).toContain('nonce');
  });
});

// ---------------------------------------------------------------------------
// Credential impact: ARC_ACTIVE_WALLET
// ---------------------------------------------------------------------------

describe('ARC_ACTIVE_WALLET credential: improved accuracy via Case B', () => {
  const engine = new SignalEngine();
  const credService = new CredentialService();

  it('wallet with nonce >= threshold earns ARC_ACTIVE_WALLET even with zero snapshot txns', () => {
    // Old behaviour: zero snapshot txns → transactionCount = 0 → not_earned
    // New behaviour (Case B): nonce = 10 → transactionCount = 10 → earned
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [], // nothing in window
      totalOutgoingTransactionCount: 10, // nonce = 10
    });
    const signals = engine.calculate(activity, emptyRegistry);
    const credentials = credService.evaluate(signals);

    const activeWallet = credentials.find((c) => c.typeId === 'ARC_ACTIVE_WALLET');
    expect(activeWallet).toBeDefined();
    expect(activeWallet!.status).toBe('active');
    // The evaluationNote should reference the count
    expect(typeof activeWallet!.evaluationNote).toBe('string');
  });

  it('wallet with nonce below threshold does not earn ARC_ACTIVE_WALLET', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 2, // nonce = 2, threshold = 5
    });
    const signals = engine.calculate(activity, emptyRegistry);
    const credentials = credService.evaluate(signals);

    const activeWallet = credentials.find((c) => c.typeId === 'ARC_ACTIVE_WALLET');
    expect(activeWallet).toBeDefined();
    expect(activeWallet!.status).toBe('not_earned');
  });

  it('credential still has partial signal evidence (count is accurate but detail is not)', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 10,
    });
    const signals = engine.calculate(activity, emptyRegistry);

    // The transactionCount signal must be 'partial' even though the count is
    // from the nonce (Case B). The credential was earned on partial data.
    const txSignal = signals.find((s) => s.key === 'transactionCount');
    expect(txSignal!.status).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// Isolation: totalOutgoingTransactionCount does NOT affect other signals
// ---------------------------------------------------------------------------

describe('Isolation: totalOutgoingTransactionCount does not affect other signals', () => {
  it('firstSeen is unaffected by totalOutgoingTransactionCount', () => {
    // Setting a high nonce does not imply any timestamp information
    const activityWithNonce = makeActivity({
      mayBeTruncated: true,
      transactions: [], // no timestamps
      totalOutgoingTransactionCount: 1000,
    });
    const activityWithoutNonce = makeActivity({
      mayBeTruncated: true,
      transactions: [],
    });
    const s1 = calculateFirstSeen(activityWithNonce);
    const s2 = calculateFirstSeen(activityWithoutNonce);
    // Both must be unavailable — nonce gives no timestamp information
    expect(s1.status).toBe('unavailable');
    expect(s1.value).toBeNull();
    expect(s2.status).toBe('unavailable');
    expect(s2.value).toBeNull();
  });

  it('activeDays is unaffected by totalOutgoingTransactionCount', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 500,
    });
    const signal = calculateActiveDays(activity);
    // activeDays counts distinct timestamp-based days — nonce provides no days
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('partial'); // truncated
  });

  it('uniqueContracts is unaffected by totalOutgoingTransactionCount', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      contractAddressesInteracted: new Set(['0xc1', '0xc2']),
      totalOutgoingTransactionCount: 999,
    });
    const signal = calculateUniqueContracts(activity);
    // uniqueContracts is set-based on observed interactions, not nonce
    expect(signal.value).toBe(2);
    expect(signal.status).toBe('partial');
  });

  it('SignalEngine passes totalOutgoingTransactionCount only to transactionCount', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      totalOutgoingTransactionCount: 42,
    });
    const engine = new SignalEngine();
    const signals = engine.calculate(activity, emptyRegistry);

    // Only transactionCount should use the nonce
    const txCount = signals.find((s) => s.key === 'transactionCount')!;
    expect(txCount.value).toBe(42);

    // firstSeen must still be unavailable
    const firstSeen = signals.find((s) => s.key === 'firstSeen')!;
    expect(firstSeen.status).toBe('unavailable');
    expect(firstSeen.value).toBeNull();

    // activeDays must still reflect only captured transactions
    const activeDays = signals.find((s) => s.key === 'activeDays')!;
    expect(activeDays.value).toBe(0);

    // economicActivity must still reflect only captured transactions
    const econ = signals.find((s) => s.key === 'economicActivity')!;
    const breakdown = JSON.parse(econ.value as string);
    expect(breakdown.nativeValueWei).toBe('0');
    expect(breakdown.usdcErc20Raw).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Regression: existing test invariants still hold
// ---------------------------------------------------------------------------

describe('Regression: existing data-quality invariants preserved', () => {
  it('zero-captured truncated wallet still reports partial (not available) for transactionCount', () => {
    // This is the original Phase 2 bug-prevention test scenario.
    // Under Phase 3B Case C (no nonce set), zero-captured still = partial.
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [],
      // totalOutgoingTransactionCount: not set → Case C
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('partial');
    // Zero here is a lower bound, NOT confirmed zero activity
  });

  it('genuine zero-activity wallet (mayBeTruncated = false, nonce = 0) remains available', () => {
    const activity = makeActivity({
      mayBeTruncated: false,
      transactions: [],
      totalOutgoingTransactionCount: 0, // confirmed zero by nonce
    });
    const signal = calculateTransactionCount(activity);
    expect(signal.value).toBe(0);
    expect(signal.status).toBe('available'); // Case A: not truncated
  });

  it('Case B: previously-zero value now reports nonce — no false zero for old wallets', () => {
    // This is the core improvement: an old wallet with nothing in the scan window
    // previously reported transactionCount = 0 (partial). Now it reports nonce = 47.
    const oldWallet = makeActivity({
      mayBeTruncated: true,
      transactions: [], // zero in window
      totalOutgoingTransactionCount: 47, // 47 lifetime transactions
    });
    const signal = calculateTransactionCount(oldWallet);
    expect(signal.value).toBe(47); // now accurate
    expect(signal.value).not.toBe(0); // explicitly: not the false zero
    expect(signal.status).toBe('partial'); // still partial (details are window-limited)
  });
});
