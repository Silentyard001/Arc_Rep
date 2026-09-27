/**
 * server/middleware/validate-address.ts
 *
 * Express middleware that validates an :address route parameter.
 *
 * Rejects requests with malformed EVM addresses before they reach
 * the domain layer. Returns a structured 400 error.
 */

import type { Request, Response, NextFunction } from 'express';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function validateAddress(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { address } = req.params;

  if (!address) {
    res.status(400).json({
      error: 'Missing address parameter.',
      code: 'MISSING_ADDRESS',
    });
    return;
  }

  if (!EVM_ADDRESS_RE.test(address)) {
    res.status(400).json({
      error: `Invalid EVM address: "${address}". Expected a 0x-prefixed 40-character hex string.`,
      code: 'INVALID_ADDRESS',
    });
    return;
  }

  next();
}
