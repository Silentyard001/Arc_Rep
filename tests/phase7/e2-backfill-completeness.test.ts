/**
 * tests/phase7/e2-backfill-completeness.test.ts
 *
 * E2 — Historical backfill completeness guard.
 *
 * Tests:
 *   1. Sync lag → mayBeTruncated = true
 *   2. Historical backfill incomplete → mayBeTruncated = true
 *   3. Both sync current + historical boundary satisfied → mayBeTruncated = false
 *   4. Empty indexed table (no rows) → mayBeTruncated = true (backfill incomplete)
 *   5. ARC_EARLY_ADOPTER remains insufficient_data while backfill incomplete
 *   6. Sync lag AND backfill incomplete → mayBeTruncated = true
 *   7. Backfill check disabled (null threshold) → not triggered by backfill
 */

import { describe, it, expect } from 'bun:test';
import { GoldskyActivityProvider } from '../../server/data/GoldskyActivityProvider.js';
import type { PgPoolLike } from '../../server/data/GoldskyActivityProvider.js';
import { CredentialService } from '../../server/domain/credentials/CredentialService.js';
import { SignalEngine } from '../../server/domain/signals/SignalEngine.js';
import { InMemoryApplicationRegistry } from '../../server/domain/applications/ApplicationRegistry.js';
import { SEED_APPLICATIONS, SEED_CONTRACTS, SEED_CATEGORIES } from '../../server/domain/applications/seed-data.js';
import type { ActivitySignal } from '../../server/domain/signals/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHAIN_HEAD = 5_000_000;
const SYNC_LAG_THRESHOLD = 1_000;

function makePool(opts: {
  latestBlock: number;
  earliestBlock: number | null; // null = empty table (backfill not started)
  chainHeadOverride?: number;
}): PgPoolLike {
  return {
    query: async (sql: string) => {
      if (sql.includes('MAX(block_number)')) {
        return { rows: [{ latest_block: String(opts.latestBlock) }] };
      }
      if (sql.includes('MIN(block_number)')) {
        return {
          rows: [{ earliest_block: opts.earliestBlock === null ? null : String(opts.earliestBlock) }],
        };
      }
      return { rows: [] };
    },
    end: async () => { /* no-op */ },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2 — sync lag causes mayBeTruncated = true', () => {
  it('sets mayBeTruncated = true when pipeline lag > threshold', async () => {
    const laggedBlock = CHAIN_HEAD - SYNC_LAG_THRESHOLD - 1; // 1 block over threshold
    const pool = makePool({ latestBlock: laggedBlock, earliestBlock: 0 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: 100,
    });

    // Override fetchChainHead to return a known value
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    expect(activity.mayBeTruncated).toBe(true);
  });

  it('sets mayBeTruncated = false when pipeline lag <= threshold', async () => {
    const currentBlock = CHAIN_HEAD - 500; // within 1000-block threshold
    const pool = makePool({ latestBlock: currentBlock, earliestBlock: 0 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: 100,
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    expect(activity.mayBeTruncated).toBe(false);
  });
});

describe('E2 — historical backfill incompleteness causes mayBeTruncated = true', () => {
  it('sets mayBeTruncated = true when earliest block > threshold', async () => {
    // Earliest indexed block is 50_000 — backfill has not reached genesis (threshold 100)
    const pool = makePool({ latestBlock: CHAIN_HEAD, earliestBlock: 50_000 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: 100,
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    expect(activity.mayBeTruncated).toBe(true);
  });

  it('sets mayBeTruncated = false when earliest block <= threshold', async () => {
    // Earliest indexed block is 50 — backfill has reached genesis (threshold 100)
    const pool = makePool({ latestBlock: CHAIN_HEAD, earliestBlock: 50 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: 100,
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    expect(activity.mayBeTruncated).toBe(false);
  });

  it('sets mayBeTruncated = true when indexed table is empty (null MIN)', async () => {
    // Empty table — no backfill at all
    const pool = makePool({ latestBlock: 0, earliestBlock: null });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: 100,
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    expect(activity.mayBeTruncated).toBe(true);
  });

  it('includes backfill diagnostic note in dataQualityNotes when incomplete', async () => {
    const pool = makePool({ latestBlock: CHAIN_HEAD, earliestBlock: 500_000 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      backfillGenesisThreshold: 100,
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    const hasBackfillNote = activity.dataQualityNotes.some((n) =>
      n.includes('backfill') || n.includes('backfill is incomplete'),
    );
    expect(hasBackfillNote).toBe(true);
  });
});

describe('E2 — combined sync + backfill conditions', () => {
  it('sets mayBeTruncated = true when both lag and backfill are incomplete', async () => {
    const laggedBlock = CHAIN_HEAD - SYNC_LAG_THRESHOLD - 1;
    const pool = makePool({ latestBlock: laggedBlock, earliestBlock: 999_999 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: 100,
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    expect(activity.mayBeTruncated).toBe(true);
  });

  it('disabling backfill check (threshold: null) does not trigger backfill truncation', async () => {
    // Earliest block is very high, but check is disabled
    const pool = makePool({ latestBlock: CHAIN_HEAD, earliestBlock: 9_999_999 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: null, // disabled
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    // Only sync lag matters — pipeline is current, so not truncated
    expect(activity.mayBeTruncated).toBe(false);
  });
});

describe('E2 — ARC_EARLY_ADOPTER remains insufficient_data during partial backfill', () => {
  it('ARC_EARLY_ADOPTER is insufficient_data when backfill incomplete', () => {
    // Simulate partial backfill: firstSeen signal is 'partial'
    // (which is what happens when mayBeTruncated = true from incomplete backfill)
    const partialFirstSeen: ActivitySignal = {
      key: 'firstSeen',
      label: 'First Seen',
      value: 1609459200, // 2021-01-01 — before the cutoff
      status: 'partial', // partial because mayBeTruncated = true
      description: '',
      source: 'GoldskyActivityProvider',
      calculationDefinition: '',
      valueUnit: 'unix_seconds',
      confidenceNote: 'Backfill incomplete',
    };

    const service = new CredentialService();
    const credentials = service.evaluate([partialFirstSeen]);
    const earlyAdopter = credentials.find((c) => c.typeId === 'ARC_EARLY_ADOPTER');

    expect(earlyAdopter).toBeDefined();
    expect(earlyAdopter!.status).toBe('insufficient_data');
    // Must NOT be 'active' even though the partial timestamp is before the cutoff
    expect(earlyAdopter!.status).not.toBe('active');
  });

  it('ARC_EARLY_ADOPTER is active only when firstSeen status is available AND before cutoff', () => {
    const availableFirstSeen: ActivitySignal = {
      key: 'firstSeen',
      label: 'First Seen',
      value: 1609459200, // 2021-01-01 — before 2025-12-31 cutoff
      status: 'available', // complete history confirmed
      description: '',
      source: 'GoldskyActivityProvider',
      calculationDefinition: '',
      valueUnit: 'unix_seconds',
      confidenceNote: '',
    };

    const service = new CredentialService();
    const credentials = service.evaluate([availableFirstSeen]);
    const earlyAdopter = credentials.find((c) => c.typeId === 'ARC_EARLY_ADOPTER');

    expect(earlyAdopter).toBeDefined();
    expect(earlyAdopter!.status).toBe('active');
  });
});

describe('E2 — full history satisfied uses real SignalEngine + registry', () => {
  it('all signals are available when provider returns complete activity', async () => {
    // Fully synced pool: latest block = chain head, earliest = 0
    const pool = makePool({ latestBlock: CHAIN_HEAD, earliestBlock: 0 });
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      syncLagThresholdBlocks: SYNC_LAG_THRESHOLD,
      backfillGenesisThreshold: 100,
    });
    (provider as unknown as { fetchChainHead: () => Promise<number> }).fetchChainHead =
      async () => CHAIN_HEAD;

    const activity = await provider.getActivity(WALLET);
    expect(activity.mayBeTruncated).toBe(false);

    const registry = new InMemoryApplicationRegistry({
      applications: SEED_APPLICATIONS,
      contracts: SEED_CONTRACTS,
      categories: SEED_CATEGORIES,
    });
    const engine = new SignalEngine();
    const signals = engine.calculate(activity, registry);

    // With no transactions, signals are available (not partial) on a non-truncated snapshot
    const firstSeen = signals.find((s) => s.key === 'firstSeen');
    // firstSeen is 'unavailable' with no transactions, which is correct
    expect(firstSeen!.status).toBe('unavailable');

    const txCount = signals.find((s) => s.key === 'transactionCount');
    // transactionCount is 'available' (non-truncated, zero txns)
    expect(txCount!.status).toBe('available');
  });
});
