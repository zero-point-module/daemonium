/**
 * Completion of a CO-SIGN action. After the client co-signs the UserOp with the user's embedded
 * wallet and submits it (the on-chain effect already happened — the user signed it), it POSTs the
 * resulting tx hash here. We verify the caller owns the proposal, then atomically consume it
 * (single-use). This records the outcome and retires the proposal; it grants nothing on its own.
 */
import { peekExecution, consumeExecution } from "@/app/lib/executions";
import { verifyUser, AuthError } from "@/app/lib/auth";
import type { ExecuteResponse } from "@/app/lib/types";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";
export const maxDuration = 30;

interface CompleteRequest {
  executionId: string;
  hash?: string;
  ok?: boolean;
  error?: string;
  chainId?: number;
}

export const POST = withRoute("execute-complete", postHandler);

async function postHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const body = (await req.json().catch(() => null)) as CompleteRequest | null;
  if (!body?.executionId) {
    return Response.json({ ok: false, error: "executionId required" }, { status: 400 });
  }

  const entry = await peekExecution(body.executionId);
  if (!entry) {
    return Response.json({ ok: false, error: "Unknown or already-used executionId" }, { status: 404 });
  }
  if (entry.userId !== userId) {
    return Response.json({ ok: false, error: "Not your proposal" }, { status: 403 });
  }
  if (!(await consumeExecution(body.executionId))) {
    return Response.json({ ok: false, error: "Unknown or already-used executionId" }, { status: 404 });
  }

  const res: ExecuteResponse = {
    ok: body.ok ?? Boolean(body.hash),
    hash: body.hash,
    error: body.error,
    chainId: body.chainId,
  };
  return Response.json(res, { status: res.ok ? 200 : 500 });
}
