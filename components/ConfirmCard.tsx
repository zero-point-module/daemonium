import type { ProposalCard } from '@/app/lib/types';

/**
 * The human-confirmation gate. The agent PROPOSES; this renders the proposal and
 * waits. A confirm tap sends back only the opaque `executionId` (never a built
 * transaction) — the server route is the sole signer. This is the entire
 * confirm-before-act contract, made visible.
 */

const ACTION_LABEL: Record<ProposalCard['action'], string> = {
  send_usdc: 'Send USDC',
  spawn_subagent: 'Spawn sub-agent',
};

function detailRows(proposal: ProposalCard): { label: string; value: string }[] {
  const d = proposal.details;
  switch (d.action) {
    case 'send_usdc':
      return [
        { label: 'Amount', value: `${d.amount} USDC` },
        { label: 'To', value: d.toEns ?? d.to },
      ];
    case 'spawn_subagent':
      return [
        { label: 'Agent', value: d.label },
        { label: 'Purpose', value: d.purpose },
      ];
  }
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
  return (
    <div
      role="dialog"
      aria-label="Confirm action"
      className="w-full max-w-sm rounded-2xl border bg-white/[0.05] p-4 backdrop-blur-md"
      style={{
        borderColor: 'color-mix(in srgb, var(--state, #ff7a18) 40%, transparent)',
        boxShadow: '0 0 28px color-mix(in srgb, var(--state, #ff7a18) 16%, transparent)',
      }}
    >
      <span
        className="text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: 'var(--state, #ff7a18)' }}
      >
        Confirm · {ACTION_LABEL[proposal.action]}
      </span>

      <p className="mt-1 text-pretty text-[15px] leading-snug text-white/90">
        {proposal.summary}
      </p>

      <dl className="mt-3 flex flex-col gap-1.5">
        {detailRows(proposal).map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 text-[13px]">
            <dt className="shrink-0 text-white/40">{row.label}</dt>
            <dd className="break-all text-right font-mono text-white/80">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(proposal.executionId)}
          className="flex-1 rounded-full px-4 py-2.5 text-sm font-semibold text-black transition active:scale-[0.98] disabled:opacity-40"
          style={{ background: 'var(--state, #ff7a18)' }}
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
