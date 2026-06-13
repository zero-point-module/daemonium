'use client';

/**
 * Adapter: presents Luca's live agent hook (`useDaemon`, app/lib/daemon-client)
 * in the shape the flame UI expects. This is the swap the seam was designed for —
 * the flame components don't change; they just read a live source instead of the
 * scripted mock (lib/useDaemon).
 *
 * Derivations follow react-best-practices: caption/busy/state are computed during
 * render (no effects), and the returned callbacks are stable (depend only on the
 * already-stable callbacks from the underlying hook).
 */
import { useCallback, useState } from 'react';
import { useDaemon } from './daemon-client';
import type { DaemonState, ProposalCard, ExecuteResponse } from './types';

export interface FlameDaemon {
  /** Live flame state (with a local `listening` overlay while the mic is open). */
  state: DaemonState;
  /** Custom status label; null lets StatusPill fall back to STATE_META copy. */
  label: string | null;
  /** Ignis's latest line — the assistant's streaming text (graceful text path). */
  caption: string | null;
  /** A turn is in flight (chips/mic disabled). */
  busy: boolean;
  /** Mic visual is open. Real capture + STT arrives in A3; for now it's a hint. */
  micOpen: boolean;
  /** Send an utterance to the live agent (/api/agent). */
  run: (text: string) => void;
  /** Toggle the mic visual. */
  toggleMic: () => void;
  /** Pending action awaiting the human confirm tap, or null. */
  proposal: ProposalCard | null;
  /** Outcome of the last confirmed action, or null. */
  txResult: (ExecuteResponse & { executionId: string }) | null;
  /** Confirm a proposal — sends only the opaque executionId to the signer route. */
  confirm: (executionId: string) => void;
  /** Dismiss the pending proposal without acting. */
  dismissProposal: () => void;
}

/** Latest assistant line, ignoring a just-sent user turn that has no reply yet. */
function lastSpokenLine(
  messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>,
): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const text = last.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  return text || null;
}

export function useFlameDaemon(): FlameDaemon {
  const {
    messages,
    status,
    state: agentState,
    proposal,
    txResult,
    sendPrompt,
    confirm,
    dismissProposal,
  } = useDaemon();

  const [micOpen, setMicOpen] = useState(false);

  const busy = status === 'submitted' || status === 'streaming';
  const caption = lastSpokenLine(messages);

  // The mic overlay only colours an otherwise-idle flame; once the agent is
  // working, its real state always wins.
  const state: DaemonState =
    micOpen && agentState === 'idle' ? 'listening' : agentState;

  const run = useCallback(
    (text: string) => {
      setMicOpen(false);
      sendPrompt(text);
    },
    [sendPrompt],
  );

  const toggleMic = useCallback(() => setMicOpen((open) => !open), []);

  return {
    state,
    label: null,
    caption,
    busy,
    micOpen,
    run,
    toggleMic,
    proposal,
    txResult,
    confirm,
    dismissProposal,
  };
}
