/**
 * src/components/WalletLookup.tsx
 *
 * Address input + wagmi wallet connect entry point.
 * Validates the address format before submitting to the API.
 * No direct blockchain reads — lookup triggers a server-side API call.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { ConnectKitButton } from 'connectkit';
import { Search, AlertCircle } from 'lucide-react';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function WalletLookup() {
  const [input, setInput] = useState('');
  const [validationError, setValidationError] = useState('');
  const navigate = useNavigate();
  const { address: connectedAddress } = useAccount();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!EVM_ADDRESS_RE.test(trimmed)) {
      setValidationError(
        'Enter a valid EVM address (0x followed by 40 hex characters).',
      );
      return;
    }
    setValidationError('');
    void navigate(`/profile/${trimmed.toLowerCase()}`);
  }

  function useConnectedWallet() {
    if (connectedAddress) {
      void navigate(`/profile/${connectedAddress.toLowerCase()}`);
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Hero */}
      <div className="text-center mb-10">
        <h1
          className="display text-4xl sm:text-5xl font-semibold text-[--ink] mb-3"
          style={{ letterSpacing: '-0.03em' }}
        >
          Arc Rep
        </h1>
        <p className="text-[--muted] text-base max-w-md mx-auto text-pretty">
          Wallet reputation and verification infrastructure for the Arc ecosystem.
          Based on verifiable on-chain evidence.
        </p>
      </div>

      {/* Search card */}
      <div
        className="rounded-2xl p-6 border border-[--border]"
        style={{ background: 'var(--surface)' }}
      >
        <p className="text-xs font-semibold text-[--muted] uppercase tracking-widest mb-3">
          Look up a wallet
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (validationError) setValidationError('');
              }}
              placeholder="0x..."
              spellCheck={false}
              className={`w-full mono text-sm px-4 py-3 pr-12 rounded-xl border outline-none transition-colors
                bg-[--surface-muted] text-[--ink] placeholder:text-[--subtle]
                focus:border-[--border-strong] focus:bg-white
                ${validationError ? 'border-[--danger]' : 'border-[--border]'}`}
            />
            <button
              type="submit"
              aria-label="Look up wallet"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-lg bg-[--ink] text-white hover:bg-[--accent-hover] transition-colors"
            >
              <Search size={14} strokeWidth={2.5} />
            </button>
          </div>

          {validationError && (
            <div className="flex items-center gap-2 text-[--danger] text-sm">
              <AlertCircle size={14} />
              <span>{validationError}</span>
            </div>
          )}
        </form>

        {/* Wallet connect shortcut */}
        <div className="mt-5 pt-5 border-t border-[--border]">
          <p className="text-xs text-[--muted] mb-3">Or look up your connected wallet:</p>
          <div className="flex items-center gap-3">
            <ConnectKitButton />
            {connectedAddress && (
              <button
                onClick={useConnectedWallet}
                className="text-sm font-medium px-4 py-2 rounded-lg border border-[--border] text-[--ink-2] hover:border-[--border-strong] hover:text-[--ink] transition-colors"
              >
                View my profile
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="text-center text-xs text-[--subtle] mt-6 px-4 text-pretty">
        Arc Rep reports observable on-chain activity only. It does not assess
        trustworthiness, rank wallets, or make eligibility decisions.
      </p>
    </div>
  );
}
