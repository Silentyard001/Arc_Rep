/**
 * src/hooks/useProfile.ts
 *
 * Fetches an Arc Rep WalletProfile from the server API.
 * No direct blockchain calls — all data flows through the API.
 */

import { useState, useCallback } from 'react';
import type { WalletProfile, ApiError } from '../types/api.js';

type ProfileState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; profile: WalletProfile }
  | { status: 'error'; error: ApiError | string };

export function useProfile() {
  const [state, setState] = useState<ProfileState>({ status: 'idle' });

  const fetchProfile = useCallback(async (address: string) => {
    setState({ status: 'loading' });
    try {
      const res = await fetch(`/api/profile/${address}`);
      const data = (await res.json()) as unknown;

      if (!res.ok) {
        setState({
          status: 'error',
          error: data as ApiError,
        });
        return;
      }

      setState({ status: 'success', profile: data as WalletProfile });

    } catch {
      setState({
        status: 'error',
        error: 'Network error: could not reach the Arc Rep API.',
      });
    }
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { state, fetchProfile, reset };
}
