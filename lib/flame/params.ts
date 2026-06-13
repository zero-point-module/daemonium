import type { DaemonState } from '@/lib/types';

/**
 * The tunable look of the flame for a single DaemonState. The renderer lerps
 * smoothly between these as the state changes, so transitions morph rather than
 * snap. The ?debug panel edits these live on-device.
 */
export interface FlameParams {
  /** heat-haze displacement amplitude (~0..0.4) */
  distort: number;
  /** noise frequency / churn */
  turbulence: number;
  /** rising-ember intensity (0..1) */
  ember: number;
  /** overall emission multiplier */
  brightness: number;
  /** breathing scale amount (0 = none) */
  breathAmp: number;
  /** breathing speed (cycles per second) */
  breathSpeed: number;
}

// Starting tuning — calm idle, alert listening, churning thinking, intense
// executing, a success flare, a sharp low error sputter. Eyeballed; the debug
// panel is for dialing these in on a real phone.
export const STATE_PARAMS: Record<DaemonState, FlameParams> = {
  idle:       { distort: 0.085, turbulence: 0.6, ember: 0.20, brightness: 1.00, breathAmp: 0.022, breathSpeed: 0.25 },
  listening:  { distort: 0.120, turbulence: 0.9, ember: 0.40, brightness: 1.12, breathAmp: 0.030, breathSpeed: 0.50 },
  thinking:   { distort: 0.170, turbulence: 1.6, ember: 0.22, brightness: 1.02, breathAmp: 0.018, breathSpeed: 0.70 },
  delegating: { distort: 0.190, turbulence: 1.4, ember: 0.45, brightness: 1.06, breathAmp: 0.020, breathSpeed: 0.60 },
  executing:  { distort: 0.150, turbulence: 1.1, ember: 0.55, brightness: 1.18, breathAmp: 0.024, breathSpeed: 0.90 },
  success:    { distort: 0.210, turbulence: 1.0, ember: 0.80, brightness: 1.30, breathAmp: 0.034, breathSpeed: 0.70 },
  error:      { distort: 0.110, turbulence: 2.2, ember: 0.10, brightness: 0.92, breathAmp: 0.026, breathSpeed: 1.40 },
};

/** "#ff7a18" | "#fff" → [r, g, b] in 0..1 for a vec3 uniform. */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
