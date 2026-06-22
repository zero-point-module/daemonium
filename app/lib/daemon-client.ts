"use client";

/**
 * Client hook bridging the agent stream to the UI. Wraps ai-sdk's useChat (pointed at
 * /api/agent), collects our `data-daemon` events into flame state + pending proposal, and
 * exposes confirm(), which POSTs the opaque executionId to /api/daemon/execute (the only
 * signer) and then feeds the outcome back so Ignis can react.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { getAuthToken } from "@dynamic-labs/sdk-react-core";
import { useWalletClient } from "wagmi";
import type { Address, Hex } from "viem";
import { coSignAndSubmit, type ConnectedWalletClient } from "./smart-account-client";
import type {
  DaemonAction,
  DaemonEvent,
  DaemonState,
  ProposalCard,
  ExecuteResponse,
  PrepareResponse,
} from "./types";

/** Authorization header carrying the Dynamic session JWT, resolved at request time. */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useDaemon() {
  const [state, setState] = useState<DaemonState>("idle");
  const [proposal, setProposal] = useState<ProposalCard | null>(null);
  const [txResult, setTxResult] = useState<
    (ExecuteResponse & { executionId: string }) | null
  >(null);
  // While a confirmed action is signing+broadcasting (the `executing` await), the proposal card
  // is gone and the outcome isn't in yet — so the only thing on screen would be the flame. We
  // remember WHICH action is in flight so the confirm zone can show an honest "Sending USDC…"
  // working line through the wait. Null when nothing is executing.
  const [executingAction, setExecutingAction] = useState<DaemonAction | null>(null);
  // Latest proposal, mirrored into a ref so confirm() (a stable callback) can read which action
  // it is confirming without re-creating itself on every proposal change. Written post-commit
  // (in an effect, not during render) per the Rules of React.
  const proposalRef = useRef<ProposalCard | null>(null);
  useEffect(() => {
    proposalRef.current = proposal;
  });
  // After a confirmed action, hold the success/error face through Ignis's spoken
  // reaction so that follow-up turn doesn't snap the flame back to "thinking".
  const reacting = useRef(false);

  // The user's embedded wallet (bridged via wagmi) — the sudo owner that co-signs UserOps.
  const { data: walletClient } = useWalletClient();

  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/agent", headers: authHeaders }),
    onData: (part) => {
      if (part.type !== "data-daemon") return;
      const ev = part.data as DaemonEvent;
      switch (ev.type) {
        case "state":
          // While reacting to a just-confirmed action, ignore that turn's "thinking"
          // so the success/error face lingers; the closing idle releases the hold.
          if (reacting.current) {
            if (ev.state === "thinking") break;
            reacting.current = false;
          }
          setState(ev.state);
          break;
        case "proposal":
          setProposal(ev.card);
          break;
        case "txResult":
          setTxResult(ev);
          break;
        // "speak"/"subagentResult"/"done" — text already streams into messages.
      }
    },
    // A request-level failure (pre-stream 500, network drop) never emits a data-daemon state event,
    // so reset here instead of leaving the flame hung on the optimistic "thinking".
    onError: () => {
      reacting.current = false;
      setState("error");
    },
  });

  const sendPrompt = useCallback(
    (text: string) => {
      reacting.current = false; // a fresh user turn always thinks normally
      setTxResult(null);
      // Optimistic: flip the flame to `thinking` on the tap, not after the model's first
      // token (~1.8s away). The stream re-emits `thinking` so this just removes the gap.
      setState("thinking");
      void sendMessage({ text });
    },
    [sendMessage],
  );

  /** Barge-in: abort the in-flight agent turn and drop the flame back to idle. No-op when nothing
   *  is streaming. */
  const stopStream = useCallback(() => {
    void stop();
    reacting.current = false;
    setState("idle");
  }, [stop]);

  const confirm = useCallback(
    async (executionId: string) => {
      setExecutingAction(proposalRef.current?.action ?? null);
      setProposal(null);
      setState("executing");
      try {
        // 1. Ask the server how this runs: executed server-side, or co-sign here.
        const prepRes = await fetch("/api/daemon/execute", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ executionId }),
        });
        if (!prepRes.ok) {
          // Surface the server's real reason (e.g. "proposal already used") instead of letting an
          // error body fall through and crash as a TypeError on prep.calls.
          const body = (await prepRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Couldn't prepare the action (${prepRes.status}).`);
        }
        const prep = (await prepRes.json()) as PrepareResponse;

        let res: ExecuteResponse;
        if (prep.mode === "server") {
          // Spawn, or an autonomous session key already signed + broadcast it.
          res = { ok: prep.ok, hash: prep.hash, error: prep.error, chainId: prep.chainId };
        } else {
          // 2. Co-sign: the user's embedded wallet signs the UserOp built from the stored proposal.
          if (!walletClient) throw new Error("Connect your wallet to confirm this action.");
          const calls = prep.calls.map((c) => ({
            to: c.to as Address,
            data: c.data as Hex,
            value: BigInt(c.value),
          }));
          const hash = await coSignAndSubmit({
            walletClient: walletClient as ConnectedWalletClient,
            calls,
            chainId: prep.chainId,
          });
          // 3. Record + consume the proposal now that the UserOp landed.
          const completeRes = await fetch("/api/daemon/execute/complete", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify({ executionId, hash, ok: true, chainId: prep.chainId }),
          });
          if (completeRes.ok) {
            res = (await completeRes.json()) as ExecuteResponse;
            if (!res.hash) res.hash = hash;
          } else {
            // The UserOp already landed on-chain (we have `hash`); only the server-side bookkeeping
            // failed. Report success — telling the user it failed would be wrong.
            res = { ok: true, hash, chainId: prep.chainId };
          }
        }

        setTxResult({ ...res, executionId });
        setState(res.ok ? "success" : "error");
        reacting.current = true; // keep that face through the reaction below
        void sendMessage({
          text: res.ok
            ? `Confirmed. The transaction went through (hash ${res.hash}). React briefly.`
            : `I confirmed, but it failed: ${res.error}. React briefly.`,
        });
      } catch (err) {
        setState("error");
        setTxResult({
          ok: false,
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setExecutingAction(null); // wait's over — the outcome (txResult) takes the stage
      }
    },
    [sendMessage, walletClient],
  );

  const dismissProposal = useCallback(() => setProposal(null), []);

  return {
    messages,
    status,
    state,
    proposal,
    txResult,
    executingAction,
    sendPrompt,
    stopStream,
    confirm,
    dismissProposal,
  };
}
