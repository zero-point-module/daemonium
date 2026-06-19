"use client";

/**
 * Autonomy control — grant or revoke the dæmon's scoped session key. Default mode is per-action
 * co-sign (the user signs each action); granting autonomy lets the dæmon act on its own within
 * on-chain limits (target allowlist + caps + a 7-day expiry), revocable here at any time.
 */
import { useAutonomy } from "../lib/useAutonomy";

export function AutonomyControl() {
  const a = useAutonomy();

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-zinc-500">Autonomy</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            a.active ? "bg-orange-500/20 text-orange-300" : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {a.active ? "autonomous (within limits)" : "co-sign every action"}
        </span>
      </div>

      <p className="text-xs text-zinc-500">
        {a.active
          ? "Your dæmon can act on its own within the limits you signed. Revoke any time."
          : "You confirm and sign each action. Grant a scoped session key to let your dæmon act autonomously within limits."}
      </p>

      {a.sessionSignerAddress && (
        <p className="break-all font-mono text-[11px] text-zinc-600">
          session key: {a.sessionSignerAddress}
        </p>
      )}

      {a.error && <p className="text-xs text-red-400">{a.error}</p>}

      <div className="flex gap-2">
        {a.active ? (
          <button
            onClick={() => void a.revoke()}
            disabled={a.busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {a.busy ? "Revoking…" : "Revoke autonomy"}
          </button>
        ) : (
          <button
            onClick={() => void a.grant({ maxUsdc: 25, days: 7 })}
            disabled={a.busy}
            className="rounded-md bg-orange-500 px-3 py-1.5 font-medium text-black hover:bg-orange-400 disabled:opacity-40"
          >
            {a.busy ? "Signing grant…" : "Grant autonomy (≤$25, 7 days)"}
          </button>
        )}
      </div>
    </section>
  );
}
