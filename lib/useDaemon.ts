'use client';

import { useCallback, useRef, useState } from 'react';
import { mockAgentRun, type DaemonEvent, type DaemonState } from '@/lib/types';

export interface DaemonView {
  /** Current flame state. */
  state: DaemonState;
  /** Optional custom status label from a `state` event (e.g. delegating). */
  label: string | null;
  /** Latest spoken line — shown as on-screen text (the graceful text fallback). */
  caption: string | null;
  /** A turn is in flight (chips/mic disabled while true). */
  busy: boolean;
  /** Mic is "open" (A0: a visual stand-in; A3 wires real capture + /api/stt). */
  micOpen: boolean;
}

export interface DaemonController extends DaemonView {
  /** Run a turn against the scripted mock and drive the flame from its events. */
  run: (text: string) => Promise<void>;
  /** Toggle the mic visual (listening ⇄ idle). */
  toggleMic: () => void;
}

const INITIAL: DaemonView = {
  state: 'idle',
  label: null,
  caption: null,
  busy: false,
  micOpen: false,
};

/**
 * The frontend's consumer of the event protocol.
 *
 * A0/skeleton: it consumes `mockAgentRun` from the shared contract. At
 * integration (A2+) the only change is swapping `mockAgentRun(text)` for the
 * `/api/agent` SSE reader — the reducer below already speaks the real event
 * vocabulary, so nothing downstream changes.
 */
export function useDaemon(): DaemonController {
  const [view, setView] = useState<DaemonView>(INITIAL);
  const runningRef = useRef(false);

  const applyEvent = useCallback((ev: DaemonEvent) => {
    switch (ev.kind) {
      case 'state':
        setView((v) => ({ ...v, state: ev.state, label: ev.label ?? null }));
        break;
      case 'speak':
        // A2/A3 will pipe this to TTS + the analyser-driven mouth. For the
        // skeleton we surface it as on-screen text (the text fallback path).
        setView((v) => ({ ...v, caption: ev.text }));
        break;
      case 'proposal':
        // A4 raises the glassmorphic confirm card here.
        console.log('[proposal]', ev.card.summary);
        break;
      case 'txResult':
        // A4 drives the success/error flare from this.
        console.log('[txResult]', ev.ok, ev.hash ?? ev.error);
        break;
      case 'subagentResult':
        // A5 shows which child reported.
        console.log('[subagentResult]', ev.childEnsName, ev.summary);
        break;
      case 'done':
        break;
    }
  }, []);

  const run = useCallback(
    async (text: string) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setView((v) => ({ ...v, busy: true, micOpen: false, caption: null }));
      try {
        for await (const ev of mockAgentRun(text)) {
          applyEvent(ev);
        }
      } finally {
        runningRef.current = false;
        // Settle back to idle at the end of a turn. (Flows that intentionally
        // pause mid-turn — e.g. a proposal awaiting confirm — arrive in A4.)
        setView((v) => ({ ...v, busy: false, state: 'idle', label: null }));
      }
    },
    [applyEvent],
  );

  const toggleMic = useCallback(() => {
    setView((v) => {
      const micOpen = !v.micOpen;
      return {
        ...v,
        micOpen,
        state: micOpen ? 'listening' : 'idle',
        caption: micOpen ? null : v.caption,
      };
    });
  }, []);

  return { ...view, run, toggleMic };
}
