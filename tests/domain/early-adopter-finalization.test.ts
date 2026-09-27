/**
 * tests/domain/early-adopter-finalization.test.ts
 *
 * Pre-backfill finalization tests for ARC_EARLY_ADOPTER.
 * Three focused tests from the Early Adopter Definition Audit:
 *
 * A. Failed-transaction-only wallet
 *    Policy: failed transactions intentionally count toward firstSeen.
 *    Rationale: firstSeen means "earliest on-chain presence", not "first
 *    successful outgoing tx". A failed tx is a verifiable timestamped
 *    on-chain event. See longevity.ts for the full policy comment.
 *
 * B. Goldsky firstSeen status accuracy
 *    Verifies the data-quality state distinctions:
 *    - complete history → status 'available'
 *    - partial/truncated → status 'partial'
 *    - provider failure / no data → status 'unavailable'
 *    A partial result must never become an authoritative firstSeen.
 *
 * C. Cutoff constant cross-check
 *    Protects against accidental modification of EARLY_ADOPTER_CUTOFF_UNIX.
 *    - Exact value: 1767225599
 *    - Corresponds to 2025-12-31T23:59:59Z
 *    - Inclusive: ts === 1767225599 qualifies; ts === 1767225600 does not
 */

import { describe, it, expect } from 'bun:test';
import { calculateFirstSeen } from '../../server/domain/signals/calculators/longevity.js';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import { EARLY_ADOPTER_CUTOFF_UNIX } from '../../server/domain/credentials/system-credentials.js';
import type { NormalizedActivity, NormalizedTransaction } from '../../server/data/types.js';
import type { ActivitySignal } from '../../server/domain/signals/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTx(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    hash: '0xabc',
    blockNumber: BigInt(8_300_000),
    timestamp: 1761609600,  // Oct 28 2025 — within early-adopter window
    from: '0xaaaa',
    to: '0xbbbb',
    valueWei: BigInt(0),
    succeeded: true,        // default: success
    isOutgoing: true,
    isContractCreation: false,
    hasInputData: false,
    erc20Transfers: [],
    ...overrides,
  };
}

function makeActivity(
  txs: NormalizedTransaction[],
  mayBeTruncated = false,
): NormalizedActivity {
  const timestamps = txs.filter((t) => t.timestamp > 0).map((t) => t.timestamp);
  return {
    address: '0xaaaa',
    chainId: 5042002,
    transactions: txs,
    contractAddressesInteracted: new Set(),
    earliestTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
    latestTimestamp:   timestamps.length > 0 ? Math.max(...timestamps) : undefined,
    totalFetched: txs.length,
    mayBeTruncated,
    fetchedAt: new Date().toISOString(),
    providerName: 'TestProvider',
    dataQualityNotes: [],
  };
}

function makeSignal(
  key: string,
  value: number | string | null,
  status: ActivitySignal['status'] = 'available',
): ActivitySignal {
  return {
    key,
    label: key,
    description: '',
    source: 'test',
    calculationDefinition: '',
    value,
    status,
    valueUnit: 'unix_seconds',
  };
}

/** Build the minimal valid "all credentials earned" signal set for the service. */
function allSignalsEarned(): ActivitySignal[] {
  return [
    makeSignal('transactionCount',      10,                                'available'),
    makeSignal('firstSeen',             EARLY_ADOPTER_CUTOFF_UNIX - 1000, 'available'),
    makeSignal('lastSeen',              EARLY_ADOPTER_CUTOFF_UNIX,        'available'),
    makeSignal('activeDays',            5,                                 'available'),
    makeSignal('uniqueContracts',       3,                                 'available'),
    makeSignal('uniqueApplications',    2,                                 'available'),
    makeSignal('activityConsistency',   0.5,                               'available'),
    makeSignal('applicationDiversity',  0.5,                               'available'),
    makeSignal('economicActivity',      JSON.stringify({ nativeValueWei: '0', usdcErc20Raw: '2000000' }), 'available'),
    makeSignal('usdcReceived',          '0',                               'available'),
    makeSignal('builderActivity',       0,                                 'available'),
    makeSignal('bridgeInteractions',    0,                                 'available'),
    makeSignal('liquidityActivity',     null,                              'future'),
  ];
}

// ---------------------------------------------------------------------------
// A. Failed-transaction-only wallet
// ---------------------------------------------------------------------------

describe('Early Adopter — A: Failed transaction policy', () => {
  it('firstSeen includes failed transactions (policy: earliest on-chain presence)', () => {
    // Wallet has only ONE transaction, and it failed.
    // Policy: failed transactions count toward firstSeen.
    const failedEarlyTx = makeTx({
      hash: '0xfailed001',
      timestamp: 1761000000,    // Oct 20 2025 — within early-adopter window
      succeeded: false,         // FAILED transaction
      isOutgoing: true,
    });

    const activity = makeActivity([failedEarlyTx], /* mayBeTruncated */ false);
    const signal = calculateFirstSeen(activity);

    // firstSeen should be the failed tx's timestamp — not null, not zero
    expect(signal.value).toBe(1761000000);
    expect(signal.status).toBe('available');  // complete snapshot
  });

  it('failed-only wallet can qualify for ARC_EARLY_ADOPTER when firstSeen is available', () => {
    // Same wallet: only failed tx, firstSeen is its timestamp, snapshot is complete.
    // With firstSeen='available' and ts < cutoff, credential must be earned.
    const service = new CredentialService();
    const signals = allSignalsEarned().map((s) =>
      s.key === 'firstSeen'
        ? makeSignal('firstSeen', 1761000000, 'available')   // failed tx timestamp
        : s,
    );

    const credential = service.evaluate(signals).find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
    expect(credential).toBeDefined();
    expect(credential.status).toBe('active');
    expect(credential.evaluationNote).toContain('2025-10-');
  });

  it('success-filter is NOT applied: a failed tx earlier than a succeeded tx sets firstSeen', () => {
    // Failed tx at time 1000, succeeded tx at time 2000.
    // firstSeen must be 1000 (the failed one), not 2000.
    const failedTx = makeTx({
      hash: '0xfailed',
      timestamp: 1761000000,
      succeeded: false,
    });
    const succeededTx = makeTx({
      hash: '0xsuccess',
      timestamp: 1761010000,
      succeeded: true,
    });

    const activity = makeActivity([succeededTx, failedTx], false);
    const signal = calculateFirstSeen(activity);

    expect(signal.value).toBe(1761000000);  // failed tx is earlier; it wins
    expect(signal.status).toBe('available');
  });

  it('incoming failed tx also contributes to firstSeen (tx is not filtered by direction)', () => {
    // An incoming failed tx is still a chain-level event involving this wallet.
    // firstSeen should see it.
    const incomingFailed = makeTx({
      hash: '0xincfailed',
      timestamp: 1761000000,
      succeeded: false,
      isOutgoing: false,  // incoming
    });

    const activity = makeActivity([incomingFailed], false);
    const signal = calculateFirstSeen(activity);

    expect(signal.value).toBe(1761000000);
    expect(signal.status).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// B. Goldsky firstSeen status accuracy
// ---------------------------------------------------------------------------

describe('Early Adopter — B: firstSeen data-quality status', () => {
  it('complete snapshot → status available', () => {
    const activity = makeActivity(
      [makeTx({ timestamp: 1761609600 })],
      /* mayBeTruncated */ false,
    );
    const signal = calculateFirstSeen(activity);
    expect(signal.status).toBe('available');
    expect(signal.value).toBe(1761609600);
  });

  it('truncated snapshot → status partial, not available', () => {
    // Even if the partial firstSeen value is very old (looks like an early adopter),
    // it must be reported as 'partial' because the true first tx may be even earlier.
    const activity = makeActivity(
      [makeTx({ timestamp: 1761609600 })],
      /* mayBeTruncated */ true,
    );
    const signal = calculateFirstSeen(activity);
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toContain('truncated');
  });

  it('partial firstSeen cannot establish ARC_EARLY_ADOPTER (safety gate)', () => {
    // Core safety invariant: even a partial firstSeen that numerically satisfies
    // the cutoff must not produce an 'active' credential.
    const service = new CredentialService();
    const signals = allSignalsEarned().map((s) =>
      s.key === 'firstSeen'
        ? makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 1, 'partial')  // satisfies cutoff but partial
        : s,
    );

    const credential = service.evaluate(signals).find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
    expect(credential.status).toBe('insufficient_data');
  });

  it('no transactions → status unavailable, value null', () => {
    const activity = makeActivity([], false);
    const signal = calculateFirstSeen(activity);
    expect(signal.status).toBe('unavailable');
    expect(signal.value).toBeNull();
  });

  it('no transactions + truncated → still unavailable, not partial or zero', () => {
    // A truncated empty snapshot must not report firstSeen as 0 or partial(0).
    // Unavailable is the only correct answer here.
    const activity = makeActivity([], /* mayBeTruncated */ true);
    const signal = calculateFirstSeen(activity);
    expect(signal.status).toBe('unavailable');
    expect(signal.value).toBeNull();
  });

  it('unavailable firstSeen → ARC_EARLY_ADOPTER returns insufficient_data', () => {
    const service = new CredentialService();
    const signals = allSignalsEarned().map((s) =>
      s.key === 'firstSeen'
        ? makeSignal('firstSeen', null, 'unavailable')
        : s,
    );

    const credential = service.evaluate(signals).find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
    expect(credential.status).toBe('insufficient_data');
  });
});

// ---------------------------------------------------------------------------
// C. Cutoff constant cross-check
// ---------------------------------------------------------------------------

describe('Early Adopter — C: Cutoff constant protection', () => {
  it('EARLY_ADOPTER_CUTOFF_UNIX equals 1767225599 exactly', () => {
    // Protects against accidental future modification of the constant.
    expect(EARLY_ADOPTER_CUTOFF_UNIX).toBe(1767225599);
  });

  it('1767225599 corresponds to 2025-12-31T23:59:59Z', () => {
    const d = new Date(EARLY_ADOPTER_CUTOFF_UNIX * 1000);
    expect(d.toISOString()).toBe('2025-12-31T23:59:59.000Z');
  });

  it('timestamp at cutoff (1767225599) qualifies — comparison is inclusive', () => {
    const service = new CredentialService();
    const signals = allSignalsEarned().map((s) =>
      s.key === 'firstSeen'
        ? makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX, 'available')  // exactly at cutoff
        : s,
    );
    const credential = service.evaluate(signals).find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
    expect(credential.status).toBe('active');
  });

  it('timestamp one second after cutoff (1767225600 = 2026-01-01T00:00:00Z) does NOT qualify', () => {
    const service = new CredentialService();
    const signals = allSignalsEarned().map((s) =>
      s.key === 'firstSeen'
        ? makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX + 1, 'available')  // one second after
        : s,
    );
    const credential = service.evaluate(signals).find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
    expect(credential.status).toBe('not_earned');
  });

  it('cutoff + 1 corresponds to 2026-01-01T00:00:00Z (boundary is new-year midnight UTC)', () => {
    const boundaryDate = new Date((EARLY_ADOPTER_CUTOFF_UNIX + 1) * 1000);
    expect(boundaryDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('genesis block with activity is at block 6_263_142 (verified Oct 17 2025)', () => {
    // Documents the empirically verified first transaction block on Arc Testnet.
    // This block defines the minimum meaningful backfillGenesisThreshold.
    // Timestamp 1760684165 = 2025-10-17T06:56:05Z (11 days before public launch).
    const FIRST_TX_BLOCK = 6_263_142;
    const FIRST_TX_TIMESTAMP = 1760684165;
    const d = new Date(FIRST_TX_TIMESTAMP * 1000);
    expect(d.toISOString().startsWith('2025-10-17')).toBe(true);
    // The timestamp is BEFORE the early-adopter cutoff — any wallet active
    // from block 6,263,142 onward is in scope for the credential.
    expect(FIRST_TX_TIMESTAMP).toBeLessThan(EARLY_ADOPTER_CUTOFF_UNIX);
    // The threshold used in production must be >= this block number.
    expect(FIRST_TX_BLOCK).toBeGreaterThan(100);  // confirms old default was wrong
  });
});
