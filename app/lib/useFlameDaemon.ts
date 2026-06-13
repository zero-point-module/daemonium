'use client';

/**
 * Adapter: presents the live agent hook (`useDaemon`, app/lib/daemon-client)
 * in the shape the flame UI expects. This is the swap the seam was designed for —
 * the flame components don't change; they just read a live source instead of a
 * scripted mock.
 *
 * Derivations follow react-best-practices: caption/busy are computed during render
 * (no effects), and `run` is the underlying hook's already-stable callback. The
 * mic/`listening` overlay is owned by the page (driven by the real `useMic`), not
 * here — this adapter is purely the agent side.
 */
import { useDaemon } from './daemon-client';
import type { DaemonState, ProposalCard, ExecuteResponse } from './types';

export interface FlameDaemon {
  /** Live flame state from the agent. */
  state: DaemonState;
  /** Custom status label; null lets StatusPill fall back to STATE_META copy. */
  label: string | null;
  /** Ignis's latest line — the assistant's streaming text (graceful text path). */
  caption: string | null;
  /** A turn is in flight (chips/mic disabled). */
  busy: boolean;
  /** Send an utterance to the live agent (/api/agent). */
  run: (text: string) => void;
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
    state,
    proposal,
    txResult,
    sendPrompt,
    confirm,
    dismissProposal,
  } = useDaemon();

  const busy = status === 'submitted' || status === 'streaming';
  const caption = lastSpokenLine(messages);

  return {
    state,
    label: null,
    caption,
    busy,
    run: sendPrompt,
    proposal,
    txResult,
    confirm,
    dismissProposal,
  };
}
