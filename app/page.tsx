'use client';

import { useEffect, useRef } from 'react';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { Flame } from '@/components/Flame';
import { IdentityBadge } from '@/components/IdentityBadge';
import { StatusPill } from '@/components/StatusPill';
import { MicButton } from '@/components/MicButton';
import { QuickActions } from '@/components/QuickActions';
import { ConfirmCard } from '@/components/ConfirmCard';
import { STATE_META } from '@/lib/stateMeta';
import { useFlameDaemon } from './lib/useFlameDaemon';
import { explorerTx } from './lib/chain';

export default function Home() {
  const d = useFlameDaemon();
  const { user, setShowAuthFlow } = useDynamicContext();
  const shellRef = useRef<HTMLDivElement>(null);
  const signedIn = !!user;

  // Publish the live state color to CSS. Every glow reads var(--state); because
  // --state is a registered @property <color>, the whole room cross-fades.
  useEffect(() => {
    shellRef.current?.style.setProperty('--state', STATE_META[d.state].color);
  }, [d.state]);

  return (
    <main
      ref={shellRef}
      className="relative mx-auto flex h-[100dvh] w-full max-w-md flex-col items-center overflow-hidden px-6 pt-[env(safe-area-inset-top)]"
      style={{ transition: '--state 600ms ease' }}
    >
      {/* ambient room glow the whole UI picks up, tinted by the state color */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20"
        style={{
          background:
            'radial-gradient(120% 78% at 50% 20%, color-mix(in srgb, var(--state, #ff7a18) 13%, transparent), transparent 60%)',
        }}
      />

      {/* upper third — flame, identity, status */}
      <section className="flex flex-1 flex-col items-center justify-center gap-6">
        <Flame state={d.state} />
        <div className="flex flex-col items-center gap-3">
          <IdentityBadge />
          <StatusPill state={d.state} label={d.label} />
        </div>
      </section>

      {/* middle — the confirm gate, else what Ignis says, plus the last tx result */}
      <div className="flex w-full flex-col items-center gap-2 px-2">
        {d.proposal ? (
          <ConfirmCard
            proposal={d.proposal}
            busy={d.busy}
            onConfirm={d.confirm}
            onDismiss={d.dismissProposal}
          />
        ) : (
          <div className="flex min-h-[2.75rem] items-center text-center">
            {d.caption ? (
              <p className="text-pretty text-[15px] leading-snug text-white/75">
                {d.caption}
              </p>
            ) : null}
          </div>
        )}

        {d.txResult ? <TxLine result={d.txResult} /> : null}
      </div>

      {/* lower third — mic + quick actions once signed in, else the summon gate */}
      <section className="flex flex-col items-center gap-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {signedIn ? (
          <>
            <MicButton open={d.micOpen} busy={d.busy} onToggle={d.toggleMic} />
            <QuickActions busy={d.busy} onPick={d.run} />
          </>
        ) : (
          <SummonGate onSummon={() => setShowAuthFlow(true)} />
        )}
      </section>
    </main>
  );
}

/** The logged-out call to action — wake your own Ignis (provisions the wallet). */
function SummonGate({ onSummon }: { onSummon: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <button
        type="button"
        onClick={onSummon}
        className="rounded-full px-7 py-3 text-sm font-semibold text-black transition active:scale-95"
        style={{
          background: 'var(--state, #ff7a18)',
          boxShadow: '0 0 30px color-mix(in srgb, var(--state, #ff7a18) 40%, transparent)',
        }}
      >
        Summon Ignis
      </button>
      <p className="text-[13px] text-white/45">
        Sign in to wake your dæmon and its wallet.
      </p>
    </div>
  );
}

/** Last confirmed action's outcome — a tappable tx link, or the error. */
function TxLine({
  result,
}: {
  result: { ok: boolean; hash?: string; error?: string };
}) {
  if (result.ok && result.hash) {
    return (
      <a
        href={explorerTx(result.hash)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[12px] text-emerald-400/90 hover:underline"
      >
        ✓ transaction confirmed — view on Etherscan
      </a>
    );
  }
  return (
    <span className="text-[12px] text-red-400/90">
      ✗ {result.error ?? 'the action failed'}
    </span>
  );
}
