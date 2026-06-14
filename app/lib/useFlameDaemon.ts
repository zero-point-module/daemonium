'use client';

/**
 * Adapter: presents the live agent hook (`useDaemon`, app/lib/daemon-client) in the
 * shape the flame UI expects, so the flame components stay decoupled from the agent
 * transport and just read this view.
 *
 * Derivations follow react-best-practices: caption/busy are computed during render
 * (no effects), and `run` is the underlying hook's already-stable callback. The
 * mic/`listening` overlay is owned by the page (driven by the real `useMic`), not
 * here — this adapter is purely the agent side.
 */
import { useDaemon } from './daemon-client';
import type { DaemonState, ProposalCard, ExecuteResponse } from './types';

export interface ChatMessage {
  role: 'user' | 'ignis';
  text: string;
}

export interface FlameDaemon {
  /** Live flame state from the agent. */
  state: DaemonState;
  /** Ignis's latest line — the assistant's streaming text (graceful text path). */
  caption: string | null;
  /** The conversation thread for the chat view (user + Ignis lines; internal turns filtered). */
  messages: ChatMessage[];
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

/** Internal directive turns we inject (proactive nudges, post-confirm reactions) — kept out of the chat. */
const INTERNAL_USER_PREFIXES = ['[ambient]', 'Confirmed.', 'I confirmed,'];

/** Flatten the ai-sdk messages into the chat thread, dropping empty + internal-directive turns. */
function toThread(
  messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) continue;
    if (m.role === 'user' && INTERNAL_USER_PREFIXES.some((p) => text.startsWith(p))) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'ignis', text });
  }
  return out;
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
  const thread = toThread(messages);

  return {
    state,
    caption,
    messages: thread,
    busy,
    run: sendPrompt,
    proposal,
    txResult,
    confirm,
    dismissProposal,
  };
}
