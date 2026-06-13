// Placeholder identity. The real DaemonIdentity (ENS name + ERC-8004 agentId)
// is provided by workstream B; this badge renders whatever it hands us.
const IGNIS = {
  ensName: 'ignis.daemonium.eth',
  agentId: '#8004', // TODO(workstream B): real ERC-8004 agentId
};

export function IdentityBadge() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 backdrop-blur-sm">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: 'var(--state, #ff7a18)',
          boxShadow: '0 0 8px var(--state, #ff7a18)',
        }}
      />
      <span className="text-[13px] font-medium tracking-wide">
        {IGNIS.ensName}
      </span>
      <span className="text-[11px] text-white/35">{IGNIS.agentId}</span>
    </div>
  );
}
