import type { ReactNode } from 'react';
import type { ProposalCard } from '@/app/lib/types';

/**
 * The human-confirmation gate. The agent PROPOSES; this renders the proposal and waits. A
 * confirm tap sends back only the opaque `executionId` (never a built transaction) — the server
 * resolves it to the payload it validated and stored. This is the entire confirm-before-act
 * contract, made visible.
 *
 * The card reads as a single onchain MOVE: a per-action glyph, then a from → to flow (what
 * leaves, where it lands), tinted to the live room color (var(--state)) so it belongs to the
 * flame it rose from.
 */

const ACTION_LABEL: Record<ProposalCard['action'], string> = {
  send_usdc: 'Send USDC',
  send_eth: 'Send ETH',
  swap: 'Swap',
  spawn_subagent: 'Summon sub-dæmon',
};

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

interface Endpoint {
  value: string;
  caption: string;
}
interface Flow {
  from: Endpoint;
  to: Endpoint;
  /** A small context line under the flow (chain, purpose), optional. */
  note?: string;
}

/** Turn a proposal into the from → to flow shown on the card. */
function flowFor(proposal: ProposalCard): Flow {
  const d = proposal.details;
  switch (d.action) {
    case 'send_usdc':
      return {
        from: { value: `${d.amount} USDC`, caption: 'leaves you' },
        to: { value: d.toEns ?? short(d.to), caption: 'recipient' },
        note: 'on Base',
      };
    case 'send_eth':
      return {
        from: { value: `${d.amount} ETH`, caption: 'leaves you' },
        to: { value: d.toEns ?? short(d.to), caption: 'recipient' },
        note: `on ${d.chain}`,
      };
    case 'swap':
      return {
        from: { value: `${d.amount} ${d.fromSymbol}`, caption: 'you pay' },
        to: { value: d.toSymbol, caption: 'you get' },
        note: 'Swap on Base',
      };
    case 'spawn_subagent':
      return {
        from: { value: d.parentKey.split('.')[0], caption: 'parent' },
        to: { value: d.label, caption: 'new dæmon' },
        note: d.purpose,
      };
  }
}

/** A small stroked glyph per action, in the live state color. */
function ActionGlyph({ action }: { action: ProposalCard['action'] }) {
  const paths: Record<ProposalCard['action'], ReactNode> = {
    send_usdc: <path d="M5 12h12m0 0-5-5m5 5-5 5" />,
    send_eth: <path d="M5 12h12m0 0-5-5m5 5-5 5" />,
    swap: (
      <>
        <path d="M5 8h12l-3-3M19 16H7l3 3" />
      </>
    ),
    spawn_subagent: <path d="M12 4l1.7 5.1L19 11l-5.3 1.9L12 18l-1.7-5.1L5 11l5.3-1.9z" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[action]}
    </svg>
  );
}

/** One side of the flow — a glassy chip with the value over a tiny role caption. */
function FlowChip({ endpoint, align }: { endpoint: Endpoint; align: 'left' | 'right' }) {
  return (
    <div
      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2"
      style={{ textAlign: align }}
    >
      <div className="truncate font-mono text-[14px] leading-tight text-white/90">
        {endpoint.value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.6px] text-white/40">
        {endpoint.caption}
      </div>
    </div>
  );
}

export function ConfirmCard({
  proposal,
  busy = false,
  onConfirm,
  onDismiss,
}: {
  proposal: ProposalCard;
  busy?: boolean;
  onConfirm: (executionId: string) => void;
  onDismiss: () => void;
}) {
  const flow = flowFor(proposal);
  return (
    <div
      role="dialog"
      aria-label="Confirm action"
      className="w-full max-w-sm rounded-[22px] border p-4 backdrop-blur-md"
      style={{
        borderColor: 'color-mix(in srgb, var(--state, #ff7a18) 42%, transparent)',
        background:
          'linear-gradient(180deg, color-mix(in srgb, var(--state, #ff7a18) 9%, rgba(14,9,6,.72)), rgba(10,7,5,.82))',
        boxShadow: '0 0 34px color-mix(in srgb, var(--state, #ff7a18) 18%, transparent)',
      }}
    >
      {/* header — glyph + eyebrow + action title */}
      <div className="flex items-center gap-3">
        <div
          className="grid flex-none place-items-center rounded-xl"
          style={{
            width: 38,
            height: 38,
            color: 'var(--state, #ff7a18)',
            background: 'color-mix(in srgb, var(--state, #ff7a18) 14%, transparent)',
            border: '1px solid color-mix(in srgb, var(--state, #ff7a18) 34%, transparent)',
          }}
        >
          <ActionGlyph action={proposal.action} />
        </div>
        <div className="min-w-0">
          <div
            className="text-[10px] font-semibold uppercase tracking-[1.4px]"
            style={{ color: 'var(--state, #ff7a18)' }}
          >
            Confirm to act
          </div>
          <div className="truncate text-[16px] font-semibold leading-tight text-white/95">
            {ACTION_LABEL[proposal.action]}
          </div>
        </div>
      </div>

      {/* the move — from → to */}
      <div className="mt-3.5 flex items-center gap-1.5">
        <FlowChip endpoint={flow.from} align="left" />
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="var(--state, #ff7a18)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-none"
          style={{ filter: 'drop-shadow(0 0 5px color-mix(in srgb, var(--state, #ff7a18) 60%, transparent))' }}
          aria-hidden
        >
          <path d="M4 12h15m0 0-5-5m5 5-5 5" />
        </svg>
        <FlowChip endpoint={flow.to} align="right" />
      </div>

      {flow.note ? (
        <p className="mt-2.5 text-pretty text-center text-[12px] leading-snug text-white/45">
          {flow.note}
        </p>
      ) : null}

      {/* the gate */}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(proposal.executionId)}
          className="flex-1 rounded-full px-4 py-2.5 text-sm font-semibold text-black transition active:scale-[0.98] disabled:opacity-40"
          style={{
            background: 'var(--state, #ff7a18)',
            boxShadow: '0 0 22px color-mix(in srgb, var(--state, #ff7a18) 35%, transparent)',
          }}
        >
          Confirm
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="rounded-full border border-white/12 px-4 py-2.5 text-sm text-white/70 transition active:scale-[0.98] hover:bg-white/[0.05] disabled:opacity-40"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
