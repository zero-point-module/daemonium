// Quick-action chips. Each one feeds an utterance through the same path a
// spoken request will (useDaemon.run), so the skeleton already exercises the
// event protocol end-to-end against the mock.
const CHIPS: { label: string; utterance: string }[] = [
  { label: 'Balance', utterance: "what's my balance" },
  { label: 'Send', utterance: 'send 2 usdc to alejandro.eth' },
  { label: 'Research', utterance: 'research this token' },
  { label: 'Who are you?', utterance: 'who are you' },
];

export function QuickActions({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (utterance: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {CHIPS.map((c) => (
        <button
          key={c.label}
          type="button"
          disabled={busy}
          onClick={() => onPick(c.utterance)}
          className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/80 backdrop-blur-sm transition active:scale-95 hover:bg-white/[0.07] disabled:opacity-40"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
