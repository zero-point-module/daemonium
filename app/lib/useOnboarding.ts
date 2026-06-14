'use client';

/**
 * First-run onboarding for the flame page: does the signed-in user have a fully
 * provisioned dæmon yet? Wraps the same /api/daemon/handle contract the dev
 * console's HandleGate uses — GET to check, POST to claim a handle (which
 * auto-provisions ENS + ERC-8004, several Sepolia txs). The component layer
 * (components/Onboarding) renders this in the flame's visual language.
 *
 * Self-heals like the console: a handle that exists but didn't finish minting is
 * re-POSTed idempotently. A mint that reserves the handle but then hiccups (500)
 * locks to that handle so only a retry of the SAME name can finish it.
 */
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from './daemon-client';

export type OnboardingStatus =
  | 'checking'
  | 'needs-handle'
  | 'summoning'
  | 'ready'
  | 'error';

export interface Onboarding {
  status: OnboardingStatus;
  /** The real ENS name once provisioned (ignis.<handle>.daemonium.eth), else null. */
  ensName: string | null;
  error: string | null;
  /** Set after a mint hiccup reserves a handle to this user — a retry must reuse it. */
  reservedHandle: string | null;
  /** The handle currently being minted (for the "summoning …" line). */
  activeHandle: string | null;
  /** Claim a (client-validated, normalized) handle and provision the dæmon. */
  claim: (handle: string) => void;
  /** Re-run the current step — re-check, or re-mint a reserved handle. */
  retry: () => void;
}

const HANDLE_URL = '/api/daemon/handle';

export function useOnboarding(enabled: boolean): Onboarding {
  const [status, setStatus] = useState<OnboardingStatus>('checking');
  const [ensName, setEnsName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reservedHandle, setReservedHandle] = useState<string | null>(null);
  // The handle to mint. Set → triggers the POST effect; cleared when it settles,
  // so re-submitting the SAME handle (a retry) still re-fires the effect.
  const [pendingHandle, setPendingHandle] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 1. Check whether this user already has a (fully provisioned) dæmon.
  useEffect(() => {
    if (!enabled) {
      setStatus('checking');
      setEnsName(null);
      setError(null);
      setReservedHandle(null);
      setPendingHandle(null);
      return;
    }
    let cancelled = false;
    setStatus('checking');
    setError(null);
    (async () => {
      try {
        const res = await fetch(HANDLE_URL, { headers: authHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (cancelled) return;
        if (!data.handle) {
          setStatus('needs-handle');
        } else if (data.identityComplete) {
          setEnsName(data.ensName);
          setStatus('ready');
        } else {
          // Handle exists but minting never finished — finish it idempotently.
          setPendingHandle(data.handle);
        }
      } catch {
        if (!cancelled) {
          setError("Couldn't reach your dæmon.");
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  // 2. Mint: claim + provision (or finish provisioning) the pending handle.
  useEffect(() => {
    if (!pendingHandle) return;
    let cancelled = false;
    setStatus('summoning');
    setError(null);
    (async () => {
      try {
        const res = await fetch(HANDLE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ handle: pendingHandle }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.ensName) {
          setEnsName(data.ensName);
          setReservedHandle(null);
          setStatus('ready');
        } else if (res.status === 500 && data.handle) {
          // Reserved to this user, but minting snagged — lock + offer a retry.
          setReservedHandle(data.handle);
          setError('Your name is reserved, but summoning hit a snag. Try again to finish.');
          setStatus('error');
        } else {
          // 409 taken/reserved or 400 invalid — let them choose another name.
          setError(data.error ?? 'Could not claim that name.');
          setStatus('needs-handle');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      } finally {
        if (!cancelled) setPendingHandle(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingHandle]);

  const claim = useCallback((handle: string) => {
    setError(null);
    setPendingHandle(handle);
  }, []);

  const retry = useCallback(() => {
    if (reservedHandle) setPendingHandle(reservedHandle);
    else setReloadKey((k) => k + 1);
  }, [reservedHandle]);

  return {
    status,
    ensName,
    error,
    reservedHandle,
    activeHandle: pendingHandle ?? reservedHandle,
    claim,
    retry,
  };
}
