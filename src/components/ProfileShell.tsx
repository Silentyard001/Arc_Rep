/**
 * src/components/ProfileShell.tsx
 *
 * Renders a WalletProfile using real API data.
 * Fetches on mount (and when address changes).
 * No direct blockchain calls.
 *
 * UI-1 Remediation applied:
 *   UI-B-01 — Retry button on error state
 *   UI-B-02 — Invalid address guard (pre-fetch, client-side)
 *   UI-C-01 — Human-readable signal status labels
 *   UI-C-03 — observationPeriodNote shown on earned credentials too
 *   UI-C-04 — Raw USDC amounts converted with 6-decimal formatting
 *   UI-C-05 — Manual profile refresh action in success state
 */

import { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Minus,
  Info,
  RefreshCw,
} from 'lucide-react';
import { useProfile } from '../hooks/useProfile.js';
import type { ActivitySignal, Credential, WalletActivitySummary } from '../types/api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const USDC_DECIMALS = 6;
const USDC_DIVISOR = Math.pow(10, USDC_DECIMALS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(unix?: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** UI-C-04: Convert raw 6-decimal USDC integer to a human-readable string. */
function formatRawUsdc(raw: string | number): string {
  const n = typeof raw === 'string' ? BigInt(raw) : BigInt(Math.round(Number(raw)));
  if (n === 0n) return '0 USDC';
  const whole = n / BigInt(USDC_DIVISOR);
  const frac = n % BigInt(USDC_DIVISOR);
  if (frac === 0n) return `${whole.toString()} USDC`;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr} USDC`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'available':
      return 'text-[--success]';
    case 'partial':
      return 'text-amber-600';
    case 'unavailable':
    case 'not_earned':
      return 'text-[--muted]';
    case 'future':
      return 'text-[--subtle]';
    default:
      return 'text-[--muted]';
  }
}

/** UI-C-01: Human-readable labels for raw signal status enum values. */
function signalStatusLabel(status: string): string {
  switch (status) {
    case 'available':     return 'Available';
    case 'partial':       return 'Partial snapshot';
    case 'unavailable':   return 'Unavailable';
    case 'future':        return 'Not yet implemented';
    default:              return status;
  }
}

function credentialStatusIcon(status: string) {
  switch (status) {
    case 'active':
      return <CheckCircle size={16} className="text-[--success] shrink-0" />;
    case 'not_earned':
      return <XCircle size={16} className="text-[--subtle] shrink-0" />;
    case 'stale':
      return <AlertTriangle size={16} className="text-amber-500 shrink-0" />;
    case 'insufficient_data':
      return <Minus size={16} className="text-amber-500 shrink-0" />;
    default:
      return <Minus size={16} className="text-[--subtle] shrink-0" />;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActivityCard({ summary }: { summary: WalletActivitySummary }) {
  return (
    <div
      className="rounded-2xl p-5 border border-[--border]"
      style={{ background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-semibold text-[--muted] uppercase tracking-widest mb-4">
        Observed Activity
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Stat label="Transactions (snapshot)" value={summary.transactionCount.toString()} />
        <Stat label="Contracts interacted" value={summary.uniqueContractAddresses.length.toString()} />
        <Stat label="First seen" value={formatTimestamp(summary.earliestTimestamp)} />
        <Stat label="Last seen" value={formatTimestamp(summary.latestTimestamp)} />
        <Stat label="Data source" value={summary.providerName} small />
        <Stat
          label="Snapshot complete"
          value={summary.mayBeTruncated ? 'Partial' : 'Yes'}
          warn={summary.mayBeTruncated}
        />
      </div>
      {summary.dataQualityNotes.length > 0 && (
        <div className="mt-4 pt-4 border-t border-[--border]">
          <p className="text-xs font-medium text-[--muted] mb-2">Data quality notes:</p>
          <ul className="space-y-1">
            {summary.dataQualityNotes.map((note, i) => (
              <li key={i} className="text-xs text-[--subtle] flex gap-2">
                <Info size={12} className="shrink-0 mt-0.5 text-[--subtle]" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  small,
  warn,
}: {
  label: string;
  value: string;
  small?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-[--muted] mb-0.5">{label}</p>
      <p
        className={`font-semibold ${small ? 'text-xs' : 'text-sm'} ${warn ? 'text-amber-600' : 'text-[--ink]'} mono`}
      >
        {value}
      </p>
    </div>
  );
}

function SignalsCard({ signals }: { signals: ActivitySignal[] }) {
  const implemented = signals.filter((s) => s.status !== 'future');
  const future = signals.filter((s) => s.status === 'future');

  return (
    <div
      className="rounded-2xl p-5 border border-[--border]"
      style={{ background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-semibold text-[--muted] uppercase tracking-widest mb-4">
        Behavioral Signals
      </h2>
      <p className="text-xs text-[--subtle] mb-4 text-pretty">
        Signals describe observable wallet behavior. They are not reputation
        scores and do not indicate trustworthiness.
      </p>

      <div className="space-y-3">
        {implemented.map((signal) => (
          <SignalRow key={signal.key} signal={signal} />
        ))}
      </div>

      {future.length > 0 && (
        <div className="mt-5 pt-4 border-t border-[--border]">
          <p className="text-xs font-medium text-[--subtle] mb-3">Future signals (not yet implemented):</p>
          <div className="flex flex-wrap gap-2">
            {future.map((s) => (
              <span
                key={s.key}
                className="text-xs px-2 py-1 rounded-md bg-[--surface-muted] text-[--subtle] border border-[--border]"
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SignalRow({ signal }: { signal: ActivitySignal }) {
  const displayValue = (): string => {
    if (signal.value === null) return '—';

    // Unix timestamp → human date
    if (signal.valueUnit === 'unix_seconds' && typeof signal.value === 'number') {
      return formatTimestamp(signal.value);
    }

    // UI-C-04: JSON economic breakdown — decode and format USDC as human amount
    if (signal.valueUnit === 'json_economic_breakdown' && typeof signal.value === 'string') {
      try {
        const b = JSON.parse(signal.value) as { nativeValueWei: string; usdcErc20Raw: string };
        const parts: string[] = [];
        if (b.nativeValueWei !== '0') parts.push(`${b.nativeValueWei} native wei`);
        if (b.usdcErc20Raw !== '0') parts.push(formatRawUsdc(b.usdcErc20Raw));
        return parts.length > 0 ? parts.join(' + ') : '0';
      } catch {
        return String(signal.value);
      }
    }

    // UI-C-04: Raw USDC amount signal (usdc_raw_units)
    if (signal.valueUnit === 'usdc_raw_units' && signal.value !== null) {
      return formatRawUsdc(signal.value);
    }

    return String(signal.value);
  };

  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-[--border] last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[--ink]">{signal.label}</p>
        <p className="text-xs text-[--subtle] truncate">{signal.description}</p>
        {signal.confidenceNote && (
          <p className="text-xs text-amber-600 mt-0.5">{signal.confidenceNote}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="mono text-sm font-semibold text-[--ink]">{displayValue()}</p>
        {/* UI-C-01: human-readable status label */}
        <p className={`text-xs ${statusColor(signal.status)}`}>
          {signalStatusLabel(signal.status)}
        </p>
      </div>
    </div>
  );
}

function CredentialsCard({ credentials }: { credentials: Credential[] }) {
  const earned = credentials.filter((c) => c.status === 'active');
  const notEarned = credentials.filter((c) => c.status === 'not_earned' || c.status === 'stale');
  const insufficientData = credentials.filter((c) => c.status === 'insufficient_data');

  return (
    <div
      className="rounded-2xl p-5 border border-[--border]"
      style={{ background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-semibold text-[--muted] uppercase tracking-widest mb-1">
        System Credentials
      </h2>
      <p className="text-xs text-[--subtle] mb-4 text-pretty">
        Credentials are issued deterministically based on signal thresholds.
        They describe observable behavior; they are not endorsements.
      </p>

      {earned.length === 0 && notEarned.length === 0 && insufficientData.length === 0 && (
        <p className="text-sm text-[--muted] py-2">No credentials found for this address.</p>
      )}

      {earned.length === 0 && notEarned.length > 0 && (
        <p className="text-sm text-[--muted] py-2 mb-3">No credentials earned in this snapshot.</p>
      )}

      {earned.length > 0 && (
        <div className="space-y-3 mb-4">
          {earned.map((c) => (
            <CredentialRow key={c.typeId} credential={c} />
          ))}
        </div>
      )}

      {notEarned.length > 0 && (
        <div className={`${earned.length > 0 ? 'mt-4 pt-4 border-t border-[--border]' : ''}`}>
          <p className="text-xs font-medium text-[--subtle] mb-3">
            Evaluated — threshold not met:
          </p>
          <div className="space-y-2">
            {notEarned.map((c) => (
              <CredentialRow key={c.typeId} credential={c} />
            ))}
          </div>
        </div>
      )}

      {insufficientData.length > 0 && (
        <div className="mt-4 pt-4 border-t border-[--border]">
          <p className="text-xs font-medium text-amber-600 mb-3">
            Cannot evaluate — insufficient data:
          </p>
          <div className="space-y-2">
            {insufficientData.map((c) => (
              <CredentialRow key={c.typeId} credential={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function credentialStatusLabel(status: string): string {
  switch (status) {
    case 'active':            return 'Earned';
    case 'not_earned':        return 'Not earned';
    case 'stale':             return 'Stale';
    case 'insufficient_data': return 'Data needed';
    default:                  return 'Unknown';
  }
}

function credentialStatusPill(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
    case 'insufficient_data':
      return 'bg-amber-50 text-amber-700 border border-amber-200';
    default:
      return 'bg-[--surface-muted] text-[--subtle] border border-[--border]';
  }
}

function CredentialRow({ credential }: { credential: Credential }) {
  // UI-C-03: show observationPeriodNote on earned credentials too, not only insufficient_data
  const showObservationNote =
    credential.observationPeriodNote &&
    (credential.status === 'active' || credential.status === 'insufficient_data');

  return (
    <div className="flex items-start gap-3 py-2 border-b border-[--border] last:border-0">
      {credentialStatusIcon(credential.status)}
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-medium ${
            credential.status === 'active' ? 'text-[--ink]' : 'text-[--muted]'
          }`}
        >
          {credential.name}
        </p>
        <p className="text-xs text-[--subtle] mt-0.5">{credential.evaluationNote}</p>
        {showObservationNote && (
          <p
            className={`text-xs mt-1 text-pretty ${
              credential.status === 'insufficient_data'
                ? 'text-amber-600'
                : 'text-[--subtle]'
            }`}
          >
            {credential.observationPeriodNote}
          </p>
        )}
      </div>
      <span
        className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${credentialStatusPill(credential.status)}`}
      >
        {credentialStatusLabel(credential.status)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProfileShell
// ---------------------------------------------------------------------------

export function ProfileShell() {
  const { address } = useParams<{ address: string }>();
  const { state, fetchProfile } = useProfile();

  // UI-B-02: validate address client-side before fetching
  const isValidAddress = address ? EVM_ADDRESS_RE.test(address) : false;

  useEffect(() => {
    if (address && isValidAddress) {
      void fetchProfile(address);
    }
  }, [address, isValidAddress, fetchProfile]);

  // UI-B-02: invalid or missing address — don't call the backend
  if (!address || !isValidAddress) {
    return (
      <div className="max-w-2xl mx-auto pt-12 px-4 text-center">
        <div
          className="rounded-2xl p-8 border border-[--border] inline-flex flex-col items-center gap-4"
          style={{ background: 'var(--surface)' }}
        >
          <AlertTriangle size={32} className="text-[--danger]" />
          <div>
            <p className="text-base font-semibold text-[--ink] mb-1">Invalid wallet address</p>
            <p className="text-sm text-[--muted] max-w-xs text-pretty">
              {address
                ? `"${address}" is not a valid EVM address.`
                : 'No address was provided.'}
              {' '}A valid address starts with 0x followed by 40 hex characters.
            </p>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg bg-[--ink] text-white hover:bg-[--accent-hover] transition-colors"
          >
            <ArrowLeft size={14} />
            Back to lookup
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Back */}
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-[--muted] hover:text-[--ink] mb-6 transition-colors"
      >
        <ArrowLeft size={14} />
        Back to lookup
      </Link>

      {/* Address header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="display text-2xl font-semibold text-[--ink]"
            style={{ letterSpacing: '-0.02em' }}
          >
            Wallet Profile
          </h1>
          <p className="mono text-sm text-[--muted] mt-1 break-all">{address}</p>
        </div>

        {/* UI-C-05: refresh action — only visible in success state */}
        {state.status === 'success' && (
          <button
            onClick={() => void fetchProfile(address)}
            aria-label="Refresh profile"
            className="shrink-0 flex items-center gap-1.5 text-xs font-medium text-[--muted] hover:text-[--ink] px-3 py-2 rounded-lg border border-[--border] hover:border-[--border-strong] transition-colors"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        )}
      </div>

      {/* Loading */}
      {state.status === 'loading' && (
        <div
          className="rounded-2xl p-8 border border-[--border] text-center"
          style={{ background: 'var(--surface)' }}
        >
          <div className="w-8 h-8 border-2 border-[--ink] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-[--muted]">
            Fetching on-chain activity from Arc...
          </p>
        </div>
      )}

      {/* Error — UI-B-01: retry button */}
      {state.status === 'error' && (
        <div
          className="rounded-2xl p-6 border border-[--danger]/30 bg-red-50"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-[--danger] shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[--danger]">
                Unable to load profile
              </p>
              <p className="text-sm text-[--muted] mt-1">
                {typeof state.error === 'string'
                  ? state.error
                  : state.error.error}
              </p>
              {typeof state.error !== 'string' && state.error.detail && (
                <p className="text-xs text-[--subtle] mt-1 mono">
                  {state.error.detail}
                </p>
              )}
              <button
                onClick={() => void fetchProfile(address)}
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg bg-[--ink] text-white hover:bg-[--accent-hover] transition-colors"
              >
                <RefreshCw size={13} />
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success */}
      {state.status === 'success' && (
        <div className="space-y-5">
          {/* Disclaimer banner */}
          <div
            className="rounded-xl px-4 py-3 border border-[--border] flex items-start gap-2"
            style={{ background: 'var(--surface-muted)' }}
          >
            <Info size={14} className="text-[--muted] shrink-0 mt-0.5" />
            <p className="text-xs text-[--subtle] text-pretty">
              This profile reports observable on-chain activity within the
              data snapshot. It does not assess trustworthiness, rank wallets,
              or make eligibility decisions. Signal values are measurements,
              not judgments.
            </p>
          </div>

          <ActivityCard summary={state.profile.activitySummary} />
          <SignalsCard signals={state.profile.signals} />
          <CredentialsCard credentials={state.profile.credentials} />

          {/* Footer meta */}
          <p className="text-xs text-[--subtle] text-center pt-2">
            Profile built at {new Date(state.profile.profileBuiltAt).toLocaleString()} ·
            Schema {state.profile.schemaVersion} · Chain ID {state.profile.chainId}
          </p>
        </div>
      )}
    </div>
  );
}
