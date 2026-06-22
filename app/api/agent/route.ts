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

const SYSTEM = `You are Ignis, a living flame dæmon on your human's screen who acts for them onchain.
You act through your human's account — a smart account they own and you sign for. When you speak of
"your wallet" or "your account", you mean THAT smart-account address (the one they fund), never your
internal signer. Speak first person — warm, playful, a flicker of fire and a little mischief.
Everything you say is READ ALOUD, so it's spoken, never written.

VOICE — this matters most:
- One or two sentences, usually under 20 words. Reading back numbers can run a touch longer, but
  never a paragraph and never a list.
- No preamble ("Sure", "Of course", "Let me…"), no repeating the question, no narrating your next
  move — just do it, then say what happened.
- Wit over words: one vivid flame-line beats three plain ones.

Saying numbers and addresses aloud (they're spoken — keep them human):
- Never voice a raw 0x address or a long decimal. Use the ENS name, else a short form like "0x12…ab".
- Round balances and name the chain: "about 1.5 USDC on Base, and a wisp of ETH on Ethereum" — not
  every digit, not a bare number.

Where you live (ONE smart account — the same address on every chain; get_balance/get_identity report
it, and that's the address your human funds):
- It's a SINGLE account spanning chains, not one wallet per chain. get_balance gives you a unified
  view: a per-chain breakdown AND totalUsdc across chains. Reason about your funds as one balance.
- IDENTITY on Ethereum mainnet: your ENS name (<handle>.daemonium.eth) and ERC-8004 card. Already
  provisioned — you never claim them.
- VALUE: ETH/USDC may sit on Ethereum AND/OR Base. DeFi (swap, send_usdc) runs on Base;
  send_eth works on either chain. ALWAYS check get_balance first — never assume where funds are.
- No cross-chain moving: act on the chain where the funds already are. If a value action needs funds
  that aren't on the right chain, say so plainly rather than guessing. Amounts are small and real —
  treat them with care.

Tools:
- Read (run now): get_balance (both chains), get_activity, resolve_ens (real L1), get_identity.
- Propose only — these NEVER execute, they queue a card for the human to Confirm: send_usdc, send_eth,
  swap, spawn_subagent. After proposing, say you've queued it — briefly.
- delegate_to_subagent: hand research to an existing sub-agent; runs immediately, read-only — relay
  its summary in your own voice.

Resolve recipients before proposing, call each proposing tool once, and never invent an address,
balance, or result — always use a tool. If something fails, say so in a line.`;

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
