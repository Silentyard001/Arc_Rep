/**
 * server/index.ts
 *
 * Arc Rep API server.
 *
 * Wires together:
 * - ArcRpcProvider (data layer)
 * - InMemoryApplicationRegistry (application recognition)
 * - ProfileService (domain orchestration)
 * - Express routes
 *
 * The frontend (Vite, port 5173) reaches this server via the /api proxy
 * configured in vite.config.ts.
 */

import express from 'express';
import cors from 'cors';
import { ArcRpcProvider } from './data/ArcRpcProvider.js';
import { GoldskyActivityProvider } from './data/GoldskyActivityProvider.js';
import type { IActivityProvider } from './data/IActivityProvider.js';
import { InMemoryApplicationRegistry } from './domain/applications/ApplicationRegistry.js';
import {
  SEED_APPLICATIONS,
  SEED_CONTRACTS,
  SEED_CATEGORIES,
} from './domain/applications/seed-data.js';
import { ProfileService } from './domain/profile/ProfileService.js';
import { createHealthRouter } from './routes/health.js';
import { createProfileRouter } from './routes/profile.js';
import { createSignalsRouter } from './routes/signals.js';
import { createCredentialsRouter } from './routes/credentials.js';
import { createVerifyRouter } from './routes/verify.js';

// ---------------------------------------------------------------------------
// Dependency wiring
// ---------------------------------------------------------------------------

/**
 * Provider selection: configuration-driven.
 *
 * When GOLDSKY_POSTGRES_URL is set, GoldskyActivityProvider is used as the
 * primary provider. It queries a Postgres database populated by the Goldsky
 * Mirror pipeline (infra/goldsky/arc-rep-pipeline.yaml) and covers full chain
 * history from genesis.
 *
 * When GOLDSKY_POSTGRES_URL is absent, ArcRpcProvider is the fallback. It uses
 * a 10,000-block (~2.8 hour) RPC scan window and marks all historical signals
 * as partial.
 *
 * See docs/PHASE5_HISTORICAL_PROVIDER_SPEC.md for the full architecture spec.
 * See SETUP STEPS in GoldskyActivityProvider.ts for the required human actions
 * before the Goldsky provider can be used.
 *
 * ⚠️  GoldskyActivityProvider requires Goldsky authentication and pipeline
 *     deployment before use. See docs/PHASE5_HISTORICAL_PROVIDER_SPEC.md
 *     and infra/goldsky/arc-rep-turbo.yaml.
 */
let provider: IActivityProvider;
if (process.env.GOLDSKY_POSTGRES_URL) {
  provider = new GoldskyActivityProvider({
    postgresUrl: process.env.GOLDSKY_POSTGRES_URL,
  });
} else {
  provider = new ArcRpcProvider();
}

const registry = new InMemoryApplicationRegistry({
  applications: SEED_APPLICATIONS,
  contracts: SEED_CONTRACTS,
  categories: SEED_CATEGORIES,
});

const profileService = new ProfileService(provider, registry);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/health', createHealthRouter(provider.name));
app.use('/profile', createProfileRouter(profileService));
app.use('/signals', createSignalsRouter(profileService));
app.use('/credentials', createCredentialsRouter(profileService));
app.use('/verify', createVerifyRouter());

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: 'Route not found.',
    code: 'NOT_FOUND',
    availableRoutes: [
      'GET  /health',
      'GET  /profile/:address',
      'GET  /signals/:address',
      'GET  /credentials/:address',
      'POST /verify  (501 stub)',
    ],
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// In Vercel's serverless runtime VERCEL=1 is set automatically. The function
// handler (api/index.ts) imports `app` directly — no HTTP server needed there.
if (process.env.VERCEL !== '1') {
  const PORT = parseInt(process.env.PORT ?? '3001', 10);

  app.listen(PORT, () => {
    console.log(`[arc-rep] API server listening on port ${PORT}`);
    console.log(`[arc-rep] Provider: ${provider.name}`);
    console.log(
      `[arc-rep] Registry: ${registry.listApplications().length} applications, ` +
        `${SEED_CONTRACTS.length} contracts`,
    );
  });
}

export { app };
