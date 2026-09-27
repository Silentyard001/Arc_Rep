/**
 * server/routes/credentials.ts
 * GET /credentials/:address
 *
 * Returns only the Credential[] for a given address.
 */

import { Router } from 'express';
import { validateAddress } from '../middleware/validate-address.js';
import { ActivityProviderError } from '../data/IActivityProvider.js';
import type { ProfileService } from '../domain/profile/ProfileService.js';

export function createCredentialsRouter(profileService: ProfileService): Router {
  const router = Router();

  router.get('/:address', validateAddress, async (req, res) => {
    const { address } = req.params;

    try {
      const profile = await profileService.buildProfile(address);
      res.json({
        address: profile.address,
        chainId: profile.chainId,
        credentials: profile.credentials,
        evaluatedAt: profile.profileBuiltAt,
      });
    } catch (err) {
      if (err instanceof ActivityProviderError) {
        res.status(502).json({
          error: 'Unable to retrieve on-chain activity.',
          detail: err.message,
          code: 'PROVIDER_ERROR',
        });
        return;
      }
      console.error('[credentials] Unexpected error for', address, err);
      res.status(500).json({
        error: 'An unexpected error occurred while evaluating credentials.',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  return router;
}
