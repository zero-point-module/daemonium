import type { DaemonState } from '@/lib/types';

export interface StateMeta {
  /** Default status-pill copy for this state (an event may override via label). */
  label: string;
  /** The room color for this state — drives every glow via --state. */
  color: string;
}

/**
 * The 7 DaemonStates → their copy + color.
 * Mirrors the mapping in NOTE_FOR_MYSELF.md:
 *   idle=orange · listening=green · thinking/executing=blue ·
 *   delegating=indigo · success=bright green · error=red.
 */
export const STATE_META: Record<DaemonState, StateMeta> = {
  idle: { label: 'Idle', color: '#ff7a18' },
  listening: { label: 'Listening…', color: '#34d399' },
  thinking: { label: 'Thinking…', color: '#4f8cff' },
  delegating: { label: 'Consulting research…', color: '#7c83ff' },
  executing: { label: 'Acting onchain…', color: '#4f8cff' },
  success: { label: 'Done', color: '#2bd576' },
  error: { label: 'Something went wrong', color: '#ff5a5a' },
};

/**
 * Which pre-rendered art each state shows. This is the A0 placeholder mapping:
 * a simple <img> swap. A1 replaces the swap with the live WebGL distortion
 * canvas (hue-rotation instead of separate-color art) behind the same Flame API.
 */
export const STATE_IMAGE: Record<DaemonState, string> = {
  idle: '/daemon/idle.png',
  listening: '/daemon/listening.png',
  thinking: '/daemon/thinking.png',
  delegating: '/daemon/thinking.png',
  executing: '/daemon/thinking.png',
  success: '/daemon/happy.png',
  error: '/daemon/concerned.png',
};
