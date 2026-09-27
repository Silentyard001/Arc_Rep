/**
 * tests/domain/credentials-phase6.test.ts
 *
 * Phase 6 credential system tests.
 *
 * Covers:
 * - All 7 credential definitions are returned
 * - insufficient_data semantics for requiresFullHistory credentials
 * - insufficient_data for future signals (ARC_BUILDER, ARC_LIQUIDITY_PARTICIPANT)
 * - ARC_EARLY_ADOPTER: only active when firstSeen is 'available' (not partial)
 * - ARC_PAYMENTS_PARTICIPANT: outgoing + incoming USDC, thresholds, zero activity
 * - exact threshold boundaries
 * - zero activity
 * - partial data
 * - unknown wallets
 * - incoming vs outgoing transfers
 * - missing signals
 * - malformed economicActivity JSON
 * - evidence traceability for new credentials
 * - observationPeriodNote present on insufficient_data, absent elsewhere
 */

import { describe, it, expect } from 'bun:test';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import type { ActivitySignal } from '../../server/domain/signals/types.js';
import {
  ACTIVE_WALLET_MIN_TXNS,
  EARLY_ADOPTER_CUTOFF_UNIX,
  MULTI_APP_MIN_APPLICATIONS,
  PAYMENTS_MIN_USDC_RAW,
} from '../../server/domain/credentials/system-credentials.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(
  key: string,
  value: number | string | null,
  status: ActivitySignal['status'] = 'available',
): ActivitySignal {
  return {
    key,
    label: key,
    value,
    status,
    description: 'Test signal',
    source: 'test',
    calculationDefinition: 'test',
    valueUnit: 'count',
    confidenceNote: '',
  };
}

function economicBreakdown(nativeValueWei: string, usdcErc20Raw: string): string {
  return JSON.stringify({ nativeValueWei, usdcErc20Raw });
}

/** Full set of signals that causes all evaluatable credentials to pass */
function allSignalsEarned(overrides: Partial<Record<string, ActivitySignal>> = {}): ActivitySignal[] {
  const defaults: Record<string, ActivitySignal> = {
    firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 100, 'available'),
    lastSeen: makeSignal('lastSeen', EARLY_ADOPTER_CUTOFF_UNIX),
    activeDays: makeSignal('activeDays', 3),
    uniqueContracts: makeSignal('uniqueContracts', 5),
    uniqueApplications: makeSignal('uniqueApplications', MULTI_APP_MIN_APPLICATIONS),
    transactionCount: makeSignal('transactionCount', ACTIVE_WALLET_MIN_TXNS),
    economicActivity: makeSignal(
      'economicActivity',
      economicBreakdown('0', PAYMENTS_MIN_USDC_RAW.toString()),
    ),
    usdcReceived: makeSignal('usdcReceived', '0'),
    applicationDiversity: makeSignal('applicationDiversity', 0.8),
    activityConsistency: makeSignal('activityConsistency', 0.5),
    builderActivity: makeSignal('builderActivity', null, 'future'),
    paymentActivity: makeSignal('paymentActivity', null, 'future'),
    liquidityActivity: makeSignal('liquidityActivity', null, 'future'),
    ecosystemBreadth: makeSignal('ecosystemBreadth', null, 'future'),
  };
  return Object.values({ ...defaults, ...overrides });
}

function getCredential(
  service: CredentialService,
  typeId: string,
  signals: ActivitySignal[],
) {
  return service.evaluate(signals).find((c) => c.typeId === typeId)!;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CredentialService Phase 6', () => {
  const service = new CredentialService();

  // -------------------------------------------------------------------------
  // Credential set completeness
  // -------------------------------------------------------------------------
  describe('credential set completeness', () => {
    it('returns all 7 defined credentials', () => {
      const creds = service.evaluate(allSignalsEarned());
      const typeIds = creds.map((c) => c.typeId);
      expect(typeIds).toContain('ARC_ACTIVE_WALLET');
      expect(typeIds).toContain('ARC_EARLY_ADOPTER');
      expect(typeIds).toContain('ARC_MULTI_APP_USER');
      expect(typeIds).toContain('ARC_CONSISTENT_USER');
      expect(typeIds).toContain('ARC_PAYMENTS_PARTICIPANT');
      expect(typeIds).toContain('ARC_BUILDER');
      expect(typeIds).toContain('ARC_LIQUIDITY_PARTICIPANT');
      expect(typeIds).toContain('ARC_BRIDGE_USER');
      expect(creds).toHaveLength(8);
    });

    it('every credential has evaluatedAt, evaluationNote, and issuer', () => {
      const creds = service.evaluate(allSignalsEarned());
      for (const c of creds) {
        expect(c.evaluatedAt).toBeTruthy();
        expect(typeof c.evaluationNote).toBe('string');
        expect(c.issuer.issuerType).toBe('system');
        expect(typeof c.observationPeriodNote).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // insufficient_data semantics
  // -------------------------------------------------------------------------
  describe('insufficient_data semantics', () => {
    it('observationPeriodNote is non-empty on insufficient_data', () => {
      const creds = service.evaluate(allSignalsEarned());
      const insufficient = creds.filter((c) => c.status === 'insufficient_data');
      for (const c of insufficient) {
        expect(c.observationPeriodNote.length).toBeGreaterThan(0);
      }
    });

    it('observationPeriodNote is empty string on active credentials', () => {
      const creds = service.evaluate(allSignalsEarned());
      const active = creds.filter((c) => c.status === 'active');
      for (const c of active) {
        expect(c.observationPeriodNote).toBe('');
      }
    });

    it('observationPeriodNote is empty string on not_earned credentials', () => {
      const creds = service.evaluate(
        allSignalsEarned({
          transactionCount: makeSignal('transactionCount', 0),
          uniqueApplications: makeSignal('uniqueApplications', 0),
          activeDays: makeSignal('activeDays', 0),
          activityConsistency: makeSignal('activityConsistency', null, 'unavailable'),
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', '0')),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      const notEarned = creds.filter((c) => c.status === 'not_earned');
      for (const c of notEarned) {
        expect(c.observationPeriodNote).toBe('');
      }
    });
  });

  // -------------------------------------------------------------------------
  // ARC_EARLY_ADOPTER — requiresFullHistory = true
  // -------------------------------------------------------------------------
  describe('ARC_EARLY_ADOPTER', () => {
    it('is active when firstSeen is available AND <= cutoff', () => {
      const c = getCredential(
        service,
        'ARC_EARLY_ADOPTER',
        allSignalsEarned({
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 1, 'available'),
        }),
      );
      expect(c.status).toBe('active');
    });

    it('is not_earned when firstSeen is available AND > cutoff', () => {
      const c = getCredential(
        service,
        'ARC_EARLY_ADOPTER',
        allSignalsEarned({
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX + 1, 'available'),
        }),
      );
      expect(c.status).toBe('not_earned');
    });

    it('is active at exact cutoff boundary (firstSeen === cutoff, available)', () => {
      const c = getCredential(
        service,
        'ARC_EARLY_ADOPTER',
        allSignalsEarned({
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX, 'available'),
        }),
      );
      expect(c.status).toBe('active');
    });

    it('is insufficient_data when firstSeen is partial (window-limited snapshot)', () => {
      const c = getCredential(
        service,
        'ARC_EARLY_ADOPTER',
        allSignalsEarned({
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 1, 'partial'),
        }),
      );
      expect(c.status).toBe('insufficient_data');
      expect(c.observationPeriodNote.length).toBeGreaterThan(0);
    });

    it('is insufficient_data even if partial firstSeen value satisfies cutoff', () => {
      // This is the core safety test: a partial firstSeen that appears to
      // satisfy the cutoff must NOT produce 'active' — the wallet may have
      // been active earlier than the window captures.
      const c = getCredential(
        service,
        'ARC_EARLY_ADOPTER',
        allSignalsEarned({
          firstSeen: makeSignal('firstSeen', 1000000, 'partial'), // very old timestamp
        }),
      );
      expect(c.status).toBe('insufficient_data');
    });

    it('is insufficient_data when firstSeen is unavailable', () => {
      const c = getCredential(
        service,
        'ARC_EARLY_ADOPTER',
        allSignalsEarned({
          firstSeen: makeSignal('firstSeen', null, 'unavailable'),
        }),
      );
      expect(c.status).toBe('insufficient_data');
    });

    it('is insufficient_data when firstSeen signal is missing entirely', () => {
      const signals = allSignalsEarned().filter((s) => s.key !== 'firstSeen');
      const c = getCredential(service, 'ARC_EARLY_ADOPTER', signals);
      expect(c.status).toBe('insufficient_data');
    });
  });

  // -------------------------------------------------------------------------
  // ARC_BUILDER — future signal
  // -------------------------------------------------------------------------
  describe('ARC_BUILDER', () => {
    it('is insufficient_data because builderActivity is future', () => {
      const c = getCredential(
        service,
        'ARC_BUILDER',
        allSignalsEarned({
          builderActivity: makeSignal('builderActivity', null, 'future'),
        }),
      );
      expect(c.status).toBe('insufficient_data');
      expect(c.evaluationNote).toContain('builderActivity');
    });

    it('is insufficient_data even if builderActivity signal is absent', () => {
      const signals = allSignalsEarned().filter((s) => s.key !== 'builderActivity');
      const c = getCredential(service, 'ARC_BUILDER', signals);
      expect(c.status).toBe('insufficient_data');
    });
  });

  // -------------------------------------------------------------------------
  // ARC_LIQUIDITY_PARTICIPANT — future signal
  // -------------------------------------------------------------------------
  describe('ARC_LIQUIDITY_PARTICIPANT', () => {
    it('is insufficient_data because liquidityActivity is future', () => {
      const c = getCredential(
        service,
        'ARC_LIQUIDITY_PARTICIPANT',
        allSignalsEarned({
          liquidityActivity: makeSignal('liquidityActivity', null, 'future'),
        }),
      );
      expect(c.status).toBe('insufficient_data');
      expect(c.evaluationNote).toContain('liquidityActivity');
    });
  });

  // -------------------------------------------------------------------------
  // ARC_PAYMENTS_PARTICIPANT
  // -------------------------------------------------------------------------
  describe('ARC_PAYMENTS_PARTICIPANT', () => {
    const minRaw = PAYMENTS_MIN_USDC_RAW.toString();
    const belowMin = (PAYMENTS_MIN_USDC_RAW - BigInt(1)).toString();

    it('is active when outgoing USDC >= threshold', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal(
            'economicActivity',
            economicBreakdown('0', minRaw),
          ),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      expect(c.status).toBe('active');
    });

    it('is active when incoming USDC >= threshold', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal(
            'economicActivity',
            economicBreakdown('0', '0'),
          ),
          usdcReceived: makeSignal('usdcReceived', minRaw),
        }),
      );
      expect(c.status).toBe('active');
    });

    it('is active when only incoming meets threshold (outgoing = 0)', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', '0')),
          usdcReceived: makeSignal('usdcReceived', minRaw),
        }),
      );
      expect(c.status).toBe('active');
      expect(c.evaluationNote).toContain('received');
    });

    it('is active when only outgoing meets threshold (incoming = 0)', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', minRaw)),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      expect(c.status).toBe('active');
      expect(c.evaluationNote).toContain('sent');
    });

    it('is not_earned when both outgoing and incoming are 0', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', '0')),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      expect(c.status).toBe('not_earned');
    });

    it('is not_earned when both are below threshold', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', belowMin)),
          usdcReceived: makeSignal('usdcReceived', belowMin),
        }),
      );
      expect(c.status).toBe('not_earned');
    });

    it('is active at exact outgoing threshold boundary', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', minRaw)),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      expect(c.status).toBe('active');
    });

    it('is not_earned at one below outgoing threshold boundary', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', belowMin)),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      expect(c.status).toBe('not_earned');
    });

    it('does NOT double-count: native wei does not satisfy USDC threshold', () => {
      // 10^18 native wei is 1 ETH-equivalent — but on Arc that is still
      // native USDC, however the credential uses the ERC-20 6-decimal value.
      // A large nativeValueWei should NOT trigger the threshold.
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal(
            'economicActivity',
            economicBreakdown('1000000000000000000', '0'), // 1e18 native, 0 erc20
          ),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      // nativeValueWei is not counted toward USDC threshold
      expect(c.status).toBe('not_earned');
    });

    it('is not_earned when economicActivity signal is unavailable and usdcReceived is zero', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', null, 'unavailable'),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      expect(c.status).toBe('not_earned');
    });

    it('is insufficient_data when both signals are unavailable', () => {
      // P8S-02: provider failure (both signals unavailable) must not collapse
      // to not_earned — it must be insufficient_data.
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', null, 'unavailable'),
          usdcReceived: makeSignal('usdcReceived', null, 'unavailable'),
        }),
      );
      expect(c.status).toBe('insufficient_data');
    });

    it('handles malformed economicActivity JSON gracefully (treats outgoing as 0)', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', 'not-valid-json'),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      // Malformed JSON → outgoing treated as 0, incoming = 0 → not_earned
      expect(c.status).toBe('not_earned');
    });

    it('is active with malformed economicActivity JSON when incoming meets threshold', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal('economicActivity', 'not-valid-json'),
          usdcReceived: makeSignal('usdcReceived', minRaw),
        }),
      );
      // Malformed JSON → outgoing = 0, but incoming meets threshold
      expect(c.status).toBe('active');
    });

    it('works with partial signal status', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal(
            'economicActivity',
            economicBreakdown('0', minRaw),
            'partial',
          ),
          usdcReceived: makeSignal('usdcReceived', '0', 'partial'),
        }),
      );
      expect(c.status).toBe('active');
    });

    it('evidence includes both economicActivity and usdcReceived signals', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned(),
      );
      const keys = c.evidenceSignals.map((e) => e.signalKey);
      expect(keys).toContain('economicActivity');
      expect(keys).toContain('usdcReceived');
    });
  });

  // -------------------------------------------------------------------------
  // Zero activity / unknown wallet
  // -------------------------------------------------------------------------
  describe('zero activity / unknown wallet', () => {
    it('handles completely empty signal set: all credentials not_earned or insufficient_data', () => {
      const creds = service.evaluate([]);
      for (const c of creds) {
        expect(['not_earned', 'insufficient_data']).toContain(c.status);
      }
    });

    it('a wallet with 0 transactions earns no credentials', () => {
      const creds = service.evaluate(
        allSignalsEarned({
          transactionCount: makeSignal('transactionCount', 0),
          uniqueApplications: makeSignal('uniqueApplications', 0),
          activeDays: makeSignal('activeDays', 1),
          activityConsistency: makeSignal('activityConsistency', null, 'unavailable'),
          economicActivity: makeSignal('economicActivity', economicBreakdown('0', '0')),
          usdcReceived: makeSignal('usdcReceived', '0'),
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 1, 'available'),
        }),
      );
      const active = creds.filter((c) => c.status === 'active');
      // firstSeen is available and before cutoff — ARC_EARLY_ADOPTER can still
      // be active for a wallet with no recent transactions (historical data)
      const activeIds = active.map((c) => c.typeId);
      expect(activeIds).not.toContain('ARC_ACTIVE_WALLET');
      expect(activeIds).not.toContain('ARC_MULTI_APP_USER');
      expect(activeIds).not.toContain('ARC_CONSISTENT_USER');
      expect(activeIds).not.toContain('ARC_PAYMENTS_PARTICIPANT');
    });
  });

  // -------------------------------------------------------------------------
  // Evidence traceability
  // -------------------------------------------------------------------------
  describe('evidence traceability', () => {
    it('ARC_PAYMENTS_PARTICIPANT evidence has non-zero signals when active', () => {
      const c = getCredential(
        service,
        'ARC_PAYMENTS_PARTICIPANT',
        allSignalsEarned({
          economicActivity: makeSignal(
            'economicActivity',
            economicBreakdown('0', PAYMENTS_MIN_USDC_RAW.toString()),
          ),
          usdcReceived: makeSignal('usdcReceived', '0'),
        }),
      );
      expect(c.status).toBe('active');
      const ea = c.evidenceSignals.find((e) => e.signalKey === 'economicActivity');
      expect(ea).toBeDefined();
    });

    it('ARC_BUILDER evidence signals are empty (no usable signals exist)', () => {
      const c = getCredential(service, 'ARC_BUILDER', allSignalsEarned());
      // future signal — evidence is empty because Gate 1 catches it before evidence collection
      expect(c.evidenceSignals).toHaveLength(0);
    });

    it('all active credentials carry at least one evidence signal', () => {
      const creds = service.evaluate(allSignalsEarned());
      const active = creds.filter((c) => c.status === 'active');
      for (const c of active) {
        expect(c.evidenceSignals.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Partial data guard — no credential is accidentally elevated
  // -------------------------------------------------------------------------
  describe('partial data guard', () => {
    it('ARC_ACTIVE_WALLET CAN be earned with partial transactionCount', () => {
      // transactionCount uses nonce fallback — partial is intentionally allowed
      const c = getCredential(
        service,
        'ARC_ACTIVE_WALLET',
        allSignalsEarned({
          transactionCount: makeSignal('transactionCount', ACTIVE_WALLET_MIN_TXNS, 'partial'),
        }),
      );
      expect(c.status).toBe('active');
    });

    it('ARC_EARLY_ADOPTER cannot be earned with partial firstSeen', () => {
      const c = getCredential(
        service,
        'ARC_EARLY_ADOPTER',
        allSignalsEarned({
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 1, 'partial'),
        }),
      );
      expect(c.status).toBe('insufficient_data');
    });
  });
});
