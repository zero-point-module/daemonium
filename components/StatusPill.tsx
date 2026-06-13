import type { DaemonState } from '@/lib/types';
import { STATE_META } from '@/lib/stateMeta';

export function StatusPill({
  state,
  label,
}: {
  state: DaemonState;
  label?: string | null;
}) {
  const text = label ?? STATE_META[state].label;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className="h-2 w-2 rounded-full"
        style={{
          background: 'var(--state, #ff7a18)',
          boxShadow: '0 0 10px var(--state, #ff7a18)',
        }}
      />
      <span className="text-white/70">{text}</span>
    </div>
  );
}
