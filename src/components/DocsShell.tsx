/**
 * src/components/DocsShell.tsx
 * Placeholder API documentation page.
 */

import { Terminal, Lock, ArrowRight } from 'lucide-react';

interface Endpoint {
  method: string;
  path: string;
  description: string;
  status: 'available' | 'stub';
}

const endpoints: Endpoint[] = [
  {
    method: 'GET',
    path: '/api/health',
    description: 'Service health check.',
    status: 'available',
  },
  {
    method: 'GET',
    path: '/api/profile/:address',
    description:
      'Full WalletProfile: activity summary, signals, and credentials.',
    status: 'available',
  },
  {
    method: 'GET',
    path: '/api/signals/:address',
    description: 'Behavioral signals only for a wallet address.',
    status: 'available',
  },
  {
    method: 'GET',
    path: '/api/credentials/:address',
    description: 'System-derived credentials for a wallet address.',
    status: 'available',
  },
  {
    method: 'POST',
    path: '/api/verify',
    description:
      'Verify whether a wallet satisfies a registered eligibility rule. Not implemented yet.',
    status: 'stub',
  },
];

export function DocsShell() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1
          className="display text-3xl font-semibold text-[--ink] mb-2"
          style={{ letterSpacing: '-0.02em' }}
        >
          API Reference
        </h1>
        <p className="text-[--muted] text-sm text-pretty max-w-lg">
          Arc Rep exposes a read-oriented JSON API for querying wallet
          activity, signals, and credentials. Verification endpoints are
          planned for Phase 2.
        </p>
      </div>

      {/* Endpoints */}
      <div
        className="rounded-2xl border border-[--border] overflow-hidden mb-8"
        style={{ background: 'var(--surface)' }}
      >
        <div className="px-5 py-4 border-b border-[--border]">
          <h2 className="text-xs font-semibold text-[--muted] uppercase tracking-widest">
            Endpoints
          </h2>
        </div>
        <div className="divide-y divide-[--border]">
          {endpoints.map((ep) => (
            <div key={ep.path} className="flex items-start gap-4 px-5 py-4">
              <span
                className={`mono text-xs font-semibold px-2 py-1 rounded shrink-0 ${
                  ep.method === 'GET'
                    ? 'bg-sky-50 text-sky-700'
                    : 'bg-purple-50 text-purple-700'
                }`}
              >
                {ep.method}
              </span>
              <div className="flex-1 min-w-0">
                <p className="mono text-sm text-[--ink]">{ep.path}</p>
                <p className="text-xs text-[--muted] mt-0.5">{ep.description}</p>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                  ep.status === 'available'
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-[--surface-muted] text-[--subtle] border border-[--border]'
                }`}
              >
                {ep.status === 'available' ? 'Available' : 'Planned'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Phase 2 callout */}
      <div
        className="rounded-2xl p-5 border border-[--border]"
        style={{ background: 'var(--surface)' }}
      >
        <div className="flex items-start gap-3 mb-4">
          <Lock size={16} className="text-[--muted] shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-[--ink]">
              Verification API (Phase 2)
            </h3>
            <p className="text-xs text-[--muted] mt-0.5 text-pretty">
              In Phase 2, projects will be able to register eligibility rules
              and query whether a wallet satisfies them — without necessarily
              receiving the wallet's full activity history.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 pl-7">
          {[
            'Project-registered VerificationRules',
            'Deterministic eligibility evaluation',
            'Selective disclosure (longer-term)',
          ].map((item) => (
            <div key={item} className="flex items-center gap-2 text-xs text-[--subtle]">
              <ArrowRight size={12} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Design principles */}
      <div
        className="rounded-2xl p-5 border border-[--border] mt-5"
        style={{ background: 'var(--surface)' }}
      >
        <div className="flex items-start gap-3 mb-4">
          <Terminal size={16} className="text-[--muted] shrink-0 mt-0.5" />
          <h3 className="text-sm font-semibold text-[--ink]">Design Principles</h3>
        </div>
        <ul className="space-y-2 pl-7">
          {[
            'A wallet is not necessarily a person.',
            'Observable activity is never automatically treated as proof of trustworthiness.',
            'Raw transaction count is never a standalone reputation score.',
            'Every derived signal carries its source, formula, and confidence.',
            'The system does not produce a composite reputation score.',
          ].map((p) => (
            <li key={p} className="text-xs text-[--subtle] flex gap-2">
              <ArrowRight size={12} className="shrink-0 mt-0.5" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
