"use client";

/**
 * Dev console for Workstream B — a text stand-in for the voice loop + flame. Lets you talk
 * to Ignis, watch the flame state, and approve proposals. Workstream A replaces this with
 * the animated flame, but it consumes the exact same useDaemon() seam.
 */
import { useState } from "react";
import { useDaemon } from "../lib/daemon-client";
import { explorerTx } from "../lib/chain";
import type { DaemonState } from "../lib/types";

const STATE_COLOR: Record<DaemonState, string> = {
  idle: "bg-zinc-600",
  listening: "bg-sky-500",
  thinking: "bg-amber-500 animate-pulse",
  delegating: "bg-violet-500 animate-pulse",
  executing: "bg-orange-500 animate-pulse",
  success: "bg-emerald-500",
  error: "bg-red-500",
};

function messageText(m: { parts: Array<{ type: string; text?: string }> }): string {
  return m.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

export function Console() {
  const {
    messages,
    status,
    state,
    proposal,
    txResult,
    sendPrompt,
    confirm,
    dismissProposal,
  } = useDaemon();
  const [input, setInput] = useState("");

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={`h-3 w-3 rounded-full ${STATE_COLOR[state]}`} />
        <span className="font-mono text-zinc-400">ignis · {state}</span>
      </div>

      <div className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm">
        {messages.map((m) => {
          const text = messageText(m);
          if (!text) return null;
          return (
            <div
              key={m.id}
              className={m.role === "user" ? "text-zinc-400" : "text-orange-200"}
            >
              <span className="text-xs uppercase tracking-wide text-zinc-600">
                {m.role === "user" ? "you" : "ignis"}{" "}
              </span>
              {text}
            </div>
          );
        })}
      </div>

      {proposal && (
        <div className="flex flex-col gap-2 rounded-md border border-orange-500/40 bg-orange-500/5 p-3 text-sm">
          <span className="text-xs uppercase tracking-wide text-orange-400">
            Confirm · {proposal.action}
          </span>
          <span className="text-zinc-100">{proposal.summary}</span>
          <div className="flex gap-2">
            <button
              onClick={() => confirm(proposal.executionId)}
              className="rounded-md bg-orange-500 px-3 py-1 font-medium text-black hover:bg-orange-400"
            >
              Confirm
            </button>
            <button
              onClick={dismissProposal}
              className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {txResult && (
        <div className="text-xs">
          {txResult.ok ? (
            <a
              href={explorerTx(txResult.hash!)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:underline"
            >
              ✓ tx {txResult.hash?.slice(0, 14)}… (view on Etherscan)
            </a>
          ) : (
            <span className="text-red-400">✗ {txResult.error}</span>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          sendPrompt(input.trim());
          setInput("");
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Talk to Ignis — e.g. “what's my balance?” or “send 1 USDC to vitalik.eth”"
          className="flex-1 rounded-md border border-zinc-700 bg-black px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-orange-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={status === "streaming" || status === "submitted"}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
