'use client';

import { useEffect, useRef, useState } from 'react';
import type { DaemonState } from '@/lib/types';
import {
  STATE_IMAGE,
  STATE_META,
  STATE_EXPRESSION,
  expressionAssets,
} from '@/lib/stateMeta';
import { STATE_PARAMS, hexToRgb01, type FlameParams } from '@/lib/flame/params';
import { createFlameRenderer, type FlameRenderer } from '@/lib/flame/renderer';

const ALL_STATES: DaemonState[] = [
  'idle', 'listening', 'thinking', 'delegating', 'executing', 'success', 'error',
];

/**
 * The flame — Ignis, the soul of the app.
 *
 * A layered 2.5D puppet on a live WebGL canvas: a soft glow, the stable
 * natural-colored face/body (core), and a flickering fire (tips) tinted to the
 * live state color, with rising embers, breathing, and parallax depth that
 * leans toward the pointer. The 7 DaemonStates morph into one another (~600ms)
 * rather than snapping. Same Flame({ state }) API as before.
 *
 * Falls back to the static composite PNG if WebGL is unavailable. Add ?debug to
 * the URL for an on-device panel to force states and tune the look live.
 */
export function Flame({ state }: { state: DaemonState }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FlameRenderer | null>(null);

  const [fallback, setFallback] = useState(false);
  const [debug, setDebug] = useState(false);
  const [override, setOverride] = useState<DaemonState | null>(null);
  const [tweak, setTweak] = useState<Partial<FlameParams>>({});

  const effective = override ?? state;

  // Init the renderer + animation loop once. Everything per-frame lives in the
  // renderer's own refs, so the rAF loop never touches React state.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const r = createFlameRenderer(canvas);
    if (!r) {
      setFallback(true);
      return;
    }
    rendererRef.current = r;

    if (new URLSearchParams(window.location.search).has('debug')) setDebug(true);

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = () => r.setMotion(!media.matches);
    applyMotion();
    media.addEventListener?.('change', applyMotion);

    const fit = () => {
      const el = wrapRef.current;
      if (!el) return;
      r.resize(el.clientWidth, el.clientHeight, Math.min(2, window.devicePixelRatio || 1));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);

    // pointer parallax — the flame leans toward the cursor / touch
    const aim = (cx: number, cy: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = ((cx - rect.left) / rect.width) * 2 - 1;
      const y = ((cy - rect.top) / rect.height) * 2 - 1;
      r.setPointer(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
    };
    const onMouse = (e: MouseEvent) => aim(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent) => {
      if (e.touches[0]) aim(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onLeave = () => r.setPointer(0, 0);
    window.addEventListener('mousemove', onMouse);
    window.addEventListener('touchmove', onTouch, { passive: true });
    window.addEventListener('mouseout', onLeave);

    let raf = 0;
    let running = true;
    const loop = (t: number) => {
      if (!running) return;
      r.frame(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('touchmove', onTouch);
      window.removeEventListener('mouseout', onLeave);
      media.removeEventListener?.('change', applyMotion);
      ro.disconnect();
      r.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Push new targets whenever the effective state (or a debug tweak) changes.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const p = { ...STATE_PARAMS[effective], ...tweak };
    r.setTargets({
      distort: p.distort,
      turbulence: p.turbulence,
      ember: p.ember,
      brightness: p.brightness,
      breathAmp: p.breathAmp,
      breathSpeed: p.breathSpeed,
      color: hexToRgb01(STATE_META[effective].color),
      layers: expressionAssets(STATE_EXPRESSION[effective]),
    });
  }, [effective, tweak]);

  return (
    <div
      ref={wrapRef}
      role="img"
      aria-label="Ignis, a living flame"
      className="relative aspect-square w-[72vw] max-w-[360px] select-none"
    >
      {/* ambient glow halo behind the flame, tinted by the live state color */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 rounded-full blur-3xl"
        style={{
          background:
            'radial-gradient(closest-side, color-mix(in srgb, var(--state, #ff7a18) 65%, transparent), transparent 72%)',
          animation: 'glow-pulse 4s ease-in-out infinite',
        }}
      />

      {fallback ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={STATE_IMAGE[effective]}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : (
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      )}

      {debug && (
        <FlameDebug
          state={effective}
          tweak={tweak}
          base={STATE_PARAMS[effective]}
          onPickState={setOverride}
          onTweak={(key, value) => setTweak((prev) => ({ ...prev, [key]: value }))}
          onReset={() => {
            setOverride(null);
            setTweak({});
          }}
        />
      )}
    </div>
  );
}

const SLIDERS: {
  key: keyof FlameParams;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: 'distort', label: 'distort', min: 0, max: 0.4, step: 0.005 },
  { key: 'turbulence', label: 'turbulence', min: 0, max: 3, step: 0.05 },
  { key: 'ember', label: 'ember', min: 0, max: 1, step: 0.02 },
  { key: 'brightness', label: 'brightness', min: 0.5, max: 1.6, step: 0.02 },
  { key: 'breathAmp', label: 'breath amp', min: 0, max: 0.06, step: 0.002 },
  { key: 'breathSpeed', label: 'breath speed', min: 0, max: 2, step: 0.05 },
];

// Dev-only overlay (?debug): force any state, tune the look live on a phone.
function FlameDebug({
  state,
  tweak,
  base,
  onPickState,
  onTweak,
  onReset,
}: {
  state: DaemonState;
  tweak: Partial<FlameParams>;
  base: FlameParams;
  onPickState: (s: DaemonState | null) => void;
  onTweak: (key: keyof FlameParams, value: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="fixed bottom-3 right-3 z-50 w-56 rounded-xl border border-white/10 bg-black/80 p-3 text-[11px] text-white/80 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-white/90">flame · {state}</span>
        <button
          onClick={onReset}
          className="rounded bg-white/10 px-2 py-0.5 text-white/70 hover:bg-white/20"
        >
          reset
        </button>
      </div>

      <div className="mb-2 grid grid-cols-3 gap-1">
        {ALL_STATES.map((s) => (
          <button
            key={s}
            onClick={() => onPickState(s)}
            className={`truncate rounded px-1 py-1 ${
              s === state ? 'bg-white/25 text-white' : 'bg-white/5 hover:bg-white/15'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        {SLIDERS.map(({ key, label, min, max, step }) => {
          const value = tweak[key] ?? base[key];
          return (
            <label key={key} className="block">
              <span className="flex justify-between">
                <span>{label}</span>
                <span className="tabular-nums text-white/50">{value.toFixed(3)}</span>
              </span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onTweak(key, parseFloat(e.target.value))}
                className="w-full accent-white/80"
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
