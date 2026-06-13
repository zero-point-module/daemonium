/**
 * Provision Ignis. POST once (idempotent) to create its server wallet, then it returns
 * the address + balances so you know where to send faucet ETH and Circle USDC.
 *   curl -X POST localhost:3000/api/daemon/init
 */
import { NextResponse } from "next/server";
import { erc20Abi, formatEther, formatUnits } from "viem";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";
import { publicClient } from "@/app/lib/evm";
import { USDC, explorerAddress } from "@/app/lib/chain";

export const runtime = "nodejs";

export async function POST() {
  try {
    const ignis = await ensureAgentWallet("ignis");
    const address = ignis.address as `0x${string}`;

    const [eth, usdc] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    ]);

    return NextResponse.json({
      identity: {
        label: ignis.label,
        ensName: ignis.ensName,
        address: ignis.address,
      },
      balances: {
        eth: formatEther(eth),
        usdc: formatUnits(usdc, USDC.decimals),
      },
      explorer: explorerAddress(ignis.address),
      fundHint:
        "Send Sepolia ETH (faucet) and Circle test USDC to the address above before sending.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
