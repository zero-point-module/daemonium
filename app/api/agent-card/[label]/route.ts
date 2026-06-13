/**
 * Serves an agent's ERC-8004 agent card JSON. This URL is the agentURI registered on-chain
 * and the value of the ENS `agent-card` text record.
 *   GET /api/agent-card/ignis
 */
import { NextResponse } from "next/server";
import { getWallet } from "@/app/lib/wallet-store";
import { buildAgentCard } from "@/app/lib/agent-card";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  const wallet = await getWallet(label);
  if (!wallet) {
    return NextResponse.json({ error: `No agent "${label}"` }, { status: 404 });
  }
  return NextResponse.json(buildAgentCard(wallet));
}
