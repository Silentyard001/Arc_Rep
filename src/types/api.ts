/**
 * src/types/api.ts
 *
 * Frontend-safe API response types.
 *
 * These are the shapes the frontend receives from the Arc Rep API.
 * They are a subset of the server domain types — no server internals exposed.
 *
 * IMPORTANT: Do not import from server/ in any src/ file.
 */

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

export type SignalStatus = 'available' | 'partial' | 'unavailable' | 'future';

export interface ActivitySignal {
  key: string;
  label: string;
  value: number | string | null;
  status: SignalStatus;
  description: string;
  source: string;
  calculationDefinition: string;
  valueUnit: string;
  observationStart?: number;
  observationEnd?: number;
  confidenceNote: string;
}

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

export type CredentialIssuerType = 'system' | 'project' | 'contract';
export type CredentialStatus = 'active' | 'stale' | 'not_earned' | 'insufficient_data';

export interface CredentialIssuer {
  id: string;
  name: string;
  issuerType: CredentialIssuerType;
  authorityId: string;
}

export interface Credential {
  typeId: string;
  name: string;
  description: string;
  status: CredentialStatus;
  issuer: CredentialIssuer;
  evidenceSignals: Array<{
    signalKey: string;
    signalLabel: string;
    value: number | string | null;
    signalStatus: string;
  }>;
  evaluatedAt: string;
  evaluationNote: string;
  observationPeriodNote: string;
}

// ---------------------------------------------------------------------------
// Activity summary
// ---------------------------------------------------------------------------

export interface WalletActivitySummary {
  address: string;
  chainId: number;
  transactionCount: number;
  uniqueContractAddresses: string[];
  earliestTimestamp?: number;
  latestTimestamp?: number;
  mayBeTruncated: boolean;
  fetchedAt: string;
  providerName: string;
  dataQualityNotes: string[];
}

// ---------------------------------------------------------------------------
// WalletProfile
// ---------------------------------------------------------------------------

export interface WalletProfile {
  address: string;
  chainId: number;
  activitySummary: WalletActivitySummary;
  signals: ActivitySignal[];
  credentials: Credential[];
  profileBuiltAt: string;
  schemaVersion: string;
}

// ---------------------------------------------------------------------------
// API error response
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  detail?: string;
  code: string;
}
