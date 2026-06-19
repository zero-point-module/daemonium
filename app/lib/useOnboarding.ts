'use client';

/**
 * First-run onboarding for the flame page: does the signed-in user have a fully
 * provisioned dæmon yet? Wraps the same /api/daemon/handle contract the dev
 * console's HandleGate uses — GET to check, POST to claim a handle (which
 * auto-provisions ENS + ERC-8004, several Ethereum txs). The component layer
 * (components/Onboarding) renders this in the flame's visual language.
 *
 * Self-heals like the console: a handle that exists but didn't finish minting is
 * re-POSTed idempotently. A mint that reserves the handle but then hiccups (500)
 * locks to that handle so only a retry of the SAME name can finish it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import { authHeaders } from './daemon-client';
import { coSignAndSubmit, type ConnectedWalletClient } from './smart-account-client';

const IDENTITY_URL = '/api/daemon/identity';

/**
 * Register + hold the ERC-8004 identity on the user's SMART ACCOUNT via a co-signed L1 UserOp:
 * fetch the calls the server built, co-sign them with the embedded wallet, then post the tx hash so
 * the server records the agentId. Best-effort — the agent wallet needs no gas; the SA pays (seeded
 * on L1 at provision). No-op if already held, no wallet, or no mainnet bundler.
 */
async function completeIdentity(walletClient: ConnectedWalletClient | undefined): Promise<void> {
  if (!walletClient) return;
  const res = await fetch(IDENTITY_URL, { headers: authHeaders() }).then((r) => r.json());
  if (!res?.needed || !Array.isArray(res.calls) || res.calls.length === 0) return;
  const calls = (res.calls as { to: string; data: string; value: string }[]).map((c) => ({
    to: c.to as Address,
    data: c.data as Hex,
    value: BigInt(c.value),
  }));
  const hash = await coSignAndSubmit({ walletClient, calls, chainId: res.chainId });
  await fetch(IDENTITY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ hash }),
  });
}

export type OnboardingStatus =
  | 'checking'
  | 'needs-handle'
  | 'summoning'
  | 'needs-funding'
  | 'ready'
  | 'error';

export interface Onboarding {
  status: OnboardingStatus;
  /** The real ENS name once provisioned (<handle>.daemonium.eth), else null. */
  ensName: string | null;
  /** The user's smart-account address — where they fund ETH/USDC before transacting. */
  smartAccount: string | null;
  error: string | null;
  /** Set after a mint hiccup reserves a handle to this user — a retry must reuse it. */
  reservedHandle: string | null;
  /** The handle currently being minted (for the "summoning …" line). */
  activeHandle: string | null;
  /** Claim a (client-validated, normalized) handle and provision the dæmon. */
  claim: (handle: string) => void;
  /** Confirm the smart account is funded — proceed from the funding step to ready. */
  confirmFunded: () => void;
  /** Re-run the current step — re-check, or re-mint a reserved handle. */
  retry: () => void;
}

const HANDLE_URL = '/api/daemon/handle';

export function useOnboarding(enabled: boolean): Onboarding {
  // The user's embedded-wallet EOA — the sudo owner of the Kernel smart account we provision. Sent
  // at claim so the server can derive the deterministic SA address and set it as the on-chain owner.
  const { primaryWallet } = useDynamicContext();
  const ownerEoa = primaryWallet?.address ?? null;
  const { data: walletClient } = useWalletClient();
  const [status, setStatus] = useState<OnboardingStatus>('checking');
  const [ensName, setEnsName] = useState<string | null>(null);
  const [smartAccount, setSmartAccount] = useState<string | null>(null);
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
        } else if (data.smartAccount) {
          // Returning user — smart account already bound → straight to ready (no funding nag).
          // (ERC-8004 identity may still be completing in the background; not needed to co-sign.)
          setEnsName(data.ensName);
          setSmartAccount(data.smartAccount);
          setStatus('ready');
        } else {
          // Handle exists but no smart account yet — a legacy or half-provisioned account.
          // Re-POST idempotently (with ownerEoa) to bind the SA and finish setup.
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

  // 2. Mint: claim + provision (or finish provisioning) the pending handle. Wait for the embedded
  //    wallet address (the SA owner) before POSTing — the server requires it to derive the SA.
  useEffect(() => {
    if (!pendingHandle) return;
    if (!ownerEoa) {
      setStatus('summoning'); // waiting on the embedded wallet; re-fires when ownerEoa arrives
      return;
    }
    let cancelled = false;
    setStatus('summoning');
    setError(null);
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      // Right after sign-up the Dynamic session is briefly `userDataForm`-scoped, so the server's
      // wallet keygen 401s (a 500 here) until it upgrades — that's the "fails on a new account,
      // works after a refresh" window. Retry a few times with a fresh auth token (authHeaders()
      // re-reads it each call), which auto-recovers without the user reloading. Non-transient
      // outcomes (taken/invalid handle, a persistent mint snag) fall through immediately.
      const MAX_ATTEMPTS = 4;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let res: Response;
        let data: { smartAccount?: string; ensName?: string; handle?: string; error?: string };
        try {
          res = await fetch(HANDLE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ handle: pendingHandle, ownerEoa }),
          });
          data = await res.json().catch(() => ({}));
        } catch (err) {
          if (cancelled) return;
          if (attempt < MAX_ATTEMPTS) {
            await delay(1800);
            continue;
          }
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
          setPendingHandle(null);
          return;
        }
        if (cancelled) return;

        if (res.ok && data.smartAccount) {
          // Freshly provisioned — pause on the funding step so the first-time user can top up
          // their smart account before doing anything that needs ETH.
          setEnsName(data.ensName ?? null);
          setSmartAccount(data.smartAccount);
          setReservedHandle(null);
          setStatus('needs-funding');
          setPendingHandle(null);
          return;
        }
        if (res.status === 500 && attempt < MAX_ATTEMPTS) {
          // Likely the transient session-upgrade window — wait and retry with a fresh token.
          await delay(1800);
          continue;
        }
        if (res.status === 500 && data.handle) {
          // Reserved to this user, but minting still snags after retries — lock + offer a retry.
          setReservedHandle(data.handle);
          setError('Your name is reserved, but summoning hit a snag. Try again to finish.');
          setStatus('error');
        } else {
          // 409 taken/reserved or 400 invalid — let them choose another name.
          setError(data.error ?? 'Could not claim that name.');
          setStatus('needs-handle');
        }
        setPendingHandle(null);
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingHandle, ownerEoa]);

  const claim = useCallback((handle: string) => {
    setError(null);
    setPendingHandle(handle);
  }, []);

  // The user confirmed funding → a natural moment to co-sign the SA's identity UserOp (the SA now
  // has gas). Best-effort: register ERC-8004 to the SA, then enter. Never blocks — if the user
  // rejects the signature or there's no mainnet bundler, identity stays deferred and value still works.
  const confirmFunded = useCallback(async () => {
    setStatus('summoning'); // brief: signing the identity UserOp
    try {
      await completeIdentity(walletClient as ConnectedWalletClient | undefined);
    } catch {
      /* identity deferred — retryable; doesn't block using the dæmon */
    }
    setStatus('ready');
  }, [walletClient]);

  const retry = useCallback(() => {
    if (reservedHandle) setPendingHandle(reservedHandle);
    else setReloadKey((k) => k + 1);
  }, [reservedHandle]);

  return {
    status,
    ensName,
    smartAccount,
    error,
    reservedHandle,
    activeHandle: pendingHandle ?? reservedHandle,
    claim,
    confirmFunded,
    retry,
  };
}
