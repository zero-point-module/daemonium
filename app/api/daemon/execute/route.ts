/**
 * THE CONFIRM GATE — now a DECISION endpoint. The confirm tap POSTs an executionId (with the user's
 * Dynamic token); this route verifies the caller owns the proposal, then decides how it runs:
 *
 *   • spawn_subagent → executed server-side (provisioning, not a fund move), result returned inline.
 *   • value action + an active session-key grant for the acting agent → the server submits the
 *     UserOp with that session key (autonomy), bounded on-chain by the grant; result returned inline.
 *   • value action, no grant → "cosign": the server returns the encoded calls (built from the
 *     STORED proposal — never client input); the client co-signs the UserOp with the user's embedded
 *     wallet and submits, then calls /execute/complete to record + consume the proposal.
 *
 * The server can no longer move a user's funds on its own: value actions require either the user's
 * signature (co-sign) or a session key whose limits the user signed and the chain enforces.
 */
import { peekExecution, consumeExecution } from "@/app/lib/executions";
import { executeProposal } from "@/app/lib/actions";
import { buildValueCalls } from "@/app/lib/action-calls";
import { submitWithSessionKey } from "@/app/lib/smart-account";
import { getActiveGrant } from "@/app/lib/session-grants";
import { getUserSmartAccount } from "@/app/lib/handles";
import { verifyUser, AuthError } from "@/app/lib/auth";
import type { Address } from "viem";
import type { ExecuteRequest, PrepareResponse } from "@/app/lib/types";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";
// An autonomous (session-key) submit waits on a bundler + receipt; give it room.
export const maxDuration = 120;

export const POST = withRoute("execute", postHandler);

async function postHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const body = (await req.json().catch(() => null)) as ExecuteRequest | null;
  if (!body?.executionId) {
    return Response.json({ ok: false, error: "executionId required" }, { status: 400 });
  }

  // Look up WITHOUT consuming — so a wrong-owner or losing-race tap can't burn a valid proposal.
  const entry = await peekExecution(body.executionId);
  if (!entry) {
    return Response.json({ ok: false, error: "Unknown or already-used executionId" }, { status: 404 });
  }
  if (entry.userId !== userId) {
    return Response.json({ ok: false, error: "Not your proposal" }, { status: 403 });
  }

  const card = entry.card;

  // Non-value action (spawn): provision server-side. Consume atomically first.
  if (card.action === "spawn_subagent") {
    if (!(await consumeExecution(body.executionId))) {
      return Response.json({ ok: false, error: "Unknown or already-used executionId" }, { status: 404 });
    }
    const result = await executeProposal(card);
    const res: PrepareResponse = { mode: "server", ...result };
    return Response.json(res, { status: result.ok ? 200 : 500 });
  }

  // Value action: needs the user's smart account (provisioned at handle claim).
  const saRec = await getUserSmartAccount(userId);
  if (!saRec) {
    return Response.json(
      { ok: false, error: "No smart account provisioned — re-open the app to finish setup." },
      { status: 409 },
    );
  }
  const smartAccount = saRec.smartAccount as Address;

  let calls;
  try {
    calls = await buildValueCalls(card, smartAccount);
  } catch (err) {
    const res: PrepareResponse = { mode: "server", ok: false, error: err instanceof Error ? err.message : String(err) };
    return Response.json(res, { status: 400 });
  }

  // Autonomy: an active grant for the acting agent ON THIS ACTION'S CHAIN → server signs with the
  // session key. Grants are per-chain, so a Base grant won't authorize a mainnet action (and vice
  // versa) — that falls back to co-sign below.
  const grant = await getActiveGrant(userId, card.agent, calls.chainId);
  if (grant) {
    if (!(await consumeExecution(body.executionId))) {
      return Response.json({ ok: false, error: "Unknown or already-used executionId" }, { status: 404 });
    }
    try {
      const hash = await submitWithSessionKey({
        approvalBlob: grant.approvalBlob,
        agentKey: card.agent,
        calls: calls.calls,
        chainId: calls.chainId,
      });
      const res: PrepareResponse = { mode: "server", ok: true, hash, chainId: calls.chainId };
      return Response.json(res, { status: 200 });
    } catch (err) {
      const res: PrepareResponse = { mode: "server", ok: false, error: err instanceof Error ? err.message : String(err), chainId: calls.chainId };
      return Response.json(res, { status: 500 });
    }
  }

  // Default: co-sign. Return the calls for the client to sign; DON'T consume yet (the client
  // consumes via /execute/complete once its UserOp lands, so a rejected signature can be retried).
  const res: PrepareResponse = {
    mode: "cosign",
    executionId: body.executionId,
    chainId: calls.chainId,
    calls: calls.calls.map((c) => ({ to: c.to, data: c.data, value: c.value.toString() })),
  };
  return Response.json(res, { status: 200 });
}
