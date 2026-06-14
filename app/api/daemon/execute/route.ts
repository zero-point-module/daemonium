/**
 * THE ONLY SIGNER. The human-confirm tap POSTs an executionId here (with the user's Dynamic
 * token); this route verifies the caller, confirms the proposal belongs to THEM, then runs it
 * through the action executor (which loads the agent's MPC key shares and broadcasts). The
 * client never supplies amounts/addresses or signs — it only references a proposal the server
 * already minted for that same user. This is the confirmation gate.
 */
import { peekExecution, consumeExecution } from "@/app/lib/executions";
import { executeProposal } from "@/app/lib/actions";
import { verifyUser, AuthError } from "@/app/lib/auth";
import type { ExecuteRequest } from "@/app/lib/types";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";

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
  const entry = peekExecution(body.executionId);
  if (!entry) {
    return Response.json(
      { ok: false, error: "Unknown or already-used executionId" },
      { status: 404 },
    );
  }
  // A proposal can only be executed by the user who created it.
  if (entry.userId !== userId) {
    return Response.json({ ok: false, error: "Not your proposal" }, { status: 403 });
  }
  // Single-use: consume it now, synchronously (no await before this), so a double-tap can't
  // double-execute — but only AFTER the owner check, so a wrong caller never consumes it.
  consumeExecution(body.executionId);

  const result = await executeProposal(entry.card);
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
