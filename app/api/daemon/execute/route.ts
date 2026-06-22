/**
 * THE CONFIRM GATE — now a DECISION endpoint. The confirm tap POSTs an executionId (with the user's
 * Dynamic token); this route verifies the caller owns the proposal, then decides how it runs:
 *
 *   • spawn_subagent → executed server-side (provisioning, not a fund move), result returned inline.
 *   • value action + an active session-key grant covering this action → the server submits the
 *     UserOp with that session key (autonomy); result returned inline.
 *   • value action, no grant (or over the grant's cap) → "cosign": the server returns the encoded
 *     calls (built from the STORED proposal — never client input); the client co-signs with the
 *     embedded wallet and submits.
 *
 * SINGLE-USE: a proposal is consumed (atomic GETDEL) BEFORE any on-chain effect — the cosign branch
 * claims it before returning calls (so it can't be prepared twice → no double-submit), and the
 * autonomy branch claims it before submitting (reinstating it only on a pre-broadcast failure so a
 * transient bundler error doesn't burn a still-valid proposal). The server can't move funds on its
 * own: value needs either the user's signature (co-sign) or a session key the user granted.
 */
import {
  peekExecution,
  consumeExecution,
  reinstateExecution,
} from "@/app/lib/executions";
import { executeProposal } from "@/app/lib/actions";
import { buildValueCalls } from "@/app/lib/action-calls";
import { submitWithSessionKey, PreBroadcastError } from "@/app/lib/smart-account";
import { getActiveGrant, type SessionGrant } from "@/app/lib/session-grants";
import { getUserSmartAccount } from "@/app/lib/handles";
import { verifyUser, AuthError } from "@/app/lib/auth";
import type { Address } from "viem";
import type { ExecuteRequest, PrepareResponse } from "@/app/lib/types";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";
// An autonomous (session-key) submit waits on a bundler + receipt; give it room.
export const maxDuration = 120;

export const POST = withRoute("execute", postHandler);

/** True if this action can't run autonomously under the grant and must fall back to the user's
 *  signature. Only a USDC send within the grant's `maxUsdc` auto-runs; a non-USDC action (send_eth /
 *  swap) or a grant with no cap set falls back to co-sign — we don't auto-spend what we can't bound. */
function exceedsGrantCap(
  card: { details: { action: string; amount?: string } },
  grant: SessionGrant,
): boolean {
  if (card.details.action !== "send_usdc") return true;
  const max = grant.policy.maxUsdc;
  if (max == null) return true;
  const amt = Number(card.details.amount);
  return !Number.isFinite(amt) || amt > max;
}

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

  // Autonomy: an active grant for the acting agent ON THIS ACTION'S CHAIN, AND within the grant's
  // user-chosen cap → server signs with the session key. Grants are per-chain (a Base grant won't
  // authorize a mainnet action). Over-cap or no grant → fall through to co-sign so the user signs it.
  const grant = await getActiveGrant(userId, card.agent, calls.chainId);
  if (grant && !exceedsGrantCap(card, grant)) {
    // Claim atomically BEFORE submitting so a double-tap can't double-submit.
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
      // Pre-broadcast failure (bundler rejected, nothing landed) → put the proposal back so the user
      // can retry. A later failure (receipt wait) is NOT reinstated: the UserOp may be on-chain.
      if (err instanceof PreBroadcastError) await reinstateExecution(entry);
      const res: PrepareResponse = { mode: "server", ok: false, error: err instanceof Error ? err.message : String(err), chainId: calls.chainId };
      return Response.json(res, { status: 500 });
    }
  }

  // Default: co-sign. CLAIM the proposal now (single-use) BEFORE handing the client signable calls,
  // so it can't be prepared again and double-submitted. A rejected signature means the proposal is
  // spent and the user re-asks — the safe direction (never double-spend).
  if (!(await consumeExecution(body.executionId))) {
    return Response.json({ ok: false, error: "Unknown or already-used executionId" }, { status: 404 });
  }
  const res: PrepareResponse = {
    mode: "cosign",
    executionId: body.executionId,
    chainId: calls.chainId,
    calls: calls.calls.map((c) => ({ to: c.to, data: c.data, value: c.value.toString() })),
  };
  return Response.json(res, { status: 200 });
}
