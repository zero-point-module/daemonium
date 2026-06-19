"use client";

/**
 * First-login handle picker. The user chooses a handle → their dæmon is provisioned at
 * <handle>.daemonium.eth (ENS subtree + ERC-8004 + text record, all minted by the
 * minter). This POST is slow (several Ethereum txs), so we show a "summoning" state.
 *
 * Error handling: a 409 (taken/reserved) lets the user pick another; a 500 means the handle was
 * already reserved for them but minting hiccupped — we lock to that handle and offer a retry
 * (provisioning is idempotent), since a different handle is no longer possible.
 */
import { useState } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { authHeaders } from "../lib/daemon-client";
import { validateHandle, HANDLE_ERROR_MESSAGE, normalizeHandle } from "../lib/handle-format";

export function HandleModal({ onDone }: { onDone: (ensName: string) => void }) {
  // The embedded-wallet EOA — sudo owner of the smart account the claim provisions.
  const { primaryWallet } = useDynamicContext();
  const ownerEoa = primaryWallet?.address ?? null;
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a 500 reserves the handle to this user — locks the input + switches to retry.
  const [reserved, setReserved] = useState<string | null>(null);

  const normalized = reserved ?? normalizeHandle(handle);
  const clientError = validateHandle(normalized);
  const canSubmit = !busy && (reserved !== null || clientError === null);

  async function submit() {
    setError(null);
    if (!ownerEoa) {
      setError("Connect your wallet first — your smart account is owned by it.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/daemon/handle", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ handle: normalized, ownerEoa }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onDone(data.ensName ?? `${normalized}.daemonium.eth`);
        return;
      }
      if (res.status === 500 && data.handle) {
        // Handle is committed to this user; only a retry of the SAME handle can succeed now.
        setReserved(data.handle);
        setError("Your name is reserved, but minting hit a snag. Retry to finish summoning.");
      } else {
        setError(data.error ?? "Could not claim that handle.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <div>
        <h2 className="text-lg font-semibold text-orange-400">Summon your dæmon</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Pick a handle. Your Ignis will live at{" "}
          <span className="font-mono text-orange-300">
            {normalized || "<handle>"}.daemonium.eth
          </span>
          .
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-zinc-700 bg-black px-3 py-2 font-mono text-sm">
        <input
          autoFocus
          value={reserved ?? handle}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && canSubmit && submit()}
          placeholder="handle"
          disabled={busy || reserved !== null}
          className="flex-1 bg-transparent text-orange-300 placeholder:text-zinc-600 focus:outline-none disabled:opacity-70"
        />
        <span className="text-zinc-500">.daemonium.eth</span>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {!error && !reserved && handle && clientError && (
        <p className="text-xs text-zinc-500">{HANDLE_ERROR_MESSAGE[clientError]}</p>
      )}

      <button
        onClick={submit}
        disabled={!canSubmit}
        className="rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-black hover:bg-orange-400 disabled:opacity-40"
      >
        {busy
          ? "Summoning Ignis… (minting on Ethereum, ~30s)"
          : reserved
            ? "Retry minting"
            : "Summon"}
      </button>
    </div>
  );
}
