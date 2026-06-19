'use client';

/**
 * The flame page's first-run experience: name your dæmon, then watch it being
 * summoned. Lives in the lower third so Ignis stays visible above the whole time.
 * Presentational only — the provisioning state machine is useOnboarding; this
 * reuses the same shared handle validation the server enforces.
 */
import { useState } from 'react';
import {
  validateHandle,
  normalizeHandle,
  HANDLE_ERROR_MESSAGE,
} from '@/app/lib/handle-format';
import type { OnboardingStatus } from '@/app/lib/useOnboarding';

export function Onboarding({
  status,
  error,
  reservedHandle,
  activeHandle,
  smartAccount,
  onClaim,
  onConfirmFunded,
  onRetry,
}: {
  status: OnboardingStatus;
  error: string | null;
  reservedHandle: string | null;
  activeHandle: string | null;
  smartAccount: string | null;
  onClaim: (handle: string) => void;
  onConfirmFunded: () => void;
  onRetry: () => void;
}) {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  // ready is handled by the page (it shows the mic instead); nothing to draw here.
  if (status === 'ready') return null;

  // First-run funding: show the smart-account address to top up before transacting. Your dæmon's
  // funds + gas live here (self-funded), so it needs a little Base ETH (+ USDC) before it can act.
  if (status === 'needs-funding') {
    const addr = smartAccount ?? '';
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(addr);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* clipboard blocked — the address is shown for manual copy */
      }
    };
    return (
      <div className="flex w-full max-w-[21rem] flex-col items-center gap-4 text-center">
        <div className="flex flex-col items-center gap-1">
          <h2 className="text-[17px] font-semibold text-white/90">Fund your dæmon</h2>
          <p className="text-[13px] text-white/45">
            Your dæmon holds its own funds + gas. Send a little{' '}
            <span className="text-white/70">Base ETH</span> (and USDC to spend) to its smart account,
            then enter.
          </p>
        </div>

        <button
          type="button"
          onClick={copy}
          aria-label="Copy smart account address"
          className="w-full break-all rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 font-mono text-[12px] text-white/80 transition active:scale-[0.99]"
        >
          {addr || '…'}
          <span className="mt-1 block text-[10px] uppercase tracking-wide text-white/35">
            {copied ? 'copied' : 'tap to copy · Base'}
          </span>
        </button>

        <button
          type="button"
          onClick={onConfirmFunded}
          className="rounded-full px-7 py-3 text-sm font-semibold text-black transition active:scale-95"
          style={{
            background: 'var(--state, #ff7a18)',
            boxShadow: '0 0 30px color-mix(in srgb, var(--state, #ff7a18) 40%, transparent)',
          }}
        >
          Account funded — enter
        </button>
        <p className="text-[11px] text-white/30">
          You can fund it later too — actions will just wait until it has gas.
        </p>
      </div>
    );
  }

  // A quiet beat while we look up whether they already have a dæmon.
  if (status === 'checking') {
    return <p className="text-[13px] text-white/40">Stirring…</p>;
  }

  // Provisioning in flight — several Ethereum txs, ~30s. The flame goes "thinking".
  if (status === 'summoning') {
    return (
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-[15px] font-medium text-white/80">Summoning Ignis…</p>
        <p className="text-[12px] text-white/40">
          {activeHandle ? `${activeHandle}.daemonium.eth · ` : ''}
          minting on Ethereum (~30s)
        </p>
      </div>
    );
  }

  // A non-recoverable check error (no reserved handle) — just offer a re-check.
  if (status === 'error' && !reservedHandle) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-[13px] text-red-400/80">
          {error ?? "Couldn't reach your dæmon."}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/70 transition active:scale-95"
        >
          Try again
        </button>
      </div>
    );
  }

  // needs-handle, or a reserved-handle mint retry: the picker.
  const locked = reservedHandle !== null;
  const normalized = reservedHandle ?? normalizeHandle(text);
  const clientError = locked ? null : validateHandle(normalized);
  const canSubmit = locked || (text.length > 0 && clientError === null);

  const submit = () => {
    if (!canSubmit) return;
    if (locked) onRetry();
    else onClaim(normalized);
  };

  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      <div className="flex flex-col items-center gap-1">
        <h2 className="text-[17px] font-semibold text-white/90">Name your dæmon</h2>
        <p className="text-[13px] text-white/45">
          Your Ignis will live at{' '}
          <span className="font-mono text-white/70">
            {normalized || '<name>'}.daemonium.eth
          </span>
        </p>
      </div>

      <div
        className="flex w-full max-w-[19rem] items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2.5 font-mono text-sm"
        style={{
          boxShadow:
            '0 0 24px color-mix(in srgb, var(--state, #ff7a18) 12%, transparent)',
        }}
      >
        <input
          autoFocus
          value={reservedHandle ?? text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="name"
          disabled={locked}
          aria-label="dæmon handle"
          className="min-w-0 flex-1 bg-transparent text-center placeholder:text-white/30 focus:outline-none disabled:opacity-70"
          style={{ color: 'var(--state, #ff7a18)' }}
        />
        <span className="text-white/35">.daemonium.eth</span>
      </div>

      {error ? (
        <p className="text-[12px] text-red-400/80">{error}</p>
      ) : text && clientError ? (
        <p className="text-[12px] text-white/40">{HANDLE_ERROR_MESSAGE[clientError]}</p>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="rounded-full px-7 py-3 text-sm font-semibold text-black transition active:scale-95 disabled:opacity-40"
        style={{
          background: 'var(--state, #ff7a18)',
          boxShadow:
            '0 0 30px color-mix(in srgb, var(--state, #ff7a18) 40%, transparent)',
        }}
      >
        {locked ? 'Try again' : 'Summon'}
      </button>
    </div>
  );
}
