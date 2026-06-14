'use client';

import { useEffect, useRef, useState } from 'react';
import type { DaemonState } from '@/app/lib/types';
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
export function Flame({
  state,
  getAmplitude,
}: {
  state: DaemonState;
  /** Live voice amplitude 0..1 (e.g. useVoice.getAmplitude). Drives the flame while speaking. */
  getAmplitude?: () => number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FlameRenderer | null>(null);
  // Latest amplitude getter, readable from the rAF loop without re-subscribing it.
  const ampRef = useRef(getAmplitude);
  ampRef.current = getAmplitude;

  const [fallback, setFallback] = useState(false);
  const [debug, setDebug] = useState(false);
  const [override, setOverride] = useState<DaemonState | null>(null);
  const [tweak, setTweak] = useState<Partial<FlameParams>>({});
  // Debug-only voice driver: null = use the live TTS amplitude, a number forces
  // it, talk = auto-oscillate a speech-like envelope. Lets us tune the mouth and
  // the voice-reactive fire on a phone without triggering real TTS.
  const [dbgVoice, setDbgVoice] = useState<number | null>(null);
  const [dbgTalk, setDbgTalk] = useState(false);
  const dbgVoiceRef = useRef(dbgVoice);
  dbgVoiceRef.current = dbgVoice;
  const dbgTalkRef = useRef(dbgTalk);
  dbgTalkRef.current = dbgTalk;
  // Core hue-adapt tuning (all 0..1): how far the core rotates toward the state
  // color, brightness restore, face-ellipse protect amount, and its vertical center.
  const [coreHue, setCoreHue] = useState(0);
  const [coreLum, setCoreLum] = useState(0);
  const [coreProtect, setCoreProtect] = useState(0);
  const [coreFaceY, setCoreFaceY] = useState(0.4);

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
      let v: number;
      if (dbgTalkRef.current) {
        // a speech-like envelope from two detuned sines, clamped to 0..1
        v = Math.max(0, Math.min(1,
          0.5 + 0.35 * Math.sin(t * 0.011) + 0.25 * Math.sin(t * 0.027 + 1.3)));
      } else if (dbgVoiceRef.current != null) {
        v = dbgVoiceRef.current;
      } else {
        v = ampRef.current ? ampRef.current() : 0;
      }
      r.setVoice(v);
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

  // Push the core hue-adapt tuning to the renderer whenever any of it changes.
  useEffect(() => {
    rendererRef.current?.setCoreFx({
      hue: coreHue,
      lumPreserve: coreLum,
      faceProtect: coreProtect,
      faceY: coreFaceY,
    });
  }, [coreHue, coreLum, coreProtect, coreFaceY]);

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
          dbgVoice={dbgVoice}
          dbgTalk={dbgTalk}
          coreHue={coreHue}
          coreLum={coreLum}
          coreProtect={coreProtect}
          coreFaceY={coreFaceY}
          onVoice={setDbgVoice}
          onTalk={setDbgTalk}
          onCoreHue={setCoreHue}
          onCoreLum={setCoreLum}
          onCoreProtect={setCoreProtect}
          onCoreFaceY={setCoreFaceY}
          onPickState={setOverride}
          onTweak={(key, value) => setTweak((prev) => ({ ...prev, [key]: value }))}
          onReset={() => {
            setOverride(null);
            setTweak({});
            setDbgVoice(null);
            setDbgTalk(false);
            setCoreHue(0);
            setCoreLum(0);
            setCoreProtect(0);
            setCoreFaceY(0.4);
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
  dbgVoice,
  dbgTalk,
  coreHue,
  coreLum,
  coreProtect,
  coreFaceY,
  onVoice,
  onTalk,
  onCoreHue,
  onCoreLum,
  onCoreProtect,
  onCoreFaceY,
  onPickState,
  onTweak,
  onReset,
}: {
  state: DaemonState;
  tweak: Partial<FlameParams>;
  base: FlameParams;
  dbgVoice: number | null;
  dbgTalk: boolean;
  coreHue: number;
  coreLum: number;
  coreProtect: number;
  coreFaceY: number;
  onVoice: (v: number | null) => void;
  onTalk: (on: boolean) => void;
  onCoreHue: (v: number) => void;
  onCoreLum: (v: number) => void;
  onCoreProtect: (v: number) => void;
  onCoreFaceY: (v: number) => void;
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

      {/* voice → mouth + fire — a debug driver so we can tune lip-sync without TTS */}
      <div className="mb-2 rounded bg-white/[0.04] p-2">
        <div className="mb-1 flex items-center justify-between">
          <span>voice → mouth</span>
          <button
            onClick={() => onTalk(!dbgTalk)}
            className={`rounded px-2 py-0.5 ${
              dbgTalk ? 'bg-emerald-400/30 text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
            }`}
          >
            {dbgTalk ? 'talking…' : 'talk'}
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={dbgVoice ?? 0}
          onChange={(e) => {
            onTalk(false);
            onVoice(parseFloat(e.target.value));
          }}
          className="w-full accent-emerald-400/80"
        />
        <div className="mt-0.5 flex justify-between text-white/40">
          <span>{dbgVoice == null ? 'live (tts)' : `forced ${dbgVoice.toFixed(2)}`}</span>
          <button
            onClick={() => {
              onTalk(false);
              onVoice(null);
            }}
            className="underline hover:text-white/70"
          >
            live
          </button>
        </div>
      </div>

      {/* core → fire color: hue rotation toward the state color + readability aids */}
      <div className="mb-2 space-y-1.5 rounded bg-white/[0.04] p-2">
        <div className="font-medium text-white/70">core → fire color</div>
        {([
          ['hue', coreHue, onCoreHue],
          ['lum-preserve', coreLum, onCoreLum],
          ['face-protect', coreProtect, onCoreProtect],
          ['face Y', coreFaceY, onCoreFaceY],
        ] as [string, number, (v: number) => void][]).map(([label, value, set]) => (
          <label key={label} className="block">
            <span className="flex justify-between">
              <span>{label}</span>
              <span className="tabular-nums text-white/50">{value.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={value}
              onChange={(e) => set(parseFloat(e.target.value))}
              className="w-full accent-orange-400/80"
            />
          </label>
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
