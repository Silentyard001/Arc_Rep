/**
 * server/routes/signals.ts
 * GET /signals/:address
 *
 * Returns only the ActivitySignal[] for a given address.
 * Runs the full pipeline (provider → registry → signal engine).
 */

import { Router } from 'express';
import { validateAddress } from '../middleware/validate-address.js';
import { ActivityProviderError } from '../data/IActivityProvider.js';
import type { ProfileService } from '../domain/profile/ProfileService.js';

export function createSignalsRouter(profileService: ProfileService): Router {
  const router = Router();

  router.get('/:address', validateAddress, async (req, res) => {
    const { address } = req.params;

    try {
      const profile = await profileService.buildProfile(address);
      res.json({
        address: profile.address,
        chainId: profile.chainId,
        signals: profile.signals,
        fetchedAt: profile.activitySummary.fetchedAt,
        dataQualityNotes: profile.activitySummary.dataQualityNotes,
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
      console.error('[signals] Unexpected error for', address, err);
      res.status(500).json({
        error: 'An unexpected error occurred while computing signals.',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  return router;
}
