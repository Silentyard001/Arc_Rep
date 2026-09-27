/**
 * server/domain/verification/types.ts
 *
 * Stub types for the Verification layer (Phase 2).
 *
 * This file defines the intended shape of the verification API.
 * No verification logic is implemented in Phase 1.
 *
 * Phase 2 goals:
 * - Projects register VerificationRules against signal criteria.
 * - Arc Rep evaluates a wallet against a rule and returns a VerificationResult.
 * - Privacy-preserving proofs: the result confirms eligibility without
 *   revealing the wallet's full activity history (ZK or selective disclosure).
 */

export type { VerificationRule, VerificationResult } from '../types.js';
