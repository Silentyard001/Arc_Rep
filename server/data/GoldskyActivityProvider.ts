/**
 * server/data/GoldskyActivityProvider.ts
 *
 * Historical Arc activity provider backed by a Goldsky Turbo → Postgres pipeline.
 *
 * Architecture:
 *   ProfileService
 *       ↓
 *   IActivityProvider
 *       └── GoldskyActivityProvider   (this file)
 *               ↓
 *           Postgres (Goldsky Turbo sink — arc_rep schema)
 *               ↑
 *           Goldsky Pipeline (arc_mainnet.receipt_transactions,
 *                             arc_mainnet.erc20_transfers,
 *                             arc_mainnet.raw_traces)
 *               ↑
 *           Arc Mainnet
 *
 * This provider queries a developer-owned Postgres database populated by the
 * Goldsky Turbo pipeline defined in infra/goldsky/arc-rep-turbo.yaml.
 * It covers full chain history from genesis, eliminating the 10,000-block
 * window limitation of ArcRpcProvider.
 *
 * HISTORICAL COMPLETENESS (E2 — Phase 7):
 *
 *   The provider tracks two separate completeness conditions:
 *
 *   1. SYNC LAG — is the pipeline keeping up with the live chain head?
 *      Detected by comparing MAX(block_number) in arc_rep.tx_activity
 *      against eth_blockNumber from the RPC.
 *      Threshold: syncLagThresholdBlocks (default: 1000 blocks).
 *
 *   2. HISTORICAL BACKFILL — has the pipeline indexed back to genesis?
 *      Detected by checking MIN(block_number) in arc_rep.tx_activity.
 *      A non-zero MIN means the backfill has not reached genesis yet.
 *      Threshold: backfillGenesisThreshold (default: 14,722,074 — first Arc Mainnet activity block).
 *
 *   EITHER condition sets mayBeTruncated = true, which propagates through
 *   the signal layer as 'partial' status and prevents requiresFullHistory
 *   credentials from issuing.
 *
 *   This ensures ARC_EARLY_ADOPTER cannot issue during a partial backfill:
 *     partial backfill → mayBeTruncated=true → firstSeen status='partial'
 *     → allSignalsPartialNoAvailable=true → insufficient_data
 *
 * ERC-20 transfer column naming (E1 — Phase 7):
 *   The arc_rep.erc20_transfers table uses `address` (not `token_address`).
 *   This matches the Goldsky arc_mainnet.erc20_transfers v1.1.0 schema.
 *   The GoldskyTransferRow interface and queryUsdcTransfers() use `address`.
 *
 * EIP-7708 dual-emitter handling:
 *   The Goldsky pipeline YAML passes all ERC-20 transfers from the
 *   arc_mainnet.erc20_transfers dataset, which Goldsky pre-decodes.
 *   The USDC contract filter (`address = ARC_USDC_CONTRACT`) in
 *   queryUsdcTransfers() ensures only USDC Transfer events are included.
 *
 * Security:
 *   - All SQL parameters use $N placeholders (never string interpolation).
 *   - Address is validated before any SQL.
 *   - GOLDSKY_POSTGRES_URL must never be logged or exposed in error messages.
 *   - The Postgres role used here should have SELECT-only permissions.
 */

import pg from 'pg';
import { requireChain } from '../../src/onchain-facts.js';
import type { IActivityProvider, ActivityProviderOptions } from './IActivityProvider.js';
import type { NormalizedActivity, NormalizedTransaction, DecodedErc20Transfer } from './types.js';
import { ActivityProviderError } from './IActivityProvider.js';
import { ARC_TESTNET_CHAIN_ID, ARC_USDC_CONTRACT } from './ArcRpcProvider.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GoldskyActivityProviderConfig {
  /** Postgres connection string: postgres://user:pass@host/db */
  postgresUrl: string;
  /** Chain ID. Defaults to ARC_TESTNET_CHAIN_ID (5042002 testnet / 5042 mainnet). */
  chainId?: number;
  /**
   * How many blocks behind the chain head before we consider the Goldsky
   * pipeline lagged and set mayBeTruncated = true.
   * Default: 1000 blocks (~16 minutes at Arc's ~1 block/second).
   */
  syncLagThresholdBlocks?: number;
  /**
   * P8-01 — Maximum number of transactions to load per wallet.
   *
   * Without a LIMIT, a bot or exchange wallet with millions of transactions
   * would load all rows into RAM, causing an OOM or extreme latency.
   *
   * When the result set equals this limit the provider sets mayBeTruncated=true,
   * which propagates partial status through the signal layer and prevents
   * full-history credentials from issuing.
   *
   * Default: 50_000 rows. This covers all realistic human-wallet histories
   * while protecting against adversarially large wallets.
   *
   * Reduce this for memory-constrained environments; increase only if you have
   * confirmed the Postgres instance has sufficient memory for the result set.
   */
  maxTransactionsPerWallet?: number;
  /**
   * P8S-03 — Maximum number of USDC transfer rows to load per wallet.
   *
   * Payment-processor and treasury wallets can have many more transfer events
   * than transactions. Without a LIMIT, a single wallet lookup could load
   * millions of rows.
   *
   * When the result set equals this limit the provider sets mayBeTruncated=true.
   * This prevents ARC_PAYMENTS_PARTICIPANT from evaluating on an incomplete
   * USDC transfer history and producing a false positive or false negative.
   *
   * Default: 50_000 rows — intentionally set equal to maxTransactionsPerWallet
   * for simplicity. Tune independently if payment-processor wallets are expected.
   */
  maxUsdcTransfersPerWallet?: number;
  /**
   * E2 — Historical backfill completeness guard.
   *
   * The Goldsky pipeline is configured with start_at: earliest, but the
   * backfill takes time. Until MIN(block_number) in arc_rep.tx_activity
   * is at or below this threshold, we consider historical data incomplete
   * and set mayBeTruncated = true.
   *
   * Default: 14_722_074 — the first Arc Mainnet block containing a user
   * transaction (empirically verified 2026-09-26). All activity is at or
   * after this block.
   *
   * NEVER lower this value — blocks before 14,722,074 on Arc Mainnet are
   * empty and confirming their absence adds no coverage. This default is
   * both a correctness requirement (firstSeen cannot be trusted until the
   * backfill reaches the first real transaction block) and a safety
   * optimization.
   *
   * When null, the backfill check is DISABLED (use only in tests that
   * explicitly test lag-only behaviour).
   */
  backfillGenesisThreshold?: number | null;
}

const DEFAULT_SYNC_LAG_THRESHOLD = 1_000;

/**
 * P8-01 — default transaction row limit per wallet.
 * 50,000 covers all realistic human-wallet histories on Arc Mainnet.
 * Exchange/bot wallets exceeding this will set mayBeTruncated=true.
 */
const DEFAULT_MAX_TRANSACTIONS_PER_WALLET = 50_000;

/**
 * P8S-03 — default USDC transfer row limit per wallet.
 * Matches the transaction limit for simplicity.
 * Payment-processor wallets exceeding this will set mayBeTruncated=true.
 */
const DEFAULT_MAX_USDC_TRANSFERS_PER_WALLET = 50_000;

/**
 * E2 — Historical backfill completeness boundary for Arc Mainnet (chain ID 5042).
 * Updated from Arc Testnet (6,263,142) during mainnet migration 2026-09-26.
 *
 * The backfill is considered complete when MIN(block_number) in arc_rep.tx_activity
 * is <= this value. Set to the first block observed to contain transaction activity
 * during a live-chain verification performed on 2026-09-26 (mainnet migration audit).
 *
 * Verification method: eth_getBlockByNumber via Arc Mainnet RPC (chain ID 5042),
 * binary search across the block range. Blocks 1–14,722,073 returned empty
 * transaction arrays; block 14,722,074 returned at least one transaction
 * (block timestamp 1786293966 = 2026-08-09T16:46:06Z).
 *
 * This is the first OBSERVED transaction-activity block, not a cryptographic
 * proof that no transaction could have existed at a lower block number. If
 * future evidence shows activity at a lower block number, update this constant
 * and re-run the Early Adopter pre-backfill audit.
 *
 * Purpose: prevents the backfill-completeness check from returning "complete"
 * merely because the pipeline has indexed the pre-activity bootstrap blocks
 * (1–14,722,073). Any MIN(block_number) above 14,722,074 means the pipeline
 * has not yet reached the first block with real data, so firstSeen cannot
 * be trusted as the wallet's true historical first activity.
 *
 * DO NOT lower this value without a new live-chain verification. Blocks before
 * 14,722,074 are empty; confirming them adds no historical coverage.
 *
 * When null, the backfill check is DISABLED (use only in tests that explicitly
 * test lag-only behaviour without a real database).
 */
const DEFAULT_BACKFILL_GENESIS_THRESHOLD = 14_722_074;

// ---------------------------------------------------------------------------
// ERC-20 Transfer row — arc_rep.erc20_transfers schema (E1 fix)
//
// The Goldsky arc_mainnet.erc20_transfers v1.1.0 dataset uses `address` for
// the token contract address (NOT `token_address`). The Turbo pipeline
// preserves this column name in arc_rep.erc20_transfers.
//
// Goldsky pre-decodes the Transfer event: `sender` = from, `recipient` = to,
// `amount` = raw uint256 transfer amount (decimal string, e.g. "108682334").
//
// There is no `topics` or `data` column to parse — Goldsky has already done
// the log decoding. No topics parsing infrastructure is needed here.
// ---------------------------------------------------------------------------

interface GoldskyTransferRow {
  transaction_hash: string;
  block_number: string;
  block_timestamp: string;
  /** E1: correct column name is `address`, not `token_address` */
  address: string;          // token contract address (ERC-20 contract)
  sender: string;           // Transfer `from` address (already decoded by Goldsky)
  recipient: string;        // Transfer `to` address (already decoded by Goldsky)
  amount: string;           // raw uint256 amount as decimal string (e.g. "1000000")
}

interface DecodedTransferWithTxHash extends DecodedErc20Transfer {
  txHash: string;
}

/**
 * Convert a Goldsky arc_rep.erc20_transfers row into a DecodedErc20Transfer.
 *
 * Goldsky pre-decodes the Transfer event: sender/recipient/amount are already
 * extracted. This function just normalises types and addresses.
 *
 * Returns null on malformed rows.
 */
function decodeGoldskyTransferRow(
  row: GoldskyTransferRow,
): DecodedTransferWithTxHash | null {
  try {
    if (!row.address || !row.sender || !row.recipient || !row.amount) return null;

    const tokenAddress = row.address.toLowerCase();
    const from = row.sender.toLowerCase();
    const to = row.recipient.toLowerCase();

    // amount is a decimal string (e.g. "1000000" for 1 USDC)
    const amountRaw = BigInt(row.amount);

    return {
      txHash: row.transaction_hash,
      tokenAddress,
      from,
      to,
      amountRaw,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Goldsky transaction row (arc_transactions table)
// ---------------------------------------------------------------------------

interface GoldskyTxRow {
  hash: string;
  block_number: string;          // numeric string or bigint from Postgres
  block_timestamp: string;       // Unix seconds (numeric string or bigint)
  from_address: string;
  to_address: string | null;
  value: string;                 // CAST as text from the pipeline; see R4 in spec
  receipt_status: string;        // '0' or '1'
  input: string;
  receipt_contract_address: string | null;
}

// ---------------------------------------------------------------------------
// GoldskyActivityProvider
// ---------------------------------------------------------------------------

/** Minimal pool interface for testing — matches the pg.Pool API used here. */
export interface PgPoolLike {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export class GoldskyActivityProvider implements IActivityProvider {
  readonly name = 'GoldskyActivityProvider';

  private readonly pool: PgPoolLike;
  private readonly chainId: number;
  private readonly syncLagThresholdBlocks: number;
  /** P8-01: maximum transaction rows fetched per wallet; hitting the limit sets mayBeTruncated=true. */
  private readonly maxTransactionsPerWallet: number;
  /** P8S-03: maximum USDC transfer rows fetched per wallet; hitting the limit sets mayBeTruncated=true. */
  private readonly maxUsdcTransfersPerWallet: number;
  /** E2: null disables the backfill check (test-only). */
  private readonly backfillGenesisThreshold: number | null;
  private readonly rpcUrl: string;

  constructor(config: GoldskyActivityProviderConfig) {
    this.chainId = config.chainId ?? ARC_TESTNET_CHAIN_ID;
    this.syncLagThresholdBlocks =
      config.syncLagThresholdBlocks ?? DEFAULT_SYNC_LAG_THRESHOLD;
    this.maxTransactionsPerWallet =
      config.maxTransactionsPerWallet ?? DEFAULT_MAX_TRANSACTIONS_PER_WALLET;
    this.maxUsdcTransfersPerWallet =
      config.maxUsdcTransfersPerWallet ?? DEFAULT_MAX_USDC_TRANSFERS_PER_WALLET;
    this.backfillGenesisThreshold =
      config.backfillGenesisThreshold !== undefined
        ? config.backfillGenesisThreshold
        : DEFAULT_BACKFILL_GENESIS_THRESHOLD;

    // Connection pool — use pg.Pool to auto-release connections on query().
    // Pool size of 5 is sufficient for Arc Rep's expected request volume.
    this.pool = new Pool({
      connectionString: config.postgresUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // We need one lightweight RPC call (eth_blockNumber) to determine sync lag.
    // Use the Arc RPC from the onchain-facts registry (mainnet or testnet per chainId).
    const chain = requireChain(this.chainId);
    this.rpcUrl = chain.rpcUrls[0];
  }

  /**
   * Test factory — injects a mock pool so unit tests can exercise provider
   * logic without a live Postgres connection.
   *
   * The rpcUrl is set to a no-op value; fetchChainHead() will return null
   * (optimistic: not lagged) unless the mock pool's query handler overrides
   * the chain-head fetch path separately.
   *
   * @internal  Not for production use.
   */
  static createForTesting(
    pool: PgPoolLike,
    config: Omit<GoldskyActivityProviderConfig, 'postgresUrl'> = {},
  ): GoldskyActivityProvider {
    const instance = new GoldskyActivityProvider({
      postgresUrl: 'postgres://localhost/test',
      ...config,
    });
    // Replace the pool created by the constructor with the injected mock.
    (instance as unknown as { pool: PgPoolLike }).pool = pool;
    return instance;
  }

  async getActivity(
    address: string,
    _options: ActivityProviderOptions = {},
  ): Promise<NormalizedActivity> {
    // Validate address (defense in depth — middleware also validates)
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new ActivityProviderError(
        `Invalid EVM address: "${address}". Expected 0x-prefixed 40 hex chars.`,
      );
    }

    const walletAddress = address.toLowerCase();
    const fetchedAt = new Date().toISOString();
    const dataQualityNotes: string[] = [];

    try {
      // Run all queries in parallel.
      const [txRows, transferRows, latestIndexedResult, earliestIndexedResult, currentChainHead] =
        await Promise.all([
          this.queryTransactions(walletAddress),
          this.queryUsdcTransfers(walletAddress),
          this.queryLatestIndexedBlock(),
          this.queryEarliestIndexedBlock(),  // E2: backfill completeness
          this.fetchChainHead(),
        ]);

      // ---------- Sync-lag detection ----------
      const latestIndexedBlock = latestIndexedResult;
      const chainHead = currentChainHead;

      const syncLag = chainHead !== null ? chainHead - latestIndexedBlock : null;
      const isLagged =
        syncLag !== null && syncLag > this.syncLagThresholdBlocks;

      if (isLagged && syncLag !== null) {
        dataQualityNotes.push(
          `Goldsky Turbo pipeline sync lag: ${syncLag} blocks ` +
            `(latest indexed: ${latestIndexedBlock}, chain head: ${chainHead}). ` +
            `Recent transactions (last ~${syncLag} blocks) may be absent.`,
        );
      }

      // ---------- E2: Historical backfill completeness ----------
      // When MIN(block_number) > backfillGenesisThreshold, the pipeline has
      // not yet indexed back to genesis. Historical signals (firstSeen, etc.)
      // are unreliable. This prevents ARC_EARLY_ADOPTER from issuing during
      // a partial backfill.
      const earliestIndexedBlock = earliestIndexedResult;
      const isBackfillIncomplete =
        this.backfillGenesisThreshold !== null &&
        (earliestIndexedBlock === null ||
          earliestIndexedBlock > this.backfillGenesisThreshold);

      if (isBackfillIncomplete) {
        dataQualityNotes.push(
          `Goldsky Turbo pipeline historical backfill is incomplete. ` +
            `Earliest indexed block: ${earliestIndexedBlock ?? 'none'} ` +
            `(threshold: <= ${this.backfillGenesisThreshold}). ` +
            `Signals requiring full history (firstSeen, builderActivity) ` +
            `are unreliable until backfill reaches genesis.`,
        );
      }

      dataQualityNotes.push(
        `Full chain history from block 0. ` +
          `Goldsky Turbo last indexed block: ${latestIndexedBlock}. ` +
          `Earliest indexed block: ${earliestIndexedBlock ?? 'none'}.`,
      );

      // ---------- P8-01: Transaction row-limit truncation ----------
      // If the transaction query returned exactly maxTransactionsPerWallet rows,
      // there may be more rows in the database. Treat the result as truncated.
      const isTxRowLimitReached = txRows.length >= this.maxTransactionsPerWallet;
      if (isTxRowLimitReached) {
        dataQualityNotes.push(
          `Transaction query reached the row limit of ${this.maxTransactionsPerWallet}. ` +
            `This wallet has at least that many transactions. ` +
            `All historical signals are partial for this wallet.`,
        );
      }

      // ---------- P8S-03: USDC transfer row-limit truncation ----------
      // If the transfer query returned exactly maxUsdcTransfersPerWallet rows,
      // the wallet may have more transfer events. This affects USDC payment
      // signals — a truncated transfer history cannot be used to definitively
      // evaluate ARC_PAYMENTS_PARTICIPANT.
      const isTransferRowLimitReached = transferRows.length >= this.maxUsdcTransfersPerWallet;
      if (isTransferRowLimitReached) {
        dataQualityNotes.push(
          `USDC transfer query reached the row limit of ${this.maxUsdcTransfersPerWallet}. ` +
            `This wallet has at least that many USDC transfer events. ` +
            `USDC payment signals are partial for this wallet.`,
        );
      }

      // ---------- mayBeTruncated ----------
      // True when ANY of:
      //   - sync lag exceeds threshold (pipeline behind live chain), OR
      //   - historical backfill is incomplete (pipeline not yet at genesis), OR
      //   - transaction row limit reached (wallet has more txns than the limit), OR
      //   - transfer row limit reached (wallet has more USDC transfers than the limit).
      // Any condition means historical signals cannot be trusted as complete.
      const mayBeTruncated =
        isLagged || isBackfillIncomplete || isTxRowLimitReached || isTransferRowLimitReached;

      // ---------- Build erc20Transfers index ----------
      // Map from txHash → DecodedErc20Transfer[]
      const transfersByTxHash = new Map<string, DecodedErc20Transfer[]>();

      for (const row of transferRows) {
        const decoded = decodeGoldskyTransferRow(row);
        if (!decoded) continue;

        const { txHash, ...transfer } = decoded;
        const existing = transfersByTxHash.get(txHash) ?? [];
        existing.push(transfer);
        transfersByTxHash.set(txHash, existing);
      }

      // ---------- Normalize transactions ----------
      const transactions: NormalizedTransaction[] = [];
      const contractAddressesInteracted = new Set<string>();

      for (const row of txRows) {
        const fromAddr = row.from_address.toLowerCase();
        const toAddr   = row.to_address ? row.to_address.toLowerCase() : null;
        const isOutgoing = fromAddr === walletAddress;

        const isContractCreation = row.to_address === null;
        const hasInputData =
          !!row.input && row.input !== '0x' && row.input.length > 2;
        const succeeded = row.receipt_status === '1';

        // R4 fix: value is cast to text in SQL to avoid JS number precision loss.
        // Use BigInt() directly on the string representation.
        let valueWei: bigint;
        try {
          valueWei = BigInt(row.value ?? '0');
        } catch {
          valueWei = BigInt(0);
        }

        const blockNumber = BigInt(row.block_number);
        const timestamp   = parseInt(row.block_timestamp, 10);

        const createdContractAddress =
          row.receipt_contract_address
            ? row.receipt_contract_address.toLowerCase()
            : undefined;

        if (isOutgoing) {
          if (toAddr && hasInputData) contractAddressesInteracted.add(toAddr);
          if (createdContractAddress) contractAddressesInteracted.add(createdContractAddress);
        }

        transactions.push({
          hash: row.hash,
          blockNumber,
          timestamp,
          from: fromAddr,
          to: toAddr,
          valueWei,
          succeeded,
          isOutgoing,
          isContractCreation,
          hasInputData,
          createdContractAddress,
          erc20Transfers: transfersByTxHash.get(row.hash) ?? [],
        });
      }

      // Sort by timestamp ascending (earliest first)
      transactions.sort((a, b) => a.timestamp - b.timestamp);

      const validTimestamps = transactions
        .filter((t) => t.timestamp > 0)
        .map((t) => t.timestamp);

      const earliestTimestamp =
        validTimestamps.length > 0 ? Math.min(...validTimestamps) : undefined;
      const latestTimestamp =
        validTimestamps.length > 0 ? Math.max(...validTimestamps) : undefined;

      // totalOutgoingTransactionCount: count of all succeeded outgoing txns.
      // From Goldsky this is an exact count (unlike the RPC nonce which counts
      // all outgoing including failed). For consistency with ArcRpcProvider
      // semantics (which uses the nonce = all outgoing including failed),
      // we count all outgoing regardless of success status here.
      const totalOutgoingTransactionCount = transactions.filter(
        (t) => t.isOutgoing,
      ).length;

      return {
        address: walletAddress,
        chainId: this.chainId,
        transactions,
        contractAddressesInteracted,
        earliestTimestamp,
        latestTimestamp,
        totalFetched: transactions.length,
        mayBeTruncated,
        fetchedAt,
        providerName: this.name,
        dataQualityNotes,
        totalOutgoingTransactionCount,
      };
    } catch (err) {
      // Re-throw ActivityProviderError as-is; wrap anything else.
      if (err instanceof ActivityProviderError) throw err;
      throw new ActivityProviderError(
        `GoldskyActivityProvider failed for address ${walletAddress}: ${String(err)}`,
        err,
      );
    }
  }

  // --------------------------------------------------------------------------
  // SQL queries
  // --------------------------------------------------------------------------

  /**
   * Query 1: All transactions involving the wallet (outgoing + incoming).
   *
   * P8-01: A LIMIT clause prevents unbounded memory use for bot/exchange wallets.
   * The limit is passed as a SQL parameter ($2). When the result equals the limit,
   * the caller sets mayBeTruncated=true (see getActivity row-limit check above).
   *
   * The CAST(value AS text) prevents precision loss when pg converts Postgres
   * numeric/decimal to JavaScript number. BigInt(valueStr) is exact.
   * See R4 in docs/PHASE5_HISTORICAL_PROVIDER_SPEC.md.
   */
  private async queryTransactions(walletAddress: string): Promise<GoldskyTxRow[]> {
    const sql = `
      SELECT
        hash,
        block_number::text                      AS block_number,
        block_timestamp::text                   AS block_timestamp,
        from_address,
        to_address,
        CAST(value AS text)                     AS value,
        receipt_status::text                    AS receipt_status,
        COALESCE(input, '0x')                   AS input,
        receipt_contract_address
      FROM arc_rep.tx_activity
      WHERE lower(from_address) = $1
         OR lower(to_address)   = $1
      ORDER BY block_number ASC, transaction_index ASC
      LIMIT $2
    `;
    const result = await this.pool.query<GoldskyTxRow>(sql, [
      walletAddress,
      this.maxTransactionsPerWallet,
    ]);
    return result.rows;
  }

  /**
   * Query 2: All USDC Transfer events involving the wallet.
   *
   * E1 fix: uses arc_rep.erc20_transfers, which has these columns:
   *   address   — token contract address (NOT `token_address`)
   *   sender    — Transfer `from` (pre-decoded by Goldsky)
   *   recipient — Transfer `to` (pre-decoded by Goldsky)
   *   amount    — raw uint256 amount as decimal string
   *
   * Filtered to:
   *   - Only the USDC ERC-20 contract (ARC_USDC_CONTRACT)
   *   - Only rows where this wallet is the sender OR recipient
   *
   * P8S-03: A LIMIT clause prevents unbounded memory use for payment-processor
   * or treasury wallets with millions of transfer events. When the result count
   * equals maxUsdcTransfersPerWallet, the caller sets mayBeTruncated=true.
   *
   * No topics parsing is needed — Goldsky pre-decodes the Transfer event.
   */
  private async queryUsdcTransfers(walletAddress: string): Promise<GoldskyTransferRow[]> {
    const sql = `
      SELECT
        transaction_hash,
        block_number::text    AS block_number,
        block_timestamp::text AS block_timestamp,
        address,
        sender,
        recipient,
        amount::text          AS amount
      FROM arc_rep.erc20_transfers
      WHERE lower(address)    = $1
        AND (lower(sender) = $2 OR lower(recipient) = $2)
      ORDER BY block_number ASC
      LIMIT $3
    `;
    // $1 = USDC contract address (filter to USDC only)
    // $2 = wallet address (filter to rows involving this wallet)
    // $3 = maximum rows (P8S-03 safety bound)
    const result = await this.pool.query<GoldskyTransferRow>(sql, [
      ARC_USDC_CONTRACT,
      walletAddress,
      this.maxUsdcTransfersPerWallet,
    ]);
    return result.rows;
  }

  /**
   * Query 3a: Latest block number indexed by Goldsky.
   * Used for sync-lag detection. Returns 0 when the table is empty.
   */
  private async queryLatestIndexedBlock(): Promise<number> {
    const sql = `SELECT COALESCE(MAX(block_number), 0)::text AS latest_block FROM arc_rep.tx_activity`;
    const result = await this.pool.query<{ latest_block: string }>(sql);
    return parseInt(result.rows[0]?.latest_block ?? '0', 10);
  }

  /**
   * E2 — Query 3b: Earliest block number indexed by Goldsky.
   * Used for historical backfill completeness detection.
   * Returns null when the table is empty (no rows ingested yet).
   * Returns a block number when at least one row exists.
   *
   * A non-null result > backfillGenesisThreshold means the pipeline has
   * not yet indexed back to genesis — historical signals are incomplete.
   */
  private async queryEarliestIndexedBlock(): Promise<number | null> {
    const sql = `SELECT MIN(block_number)::text AS earliest_block FROM arc_rep.tx_activity`;
    const result = await this.pool.query<{ earliest_block: string | null }>(sql);
    const raw = result.rows[0]?.earliest_block;
    if (raw === null || raw === undefined) return null;
    return parseInt(raw, 10);
  }

  /**
   * Fetch the current chain head block number via a lightweight eth_blockNumber
   * RPC call. Used to compare against the Goldsky indexed block for sync-lag.
   *
   * Returns null on failure — callers treat null as "sync lag unknown" and
   * default to mayBeTruncated = false (optimistic, since the Goldsky pipeline
   * is usually current and an RPC failure shouldn't degrade all profiles).
   */
  private async fetchChainHead(): Promise<number | null> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_blockNumber',
          params: [],
        }),
        signal: AbortSignal.timeout(5_000), // 5-second timeout
      });
      if (!response.ok) return null;
      const json = (await response.json()) as { result?: string };
      if (!json.result) return null;
      return parseInt(json.result, 16);
    } catch {
      return null;
    }
  }

  /**
   * Close the Postgres connection pool.
   * Call this during graceful server shutdown.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Export the ARC_USDC_CONTRACT reference so tests can verify the filter constant.
export { ARC_USDC_CONTRACT };
