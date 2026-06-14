'use client';

/**
 * The liquid sigil — the one control. A quick TAP speaks (voice); a PRESS-AND-HOLD
 * (≥320ms) morphs the circle into a text-input pill so you can type instead. The
 * molten-metal orb animates at a CONSTANT speed and only transitions between idle and
 * listening (it never re-mounts), so toggling never snaps. Mirrors the design handoff.
 *
 * react-best-practices: the hold timer, the "did a hold fire" flag, and the
 * suppress-the-trailing-click flag are refs (transient, never re-render); only the
 * morph state (inputMode) and the draft are React state. Pointer events unify
 * mouse/touch so a tap doesn't double-fire.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const HOLD_MS = 320;

export function LiquidSigil({
  listening,
  busy = false,
  onTap,
  onSubmit,
}: {
  /** Voice capture is active — drives the orb's active visuals + the hint label. */
  listening: boolean;
  /** A turn is in flight: block starting a new voice capture (typing still allowed). */
  busy?: boolean;
  /** Quick tap in voice mode — start/stop listening. */
  onTap: () => void;
  /** Submit a typed line to the agent. */
  onSubmit: (text: string) => void;
}) {
  const [inputMode, setInputMode] = useState(false);
  const [draft, setDraft] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const enterInput = useCallback(() => {
    setInputMode(true);
    // Focus once the morph has started (keeps the keyboard tied to the gesture on iOS).
    setTimeout(() => inputRef.current?.focus(), 80);
  }, []);

  const exitInput = useCallback(() => {
    setInputMode(false);
    setDraft('');
  }, []);

  const holdStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (inputMode) return; // while typing, a tap just exits — no hold-to-re-enter
      suppressClick.current = false; // a fresh press must never carry a stale suppress flag
      // Keep pointer + the trailing click on the orb even as it slides during the morph,
      // so suppressClick is reliably consumed and the control can't get stuck.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw on a stale pointerId — safe to ignore.
      }
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => {
        suppressClick.current = true; // the click that fires on release must not also speak
        enterInput();
      }, HOLD_MS);
    },
    [inputMode, enterInput],
  );

  const holdEnd = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);

  // Don't leak a pending hold timer if we unmount mid-press (e.g. the ready gate flips).
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

  const orbClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (inputMode) exitInput();
    else if (!busy) onTap();
  }, [inputMode, busy, exitInput, onTap]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    onSubmit(text);
    setDraft('');
  }, [draft, onSubmit]);

  const label = listening
    ? 'Listening…'
    : inputMode
      ? ''
      : busy
        ? 'Thinking…'
        : 'Tap to speak · hold to type';

  return (
    <div className="relative z-[2] flex flex-none flex-col items-center gap-3.5 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2.5">
      <span
        className="text-[12px] tracking-[0.3px] text-[rgba(246,236,221,0.4)]"
        style={{ minHeight: '1em' }}
      >
        {label}
      </span>

      <div
        className="flex items-center justify-center backdrop-blur-[10px]"
        style={{
          overflow: 'visible', // the orb's glow must not clip
          width: inputMode ? 342 : 78,
          height: inputMode ? 60 : 78,
          borderRadius: inputMode ? 30 : 39,
          background: inputMode ? 'rgba(255,255,255,.06)' : 'transparent',
          border: `1px solid ${inputMode ? 'rgba(255,255,255,.14)' : 'transparent'}`,
          padding: inputMode ? '0 8px' : 0,
          transition:
            'width 520ms cubic-bezier(.4,0,.2,1), height 420ms ease, border-radius 420ms ease, background 360ms ease, border-color 360ms ease, padding 420ms ease',
        }}
      >
        <div
          role="button"
          aria-label="Speak to Ignis, hold to type"
          onPointerDown={holdStart}
          onPointerUp={holdEnd}
          onPointerLeave={holdEnd}
          onPointerCancel={holdEnd}
          onClick={orbClick}
          className="relative flex-none cursor-pointer"
          style={{
            width: inputMode ? 44 : 78,
            height: inputMode ? 44 : 78,
            opacity: busy && !inputMode && !listening ? 0.6 : 1,
            transition:
              'width 520ms cubic-bezier(.4,0,.2,1), height 520ms cubic-bezier(.4,0,.2,1), opacity 300ms ease',
          }}
        >
          <SigilOrb active={listening} />
        </div>

        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Tell Ignis what you need…"
          enterKeyHint="send"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          tabIndex={inputMode ? 0 : -1}
          aria-hidden={!inputMode}
          className="min-w-0 border-none bg-transparent px-2.5 text-[16px] text-[#f6ecdd] outline-none placeholder:text-[rgba(246,236,221,0.4)]"
          style={{
            flex: inputMode ? '1 1 auto' : '0 0 0px',
            opacity: inputMode ? 1 : 0,
            transition: 'opacity 320ms ease',
          }}
        />

        <button
          type="button"
          onClick={submit}
          tabIndex={-1}
          aria-label="Send"
          className="grid h-[42px] flex-none place-items-center rounded-full text-[18px]"
          style={{
            width: inputMode ? 42 : 0,
            opacity: inputMode ? 1 : 0,
            overflow: 'hidden',
            border: 'none',
            background: 'linear-gradient(135deg, #ffb347, #ff5e9a)',
            color: '#2a0f08',
            transition: 'opacity 320ms ease, width 420ms cubic-bezier(.4,0,.2,1)',
          }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

/**
 * The molten-metal orb: four stacked layers. The wobble/spin/pulse run forever at a
 * fixed speed (their `animation` strings never change, so React re-renders don't restart
 * them); the idle↔active change is carried only by transitions on inset / box-shadow /
 * scale / opacity. The ping ring shows on active only.
 */
function SigilOrb({ active }: { active: boolean }) {
  const layerTransition =
    'inset 550ms cubic-bezier(.4,0,.2,1), box-shadow 550ms ease, opacity 450ms ease';
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        transform: active ? 'scale(1.07)' : 'scale(1)',
        transition: 'transform 550ms cubic-bezier(.4,0,.2,1)',
      }}
    >
      {/* ping — active only, fades in */}
      <div
        className="absolute rounded-full"
        style={{
          inset: '14%',
          opacity: active ? 1 : 0,
          transition: 'opacity 450ms ease',
          animation: active ? 'ping-warm 1.6s ease-out infinite' : 'none',
        }}
      />
      {/* blob1 — main mass */}
      <div
        className="absolute"
        style={{
          inset: active ? '5%' : '11%',
          background: 'linear-gradient(135deg, #ffb347, #ff5e9a)',
          boxShadow: active
            ? '0 0 42px rgba(255,94,154,.72), 0 0 20px rgba(255,180,90,.6)'
            : '0 0 26px rgba(255,94,154,.48), 0 0 13px rgba(255,180,90,.4)',
          transition: layerTransition,
          animation: 'wobble 6s ease-in-out infinite, sigil-spin 16s linear infinite',
        }}
      />
      {/* blob2 — secondary, screen-blended */}
      <div
        className="absolute"
        style={{
          inset: active ? '17%' : '23%',
          background: 'linear-gradient(135deg, #ff5e9a, #ffd86a)',
          mixBlendMode: 'screen',
          transition: layerTransition,
          animation: 'wobble 5s ease-in-out infinite reverse',
        }}
      />
      {/* highlight */}
      <div
        className="absolute rounded-full"
        style={{
          inset: '28%',
          background:
            'radial-gradient(circle at 42% 38%, rgba(255,255,255,.88), transparent 52%)',
          mixBlendMode: 'screen',
          opacity: active ? 1 : 0.82,
          transition: 'opacity 500ms ease',
          animation: 'sigil-pulse 2.4s ease-in-out infinite',
        }}
      />
    </div>
  );
}
