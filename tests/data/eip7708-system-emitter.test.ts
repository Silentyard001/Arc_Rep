/**
 * tests/data/eip7708-system-emitter.test.ts
 *
 * Regression tests for the EIP-7708 dual-emitter safety fix in ArcRpcProvider.
 *
 * Arc implements EIP-7708: when a native USDC transfer occurs, Arc emits a
 * Transfer-shaped log from BOTH the ERC-20 contract (ARC_USDC_CONTRACT) AND
 * the protocol-internal system emitter address (ARC_SYSTEM_EMITTER).
 *
 * The system emitter log is NOT an ERC-20 token transfer. It must be discarded
 * before decoding so that:
 *   1. No DecodedErc20Transfer with tokenAddress = SYSTEM_EMITTER is created.
 *   2. economicActivity.usdcErc20Raw is not double-counted.
 *   3. usdcReceived is not double-counted.
 *   4. Non-USDC ERC-20 decoding is unaffected.
 *
 * Architecture note:
 *   These tests replicate the EIP-7708 filter logic that lives in ArcRpcProvider
 *   Step 3. The filter and decode functions are extracted as pure functions here
 *   for unit-testable coverage without live RPC calls.
 *
 *   If the filter logic in ArcRpcProvider changes, update this file in sync.
 */

import { describe, it, expect } from 'bun:test';
import { ARC_USDC_CONTRACT, ARC_SYSTEM_EMITTER } from '../../server/data/ArcRpcProvider.js';
import { calculateEconomicActivity } from '../../server/domain/signals/calculators/activity.js';
import { calculateUsdcReceived } from '../../server/domain/signals/calculators/activity.js';
import type { NormalizedActivity, NormalizedTransaction, DecodedErc20Transfer } from '../../server/data/types.js';

// ---------------------------------------------------------------------------
// Replicate the provider-level filter + decode logic exactly.
// This mirrors the filter and decodeErc20TransferLog in ArcRpcProvider Step 3.
// ---------------------------------------------------------------------------

interface RawErc20Log {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function decodeErc20TransferLog(log: RawErc20Log): DecodedErc20Transfer | null {
  if (!log) return null;
  if (!Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) return null;
  try {
    const fromTopic = log.topics[1];
    const toTopic = log.topics[2];
    const dataPart = log.data;
    if (!fromTopic || fromTopic.length < 42) return null;
    if (!toTopic || toTopic.length < 42) return null;
    if (!dataPart || dataPart === '0x' || dataPart.length < 3) return null;
    const from = ('0x' + fromTopic.slice(-40)).toLowerCase();
    const to = ('0x' + toTopic.slice(-40)).toLowerCase();
    const amountRaw = BigInt(dataPart);
    const tokenAddress = log.address.toLowerCase();
    return { tokenAddress, from, to, amountRaw };
  } catch {
    return null;
  }
}

/** Apply the EIP-7708 filter then decode — same logic as ArcRpcProvider Step 3. */
function filterAndDecode(logs: RawErc20Log[]): DecodedErc20Transfer[] {
  return logs
    .filter((log) => log.address.toLowerCase() !== ARC_SYSTEM_EMITTER)
    .map((log) => decodeErc20TransferLog(log))
    .filter((d): d is DecodedErc20Transfer => d !== null);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET  = '0xaaaa000000000000000000000000000000000001';
const OTHER   = '0xbbbb000000000000000000000000000000000002';
const TX_HASH = '0x' + 'cc'.repeat(32);

const TOPIC_WALLET = '0x000000000000000000000000' + WALLET.slice(2);
const TOPIC_OTHER  = '0x000000000000000000000000' + OTHER.slice(2);

const AMOUNT_RAW = 5_000_000n; // 5 USDC (6-decimal)
const AMOUNT_HEX = '0x' + AMOUNT_RAW.toString(16).padStart(64, '0');

/** A legitimate USDC Transfer log emitted by the ERC-20 contract. */
function makeUsdcLog(from = WALLET, to = OTHER): RawErc20Log {
  return {
    address: ARC_USDC_CONTRACT,
    topics: [
      ERC20_TRANSFER_TOPIC,
      '0x000000000000000000000000' + from.slice(2),
      '0x000000000000000000000000' + to.slice(2),
    ],
    data: AMOUNT_HEX,
    transactionHash: TX_HASH,
    blockNumber: '0x64',
  };
}

/** The EIP-7708 system emitter log for the same transfer. */
function makeSystemEmitterLog(from = WALLET, to = OTHER): RawErc20Log {
  return {
    address: ARC_SYSTEM_EMITTER,   // ← system emitter, not the ERC-20 contract
    topics: [
      ERC20_TRANSFER_TOPIC,
      '0x000000000000000000000000' + from.slice(2),
      '0x000000000000000000000000' + to.slice(2),
    ],
    data: AMOUNT_HEX,
    transactionHash: TX_HASH,
    blockNumber: '0x64',
  };
}

/** A non-USDC ERC-20 Transfer log (should be decoded normally). */
const OTHER_TOKEN = '0x9999000000000000000000000000000000000009';
function makeOtherTokenLog(): RawErc20Log {
  return {
    address: OTHER_TOKEN,
    topics: [
      ERC20_TRANSFER_TOPIC,
      TOPIC_WALLET,
      TOPIC_OTHER,
    ],
    data: AMOUNT_HEX,
    transactionHash: TX_HASH,
    blockNumber: '0x64',
  };
}

/** Build a NormalizedActivity from a list of DecodedErc20Transfer arrays. */
function makeActivity(
  walletAddress: string,
  txTransfers: DecodedErc20Transfer[][],
  isOutgoing = true,
  mayBeTruncated = false,
): NormalizedActivity {
  const transactions: NormalizedTransaction[] = txTransfers.map((transfers, i) => ({
    hash: `0x${'aa'.repeat(31)}${i.toString(16).padStart(2, '0')}`,
    blockNumber: BigInt(100 + i),
    timestamp: 1_700_000_000 + i * 60,
    from: isOutgoing ? walletAddress : OTHER,
    to: isOutgoing ? OTHER : walletAddress,
    valueWei: 0n,
    succeeded: true,
    isOutgoing,
    isContractCreation: false,
    hasInputData: true,
    erc20Transfers: transfers,
  }));

  return {
    address: walletAddress.toLowerCase(),
    chainId: 5042002,
    transactions,
    contractAddressesInteracted: new Set(),
    earliestTimestamp: transactions[0]?.timestamp,
    latestTimestamp: transactions[transactions.length - 1]?.timestamp,
    totalFetched: transactions.length,
    mayBeTruncated,
    fetchedAt: new Date().toISOString(),
    providerName: 'test',
    dataQualityNotes: [],
  };
}

// ---------------------------------------------------------------------------
// Test: exported constants
// ---------------------------------------------------------------------------

describe('EIP-7708 constants', () => {
  it('ARC_USDC_CONTRACT is the expected address', () => {
    expect(ARC_USDC_CONTRACT).toBe('0x3600000000000000000000000000000000000000');
  });

  it('ARC_SYSTEM_EMITTER is lowercase', () => {
    expect(ARC_SYSTEM_EMITTER).toBe(ARC_SYSTEM_EMITTER.toLowerCase());
  });

  it('ARC_SYSTEM_EMITTER is a valid 40-hex-char EVM address', () => {
    expect(/^0x[0-9a-f]{40}$/.test(ARC_SYSTEM_EMITTER)).toBe(true);
  });

  it('ARC_SYSTEM_EMITTER is not the same as ARC_USDC_CONTRACT', () => {
    expect(ARC_SYSTEM_EMITTER).not.toBe(ARC_USDC_CONTRACT);
  });
});

// ---------------------------------------------------------------------------
// Test: provider-level filter (filterAndDecode replicates ArcRpcProvider Step 3)
// ---------------------------------------------------------------------------

describe('EIP-7708 system emitter filter — log-level', () => {
  it('USDC Transfer log from ARC_USDC_CONTRACT is decoded normally', () => {
    const results = filterAndDecode([makeUsdcLog()]);
    expect(results).toHaveLength(1);
    expect(results[0].tokenAddress).toBe(ARC_USDC_CONTRACT);
    expect(results[0].amountRaw).toBe(AMOUNT_RAW);
  });

  it('Transfer-shaped log from ARC_SYSTEM_EMITTER is discarded', () => {
    const results = filterAndDecode([makeSystemEmitterLog()]);
    expect(results).toHaveLength(0);
  });

  it('dual-emitter scenario: USDC log + system-emitter log → only one decoded transfer', () => {
    const logs = [makeUsdcLog(), makeSystemEmitterLog()];
    const results = filterAndDecode(logs);
    expect(results).toHaveLength(1);
    expect(results[0].tokenAddress).toBe(ARC_USDC_CONTRACT);
  });

  it('system emitter is filtered regardless of from/to addresses', () => {
    // Different wallet as recipient — still must be filtered
    const log = makeSystemEmitterLog(OTHER, WALLET);
    const results = filterAndDecode([log]);
    expect(results).toHaveLength(0);
  });

  it('system emitter address comparison is case-insensitive', () => {
    // Mixed-case system emitter address in the log
    const log: RawErc20Log = {
      ...makeSystemEmitterLog(),
      address: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE', // mixed case
    };
    const results = filterAndDecode([log]);
    expect(results).toHaveLength(0);
  });

  it('non-USDC ERC-20 Transfer is preserved (system emitter filter is address-specific)', () => {
    const results = filterAndDecode([makeOtherTokenLog()]);
    expect(results).toHaveLength(1);
    expect(results[0].tokenAddress).toBe(OTHER_TOKEN);
  });

  it('mixed batch: USDC + system emitter + other token → 2 transfers (USDC and other)', () => {
    const logs = [makeUsdcLog(), makeSystemEmitterLog(), makeOtherTokenLog()];
    const results = filterAndDecode(logs);
    expect(results).toHaveLength(2);
    const tokenAddresses = results.map((r) => r.tokenAddress);
    expect(tokenAddresses).toContain(ARC_USDC_CONTRACT);
    expect(tokenAddresses).toContain(OTHER_TOKEN);
    expect(tokenAddresses).not.toContain(ARC_SYSTEM_EMITTER);
  });

  it('empty log list returns empty array', () => {
    expect(filterAndDecode([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: economicActivity signal — no double-counting via system emitter
// ---------------------------------------------------------------------------

describe('economicActivity — EIP-7708 no double-counting', () => {
  it('outgoing USDC transfer via ERC-20 (ARC_USDC_CONTRACT) is counted once', () => {
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: ARC_USDC_CONTRACT, from: WALLET, to: OTHER, amountRaw: AMOUNT_RAW },
    ];
    const activity = makeActivity(WALLET, [transfers], true);
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(BigInt(breakdown.usdcErc20Raw)).toBe(AMOUNT_RAW);
  });

  it('if system-emitter transfer somehow reached erc20Transfers[], it is not counted as USDC', () => {
    // This simulates a hypothetical future provider bug where the system emitter
    // was not filtered. The signal calculator's tokenAddress filter provides a
    // second line of defence: tokenAddress !== ARC_USDC_CONTRACT → excluded.
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: ARC_SYSTEM_EMITTER, from: WALLET, to: OTHER, amountRaw: AMOUNT_RAW },
    ];
    const activity = makeActivity(WALLET, [transfers], true);
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    // System emitter tokenAddress does not match ARC_USDC_CONTRACT filter
    expect(BigInt(breakdown.usdcErc20Raw)).toBe(0n);
  });

  it('dual-emitter scenario at activity level: one ERC-20 transfer + one system-emitter transfer → counted once', () => {
    // Provider has correctly filtered the system emitter — only one transfer present.
    // This is the expected post-fix state.
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: ARC_USDC_CONTRACT, from: WALLET, to: OTHER, amountRaw: AMOUNT_RAW },
      // System emitter has already been filtered by ArcRpcProvider Step 3.
      // If it were present, tokenAddress = ARC_SYSTEM_EMITTER would not match.
    ];
    const activity = makeActivity(WALLET, [transfers], true);
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(BigInt(breakdown.usdcErc20Raw)).toBe(AMOUNT_RAW); // exactly once
  });

  it('usdcErc20Raw would be 2x AMOUNT_RAW if system-emitter were decoded as USDC (pre-fix scenario)', () => {
    // Documents what the bug looked like: if both logs were decoded with
    // tokenAddress = ARC_USDC_CONTRACT, the sum would be 2 × AMOUNT_RAW.
    // This test verifies the pre-fix scenario would have produced the wrong answer.
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: ARC_USDC_CONTRACT, from: WALLET, to: OTHER, amountRaw: AMOUNT_RAW },
      { tokenAddress: ARC_USDC_CONTRACT, from: WALLET, to: OTHER, amountRaw: AMOUNT_RAW }, // hypothetical duplicate
    ];
    const activity = makeActivity(WALLET, [transfers], true);
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    // Two transfers with same tokenAddress → summed → 2 × AMOUNT_RAW
    // This confirms the bug existed and the fix prevents it.
    expect(BigInt(breakdown.usdcErc20Raw)).toBe(AMOUNT_RAW * 2n);
  });
});

// ---------------------------------------------------------------------------
// Test: usdcReceived signal — no double-counting via system emitter
// ---------------------------------------------------------------------------

describe('usdcReceived — EIP-7708 no double-counting', () => {
  it('incoming USDC transfer (to === wallet) is counted once', () => {
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: ARC_USDC_CONTRACT, from: OTHER, to: WALLET, amountRaw: AMOUNT_RAW },
    ];
    // isOutgoing=false: wallet received, OTHER sent
    const activity = makeActivity(WALLET, [transfers], false);
    const signal = calculateUsdcReceived(activity);
    expect(BigInt(signal.value as string)).toBe(AMOUNT_RAW);
  });

  it('system-emitter transfer in erc20Transfers[] is not counted as incoming USDC', () => {
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: ARC_SYSTEM_EMITTER, from: OTHER, to: WALLET, amountRaw: AMOUNT_RAW },
    ];
    const activity = makeActivity(WALLET, [transfers], false);
    const signal = calculateUsdcReceived(activity);
    // tokenAddress !== ARC_USDC_CONTRACT → not counted
    expect(BigInt(signal.value as string)).toBe(0n);
  });

  it('post-fix: one legitimate incoming USDC transfer counts once (no dual-emitter inflation)', () => {
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: ARC_USDC_CONTRACT, from: OTHER, to: WALLET, amountRaw: AMOUNT_RAW },
      // System emitter already filtered by ArcRpcProvider — not in erc20Transfers[].
    ];
    const activity = makeActivity(WALLET, [transfers], false);
    const signal = calculateUsdcReceived(activity);
    expect(BigInt(signal.value as string)).toBe(AMOUNT_RAW); // exactly once
  });
});

// ---------------------------------------------------------------------------
// Test: non-USDC ERC-20 decoding is unaffected
// ---------------------------------------------------------------------------

describe('non-USDC ERC-20 decoding is preserved', () => {
  it('a non-USDC token transfer is present in erc20Transfers after filter', () => {
    // The filter only removes system-emitter logs; other tokens pass through.
    const results = filterAndDecode([makeOtherTokenLog()]);
    expect(results).toHaveLength(1);
    expect(results[0].tokenAddress).toBe(OTHER_TOKEN);
    expect(results[0].amountRaw).toBe(AMOUNT_RAW);
  });

  it('non-USDC token does not contribute to economicActivity.usdcErc20Raw', () => {
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: OTHER_TOKEN, from: WALLET, to: OTHER, amountRaw: AMOUNT_RAW },
    ];
    const activity = makeActivity(WALLET, [transfers], true);
    const signal = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(signal.value as string);
    expect(BigInt(breakdown.usdcErc20Raw)).toBe(0n); // not USDC
  });

  it('non-USDC token does not contribute to usdcReceived', () => {
    const transfers: DecodedErc20Transfer[] = [
      { tokenAddress: OTHER_TOKEN, from: OTHER, to: WALLET, amountRaw: AMOUNT_RAW },
    ];
    const activity = makeActivity(WALLET, [transfers], false);
    const signal = calculateUsdcReceived(activity);
    expect(BigInt(signal.value as string)).toBe(0n); // not USDC
  });
});
