'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { Flame } from '@/components/Flame';
import { ENSHeaderPill } from '@/components/ENSHeaderPill';
import { ChatThread } from '@/components/ChatThread';
import { LiquidSigil } from '@/components/LiquidSigil';
import { IdentityPanel } from '@/components/IdentityPanel';
import { ConfirmCard } from '@/components/ConfirmCard';
import { Onboarding } from '@/components/Onboarding';
import { Cluster } from '@/components/Cluster';
import { SummonSheet } from '@/components/SummonSheet';
import { STATE_META } from '@/lib/stateMeta';
import { rootLabelOf } from '@/lib/cluster';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';

import { useFlameDaemon, type ChatMessage } from './lib/useFlameDaemon';
import type { DaemonAction } from './lib/types';
import { useVoice } from './lib/useVoice';
import { useMic } from './lib/useMic';
import { useOnboarding } from './lib/useOnboarding';
import { useCluster } from './lib/useCluster';
import { useProactiveWatch } from './lib/useProactiveWatch';
import { DEFAULT_VOICE_ID } from './lib/voices';
import { explorerTxUrl, explorerName } from './lib/chain';

export default function Home() {
  const d = useFlameDaemon();
  const { user, setShowAuthFlow } = useDynamicContext();

  // Character voice fed to the voice pipeline — the persisted choice, or the default. The
  // picker UI is hidden, so it no longer changes at runtime (hydrated once from storage).
  const [voiceId] = useState(() =>
    typeof window === 'undefined'
      ? DEFAULT_VOICE_ID
      : (localStorage.getItem('ignis.voice') ?? DEFAULT_VOICE_ID),
  );

  // Voice owns both the speech and the synced caption: it segments Ignis's streaming line into
  // sentences, speaks each as it's ready, and reveals the caption in lockstep with the audio.
  const voice = useVoice({ text: d.caption, busy: d.busy, voice: voiceId });
  const mic = useMic({ onTranscript: d.run, isSpeaking: voice.isSpeaking });

  const shellRef = useRef<HTMLDivElement>(null);
  const pagerRef = useRef<HTMLDivElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [summonSlot, setSummonSlot] = useState<number | null>(null);
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

  // Trivial tap handlers — not memoized: their children aren't memo'd, so a stable identity
  // buys nothing, and a fresh closure each render avoids stale-value footguns.
  const handleTap = () => {
    voice.unlock();
    mic.toggle();
  };

  const handleSubmit = (text: string) => {
    voice.unlock();
    d.run(text);
  };

  const handleSummon = () => {
    voice.unlock();
    setShowAuthFlow(true);
  };

  // The cluster (page 2) + summon ritual. The roster + live spells come from the agent's real
  // wallet tree and run registry (polled); the root label comes from the live identity.
  const rootLabel = rootLabelOf(onb.ensName);
  const cluster = useCluster({ enabled: ready, rootLabel });

  const goToHome = () => pagerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

  const openSummon = (slot: number) => {
    voice.unlock();
    setSummonSlot(slot);
  };
  const closeSummon = () => setSummonSlot(null);

  // Kindle: route the new dæmon through Ignis as a real, confirm-gated spawn. The [summon]
  // directive is filtered out of the visible chat (see useFlameDaemon). We let the "kindling"
  // beat land, then drop back to Ignis so the human watches it think and the confirm card rise.
  const handleKindle = ({ handle, purpose }: { handle: string; purpose: string }) => {
    voice.unlock();
    const p = purpose || 'general assistance in my cluster';
    d.run(
      `[summon] Summon a new dæmon in my cluster. Call the spawn_subagent tool now with label "${handle}" and this exact purpose: "${p}". Don't ask me to clarify — just propose it so I can confirm.`,
    );
    window.setTimeout(() => {
      closeSummon();
      goToHome();
    }, 650);
  };

  const showConfirmZone =
    !!d.proposal || !!d.executingAction || !!d.txResult || !!mic.error;

  return (
    <main
      ref={shellRef}
      className="relative mx-auto h-[100dvh] w-full max-w-[420px] overflow-hidden bg-[#050505]"
      style={{ transition: '--state 600ms ease' }}
    >
      {/* vertical pager — Home (page 1) over the Cluster (page 2), TikTok-style snap paging */}
      <div
        ref={pagerRef}
        className="h-full overflow-y-auto"
        style={{ scrollSnapType: 'y mandatory', overscrollBehaviorY: 'contain' }}
      >
        {/* page 1 — the voice room */}
        <section
          className="relative flex h-full w-full flex-col items-center overflow-hidden pt-[env(safe-area-inset-top)]"
          style={{
            scrollSnapAlign: 'start',
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
              {d.executingAction ? <WorkingLine action={d.executingAction} /> : null}
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
                smartAccount={onb.smartAccount}
                onClaim={(h) => {
                  voice.unlock();
                  onb.claim(h);
                }}
                onConfirmFunded={onb.confirmFunded}
                onRetry={onb.retry}
              />
            </div>
          )}
        </section>

        {/* page 2 — the cluster (only once there's a dæmon to show) */}
        {ready && onb.ensName ? (
          <section
            aria-label="Dæmon cluster"
            className="relative h-full w-full overflow-hidden"
            style={{ scrollSnapAlign: 'start' }}
          >
            <Cluster
              rootLabel={rootLabel}
              daemons={cluster.daemons}
              spells={cluster.spells}
              summary={cluster.summary}
              activeSlot={summonSlot}
              onSlotTap={openSummon}
            />
          </section>
        ) : null}
      </div>

      {/* summon ritual — a sheet over the (dimmed) cluster */}
      {summonSlot != null && onb.ensName ? (
        <SummonSheet
          rootEnsName={onb.ensName}
          rootLabel={rootLabel}
          takenLabels={cluster.daemons.map((dm) => dm.sub)}
          onKindle={handleKindle}
          onDismiss={closeSummon}
        />
      ) : null}

      {/* identity / wallet sheet */}
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

/** Present-participle of each action, for the "working" line shown through the executing wait. */
const WORKING_VERB: Record<DaemonAction, string> = {
  send_usdc: 'Sending USDC',
  send_eth: 'Sending ETH',
  swap: 'Swapping',
  lifi_zap: 'Depositing into the vault',
  lifi_bridge: 'Bridging across chains',
  spawn_subagent: 'Forging the sub-dæmon',
};

/** Shown while a confirmed action is signing+broadcasting — an honest, state-tinted progress
 *  beat so the wait reads as the flame actively working, not stalled. */
function WorkingLine({ action }: { action: DaemonAction }) {
  return (
    <div
      className="flex items-center gap-2 text-[12px]"
      style={{ color: 'color-mix(in srgb, var(--state, #ff7a18) 80%, white)' }}
    >
      <span
        className="inline-block rounded-full"
        style={{
          width: 7,
          height: 7,
          background: 'var(--state, #ff7a18)',
          boxShadow: '0 0 9px var(--state, #ff7a18)',
          animation: 'working-pulse 1.1s ease-in-out infinite',
        }}
      />
      {WORKING_VERB[action]} onchain…
    </div>
  );
}

/** Last confirmed action's outcome — a tappable tx link, or the error. */
function TxLine({
  result,
}: {
  result: { ok: boolean; hash?: string; error?: string; chainId?: number };
}) {
  if (result.ok && result.hash) {
    return (
      <a
        href={explorerTxUrl(result.hash, result.chainId)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[12px] text-emerald-400/90 hover:underline"
      >
        ✓ transaction confirmed — view on {explorerName(result.chainId)}
      </a>
    );
  }
  return (
    <span className="text-[12px] text-red-400/90">
      ✗ {result.error ?? 'the action failed'}
    </span>
  );
}
