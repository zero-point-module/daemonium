/**
 * Debug/manual proposal entry — mints a pending execution and returns its card.
 * The agent loop (B2) builds the same cards via createExecution; this route lets you
 * exercise the confirm→execute path before the agent exists.
 *   curl -X POST localhost:3000/api/daemon/propose \
 *     -H 'content-type: application/json' \
 *     -d '{"action":"send_usdc","agent":"ignis","to":"0x..","amount":"1"}'
 */
import { NextResponse } from "next/server";
import { createExecution } from "@/app/lib/executions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || body.action !== "send_usdc") {
    return NextResponse.json(
      { error: "Only send_usdc supported in the debug propose route" },
      { status: 400 },
    );
  }
  const agent = body.agent ?? "ignis";
  const { to, amount, toEns } = body;
  if (!to || !amount) {
    return NextResponse.json({ error: "to and amount are required" }, { status: 400 });
  }

  const card = createExecution({
    action: "send_usdc",
    agent,
    summary: `Send ${amount} USDC to ${toEns ?? to}`,
    details: { action: "send_usdc", to, amount: String(amount), toEns },
  });

  return NextResponse.json(card);
}
