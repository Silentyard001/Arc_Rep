/**
 * tests/data/provider.test.ts
 *
 * Tests for the IActivityProvider interface contract and address validation.
 *
 * These tests verify that ArcRpcProvider correctly validates addresses
 * without making live RPC calls (we test the guard behavior).
 *
 * NOTE: Live RPC integration tests would require a testnet node.
 * Those are left for a separate integration test suite.
 */

import { describe, it, expect } from 'bun:test';
import { ArcRpcProvider } from '../../server/data/ArcRpcProvider.js';
import { ActivityProviderError } from '../../server/data/IActivityProvider.js';

describe('ArcRpcProvider address validation', () => {
  const provider = new ArcRpcProvider();

  it('throws ActivityProviderError for an invalid address (no 0x prefix)', async () => {
    await expect(
      provider.getActivity('abc1234567890abcdef1234567890abcdef123456'),
    ).rejects.toBeInstanceOf(ActivityProviderError);
  });

  it('throws ActivityProviderError for a too-short address', async () => {
    await expect(provider.getActivity('0x1234')).rejects.toBeInstanceOf(
      ActivityProviderError,
    );
  });

  it('throws ActivityProviderError for an empty string', async () => {
    await expect(provider.getActivity('')).rejects.toBeInstanceOf(
      ActivityProviderError,
    );
  });

  it('throws ActivityProviderError for an address with invalid hex chars', async () => {
    await expect(
      provider.getActivity('0xGGGG000000000000000000000000000000000000'),
    ).rejects.toBeInstanceOf(ActivityProviderError,
    );
  });

  it('provider has a non-empty name', () => {
    expect(provider.name).toBeTruthy();
    expect(typeof provider.name).toBe('string');
  });
});

describe('Address validation middleware logic', () => {
  // Test the regex used by both the provider and the middleware
  const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

  const valid = [
    '0xabc0000000000000000000000000000000000001',
    '0xABC0000000000000000000000000000000000001',
    '0x1234567890abcdefABCDEF1234567890abcdef12',
  ];

  const invalid = [
    '0x123', // too short
    '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', // invalid hex chars
    'abc1234567890abcdef1234567890abcdef123456', // no 0x
    '0x1234567890abcdef1234567890abcdef123456789', // too long
    '', // empty
    '0x', // just prefix
  ];

  for (const addr of valid) {
    it(`accepts valid address: ${addr.slice(0, 10)}...`, () => {
      expect(EVM_ADDRESS_RE.test(addr)).toBe(true);
    });
  }

  for (const addr of invalid) {
    it(`rejects invalid address: "${addr.slice(0, 20)}"`, () => {
      expect(EVM_ADDRESS_RE.test(addr)).toBe(false);
    });
  }
});
