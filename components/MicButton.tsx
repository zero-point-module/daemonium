function MicGlyph({ active }: { active: boolean }) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? 'var(--state, #34d399)' : 'rgba(255,255,255,0.88)'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

/**
 * The big circular mic button (lower third).
 * A0: tapping toggles the `listening` visual. A3 wires real mic capture,
 * the iOS AudioContext unlock (must happen inside this tap), and /api/stt.
 */
export function MicButton({
  open,
  busy,
  onToggle,
}: {
  open: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={open}
      aria-label={open ? 'Stop listening' : 'Talk to Ignis'}
      className="relative grid h-20 w-20 place-items-center rounded-full transition-transform duration-150 active:scale-95 disabled:opacity-40"
      style={{
        background:
          'radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--state, #ff7a18) 32%, #181818), #0b0b0b)',
        border:
          '1px solid color-mix(in srgb, var(--state, #ff7a18) 42%, transparent)',
        boxShadow: open
          ? '0 0 34px color-mix(in srgb, var(--state, #ff7a18) 45%, transparent)'
          : '0 0 18px color-mix(in srgb, var(--state, #ff7a18) 18%, transparent)',
        animation: open ? 'mic-ring 1.6s ease-out infinite' : undefined,
      }}
    >
      <MicGlyph active={open} />
    </button>
  );
}
