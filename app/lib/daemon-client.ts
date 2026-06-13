"use client";

/**
 * Client hook bridging the agent stream to the UI. Wraps ai-sdk's useChat (pointed at
 * /api/agent), collects our `data-daemon` events into flame state + pending proposal, and
 * exposes confirm(), which POSTs the opaque executionId to /api/daemon/execute (the only
 * signer) and then feeds the outcome back so Ignis can react.
 */
import { useCallback, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type {
  DaemonEvent,
  DaemonState,
  ProposalCard,
  ExecuteResponse,
} from "./types";

export function useDaemon() {
  const [state, setState] = useState<DaemonState>("idle");
  const [proposal, setProposal] = useState<ProposalCard | null>(null);
  const [txResult, setTxResult] = useState<
    (ExecuteResponse & { executionId: string }) | null
  >(null);

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/agent" }),
    onData: (part) => {
      if (part.type !== "data-daemon") return;
      const ev = part.data as DaemonEvent;
      switch (ev.type) {
        case "state":
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
      setTxResult(null);
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ executionId }),
        }).then((r) => r.json())) as ExecuteResponse;

        setTxResult({ ...res, executionId });
        setState(res.ok ? "success" : "error");
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
