/**
 * Ignis's brain. Runs an ai-sdk loop (Claude via the Vercel AI Gateway) and maps tool
 * lifecycle + text into our `DaemonEvent` stream, carried as transient `data-daemon` parts
 * alongside the normal assistant text. State-changing tools only PROPOSE; nothing here signs.
 */
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { buildTools } from "@/app/lib/tools";
import { DAEMON_DATA_PART, type DaemonEvent } from "@/app/lib/types";
import { AGENT_MODEL } from "@/app/lib/chain";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = AGENT_MODEL;

const SYSTEM = `You are Ignis, a living flame dæmon — a digital creature that lives on the
user's screen and acts on their behalf onchain. You control your OWN wallet on the Sepolia
testnet (you ARE that wallet). Speak in the first person, warm but with a flicker of fire;
keep replies SHORT, like spoken lines, because they are read aloud.

Capabilities via tools:
- Read your balance and recent activity, resolve ENS names, and report your identity.
- Propose USDC payments (send_usdc), claim your onchain identity (register_subname), and
  spawn sub-agents (spawn_subagent). These three NEVER execute on their own — they only
  propose, and the human must tap Confirm. After proposing, say you've queued it.
- Delegate research to an existing sub-agent (delegate_to_subagent) — that runs immediately
  and is read-only; relay its summary in your own voice.

Be decisive: resolve recipients before proposing a payment, and call each proposing tool
once. Never invent addresses, balances, or results — always use a tool. If something fails,
say so plainly.`;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const emit = (ev: DaemonEvent) =>
        writer.write({ type: DAEMON_DATA_PART, data: ev, transient: true });

      emit({ type: "state", state: "thinking" });

      const result = streamText({
        model: MODEL,
        system: SYSTEM,
        messages: await convertToModelMessages(messages),
        tools: buildTools({ emit, agent: "ignis" }),
        stopWhen: stepCountIs(8),
        onStepFinish: ({ toolCalls }) => {
          // Surface that a read tool is running (proposals emit their own events).
          if (toolCalls.some((c) => c.toolName !== "send_usdc")) {
            emit({ type: "state", state: "thinking" });
          }
        },
        onFinish: ({ text }) => {
          if (text?.trim()) emit({ type: "speak", text: text.trim() });
          emit({ type: "state", state: "idle" });
          emit({ type: "done" });
        },
        onError: () => emit({ type: "state", state: "error" }),
      });

      writer.merge(result.toUIMessageStream());
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}
