'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Flame } from '@/components/Flame';
import { IdentityBadge } from '@/components/IdentityBadge';
import { StatusPill } from '@/components/StatusPill';
import { MicButton } from '@/components/MicButton';
import { QuickActions } from '@/components/QuickActions';
import { ConfirmCard } from '@/components/ConfirmCard';
import { STATE_META } from '@/lib/stateMeta';
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";

import { useFlameDaemon } from './lib/useFlameDaemon';
import { useTts } from './lib/useTts';
import { useMic } from './lib/useMic';
import { useSpeakOnNewLine } from './lib/useSpeakOnNewLine';
import { explorerTx } from './lib/chain';


export default function Home() {
  const d = useFlameDaemon();
  const { user, setShowAuthFlow } = useDynamicContext();
  const tts = useTts();
  const mic = useMic({ onTranscript: d.run, isSpeaking: tts.isSpeaking });

  // Speak each finished assistant line aloud (once it's final, not the partial stream).
  useSpeakOnNewLine(d.caption, d.busy, tts.speak);

  const shellRef = useRef<HTMLDivElement>(null);
  const signedIn = !!user;

  // The real mic drives the `listening` overlay on an otherwise-idle flame.
  const flameState =
    mic.recording && d.state === 'idle' ? 'listening' : d.state;

  // Publish the live state color to CSS. Every glow reads var(--state); because
  // --state is a registered @property <color>, the whole room cross-fades.
  useEffect(() => {
    shellRef.current?.style.setProperty('--state', STATE_META[flameState].color);
  }, [flameState]);

  // Every tap is a chance to arm the iOS AudioContext (must happen in a gesture).
  const handleMic = useCallback(() => {
    tts.unlock();
    mic.toggle();
  }, [tts.unlock, mic.toggle]);

  const handlePick = useCallback(
    (text: string) => {
      tts.unlock();
      d.run(text);
    },
    [tts.unlock, d.run],
  );

  const handleSummon = useCallback(() => {
    tts.unlock();
    setShowAuthFlow(true);
  }, [tts.unlock, setShowAuthFlow]);

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
        <Flame state={flameState} getAmplitude={tts.getAmplitude} />
        <div className="flex flex-col items-center gap-3">
          <IdentityBadge />
          <StatusPill state={flameState} label={d.label} />
        </div>
      </section>

      {/* middle — the confirm gate, else what Ignis says, plus tx + mic errors */}
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
        {mic.error ? (
          <span className="text-[12px] text-red-400/80">{mic.error}</span>
        ) : null}
      </div>

      {/* lower third — mic + quick actions once signed in, else the summon gate */}
      <section className="flex flex-col items-center gap-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {signedIn ? (
          <>
            <MicButton
              open={mic.recording}
              busy={d.busy || mic.transcribing}
              onToggle={handleMic}
            />
            <QuickActions busy={d.busy} onPick={handlePick} />
          </>
        ) : (
          <SummonGate onSummon={handleSummon} />
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
