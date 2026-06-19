"use client";

/**
 * Autonomy control — grant or revoke the dæmon's session key, PER CHAIN. Default is per-action
 * co-sign (you sign each action); granting on a chain lets the dæmon act on its own there —
 * including ETH sends — until the grant expires, with per-tx caps still enforced server-side and
 * revocable any time. One row per chain (Base for DeFi, Ethereum for L1 ETH sends).
 */
import { base, mainnet } from "viem/chains";
import { useAutonomy } from "../lib/useAutonomy";

export function AutonomyControl() {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm">
      <span className="text-xs uppercase tracking-wide text-zinc-500">Autonomy</span>
      <p className="text-xs text-zinc-500">
        Grant once per chain to let your dæmon transact on its own (sends, swaps, ETH) until the
        grant expires. Per-tx caps still apply; revoke any time.
      </p>
      <ChainRow chainId={base.id} label="Base" />
      <ChainRow chainId={mainnet.id} label="Ethereum" />
    </section>
  );
}

function ChainRow({ chainId, label }: { chainId: number; label: string }) {
  const a = useAutonomy(chainId);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-800/70 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-zinc-300">{label}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            a.active ? "bg-orange-500/20 text-orange-300" : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {a.active ? "autonomous" : "co-sign"}
        </span>
      </div>

      {a.error && <p className="text-xs text-red-400">{a.error}</p>}

      {a.active ? (
        <button
          type="button"
          onClick={() => void a.revoke()}
          disabled={a.busy}
          className="self-start rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          {a.busy ? "Revoking…" : `Revoke ${label}`}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void a.grant({ maxUsdc: 25, days: 7 })}
          disabled={a.busy}
          className="self-start rounded-md bg-orange-500 px-3 py-1.5 font-medium text-black hover:bg-orange-400 disabled:opacity-40"
        >
          {a.busy ? "Signing grant…" : `Grant ${label} (7 days)`}
        </button>
      )}
    </div>
  );
}
