/**
 * The dæmon's identity chip. Shows the user's real ENS name once provisioned
 * (ignis.<handle>.daemonium.eth); before that, the parent brand as a teaser. The
 * name is resolved upstream (useOnboarding) and passed in — we never fabricate a
 * per-user id.
 */
export function IdentityBadge({ ensName }: { ensName: string | null }) {
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
        {ensName ?? 'ignis.daemonium.eth'}
      </span>
    </div>
  );
}
