"use client";

/**
 * Gates its children behind the user having a FULLY provisioned dæmon (handle + ENS subtree +
 * ERC-8004). Shows the picker until a handle exists; if a handle exists but identity didn't
 * finish (e.g. a mint reverted on an earlier attempt), it re-runs provisioning idempotently —
 * so half-provisioned accounts self-heal on next login instead of being stuck. Mount only when
 * logged in.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { authHeaders } from "../lib/daemon-client";
import { HandleModal } from "./handle-modal";

type State =
  | { status: "checking" }
  | { status: "needs-handle" }
  | { status: "completing"; handle: string }
  | { status: "ready"; ensName: string }
  | { status: "error"; message?: string };

export function HandleGate({
  children,
}: {
  children: ReactNode | ((ensName: string) => ReactNode);
}) {
  const { primaryWallet } = useDynamicContext();
  const ownerEoa = primaryWallet?.address ?? null;
  const [state, setState] = useState<State>({ status: "checking" });
  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  // 1. Check whether the user has a handle and whether identity is complete.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ status: "checking" });
      try {
        const res = await fetch("/api/daemon/handle", { headers: authHeaders() });
        if (!res.ok) {
          if (!cancelled) setState({ status: "error" });
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (!data.handle) setState({ status: "needs-handle" });
        else if (data.smartAccount) setState({ status: "ready", ensName: data.ensName });
        else setState({ status: "completing", handle: data.handle }); // bind SA / finish setup
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 2. Finish provisioning for a handle that exists but isn't fully claimed yet (idempotent).
  useEffect(() => {
    if (state.status !== "completing") return;
    if (!ownerEoa) return; // wait until the embedded wallet (SA owner) is available
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/daemon/handle", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ handle: state.handle, ownerEoa }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.smartAccount) setState({ status: "ready", ensName: data.ensName });
        else setState({ status: "error", message: data.error });
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, ownerEoa]);

  if (state.status === "checking") {
    return <p className="text-sm text-zinc-500">Checking your dæmon…</p>;
  }
  if (state.status === "completing") {
    return (
      <p className="text-sm text-zinc-500">
        Finishing your dæmon&apos;s setup (minting on Ethereum, ~30s)…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-red-400">{state.message ?? "Couldn't reach your dæmon."}</p>
        <button
          onClick={retry}
          className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800"
        >
          Retry
        </button>
      </div>
    );
  }
  if (state.status === "needs-handle") {
    return <HandleModal onDone={(ensName) => setState({ status: "ready", ensName })} />;
  }
  return <>{typeof children === "function" ? children(state.ensName) : children}</>;
}
