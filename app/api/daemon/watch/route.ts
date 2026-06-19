/**
 * Proactive watch — the backend side of "Ignis notices an incoming transfer and speaks up".
 * Scoped to the calling user's Ignis (or one of their sub-agents via ?subagent=). The client
 * polls with the last block it saw; when `transfers` is non-empty it can flip the flame and
 * send Ignis a synthetic prompt to react. Stateless: the client owns the cursor.
 *   GET /api/daemon/watch?since=<block>&subagent=research  (Authorization: Bearer <token>)
 */
import { getIncomingUsdc } from "@/app/lib/evm";
import { getWallet } from "@/app/lib/wallet-store";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey } from "@/app/lib/handles";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";

export const GET = withRoute("watch", getHandler);

async function getHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const url = new URL(req.url);
  const subagent = url.searchParams.get("subagent");
  const sinceParam = url.searchParams.get("since");
  const selfKey = await resolveUserKey(userId);
  if (!selfKey) {
    return Response.json({ error: "Pick a handle first", needsHandle: true }, { status: 409 });
  }
  // Only allow a single-label direct child of the caller's own dæmon (no nested probing).
  if (subagent && subagent.includes(".")) {
    return Response.json({ error: "subagent must be a single label" }, { status: 400 });
  }
  const key = subagent ? `${subagent}.${selfKey}` : selfKey;

  const wallet = await getWallet(key);
  if (!wallet) return Response.json({ error: `No agent "${key}"` }, { status: 404 });
  if (subagent && wallet.parent !== selfKey) {
    return Response.json({ error: "Not your sub-agent" }, { status: 403 });
  }

  // Watch the user's SMART ACCOUNT — that's where funds land now (the agent's MPC address is just
  // a session-key signer). Fall back to the agent address for legacy accounts without an SA.
  const watchAddress = (wallet.ownerSmartAccount ?? wallet.address) as `0x${string}`;

  const since = sinceParam ? BigInt(sinceParam) : undefined;
  const { latestBlock, transfers } = await getIncomingUsdc(watchAddress, since);

  return Response.json({
    agent: key,
    address: watchAddress,
    latestBlock: latestBlock.toString(),
    transfers,
  });
}
