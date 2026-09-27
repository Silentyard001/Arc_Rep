/**
 * server/routes/health.ts
 * GET /health
 *
 * Returns a lightweight liveness + deployment-verification response.
 *
 * Fields:
 *   status       — always "ok" when the process is alive
 *   service      — service identifier
 *   version      — application version string
 *   provider     — name of the active activity provider (RPC or Goldsky)
 *   startedAt    — ISO timestamp of process startup; compare after deployment
 *                  to confirm the new process is running (not a stale restart)
 *   uptimeSeconds — seconds since startup
 *   timestamp    — current wall-clock time
 *
 * This endpoint is intentionally cheap: no provider queries, no DB calls.
 */

import { Router } from 'express';

const START_TIME = new Date();

export function createHealthRouter(providerName?: string): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const now = new Date();
    res.json({
      status: 'ok',
      service: 'arc-rep-api',
      version: '1.0.0',
      provider: providerName ?? 'unknown',
      startedAt: START_TIME.toISOString(),
      uptimeSeconds: Math.floor((now.getTime() - START_TIME.getTime()) / 1000),
      timestamp: now.toISOString(),
    });
  });

  return router;
}
