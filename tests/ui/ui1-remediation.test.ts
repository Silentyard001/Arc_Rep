/**
 * tests/ui/ui1-remediation.test.ts
 *
 * Regression tests for UI-1 remediation fixes.
 * These tests exercise pure helper logic extracted from ProfileShell.tsx
 * that can be unit-tested without a DOM renderer.
 *
 * Covered findings:
 *   UI-B-02 — EVM address validation
 *   UI-C-01 — Human-readable signal status labels
 *   UI-C-03 — observationPeriodNote visibility logic
 *   UI-C-04 — USDC 6-decimal formatting
 */

import { describe, it, expect } from 'bun:test';

// ---------------------------------------------------------------------------
// Reproduce the pure helpers from ProfileShell.tsx for isolated testing.
// These must stay in sync with the component.
// ---------------------------------------------------------------------------

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const USDC_DECIMALS = 6;
const USDC_DIVISOR = Math.pow(10, USDC_DECIMALS);

function isValidAddress(address: string): boolean {
  return EVM_ADDRESS_RE.test(address);
}

function formatRawUsdc(raw: string | number): string {
  const n = typeof raw === 'string' ? BigInt(raw) : BigInt(Math.round(Number(raw)));
  if (n === 0n) return '0 USDC';
  const whole = n / BigInt(USDC_DIVISOR);
  const frac = n % BigInt(USDC_DIVISOR);
  if (frac === 0n) return `${whole.toString()} USDC`;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr} USDC`;
}

function signalStatusLabel(status: string): string {
  switch (status) {
    case 'available':   return 'Available';
    case 'partial':     return 'Partial snapshot';
    case 'unavailable': return 'Unavailable';
    case 'future':      return 'Not yet implemented';
    default:            return status;
  }
}

function shouldShowObservationNote(status: string, note: string | undefined): boolean {
  if (!note) return false;
  return status === 'active' || status === 'insufficient_data';
}

// ---------------------------------------------------------------------------
// UI-B-02 — EVM address validation
// ---------------------------------------------------------------------------

describe('UI-B-02: EVM address validation', () => {
  it('accepts a valid lowercase 0x address', () => {
    expect(isValidAddress('0x' + 'a'.repeat(40))).toBe(true);
  });

  it('accepts a valid mixed-case address', () => {
    expect(isValidAddress('0xAbCdEf1234567890AbCdEf1234567890AbCdEf12')).toBe(true);
  });

  it('accepts a valid all-zero address', () => {
    expect(isValidAddress('0x' + '0'.repeat(40))).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidAddress('')).toBe(false);
  });

  it('rejects a bare hex string without 0x prefix', () => {
    expect(isValidAddress('a'.repeat(40))).toBe(false);
  });

  it('rejects an address that is too short', () => {
    expect(isValidAddress('0x' + 'a'.repeat(39))).toBe(false);
  });

  it('rejects an address that is too long', () => {
    expect(isValidAddress('0x' + 'a'.repeat(41))).toBe(false);
  });

  it('rejects a non-hex character in the address body', () => {
    expect(isValidAddress('0x' + 'g'.repeat(40))).toBe(false);
  });

  it('rejects a plain ENS name', () => {
    expect(isValidAddress('vitalik.eth')).toBe(false);
  });

  it('rejects whitespace-padded address', () => {
    expect(isValidAddress(' 0x' + 'a'.repeat(40))).toBe(false);
  });

  it('rejects null-byte in address', () => {
    expect(isValidAddress('0x' + '\0'.repeat(40))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UI-C-01 — Human-readable signal status labels
// ---------------------------------------------------------------------------

describe('UI-C-01: signal status labels', () => {
  it('returns "Available" for "available"', () => {
    expect(signalStatusLabel('available')).toBe('Available');
  });

  it('returns "Partial snapshot" for "partial"', () => {
    expect(signalStatusLabel('partial')).toBe('Partial snapshot');
  });

  it('returns "Unavailable" for "unavailable"', () => {
    expect(signalStatusLabel('unavailable')).toBe('Unavailable');
  });

  it('returns "Not yet implemented" for "future"', () => {
    expect(signalStatusLabel('future')).toBe('Not yet implemented');
  });

  it('passes through unknown status values unchanged', () => {
    expect(signalStatusLabel('custom_status')).toBe('custom_status');
  });

  it('does not return any raw enum strings for the four known statuses', () => {
    for (const s of ['available', 'partial', 'unavailable', 'future']) {
      expect(signalStatusLabel(s)).not.toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
// UI-C-03 — observationPeriodNote visibility
// ---------------------------------------------------------------------------

describe('UI-C-03: observation period note visibility', () => {
  it('shows note on active credential with a note', () => {
    expect(shouldShowObservationNote('active', 'Observed since network genesis')).toBe(true);
  });

  it('shows note on insufficient_data credential with a note', () => {
    expect(shouldShowObservationNote('insufficient_data', 'Requires full historical data')).toBe(true);
  });

  it('does NOT show note on not_earned credential', () => {
    expect(shouldShowObservationNote('not_earned', 'Some note')).toBe(false);
  });

  it('does NOT show note on stale credential', () => {
    expect(shouldShowObservationNote('stale', 'Some note')).toBe(false);
  });

  it('does NOT show note when note is empty string', () => {
    expect(shouldShowObservationNote('active', '')).toBe(false);
  });

  it('does NOT show note when note is undefined', () => {
    expect(shouldShowObservationNote('active', undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UI-C-04 — USDC raw amount formatting
// ---------------------------------------------------------------------------

describe('UI-C-04: USDC 6-decimal formatting', () => {
  it('formats 0 as "0 USDC"', () => {
    expect(formatRawUsdc('0')).toBe('0 USDC');
    expect(formatRawUsdc(0)).toBe('0 USDC');
  });

  it('formats 1 (sub-cent) correctly', () => {
    expect(formatRawUsdc('1')).toBe('0.000001 USDC');
  });

  it('formats 1000000 as "1 USDC"', () => {
    expect(formatRawUsdc('1000000')).toBe('1 USDC');
  });

  it('formats 2500000 as "2.5 USDC"', () => {
    expect(formatRawUsdc('2500000')).toBe('2.5 USDC');
  });

  it('formats 1500000 as "1.5 USDC"', () => {
    expect(formatRawUsdc('1500000')).toBe('1.5 USDC');
  });

  it('formats 1100000 as "1.1 USDC"', () => {
    expect(formatRawUsdc('1100000')).toBe('1.1 USDC');
  });

  it('formats 1000001 as "1.000001 USDC"', () => {
    expect(formatRawUsdc('1000001')).toBe('1.000001 USDC');
  });

  it('trims trailing fractional zeros', () => {
    // 1200000 = 1.2 USDC (not 1.200000)
    expect(formatRawUsdc('1200000')).toBe('1.2 USDC');
  });

  it('formats large whole amounts', () => {
    expect(formatRawUsdc('1000000000000')).toBe('1000000 USDC');
  });

  it('formats large fractional amounts', () => {
    expect(formatRawUsdc('1234567')).toBe('1.234567 USDC');
  });

  it('handles numeric input (not just string)', () => {
    expect(formatRawUsdc(1000000)).toBe('1 USDC');
  });

  it('handles exact minimum earned threshold (1 USDC = 1000000 raw)', () => {
    // The payments credential threshold is 1 USDC
    expect(formatRawUsdc('1000000')).toBe('1 USDC');
    // Below threshold
    expect(formatRawUsdc('999999')).toBe('0.999999 USDC');
  });
});
