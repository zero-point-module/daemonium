/**
 * Provision the calling user's Ignis. POST (idempotent) with the Dynamic auth token to create
 * their server wallet, then it returns the address + balances so they know where to send
 * faucet ETH and Circle USDC.
 *   curl -X POST localhost:3000/api/daemon/init -H "Authorization: Bearer <token>"
 */
import { erc20Abi, formatEther, formatUnits } from "viem";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";
import { defiClient } from "@/app/lib/evm";
import { USDC, defiExplorerAddress } from "@/app/lib/chain";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey } from "@/app/lib/handles";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";

export const POST = withRoute("init", postHandler);

async function postHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const key = await resolveUserKey(userId);
  if (!key) {
    return Response.json({ error: "Pick a handle first", needsHandle: true }, { status: 409 });
  }

  try {
    const ignis = await ensureAgentWallet(key);
    const address = ignis.address as `0x${string}`;

    // Spendable balance lives on Base mainnet (the value layer).
    const [eth, usdc] = await Promise.all([
      defiClient.getBalance({ address }),
      defiClient.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    ]);

    return Response.json({
      identity: { ensName: ignis.ensName, address: ignis.address },
      balances: { eth: formatEther(eth), usdc: formatUnits(usdc, USDC.decimals) },
      explorer: defiExplorerAddress(ignis.address),
      fundHint: "Send a little Base ETH (gas) + Base USDC to the address above before transacting.",
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
