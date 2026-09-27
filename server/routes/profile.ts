/**
 * server/routes/profile.ts
 * GET /profile/:address
 *
 * Returns a full WalletProfile for the given address.
 * Errors from the provider or domain layer are caught and returned
 * as structured JSON without leaking stack traces.
 */

import { Router } from 'express';
import { validateAddress } from '../middleware/validate-address.js';
import { ActivityProviderError } from '../data/IActivityProvider.js';
import type { ProfileService } from '../domain/profile/ProfileService.js';

export function createProfileRouter(profileService: ProfileService): Router {
  const router = Router();

  router.get('/:address', validateAddress, async (req, res) => {
    const { address } = req.params;

    try {
      const profile = await profileService.buildProfile(address);
      res.json(profile);
    } catch (err) {
      if (err instanceof ActivityProviderError) {
        res.status(502).json({
          error: 'Unable to retrieve on-chain activity for this address.',
          detail: err.message,
          code: 'PROVIDER_ERROR',
        });
        return;
      }
      console.error('[profile] Unexpected error for', address, err);
      res.status(500).json({
        error: 'An unexpected error occurred while building the profile.',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  return router;
}
