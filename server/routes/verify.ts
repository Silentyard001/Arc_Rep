/**
 * server/routes/verify.ts
 * POST /verify
 *
 * Phase 1: 501 Not Implemented stub.
 *
 * Phase 2 intent:
 * - Accept: { address, ruleId }
 * - Return: VerificationResult (satisfied: boolean, evidence)
 * - Eventually: privacy-preserving proof of eligibility.
 *
 * See docs/ARCHITECTURE.md for the Phase 2 design.
 */

import { Router } from 'express';

export function createVerifyRouter(): Router {
  const router = Router();

  router.post('/', (_req, res) => {
    res.status(501).json({
      error: 'Verification API is not implemented in Phase 1.',
      code: 'NOT_IMPLEMENTED',
      plannedFor: 'Phase 2',
      description:
        'In Phase 2, this endpoint will accept a wallet address and a verification rule ID, ' +
        'and return whether the wallet satisfies the rule criteria. ' +
        'Privacy-preserving verification (selective disclosure) is a longer-term goal.',
    });
  });

  return router;
}
