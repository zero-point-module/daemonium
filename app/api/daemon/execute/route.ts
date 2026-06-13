/**
 * THE ONLY SIGNER. The human-confirm tap POSTs an executionId here; this route looks up
 * the validated proposal and runs it through the action executor (which loads the agent's
 * MPC key shares and broadcasts). The client never supplies amounts/addresses or signs —
 * it only references a proposal the server already minted. This is the confirmation gate.
 */
import { NextResponse } from "next/server";
import { takeExecution } from "@/app/lib/executions";
import { executeProposal } from "@/app/lib/actions";
import type { ExecuteRequest } from "@/app/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ExecuteRequest | null;
  if (!body?.executionId) {
    return NextResponse.json({ ok: false, error: "executionId required" }, { status: 400 });
  }

  const card = takeExecution(body.executionId);
  if (!card) {
    return NextResponse.json(
      { ok: false, error: "Unknown or already-used executionId" },
      { status: 404 },
    );
  }

  const result = await executeProposal(card);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
