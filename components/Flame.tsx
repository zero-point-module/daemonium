import type { DaemonState } from '@/lib/types';
import { STATE_IMAGE } from '@/lib/stateMeta';

// Unique set of art sources, so we stack each PNG only once.
const IMAGE_SRCS = Array.from(new Set(Object.values(STATE_IMAGE)));

/**
 * The flame slot.
 *
 * A0/skeleton: a state-colored glow halo + the real Ignis art, crossfading
 * between pre-rendered PNGs, with a gentle CSS "breathing" scale. Black pixels
 * read as transparent via `screen` blending against the near-black room.
 *
 * SWAP POINT FOR A1: replace the <img> stack with a WebGL <canvas> running the
 * heat-distortion shader + additive compositing + hue-rotation. The public
 * Flame(props) stays the same, so nothing else in the app changes.
 */
export function Flame({ state }: { state: DaemonState }) {
  const activeSrc = STATE_IMAGE[state];

  return (
    <div
      role="img"
      aria-label="Ignis, a living flame"
      className="relative aspect-square w-[72vw] max-w-[360px] select-none"
    >
      {/* glow halo behind the character, tinted by the live state color */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 rounded-full blur-3xl"
        style={{
          background:
            'radial-gradient(closest-side, color-mix(in srgb, var(--state, #ff7a18) 70%, transparent), transparent 72%)',
          animation: 'glow-pulse 4s ease-in-out infinite',
        }}
      />

      {/* the character art — crossfaded by state, breathing continuously */}
      <div
        className="absolute inset-0"
        style={{ animation: 'breathe 4s ease-in-out infinite' }}
      >
        {IMAGE_SRCS.map((src) => (
          <img
            key={src}
            src={src}
            alt=""
            draggable={false}
            loading="eager"
            className="absolute inset-0 h-full w-full object-contain transition-opacity duration-500 ease-out"
            style={{
              opacity: src === activeSrc ? 1 : 0,
              mixBlendMode: 'screen',
            }}
          />
        ))}
      </div>
    </div>
  );
}
