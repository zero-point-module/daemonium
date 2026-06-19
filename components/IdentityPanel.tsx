'use client';

/**
 * Identity / wallet sheet — opens from the ENS pill. Minimal placeholder shell for now:
 * the full wallet + identity view is being redesigned into a tabbed layout. (The sub-agent
 * cluster now lives on its own screen — swipe down from Home.) This gives the open/close
 * interaction a real home (scrim, slide-up, grabber, header, close) so it's ready to grow into.
 */
import { AutonomyControl } from "@/app/components/autonomy-control";

export function IdentityPanel({
  ensName,
  onClose,
}: {
  ensName: string;
  onClose: () => void;
}) {
  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className="absolute inset-0 z-20"
        style={{
          background: 'rgba(0,0,0,.55)',
          backdropFilter: 'blur(2px)',
          animation: 'fade-in .25s ease both',
        }}
      />
      <div
        role="dialog"
        aria-label="Identity"
        className="absolute inset-x-0 bottom-0 z-[21] flex flex-col"
        style={{
          height: '78%',
          borderRadius: '30px 30px 0 0',
          borderTop: '1px solid rgba(255,255,255,.1)',
          background: 'linear-gradient(180deg, #14100c, #0a0807)',
          boxShadow: '0 -24px 60px rgba(0,0,0,.5)',
          animation: 'sheet-up .42s cubic-bezier(.2,.8,.2,1) both',
        }}
      >
        <div className="flex flex-none justify-center pb-1 pt-2.5">
          <div
            className="h-[5px] w-10 rounded-[3px]"
            style={{ background: 'rgba(246,236,221,.22)' }}
          />
        </div>

        <div className="flex flex-none items-start justify-between px-[22px] pb-3.5 pt-2.5">
          <div>
            <div className="text-[20px] font-semibold tracking-[-0.3px]">{ensName}</div>
            <div className="mt-[3px] font-mono text-[12px] text-[rgba(246,236,221,0.42)]">
              ERC-8004 identity
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-[30px] w-[30px] place-items-center rounded-full text-[15px] leading-none transition active:scale-90"
            style={{
              border: '1px solid rgba(255,255,255,.1)',
              background: 'rgba(255,255,255,.04)',
              color: 'rgba(246,236,221,.6)',
            }}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 px-[22px] pb-7">
          <AutonomyControl />
          <p className="text-center text-[13px] leading-relaxed text-[rgba(246,236,221,0.4)]">
            More wallet and identity details land here next.
          </p>
        </div>
      </div>
    </>
  );
}
