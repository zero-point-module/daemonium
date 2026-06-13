/**
 * Scripted DaemonEvent emitter — lets Workstream A build the flame against the real
 * event shapes before /api/agent exists. Drives a believable "send USDC" flow:
 * listening → thinking → speak → proposal → (caller confirms) → executing → success.
 *
 * Usage (client):
 *   for await (const ev of mockAgentRun("send 1 usdc to alice.eth")) { drive(ev); }
 */
import type { DaemonEvent } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* mockAgentRun(
  prompt = "send 1 USDC to research.ignis.daemonium.eth",
): AsyncGenerator<DaemonEvent> {
  yield { type: "state", state: "listening" };
  await sleep(500);

  yield { type: "state", state: "thinking" };
  await sleep(900);

  yield { type: "speak", text: `On it — "${prompt}". Let me line that up.` };
  await sleep(600);

  const executionId = "mock-exec-1";
  yield {
    type: "proposal",
    card: {
      executionId,
      action: "send_usdc",
      agent: "ignis",
      summary: "Send 1 USDC to research.ignis.daemonium.eth",
      details: {
        action: "send_usdc",
        to: "0x0000000000000000000000000000000000000000",
        toEns: "research.ignis.daemonium.eth",
        amount: "1",
      },
    },
  };

  // In the real flow the human now taps Confirm; the mock just pauses, then proceeds.
  await sleep(1500);

  yield { type: "state", state: "executing" };
  await sleep(1200);

  yield {
    type: "txResult",
    executionId,
    ok: true,
    hash: "0xmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmock01",
  };
  yield { type: "state", state: "success" };
  yield { type: "speak", text: "Done — 1 USDC is on its way." };
  await sleep(400);

  yield { type: "done" };
}
