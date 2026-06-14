import type { DaemonState } from '@/app/lib/types';

export interface StateMeta {
  /** Default status-pill copy for this state (an event may override via label). */
  label: string;
  /** The room color for this state — drives every glow via --state. */
  color: string;
}

/**
 * The 7 DaemonStates → their copy + color. Each color is tuned to its painted
 * expression so the recolored WebGL fire (tips + glow) blends with the art:
 *   idle=amber · listening=lime green · thinking=azure · delegating=violet ·
 *   executing=electric blue · success=green · error=warm red.
 */
export const STATE_META: Record<DaemonState, StateMeta> = {
  idle: { label: 'Idle', color: '#ff7a18' },
  listening: { label: 'Listening…', color: '#46d633' },
  thinking: { label: 'Thinking…', color: '#4f8cff' },
  delegating: { label: 'Consulting research…', color: '#9d5cff' },
  executing: { label: 'Acting onchain…', color: '#2b6bff' },
  success: { label: 'Done', color: '#2bd576' },
  error: { label: 'Something went wrong', color: '#ff453a' },
};

/**
 * Ignis wears a distinct face per state — seven expressions, each its own folder
 * under public/daemon/: idle, listening, thinking, delegating, executing, happy
 * (success), concerned (error). The flame's color (--state) and per-state motion
 * params layer on top.
 *
 * Each folder holds the layered webp art (1024², straight alpha): full (flat
 * fallback composite), core (the face/body), tips (the licking flame that gets
 * distorted), glow (soft aura). Every state shares idle's tips/glow ring,
 * recolored at runtime, so the WebGL fire surrounds each creature the same way.
 * The core also carries the cel frames that move the face: core-talk and
 * core-talk-wide (the mouth opening in two stages with the voice) plus
 * core-blink (eyes closed), all registered to the same position and size.
 */
export type ExpressionKey =
  | 'idle' | 'listening' | 'thinking' | 'delegating' | 'executing'
  | 'happy' | 'concerned';

/** Expressions whose neutral face has open eyes, so an eyes-closed blink fits. */
const MOODS_WITH_BLINK = new Set<ExpressionKey>([
  'idle', 'listening', 'thinking', 'delegating', 'executing', 'happy', 'concerned',
]);

export interface ExpressionAssets {
  full: string;
  core: string;
  coreTalk: string;
  /** Wider mouth, reached at higher voice amplitude (rest → talk → talk-wide). */
  coreTalkWide?: string;
  coreBlink?: string;
  tips: string;
  glow: string;
}

export function expressionAssets(key: ExpressionKey): ExpressionAssets {
  const base = `/daemon/${key}`;
  const assets: ExpressionAssets = {
    full: `${base}/full.webp`,
    core: `${base}/core.webp`,
    coreTalk: `${base}/core-talk.webp`,
    coreTalkWide: `${base}/core-talk-wide.webp`,
    tips: `${base}/tips.webp`,
    glow: `${base}/glow.webp`,
  };
  if (MOODS_WITH_BLINK.has(key)) assets.coreBlink = `${base}/core-blink.webp`;
  return assets;
}

/** Which face each DaemonState wears (success→happy, error→concerned). */
export const STATE_EXPRESSION: Record<DaemonState, ExpressionKey> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  delegating: 'delegating',
  executing: 'executing',
  success: 'happy',
  error: 'concerned',
};

/** State → flat composite URL (the no-WebGL fallback image). */
export const STATE_IMAGE: Record<DaemonState, string> = {
  idle: expressionAssets('idle').full,
  listening: expressionAssets('listening').full,
  thinking: expressionAssets('thinking').full,
  delegating: expressionAssets('delegating').full,
  executing: expressionAssets('executing').full,
  success: expressionAssets('happy').full,
  error: expressionAssets('concerned').full,
};
