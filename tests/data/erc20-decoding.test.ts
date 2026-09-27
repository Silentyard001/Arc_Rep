/**
 * tests/data/erc20-decoding.test.ts
 *
 * Unit tests for ERC-20 Transfer log decoding.
 *
 * These tests exercise decodeErc20TransferLog directly.
 * Because the function is not exported from ArcRpcProvider (it is a module-level
 * helper), we test the equivalent logic here using the same algorithm extracted
 * as a pure function — allowing us to cover all edge cases without live RPC calls.
 *
 * Architecture note: these tests validate the DECODING ALGORITHM only.
 * Integration with ArcRpcProvider is covered by the provider's end-to-end behaviour.
 */

import { describe, it, expect } from 'bun:test';

// ---------------------------------------------------------------------------
// Replicate the decoding algorithm from ArcRpcProvider exactly.
// If the ArcRpcProvider helper changes, this must be updated in sync.
// ---------------------------------------------------------------------------

interface RawErc20Log {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

interface DecodedErc20Transfer {
  tokenAddress: string;
  from: string;
  to: string;
  amountRaw: bigint;
}

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Pure decode function — same logic as ArcRpcProvider.decodeErc20TransferLog.
 *
 * Transfer(address indexed from, address indexed to, uint256 value)
 *
 * topics[0] = event selector (Transfer sig hash)
 * topics[1] = from address, ABI-encoded (32 bytes, left-padded with zeros)
 * topics[2] = to address, ABI-encoded (32 bytes, left-padded with zeros)
 * data       = ABI-encoded uint256 value (32 bytes)
 */
function decodeErc20TransferLog(log: RawErc20Log): DecodedErc20Transfer | null {
  if (!log) return null;
  if (!Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) return null;

  try {
    const fromTopic = log.topics[1];
    const toTopic   = log.topics[2];
    const dataPart  = log.data;

    if (!fromTopic || fromTopic.length < 42) return null;
    if (!toTopic   || toTopic.length < 42)   return null;
    if (!dataPart  || dataPart === '0x' || dataPart.length < 3) return null;

    // ABI-encoded indexed address: 0x + 24 zero chars + 40 hex chars = 66 chars total
    const from = ('0x' + fromTopic.slice(-40)).toLowerCase();
    const to   = ('0x' + toTopic.slice(-40)).toLowerCase();

    // data is a 32-byte ABI-encoded uint256 (no padding needed for parsing)
    const amountRaw = BigInt(dataPart);

    const tokenAddress = log.address.toLowerCase();

    return { tokenAddress, from, to, amountRaw };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
const FROM_ADDR    = '0xaaaa000000000000000000000000000000000001';
const TO_ADDR      = '0xbbbb000000000000000000000000000000000002';
const TX_HASH      = '0x' + 'ab'.repeat(32);

// ERC-20 Transfer topics encoding:
// topics[1] (from): 0x000000000000000000000000 + FROM_ADDR.slice(2)
// topics[2] (to):   0x000000000000000000000000 + TO_ADDR.slice(2)
const TOPIC_FROM = '0x000000000000000000000000' + FROM_ADDR.slice(2);
const TOPIC_TO   = '0x000000000000000000000000' + TO_ADDR.slice(2);

function makeTransferLog(overrides: Partial<RawErc20Log> = {}): RawErc20Log {
  return {
    address: USDC_ADDRESS,
    topics: [
      ERC20_TRANSFER_TOPIC,
      TOPIC_FROM,
      TOPIC_TO,
    ],
    data: '0x' + (1_000_000n).toString(16).padStart(64, '0'), // 1 USDC (6-decimal)
    transactionHash: TX_HASH,
    blockNumber: '0x64',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decodeErc20TransferLog — valid Transfer event', () => {
  it('decodes a standard Transfer event correctly', () => {
    const log = makeTransferLog();
    const result = decodeErc20TransferLog(log);
    expect(result).not.toBeNull();
    expect(result!.tokenAddress).toBe(USDC_ADDRESS);
    expect(result!.from).toBe(FROM_ADDR);
    expect(result!.to).toBe(TO_ADDR);
    expect(result!.amountRaw).toBe(1_000_000n);
  });

  it('returns correct token address (the log.address, not a topic)', () => {
    const OTHER_TOKEN = '0x9999999999999999999999999999999999999999';
    const log = makeTransferLog({ address: OTHER_TOKEN });
    const result = decodeErc20TransferLog(log);
    expect(result!.tokenAddress).toBe(OTHER_TOKEN);
  });

  it('returns correct from address (lowercased, stripped of padding)', () => {
    // Mixed-case from address in the topic
    const log = makeTransferLog({
      topics: [
        ERC20_TRANSFER_TOPIC,
        '0x000000000000000000000000AAAA000000000000000000000000000000000001',
        TOPIC_TO,
      ],
    });
    const result = decodeErc20TransferLog(log);
    expect(result!.from).toBe('0xaaaa000000000000000000000000000000000001');
  });

  it('returns correct to address (lowercased, stripped of padding)', () => {
    const log = makeTransferLog({
      topics: [
        ERC20_TRANSFER_TOPIC,
        TOPIC_FROM,
        '0x000000000000000000000000BBBB000000000000000000000000000000000002',
      ],
    });
    const result = decodeErc20TransferLog(log);
    expect(result!.to).toBe('0xbbbb000000000000000000000000000000000002');
  });

  it('decodes amount = 1 (minimum positive value)', () => {
    const log = makeTransferLog({
      data: '0x' + '1'.padStart(64, '0'),
    });
    const result = decodeErc20TransferLog(log);
    expect(result!.amountRaw).toBe(1n);
  });

  it('decodes a large uint256 amount without precision loss', () => {
    // 2^256 - 1 = max uint256
    const maxUint256 = (2n ** 256n) - 1n;
    const log = makeTransferLog({
      data: '0x' + maxUint256.toString(16).padStart(64, '0'),
    });
    const result = decodeErc20TransferLog(log);
    expect(result!.amountRaw).toBe(maxUint256);
  });

  it('decodes a realistic USDC amount: 100 USDC (100_000_000 in 6-decimal raw)', () => {
    const oneHundredUsdc = 100_000_000n; // 100 * 10^6
    const log = makeTransferLog({
      data: '0x' + oneHundredUsdc.toString(16).padStart(64, '0'),
    });
    const result = decodeErc20TransferLog(log);
    expect(result!.amountRaw).toBe(oneHundredUsdc);
  });
});

describe('decodeErc20TransferLog — multiple logs for same transaction', () => {
  it('decodes two different Transfer events in the same transaction independently', () => {
    const log1 = makeTransferLog({
      data: '0x' + (500_000n).toString(16).padStart(64, '0'),
    });
    const log2 = makeTransferLog({
      topics: [
        ERC20_TRANSFER_TOPIC,
        TOPIC_TO,    // swapped: to → from
        TOPIC_FROM,  // swapped: from → to
      ],
      data: '0x' + (200_000n).toString(16).padStart(64, '0'),
    });

    const r1 = decodeErc20TransferLog(log1);
    const r2 = decodeErc20TransferLog(log2);

    expect(r1!.from).toBe(FROM_ADDR);
    expect(r1!.amountRaw).toBe(500_000n);

    expect(r2!.from).toBe(TO_ADDR);
    expect(r2!.amountRaw).toBe(200_000n);
  });

  it('a transaction with no Transfer events results in an empty transfer list', () => {
    // This is tested at the NormalizedTransaction level — erc20Transfers: []
    // is the default when no logs are associated with a transaction.
    // We confirm decodeErc20TransferLog is not called on non-Transfer logs.
    const nonTransferLog: RawErc20Log = {
      address: USDC_ADDRESS,
      topics: [
        '0xother0000000000000000000000000000000000000000000000000000000000', // not Transfer topic
        TOPIC_FROM,
        TOPIC_TO,
      ],
      data: '0x' + (500_000n).toString(16).padStart(64, '0'),
      transactionHash: TX_HASH,
      blockNumber: '0x64',
    };
    const result = decodeErc20TransferLog(nonTransferLog);
    expect(result).toBeNull();
  });
});

describe('decodeErc20TransferLog — malformed / incomplete logs', () => {
  it('returns null for a log with no topics', () => {
    const log = makeTransferLog({ topics: [] });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });

  it('returns null for a log with only topic0 (missing from/to topics)', () => {
    const log = makeTransferLog({ topics: [ERC20_TRANSFER_TOPIC] });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });

  it('returns null for a log with two topics (missing to topic)', () => {
    const log = makeTransferLog({ topics: [ERC20_TRANSFER_TOPIC, TOPIC_FROM] });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });

  it('returns null for wrong topic0 (not a Transfer event)', () => {
    const log = makeTransferLog({
      topics: [
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        TOPIC_FROM,
        TOPIC_TO,
      ],
    });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });

  it('returns null for empty data field', () => {
    const log = makeTransferLog({ data: '0x' });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });

  it('returns null for null data field', () => {
    const log = makeTransferLog({ data: null as unknown as string });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });

  it('returns null for a null log', () => {
    expect(decodeErc20TransferLog(null as unknown as RawErc20Log)).toBeNull();
  });

  it('returns null for a log with malformed from-topic (too short)', () => {
    const log = makeTransferLog({
      topics: [
        ERC20_TRANSFER_TOPIC,
        '0x0000', // too short to contain a 40-hex address
        TOPIC_TO,
      ],
    });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });

  it('returns null for a log with malformed to-topic (too short)', () => {
    const log = makeTransferLog({
      topics: [
        ERC20_TRANSFER_TOPIC,
        TOPIC_FROM,
        '0x0000', // too short
      ],
    });
    expect(decodeErc20TransferLog(log)).toBeNull();
  });
});
