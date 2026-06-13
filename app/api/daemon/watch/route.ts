/**
 * Proactive watch — the backend side of "Ignis notices an incoming transfer and speaks up".
 * Workstream A polls this with the last block it saw; when `transfers` is non-empty it can
 * flip the flame and send Ignis a synthetic prompt to react (e.g. "you just received 5 USDC
 * from 0x…"). Stateless: the client owns the cursor.
 *   GET /api/daemon/watch?agent=ignis&since=<blockNumber>
 */
import { NextResponse } from "next/server";
import { getIncomingUsdc } from "@/app/lib/evm";
import { getWallet } from "@/app/lib/wallet-store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const label = url.searchParams.get("agent") ?? "ignis";
  const sinceParam = url.searchParams.get("since");

  const wallet = await getWallet(label);
  if (!wallet) {
    return NextResponse.json({ error: `No agent "${label}"` }, { status: 404 });
  }

  const since = sinceParam ? BigInt(sinceParam) : undefined;
  const { latestBlock, transfers } = await getIncomingUsdc(
    wallet.address as `0x${string}`,
    since,
  );

  return NextResponse.json({
    agent: label,
    address: wallet.address,
    latestBlock: latestBlock.toString(),
    transfers,
  });
}
