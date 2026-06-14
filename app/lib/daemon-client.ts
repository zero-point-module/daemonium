"use client";

/**
 * Client hook bridging the agent stream to the UI. Wraps ai-sdk's useChat (pointed at
 * /api/agent), collects our `data-daemon` events into flame state + pending proposal, and
 * exposes confirm(), which POSTs the opaque executionId to /api/daemon/execute (the only
 * signer) and then feeds the outcome back so Ignis can react.
 */
import { useCallback, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { getAuthToken } from "@dynamic-labs/sdk-react-core";
import type {
  DaemonEvent,
  DaemonState,
  ProposalCard,
  ExecuteResponse,
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
  // After a confirmed action, hold the success/error face through Ignis's spoken
  // reaction so that follow-up turn doesn't snap the flame back to "thinking".
  const reacting = useRef(false);

  const { messages, sendMessage, status } = useChat({
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

  const confirm = useCallback(
    async (executionId: string) => {
      setProposal(null);
      setState("executing");
      try {
        const res = (await fetch("/api/daemon/execute", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ executionId }),
        }).then((r) => r.json())) as ExecuteResponse;

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
      }
    },
    [sendMessage],
  );

  const dismissProposal = useCallback(() => setProposal(null), []);

  return {
    messages,
    status,
    state,
    proposal,
    txResult,
    sendPrompt,
    confirm,
    dismissProposal,
  };
}
