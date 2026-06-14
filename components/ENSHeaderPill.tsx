'use client';

/**
 * The ENS identity pill at the top of the room. Tap to open the identity / cluster panel.
 * The status dot tracks the live state color (var(--state)), so it warms/cools with Ignis.
 */
export function ENSHeaderPill({
  ensName,
  agentId,
  onOpen,
}: {
  ensName: string;
  /** ERC-8004 id like "#8004", shown only when known. */
  agentId?: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative z-[5] flex flex-none items-center gap-[9px] rounded-full px-[15px] py-2 backdrop-blur-md transition active:scale-[0.97]"
      style={{
        border: '1px solid rgba(255,255,255,.08)',
        background: 'rgba(255,255,255,.04)',
        color: 'inherit',
      }}
    >
      <span
        className="h-[7px] w-[7px] rounded-full"
        style={{
          background: 'var(--state, #ff7a18)',
          boxShadow: '0 0 9px var(--state, #ff7a18)',
        }}
      />
      <span className="text-[15px] font-medium tracking-[0.2px] text-[#f6ecdd]">
        {ensName}
      </span>
      {agentId ? (
        <span className="text-[11px] tabular-nums text-[rgba(246,236,221,0.34)]">
          {agentId}
        </span>
      ) : null}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="rgba(246,236,221,.4)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ marginLeft: 1 }}
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}
