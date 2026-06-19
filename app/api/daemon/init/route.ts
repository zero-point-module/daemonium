/**
 * Provision the calling user's Ignis. POST (idempotent) with the Dynamic auth token to create
 * their server wallet, then it returns the address + balances so they know where to send
 * faucet ETH and Circle USDC.
 *   curl -X POST localhost:3000/api/daemon/init -H "Authorization: Bearer <token>"
 */
import { erc20Abi, formatEther, formatUnits, type Address } from "viem";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";
import { defiClient } from "@/app/lib/evm";
import { USDC, defiExplorerAddress } from "@/app/lib/chain";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey, getUserSmartAccount } from "@/app/lib/handles";
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
    // The user's smart account is the on-chain owner + treasury — that's where funds live and the
    // address to top up. Fall back to the agent address only for legacy accounts without an SA.
    const sa = await getUserSmartAccount(userId);
    const fundTarget = (sa?.smartAccount ?? ignis.address) as Address;

    // Spendable balance lives on Base mainnet (the value layer), in the smart account.
    const [eth, usdc] = await Promise.all([
      defiClient.getBalance({ address: fundTarget }),
      defiClient.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [fundTarget],
      }),
    ]);

    return Response.json({
      identity: { ensName: ignis.ensName, address: ignis.address },
      smartAccount: sa?.smartAccount ?? null,
      owner: sa?.ownerEoa ?? null,
      balances: { eth: formatEther(eth), usdc: formatUnits(usdc, USDC.decimals) },
      explorer: defiExplorerAddress(fundTarget),
      fundHint:
        "Send a little Base ETH (gas) + Base USDC to your smart account above before transacting.",
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
