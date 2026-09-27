/**
 * tests/domain/usdc-received.test.ts
 *
 * Comprehensive unit tests for the usdcReceived signal calculator.
 *
 * Tests are grouped by:
 *   1. Core counting semantics (incoming vs outgoing vs failed)
 *   2. Token address filtering (only Arc USDC)
 *   3. Multi-transfer and cross-transaction summation
 *   4. Transaction state handling (outgoing vs incoming transactions)
 *   5. Data quality / truncation behavior
 *   6. No double-counting with economicActivity
 *   7. Large uint256 precision
 *   8. Signal metadata (key, label, description, valueUnit)
 *   9. No reputation language in signal fields
 */

import { describe, it, expect } from 'bun:test';
import { calculateUsdcReceived, calculateEconomicActivity } from '../../server/domain/signals/calculators/activity.js';
import type { NormalizedActivity, NormalizedTransaction } from '../../server/data/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC = '0x3600000000000000000000000000000000000000';
const OTHER_TOKEN = '0xothertoken00000000000000000000000000001';
const WALLET = '0xabc0000000000000000000000000000000000001';
const OTHER_WALLET = '0xother0000000000000000000000000000000001';
const RECIPIENT = '0xrecipient000000000000000000000000000001';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActivity(overrides: Partial<NormalizedActivity> = {}): NormalizedActivity {
  return {
    address: WALLET,
    chainId: 5042002,
    transactions: [],
    contractAddressesInteracted: new Set(),
    totalFetched: 0,
    mayBeTruncated: false,
    fetchedAt: new Date().toISOString(),
    providerName: 'TestProvider',
    dataQualityNotes: [],
    ...overrides,
  };
}

/**
 * Build a transaction with full control over direction and ERC-20 transfers.
 * Defaults to an outgoing succeeded transaction with no ERC-20 transfers.
 */
function makeTx(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
    blockNumber: BigInt(1),
    timestamp: 1_700_000_000,
    from: WALLET,
    to: USDC,
    valueWei: BigInt(0),
    succeeded: true,
    isOutgoing: true,
    isContractCreation: false,
    hasInputData: true,
    erc20Transfers: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Core counting semantics
// ---------------------------------------------------------------------------

describe('usdcReceived: core counting semantics', () => {
  it('returns "0" for empty wallet', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(signal.value).toBe('0');
  });

  it('counts an incoming USDC transfer (transfer.to === wallet)', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          from: OTHER_WALLET,
          to: WALLET,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('5000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('5000000');
  });

  it('does NOT count outgoing USDC transfer (transfer.from === wallet, transfer.to !== wallet)', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: true,
          succeeded: true,
          erc20Transfers: [
            // Wallet is the sender — should NOT contribute to usdcReceived
            { tokenAddress: USDC, from: WALLET, to: RECIPIENT, amountRaw: BigInt('9000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('0');
  });

  it('does NOT count a failed incoming USDC transfer', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: false, // failed
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('7000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('0');
  });

  it('does NOT count a failed outgoing tx that also carries an incoming transfer', () => {
    // Edge case: the wallet sent a tx that failed, but the Transfer event would
    // have made the wallet a recipient. Since tx.succeeded === false, skip it.
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: true,
          succeeded: false,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('3000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// 2. Token address filtering
// ---------------------------------------------------------------------------

describe('usdcReceived: token address filtering', () => {
  it('ignores non-USDC ERC-20 transfers to the wallet', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            // Different token, not USDC
            { tokenAddress: OTHER_TOKEN, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('100000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('0');
  });

  it('counts USDC but ignores other tokens when both appear in same tx', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('4000000') },
            { tokenAddress: OTHER_TOKEN, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('999999') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    // Only the USDC transfer is counted
    expect(signal.value).toBe('4000000');
  });

  it('uses the exact ARC_USDC_CONTRACT address (0x3600...0000)', () => {
    // An address that is NOT the Arc USDC contract must not be counted
    const notUsdc = '0x3600000000000000000000000000000000000001'; // differs by 1 nibble
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: notUsdc, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('1000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-transfer and cross-transaction summation
// ---------------------------------------------------------------------------

describe('usdcReceived: summation across multiple transfers and transactions', () => {
  it('sums multiple incoming USDC transfers in the same transaction', () => {
    // Two USDC Transfer events in one tx both to the wallet
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('1000000') },
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('2000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('3000000'); // 1_000_000 + 2_000_000
  });

  it('sums incoming USDC transfers across multiple transactions', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          hash: '0x01',
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('1000000') },
          ],
        }),
        makeTx({
          hash: '0x02',
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('2500000') },
          ],
        }),
        makeTx({
          hash: '0x03',
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('500000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('4000000'); // 1_000_000 + 2_500_000 + 500_000
  });

  it('handles a mix of incoming/outgoing/failed across multiple transactions', () => {
    const activity = makeActivity({
      transactions: [
        // counted: incoming, succeeded, USDC, to=wallet
        makeTx({
          hash: '0xA',
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('6000000') },
          ],
        }),
        // NOT counted: outgoing USDC (wallet is sender)
        makeTx({
          hash: '0xB',
          isOutgoing: true,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: RECIPIENT, amountRaw: BigInt('1000000') },
          ],
        }),
        // NOT counted: failed
        makeTx({
          hash: '0xC',
          isOutgoing: false,
          succeeded: false,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('9999999') },
          ],
        }),
        // NOT counted: different token
        makeTx({
          hash: '0xD',
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: OTHER_TOKEN, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('500000') },
          ],
        }),
        // counted: incoming, succeeded, USDC
        makeTx({
          hash: '0xE',
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('1000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.value).toBe('7000000'); // 6_000_000 + 1_000_000
  });
});

// ---------------------------------------------------------------------------
// 4. Transaction direction handling
// ---------------------------------------------------------------------------

describe('usdcReceived: incoming transfers on outgoing transactions', () => {
  it('counts incoming USDC even in an outgoing transaction (e.g. contract returns change)', () => {
    // A wallet initiates a tx (isOutgoing = true) but the contract sends USDC back
    // transfer.to === wallet means it's an incoming transfer on this specific event
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: true,
          succeeded: true,
          erc20Transfers: [
            // The wallet is the recipient of this specific Transfer event
            { tokenAddress: USDC, from: '0xcontract0000000000000000000000000000001', to: WALLET, amountRaw: BigInt('250000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    // transfer.to === WALLET is the sole criterion — direction of tx is irrelevant
    expect(signal.value).toBe('250000');
  });
});

// ---------------------------------------------------------------------------
// 5. Data quality / truncation behavior
// ---------------------------------------------------------------------------

describe('usdcReceived: truncation and data quality', () => {
  it('status is "available" when mayBeTruncated = false', () => {
    const signal = calculateUsdcReceived(makeActivity({ mayBeTruncated: false }));
    expect(signal.status).toBe('available');
    expect(signal.confidenceNote).toBe('');
  });

  it('status is "partial" when mayBeTruncated = true', () => {
    const signal = calculateUsdcReceived(makeActivity({ mayBeTruncated: true }));
    expect(signal.status).toBe('partial');
    expect(signal.confidenceNote).toBeTruthy();
  });

  it('confidenceNote mentions truncation when partial', () => {
    const signal = calculateUsdcReceived(makeActivity({ mayBeTruncated: true }));
    expect(signal.confidenceNote.toLowerCase()).toContain('truncat');
  });

  it('partial status does not prevent a non-zero value from being reported', () => {
    const activity = makeActivity({
      mayBeTruncated: true,
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('3000000') },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(signal.status).toBe('partial');
    expect(signal.value).toBe('3000000'); // value is reported even though partial
  });

  it('zero value with truncation is "partial", not "available"', () => {
    // Even when no USDC received in window, if truncated, result is partial
    const signal = calculateUsdcReceived(makeActivity({
      mayBeTruncated: true,
      transactions: [],
    }));
    expect(signal.value).toBe('0');
    expect(signal.status).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// 6. No double-counting with economicActivity
// ---------------------------------------------------------------------------

describe('usdcReceived: no double-counting with economicActivity', () => {
  it('incoming transfer is counted by usdcReceived but NOT by economicActivity', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            // transfer.to === WALLET: incoming
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('5000000') },
          ],
        }),
      ],
    });

    const received = calculateUsdcReceived(activity);
    const economic = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(economic.value as string);

    expect(received.value).toBe('5000000');       // usdcReceived counts it
    expect(breakdown.usdcErc20Raw).toBe('0');      // economicActivity does NOT count it
    expect(breakdown.nativeValueWei).toBe('0');
  });

  it('outgoing transfer is counted by economicActivity but NOT by usdcReceived', () => {
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: true,
          succeeded: true,
          erc20Transfers: [
            // transfer.from === WALLET: outgoing
            { tokenAddress: USDC, from: WALLET, to: RECIPIENT, amountRaw: BigInt('8000000') },
          ],
        }),
      ],
    });

    const received = calculateUsdcReceived(activity);
    const economic = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(economic.value as string);

    expect(received.value).toBe('0');              // usdcReceived does NOT count it
    expect(breakdown.usdcErc20Raw).toBe('8000000'); // economicActivity counts it
  });

  it('a transaction with both an incoming and outgoing transfer reports each in its correct signal', () => {
    // This wallet sends 3 USDC to A, and contract sends 1 USDC back as change
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: true,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: RECIPIENT, amountRaw: BigInt('3000000') },    // outgoing
            { tokenAddress: USDC, from: '0xcontract0000000000000000000000000000001', to: WALLET, amountRaw: BigInt('1000000') }, // incoming change
          ],
        }),
      ],
    });

    const received = calculateUsdcReceived(activity);
    const economic = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(economic.value as string);

    // Each signal counts exactly what belongs to it
    expect(received.value).toBe('1000000');         // the incoming change
    expect(breakdown.usdcErc20Raw).toBe('3000000'); // the outgoing send
  });

  it('the same amount is never summed in both signals', () => {
    // Run both on the same activity and confirm total is not double-counted
    const activity = makeActivity({
      transactions: [
        // outgoing send
        makeTx({
          hash: '0x01',
          isOutgoing: true,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: WALLET, to: RECIPIENT, amountRaw: BigInt('2000000') },
          ],
        }),
        // incoming receive
        makeTx({
          hash: '0x02',
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: BigInt('4000000') },
          ],
        }),
      ],
    });

    const received = calculateUsdcReceived(activity);
    const economic = calculateEconomicActivity(activity);
    const breakdown = JSON.parse(economic.value as string);

    // The two signals are non-overlapping:
    expect(received.value).toBe('4000000');          // only the incoming
    expect(breakdown.usdcErc20Raw).toBe('2000000');  // only the outgoing
    // Neither signal contains the other's amount
    expect(BigInt(received.value as string) + BigInt(breakdown.usdcErc20Raw)).toBe(BigInt('6000000'));
  });
});

// ---------------------------------------------------------------------------
// 7. Large uint256 precision
// ---------------------------------------------------------------------------

describe('usdcReceived: large uint256 precision', () => {
  it('preserves exact BigInt value for large USDC amounts', () => {
    // A trillion USDC at 6-decimal precision
    const oneTrillion = BigInt('1000000') * BigInt('1000000000000'); // 1e18 raw
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: oneTrillion },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(BigInt(signal.value as string)).toBe(oneTrillion);
  });

  it('handles max uint256 without precision loss', () => {
    const maxUint256 = BigInt(2) ** BigInt(256) - BigInt(1);
    const activity = makeActivity({
      transactions: [
        makeTx({
          isOutgoing: false,
          succeeded: true,
          erc20Transfers: [
            { tokenAddress: USDC, from: OTHER_WALLET, to: WALLET, amountRaw: maxUint256 },
          ],
        }),
      ],
    });
    const signal = calculateUsdcReceived(activity);
    expect(BigInt(signal.value as string)).toBe(maxUint256);
  });
});

// ---------------------------------------------------------------------------
// 8. Signal metadata
// ---------------------------------------------------------------------------

describe('usdcReceived: signal metadata fields', () => {
  it('has the correct key', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(signal.key).toBe('usdcReceived');
  });

  it('has a non-empty label', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(signal.label).toBeTruthy();
  });

  it('has a non-empty description', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(signal.description).toBeTruthy();
  });

  it('has a non-empty source', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(signal.source).toBeTruthy();
  });

  it('has a non-empty calculationDefinition', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(signal.calculationDefinition).toBeTruthy();
  });

  it('valueUnit is "bigint_usdc_raw_6dec_string"', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(signal.valueUnit).toBe('bigint_usdc_raw_6dec_string');
  });

  it('value is a string (serialized bigint decimal), not a number or null', () => {
    const signal = calculateUsdcReceived(makeActivity());
    expect(typeof signal.value).toBe('string');
    expect(signal.value).not.toBeNull();
    // Must be parseable as a BigInt
    expect(() => BigInt(signal.value as string)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. No reputation language
// ---------------------------------------------------------------------------

describe('usdcReceived: no reputation language in signal fields', () => {
  it('description frames the signal as an observable fact, not reputation', () => {
    const signal = calculateUsdcReceived(makeActivity());
    // The description must explicitly state this is an observable fact, not reputation.
    // It may reference what the signal does NOT measure, so we check for positive framing.
    expect(signal.description.toLowerCase()).toContain('observable');
  });

  it('label does not contain reputation terms', () => {
    const signal = calculateUsdcReceived(makeActivity());
    const label = signal.label.toLowerCase();
    for (const term of ['score', 'rank', 'trust', 'reputation', 'sybil']) {
      expect(label).not.toContain(term);
    }
  });

  it('key is "usdcReceived", not a reputation key', () => {
    const signal = calculateUsdcReceived(makeActivity());
    const key = signal.key.toLowerCase();
    for (const term of ['score', 'rank', 'trust', 'reputation']) {
      expect(key).not.toContain(term);
    }
  });
});
