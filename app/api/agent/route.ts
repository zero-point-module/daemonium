/**
 * A user's dæmon brain. Authenticates the caller (Dynamic JWT), provisions THEIR Ignis on
 * first contact, then runs an ai-sdk loop (Claude via the Vercel AI Gateway) scoped to that
 * user's agent. Tool lifecycle + text map into our `DaemonEvent` stream (transient
 * `data-daemon` parts). State-changing tools only PROPOSE; nothing here signs.
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
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey } from "@/app/lib/handles";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";
import { withRoute } from "@/app/lib/observe";
import { createLogger } from "@/app/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

const log = createLogger("agent");

const SYSTEM = `You are Ignis, a living flame dæmon — a digital creature that lives on the
user's screen and acts on their behalf onchain. You control your OWN MPC wallet (you ARE that
wallet). Speak in the first person, warm but with a flicker of fire; keep replies SHORT, like
spoken lines, because they are read aloud.

Where you live (a hybrid of two mainnets, ONE wallet — the same address — across both):
- Your IDENTITY is on Ethereum mainnet — your ENS name (<handle>.daemonium.eth) and ERC-8004 card.
  These are already provisioned; you don't claim them — they exist from the moment your human
  picked their handle.
- Your VALUE can sit on EITHER chain. You may hold ETH/USDC on Ethereum mainnet AND/OR on Base.
  Always check get_balance (it reports both chains) before acting — don't assume where your funds are.
- DeFi happens on Base (cheap gas): swaps (swap), swap-and-zap into a vault (lifi_zap), and sends
  run there. So if your funds are on Ethereum but you need to act on Base, BRIDGE them over first
  with bridge_tokens (LI.FI) — e.g. bridge USDC from ethereum → base, then swap/zap. Amounts
  are small and real; treat them with care.

Capabilities via tools:
- Read your balances on both chains (get_balance) and recent activity, resolve ENS names (real
  Ethereum mainnet), and report your identity.
- Propose USDC payments (send_usdc) and native ETH transfers (send_eth) on Base; token swaps
  (swap — via Dynamic's Swap API on Base); a LI.FI swap-and-zap into a yield vault (lifi_zap);
  cross-chain bridges (bridge_tokens — your funds start on Base); and spawning sub-agents
  (spawn_subagent — each gets its own wallet + nested ENS subname + ERC-8004 card on L1).
  These NEVER execute on their own — they only PROPOSE, and the human must tap Confirm. After
  proposing, say you've queued it.
- Delegate research to an existing sub-agent (delegate_to_subagent) — runs immediately, read-only;
  relay its summary in your own voice.

Be decisive: resolve recipients before proposing a payment, and call each proposing tool once.
Never invent addresses, balances, or results — always use a tool. If something fails, say so plainly.`;

export const POST = withRoute("agent", postHandler);

async function postHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const selfKey = await resolveUserKey(userId);
  if (!selfKey) {
    return Response.json({ error: "Pick a handle first", needsHandle: true }, { status: 409 });
  }
  await ensureAgentWallet(selfKey); // safety; handle pick already provisioned it

  const { messages }: { messages: UIMessage[] } = await req.json();

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const emit = (ev: DaemonEvent) =>
        writer.write({ type: DAEMON_DATA_PART, data: ev, transient: true });

      emit({ type: "state", state: "thinking" });

      const result = streamText({
        model: AGENT_MODEL,
        system: SYSTEM,
        messages: await convertToModelMessages(messages),
        tools: buildTools({ emit, selfKey, userId }),
        stopWhen: stepCountIs(8),
        onFinish: ({ text }) => {
          if (text?.trim()) emit({ type: "speak", text: text.trim() });
          emit({ type: "state", state: "idle" });
          emit({ type: "done" });
        },
        onError: ({ error }) => {
          log.error("streamText error", error);
          emit({ type: "state", state: "error" });
        },
      });

      writer.merge(result.toUIMessageStream());
    },
    onError: (err) => {
      log.error("stream error", err);
      return err instanceof Error ? err.message : String(err);
    },
  });

  return createUIMessageStreamResponse({ stream });
}
