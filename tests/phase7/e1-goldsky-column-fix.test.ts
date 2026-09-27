/**
 * tests/phase7/e1-goldsky-column-fix.test.ts
 *
 * E1 — Verify the Goldsky USDC transfer query uses the correct column name `address`
 * (not `token_address`) and that the decoding pipeline handles the pre-decoded
 * Goldsky erc20_transfers schema (address/sender/recipient/amount).
 */

import { describe, it, expect } from 'bun:test';
import { GoldskyActivityProvider } from '../../server/data/GoldskyActivityProvider.js';
import type { PgPoolLike } from '../../server/data/GoldskyActivityProvider.js';
import { ARC_USDC_CONTRACT } from '../../server/data/ArcRpcProvider.js';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER  = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

interface QueryCall { sql: string; params: unknown[] | undefined }

function makeMockPool(
  handler: (sql: string, params?: unknown[]) => { rows: Record<string, unknown>[] },
  calls: QueryCall[] = [],
): PgPoolLike {
  return {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return handler(sql, params);
    },
    end: async () => { /* no-op */ },
  };
}

// Standard empty responses for queries we don't care about in a given test.
function emptyHandler(sql: string): { rows: Record<string, unknown>[] } {
  if (sql.includes('MIN(block_number)')) return { rows: [{ earliest_block: '0' }] };
  if (sql.includes('MAX(block_number)')) return { rows: [{ latest_block: '5000000' }] };
  return { rows: [] };
}

// ---------------------------------------------------------------------------
// E1 tests
// ---------------------------------------------------------------------------

describe('E1 — Goldsky query uses `address` not `token_address`', () => {
  it('USDC transfer query selects `address` column (not `token_address`)', async () => {
    const calls: QueryCall[] = [];
    const pool = makeMockPool(emptyHandler, calls);
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      backfillGenesisThreshold: null, // disable backfill check
    });

    await provider.getActivity(WALLET);

    const transferQuery = calls.find(
      (c) => c.sql.includes('erc20_transfers') && !c.sql.includes('MIN') && !c.sql.includes('MAX'),
    );
    expect(transferQuery).toBeDefined();
    expect(transferQuery!.sql).toContain('address');
    expect(transferQuery!.sql).not.toContain('token_address');
  });

  it('USDC transfer query filters by ARC_USDC_CONTRACT address as $1', async () => {
    const calls: QueryCall[] = [];
    const pool = makeMockPool(emptyHandler, calls);
    const provider = GoldskyActivityProvider.createForTesting(pool, {
      backfillGenesisThreshold: null,
    });

    await provider.getActivity(WALLET);

    const transferQuery = calls.find(
      (c) => c.sql.includes('erc20_transfers') && !c.sql.includes('MIN') && !c.sql.includes('MAX'),
    );
    expect(transferQuery).toBeDefined();
    // $1 should be the USDC contract address
    expect((transferQuery!.params as string[])[0]).toBe(ARC_USDC_CONTRACT);
    // $2 should be the wallet address
    expect((transferQuery!.params as string[])[1]).toBe(WALLET);
  });

  it('decodes Goldsky erc20_transfers rows (address/sender/recipient/amount) correctly', async () => {
    const usdcAmount = '5000000'; // 5 USDC
    const calls: QueryCall[] = [];
    const pool = makeMockPool((sql) => {
      if (sql.includes('MIN(block_number)')) return { rows: [{ earliest_block: '0' }] };
      if (sql.includes('MAX(block_number)')) return { rows: [{ latest_block: '5000000' }] };
      // tx_activity: one outgoing tx from WALLET to OTHER
      if (sql.includes('tx_activity') && !sql.includes('MIN') && !sql.includes('MAX')) {
        return {
          rows: [{
            hash: '0xtx1',
            block_number: '100',
            block_timestamp: '1700000100',
            from_address: WALLET,
            to_address: OTHER,
            value: '0',
            receipt_status: '1',
            input: '0xa9059cbb',
            receipt_contract_address: null,
          }],
        };
      }
      // erc20_transfers: one USDC transfer from WALLET to OTHER
      if (sql.includes('erc20_transfers')) {
        return {
          rows: [{
            transaction_hash: '0xtx1',
            block_number: '100',
            block_timestamp: '1700000100',
            address: ARC_USDC_CONTRACT,   // E1: correct column name
            sender: WALLET,
            recipient: OTHER,
            amount: usdcAmount,
          }],
        };
      }
      return { rows: [] };
    }, calls);

    const provider = GoldskyActivityProvider.createForTesting(pool, {
      backfillGenesisThreshold: null,
    });
    const activity = await provider.getActivity(WALLET);

    // The tx should have one ERC-20 transfer decoded
    expect(activity.transactions.length).toBe(1);
    expect(activity.transactions[0].erc20Transfers.length).toBe(1);

    const transfer = activity.transactions[0].erc20Transfers[0];
    expect(transfer.tokenAddress).toBe(ARC_USDC_CONTRACT);
    expect(transfer.from).toBe(WALLET);
    expect(transfer.to).toBe(OTHER);
    expect(transfer.amountRaw).toBe(BigInt(usdcAmount));
  });

  it('correctly maps incoming USDC transfer (recipient = wallet) into erc20Transfers', async () => {
    const usdcAmount = '2000000'; // 2 USDC
    const pool = makeMockPool((sql) => {
      if (sql.includes('MIN(block_number)')) return { rows: [{ earliest_block: '0' }] };
      if (sql.includes('MAX(block_number)')) return { rows: [{ latest_block: '5000000' }] };
      if (sql.includes('tx_activity') && !sql.includes('MIN') && !sql.includes('MAX')) {
        return {
          rows: [{
            hash: '0xtx2',
            block_number: '200',
            block_timestamp: '1700000200',
            from_address: OTHER,
            to_address: WALLET,
            value: '0',
            receipt_status: '1',
            input: '0x',
            receipt_contract_address: null,
          }],
        };
      }
      if (sql.includes('erc20_transfers')) {
        return {
          rows: [{
            transaction_hash: '0xtx2',
            block_number: '200',
            block_timestamp: '1700000200',
            address: ARC_USDC_CONTRACT,
            sender: OTHER,
            recipient: WALLET,  // wallet is recipient
            amount: usdcAmount,
          }],
        };
      }
      return { rows: [] };
    });

    const provider = GoldskyActivityProvider.createForTesting(pool, {
      backfillGenesisThreshold: null,
    });
    const activity = await provider.getActivity(WALLET);

    expect(activity.transactions.length).toBe(1);
    expect(activity.transactions[0].erc20Transfers.length).toBe(1);
    const t = activity.transactions[0].erc20Transfers[0];
    expect(t.from).toBe(OTHER);
    expect(t.to).toBe(WALLET);
    expect(t.amountRaw).toBe(BigInt(usdcAmount));
  });

  it('malformed transfer row (missing amount) is silently skipped', async () => {
    const pool = makeMockPool((sql) => {
      if (sql.includes('MIN(block_number)')) return { rows: [{ earliest_block: '0' }] };
      if (sql.includes('MAX(block_number)')) return { rows: [{ latest_block: '5000000' }] };
      if (sql.includes('tx_activity') && !sql.includes('MIN') && !sql.includes('MAX')) {
        return {
          rows: [{
            hash: '0xtx3',
            block_number: '300',
            block_timestamp: '1700000300',
            from_address: WALLET,
            to_address: OTHER,
            value: '0',
            receipt_status: '1',
            input: '0x',
            receipt_contract_address: null,
          }],
        };
      }
      if (sql.includes('erc20_transfers')) {
        return {
          rows: [{
            transaction_hash: '0xtx3',
            block_number: '300',
            block_timestamp: '1700000300',
            address: ARC_USDC_CONTRACT,
            sender: WALLET,
            recipient: OTHER,
            amount: null, // malformed — should be skipped
          }],
        };
      }
      return { rows: [] };
    });

    const provider = GoldskyActivityProvider.createForTesting(pool, {
      backfillGenesisThreshold: null,
    });
    const activity = await provider.getActivity(WALLET);
    // Malformed row is skipped — no transfers on the tx
    expect(activity.transactions[0].erc20Transfers.length).toBe(0);
  });
});
