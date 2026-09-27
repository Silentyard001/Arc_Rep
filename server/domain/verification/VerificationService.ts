/**
 * server/domain/verification/VerificationService.ts
 *
 * Stub — not implemented in Phase 1.
 *
 * Phase 2 design intent:
 * - Projects register VerificationRules specifying criteria over signal keys.
 * - VerificationService evaluates a wallet against a rule.
 * - Returns a VerificationResult (satisfied: boolean, evidence).
 * - Long-term: selective disclosure / ZK proofs so projects can confirm
 *   eligibility without receiving full wallet activity.
 *
 * The HTTP route POST /verify returns 501 Not Implemented in Phase 1.
 */

export class VerificationService {
  /**
   * Stub: always throws to signal not-implemented.
   * The API route handles this gracefully with 501.
   */
  evaluate(_address: string, _ruleId: string): never {
    throw new Error(
      'VerificationService is not implemented in Phase 1. ' +
        'See docs/ARCHITECTURE.md for the Phase 2 design.',
    );
  }
}
