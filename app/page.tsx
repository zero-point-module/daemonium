'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Flame } from '@/components/Flame';
import { ENSHeaderPill } from '@/components/ENSHeaderPill';
import { ChatThread } from '@/components/ChatThread';
import { LiquidSigil } from '@/components/LiquidSigil';
import { IdentityPanel } from '@/components/IdentityPanel';
import { ConfirmCard } from '@/components/ConfirmCard';
import { Onboarding } from '@/components/Onboarding';
import { VoicePicker } from '@/components/VoicePicker';
import { STATE_META } from '@/lib/stateMeta';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';

import { useFlameDaemon, type ChatMessage } from './lib/useFlameDaemon';
import { useVoice } from './lib/useVoice';
import { useMic } from './lib/useMic';
import { useOnboarding } from './lib/useOnboarding';
import { useProactiveWatch } from './lib/useProactiveWatch';
import { DEFAULT_VOICE_ID } from './lib/voices';
import { explorerTx } from './lib/chain';

export default function Home() {
  const d = useFlameDaemon();
  const { user, setShowAuthFlow } = useDynamicContext();

  // Selected character voice (persisted), fed to the voice pipeline.
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  useEffect(() => {
    const saved = localStorage.getItem('ignis.voice');
    if (saved) setVoiceId(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem('ignis.voice', voiceId);
  }, [voiceId]);

  // Voice owns both the speech and the synced caption: it segments Ignis's streaming line into
  // sentences, speaks each as it's ready, and reveals the caption in lockstep with the audio.
  const voice = useVoice({ text: d.caption, busy: d.busy, voice: voiceId });
  const mic = useMic({ onTranscript: d.run, isSpeaking: voice.isSpeaking });

  const shellRef = useRef<HTMLDivElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const signedIn = !!user;

  // First-run gate: does this user have a fully provisioned dæmon yet?
  const onb = useOnboarding(signedIn);
  const ready = signedIn && onb.status === 'ready';

  // Once provisioned, Ignis watches its wallet and speaks up on its own when funds
  // arrive — held back while a turn, the mic, speech, or a proposal is in flight.
  useProactiveWatch({
    enabled: ready,
    paused: d.busy || mic.recording || voice.isSpeaking || !!d.proposal,
    run: d.run,
  });

  // The flame leads onboarding (it "thinks" while minting); the real mic drives the
  // `listening` overlay on an otherwise-idle flame.
  const flameState =
    onb.status === 'summoning'
      ? 'thinking'
      : mic.recording && d.state === 'idle'
        ? 'listening'
        : d.state;

  // Publish the live state color to CSS. Every glow reads var(--state); because
  // --state is a registered @property <color>, the whole room cross-fades.
  useEffect(() => {
    shellRef.current?.style.setProperty('--state', STATE_META[flameState].color);
  }, [flameState]);

  // The chat thread shows the conversation; while Ignis is speaking, the last line is revealed
  // in sync with the voice (voice.caption) instead of dumping the whole reply at once — and is
  // held back until the first sentence is voiced, so the text never runs ahead of the audio.
  const messages = useMemo<ChatMessage[]>(() => {
    const last = d.messages[d.messages.length - 1];
    if (!last || last.role !== 'ignis') return d.messages;
    // Only gate the last bubble on the synced caption when it IS the turn being voiced.
    // d.caption is the in-flight assistant line — null when the latest turn is a user or
    // internal message (e.g. a proactive nudge, whose user turn is filtered out), so a prior
    // reply stays on screen instead of blinking out during the pre-audio gap.
    const inFlight = !!d.caption;
    if (inFlight && (d.busy || voice.isSpeaking)) {
      const head = d.messages.slice(0, -1);
      return voice.caption ? [...head, { ...last, text: voice.caption }] : head;
    }
    return d.messages;
  }, [d.messages, d.caption, voice.caption, d.busy, voice.isSpeaking]);

  const handleTap = useCallback(() => {
    voice.unlock();
    mic.toggle();
  }, [voice.unlock, mic.toggle]);

  const handleSubmit = useCallback(
    (text: string) => {
      voice.unlock();
      d.run(text);
    },
    [voice.unlock, d.run],
  );

  const handleSummon = useCallback(() => {
    voice.unlock();
    setShowAuthFlow(true);
  }, [voice.unlock, setShowAuthFlow]);

  const showConfirmZone = !!d.proposal || !!d.txResult || !!mic.error;

  return (
    <main
      ref={shellRef}
      className="relative mx-auto flex h-[100dvh] w-full max-w-[420px] flex-col items-center overflow-hidden pt-[env(safe-area-inset-top)]"
      style={{
        transition: '--state 600ms ease',
        background:
          'radial-gradient(94% 52% at 50% 18%, #100b07 0%, #060504 60%, #040303 100%)',
      }}
    >
      {/* ambient ember glow the whole room picks up, warmed by the state color */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            'radial-gradient(110% 50% at 50% 16%, color-mix(in srgb, var(--state, #ff7a18) 15%, transparent), transparent 56%)',
        }}
      />

      {/* ENS header + voice picker — only once provisioned */}
      {ready && onb.ensName ? (
        <div className="mt-3 flex flex-none flex-col items-center gap-2">
          <ENSHeaderPill ensName={onb.ensName} onOpen={() => setPanelOpen(true)} />
          <VoicePicker value={voiceId} onChange={setVoiceId} />
        </div>
      ) : null}

      {/* the flame — the protagonist, present in every state */}
      <div className="relative z-[2] -mt-1 flex flex-none items-center justify-center">
        <Flame state={flameState} getAmplitude={voice.getAmplitude} />
      </div>

      {/* the room between flame and control: the chat thread, or empty space */}
      {ready ? <ChatThread messages={messages} /> : <div className="w-full flex-1" />}

      {/* the human-confirm gate + last outcome + mic errors, just above the control */}
      {showConfirmZone ? (
        <div className="relative z-[2] flex w-full flex-none flex-col items-center gap-2 px-4 pb-2">
          {d.proposal ? (
            <ConfirmCard
              proposal={d.proposal}
              busy={d.busy}
              onConfirm={d.confirm}
              onDismiss={d.dismissProposal}
            />
          ) : null}
          {d.txResult ? <TxLine result={d.txResult} /> : null}
          {mic.error ? (
            <span className="text-[12px] text-red-400/80">{mic.error}</span>
          ) : null}
        </div>
      ) : null}

      {/* the control: summon (logged out) → onboarding (no dæmon) → liquid sigil (ready) */}
      {!signedIn ? (
        <div className="flex w-full flex-none flex-col items-center px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-3">
          <SummonGate onSummon={handleSummon} />
        </div>
      ) : ready ? (
        <LiquidSigil
          listening={mic.recording}
          busy={d.busy || mic.transcribing}
          onTap={handleTap}
          onSubmit={handleSubmit}
        />
      ) : (
        <div className="flex w-full flex-none flex-col items-center px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-3">
          <Onboarding
            status={onb.status}
            error={onb.error}
            reservedHandle={onb.reservedHandle}
            activeHandle={onb.activeHandle}
            onClaim={(h) => {
              voice.unlock();
              onb.claim(h);
            }}
            onRetry={onb.retry}
          />
        </div>
      )}

      {/* identity / cluster sheet */}
      {panelOpen && onb.ensName ? (
        <IdentityPanel ensName={onb.ensName} onClose={() => setPanelOpen(false)} />
      ) : null}
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
