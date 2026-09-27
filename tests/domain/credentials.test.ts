/**
 * tests/domain/credentials.test.ts
 *
 * Unit tests for the CredentialService.
 *
 * Covers:
 * - Credential evaluation for each system credential
 * - Edge cases: missing signals, future signals, partial signals
 * - Evidence traceability
 */

import { describe, it, expect } from 'bun:test';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import type { ActivitySignal } from '../../server/domain/signals/types.js';
import { ACTIVE_WALLET_MIN_TXNS, EARLY_ADOPTER_CUTOFF_UNIX, MULTI_APP_MIN_APPLICATIONS } from '../../server/domain/credentials/system-credentials.js';

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

function allSignals(overrides: Partial<Record<string, ActivitySignal>> = {}): ActivitySignal[] {
  const defaults: Record<string, ActivitySignal> = {
    firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 100),
    lastSeen: makeSignal('lastSeen', EARLY_ADOPTER_CUTOFF_UNIX),
    activeDays: makeSignal('activeDays', 3),
    uniqueContracts: makeSignal('uniqueContracts', 5),
    uniqueApplications: makeSignal('uniqueApplications', MULTI_APP_MIN_APPLICATIONS),
    transactionCount: makeSignal('transactionCount', ACTIVE_WALLET_MIN_TXNS),
    economicActivity: makeSignal('economicActivity', '1000000'),
    applicationDiversity: makeSignal('applicationDiversity', 0.8),
    activityConsistency: makeSignal('activityConsistency', 0.5),
    builderActivity: makeSignal('builderActivity', null, 'future'),
    paymentActivity: makeSignal('paymentActivity', null, 'future'),
    liquidityActivity: makeSignal('liquidityActivity', null, 'future'),
    ecosystemBreadth: makeSignal('ecosystemBreadth', null, 'future'),
  };
  return Object.values({ ...defaults, ...overrides });
}

// ---------------------------------------------------------------------------
// CredentialService
// ---------------------------------------------------------------------------

describe('CredentialService', () => {
  const service = new CredentialService();

  it('returns credentials for all defined system types', () => {
    const credentials = service.evaluate(allSignals());
    const typeIds = credentials.map((c) => c.typeId);
    expect(typeIds).toContain('ARC_ACTIVE_WALLET');
    expect(typeIds).toContain('ARC_EARLY_ADOPTER');
    expect(typeIds).toContain('ARC_MULTI_APP_USER');
    expect(typeIds).toContain('ARC_CONSISTENT_USER');
  });

  it('each credential carries evaluatedAt and evaluationNote', () => {
    const credentials = service.evaluate(allSignals());
    for (const c of credentials) {
      expect(c.evaluatedAt).toBeTruthy();
      expect(typeof c.evaluationNote).toBe('string');
      expect(c.issuer.issuerType).toBe('system');
    }
  });

  // ARC_ACTIVE_WALLET
  describe('ARC_ACTIVE_WALLET', () => {
    it('is active when transactionCount >= threshold', () => {
      const creds = service.evaluate(
        allSignals({
          transactionCount: makeSignal('transactionCount', ACTIVE_WALLET_MIN_TXNS),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_ACTIVE_WALLET')!;
      expect(c.status).toBe('active');
    });

    it('is not_earned when transactionCount < threshold', () => {
      const creds = service.evaluate(
        allSignals({
          transactionCount: makeSignal('transactionCount', ACTIVE_WALLET_MIN_TXNS - 1),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_ACTIVE_WALLET')!;
      expect(c.status).toBe('not_earned');
    });

    it('is not_earned when transactionCount signal is unavailable', () => {
      const creds = service.evaluate(
        allSignals({
          transactionCount: makeSignal('transactionCount', null, 'unavailable'),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_ACTIVE_WALLET')!;
      expect(c.status).toBe('not_earned');
    });

    it('is active when transactionCount is partial (truncated snapshot)', () => {
      const creds = service.evaluate(
        allSignals({
          transactionCount: makeSignal('transactionCount', ACTIVE_WALLET_MIN_TXNS, 'partial'),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_ACTIVE_WALLET')!;
      expect(c.status).toBe('active');
    });
  });

  // ARC_EARLY_ADOPTER
  describe('ARC_EARLY_ADOPTER', () => {
    it('is active when firstSeen <= cutoff', () => {
      const creds = service.evaluate(
        allSignals({
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX - 1),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
      expect(c.status).toBe('active');
    });

    it('is not_earned when firstSeen > cutoff', () => {
      const creds = service.evaluate(
        allSignals({
          firstSeen: makeSignal('firstSeen', EARLY_ADOPTER_CUTOFF_UNIX + 1),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
      expect(c.status).toBe('not_earned');
    });

    it('is insufficient_data when firstSeen is unavailable', () => {
      // ARC_EARLY_ADOPTER requiresFullHistory = true. An unavailable firstSeen
      // means the data is insufficient — cannot determine eligibility at all.
      const creds = service.evaluate(
        allSignals({
          firstSeen: makeSignal('firstSeen', null, 'unavailable'),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_EARLY_ADOPTER')!;
      expect(c.status).toBe('insufficient_data');
    });
  });

  // ARC_MULTI_APP_USER
  describe('ARC_MULTI_APP_USER', () => {
    it('is active when uniqueApplications >= threshold', () => {
      const creds = service.evaluate(
        allSignals({
          uniqueApplications: makeSignal('uniqueApplications', MULTI_APP_MIN_APPLICATIONS),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_MULTI_APP_USER')!;
      expect(c.status).toBe('active');
    });

    it('is not_earned when uniqueApplications < threshold', () => {
      const creds = service.evaluate(
        allSignals({
          uniqueApplications: makeSignal('uniqueApplications', MULTI_APP_MIN_APPLICATIONS - 1),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_MULTI_APP_USER')!;
      expect(c.status).toBe('not_earned');
    });

    it('is not_earned when wallet has only unknown contracts (uniqueApplications = 0)', () => {
      const creds = service.evaluate(
        allSignals({
          uniqueApplications: makeSignal('uniqueApplications', 0),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_MULTI_APP_USER')!;
      expect(c.status).toBe('not_earned');
    });
  });

  // ARC_CONSISTENT_USER
  describe('ARC_CONSISTENT_USER', () => {
    it('is active when activeDays >= 2 and consistency is available', () => {
      const creds = service.evaluate(
        allSignals({
          activeDays: makeSignal('activeDays', 3),
          activityConsistency: makeSignal('activityConsistency', 0.5),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_CONSISTENT_USER')!;
      expect(c.status).toBe('active');
    });

    it('is not_earned when activeDays < 2', () => {
      const creds = service.evaluate(
        allSignals({
          activeDays: makeSignal('activeDays', 1),
          activityConsistency: makeSignal('activityConsistency', 0.5),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_CONSISTENT_USER')!;
      expect(c.status).toBe('not_earned');
    });

    it('is not_earned when consistency signal is unavailable', () => {
      const creds = service.evaluate(
        allSignals({
          activeDays: makeSignal('activeDays', 5),
          activityConsistency: makeSignal('activityConsistency', null, 'unavailable'),
        }),
      );
      const c = creds.find((c) => c.typeId === 'ARC_CONSISTENT_USER')!;
      expect(c.status).toBe('not_earned');
    });
  });

  // Evidence traceability
  describe('evidence traceability', () => {
    it('ARC_ACTIVE_WALLET evidence includes transactionCount signal', () => {
      const creds = service.evaluate(allSignals());
      const c = creds.find((c) => c.typeId === 'ARC_ACTIVE_WALLET')!;
      const evidence = c.evidenceSignals.find((e) => e.signalKey === 'transactionCount');
      expect(evidence).toBeDefined();
      expect(evidence?.value).toBe(ACTIVE_WALLET_MIN_TXNS);
    });

    it('all evidence signals have required fields', () => {
      const creds = service.evaluate(allSignals());
      for (const c of creds) {
        for (const e of c.evidenceSignals) {
          expect(e.signalKey).toBeTruthy();
          expect(e.signalLabel).toBeTruthy();
          expect(typeof e.signalStatus).toBe('string');
        }
      }
    });
  });

  // Empty wallet
  describe('empty wallet history', () => {
    it('handles empty signal set gracefully', () => {
      const creds = service.evaluate([]);
      // All credentials should be not_earned OR insufficient_data (required signals missing).
      // Credentials with requiresFullHistory or future signals return insufficient_data;
      // others return not_earned. None should be 'active' or 'stale'.
      for (const c of creds) {
        expect(['not_earned', 'insufficient_data']).toContain(c.status);
      }
    });
  });
});
