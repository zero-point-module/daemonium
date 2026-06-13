'use client';

import { useEffect, useRef } from 'react';
import { Flame } from '@/components/Flame';
import { IdentityBadge } from '@/components/IdentityBadge';
import { StatusPill } from '@/components/StatusPill';
import { MicButton } from '@/components/MicButton';
import { QuickActions } from '@/components/QuickActions';
import { useDaemon } from '@/lib/useDaemon';
import { STATE_META } from '@/lib/stateMeta';

export default function Home() {
  const d = useDaemon();
  const shellRef = useRef<HTMLDivElement>(null);

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

      {/* what Ignis says — on-screen text (graceful fallback; TTS arrives in A2/A3) */}
      <div className="flex min-h-[2.75rem] items-center px-2 text-center">
        {d.caption ? (
          <p className="text-pretty text-[15px] leading-snug text-white/75">
            {d.caption}
          </p>
        ) : null}
      </div>

      {/* lower third — mic + quick actions */}
      <section className="flex flex-col items-center gap-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <MicButton open={d.micOpen} busy={d.busy} onToggle={d.toggleMic} />
        <QuickActions busy={d.busy} onPick={d.run} />
      </section>
    </main>
  );
}
