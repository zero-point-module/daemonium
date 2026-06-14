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
  onClaim,
  onRetry,
}: {
  status: OnboardingStatus;
  error: string | null;
  reservedHandle: string | null;
  activeHandle: string | null;
  onClaim: (handle: string) => void;
  onRetry: () => void;
}) {
  const [text, setText] = useState('');

  // ready is handled by the page (it shows the mic instead); nothing to draw here.
  if (status === 'ready') return null;

  // A quiet beat while we look up whether they already have a dæmon.
  if (status === 'checking') {
    return <p className="text-[13px] text-white/40">Stirring…</p>;
  }

  // Provisioning in flight — several Sepolia txs, ~30s. The flame goes "thinking".
  if (status === 'summoning') {
    return (
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-[15px] font-medium text-white/80">Summoning Ignis…</p>
        <p className="text-[12px] text-white/40">
          {activeHandle ? `ignis.${activeHandle}.daemonium.eth · ` : ''}
          minting on Sepolia (~30s)
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
            ignis.{normalized || '<name>'}.daemonium.eth
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
        <span className="text-white/35">ignis.</span>
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
