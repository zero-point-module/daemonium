/**
 * ENS / identity status (honest, post-migration). Sepolia ENS has moved to v2 and on-chain
 * subname minting isn't available there (v1 NameWrapper frozen; v2 subname-issuance contracts
 * unpublished), so agent ENS names are a human-readable LABEL layer. The REAL on-chain identity
 * is the ERC-8004 NFT + the agent's wallet. The parent `daemonium.eth` IS registered in ENS v2,
 * which we read + surface here.
 *   curl localhost:3000/api/daemon/ens-status -H "Authorization: Bearer <token>"
 */
import { ENS_PARENT_NAME, ENS_ONCHAIN_MINTING, explorerAddress } from "@/app/lib/chain";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";
import { readEthNameV2 } from "@/app/lib/ens-v2";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey } from "@/app/lib/handles";

export const runtime = "nodejs";

export async function GET(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const key = await resolveUserKey(userId);
  const ignis = key ? await ensureAgentWallet(key) : null;

  // The parent's REAL state in ENS v2 (the deployment Sepolia runs now).
  const parentLabel = ENS_PARENT_NAME.replace(/\.eth$/, "");
  const parentV2 = await readEthNameV2(parentLabel).catch((e) => ({
    name: ENS_PARENT_NAME,
    status: "unknown",
    owner: null,
    error: e instanceof Error ? e.message : String(e),
  }));

  return Response.json({
    yourDaemon: ignis
      ? {
          ensName: ignis.ensName, // human-readable label (not minted on-chain on Sepolia)
          address: ignis.address,
          erc8004AgentId: ignis.agentId ?? null, // the REAL on-chain identity
          agentCardUri: ignis.agentCardUri ?? null,
          explorer: explorerAddress(ignis.address),
        }
      : null,
    ensParent: parentV2, // { name, status: "registered", owner } from the v2 .eth registry
    onChainSubnameMinting: ENS_ONCHAIN_MINTING,
    note:
      "Sepolia ENS is v2; on-chain subname minting isn't available (v1 NameWrapper frozen, v2 " +
      "subname-issuance contracts unpublished). Agent ENS names are a naming/org-chart layer; the " +
      "verifiable on-chain identity per agent is its ERC-8004 NFT + wallet. daemonium.eth is " +
      "really registered in ENS v2 (see ensParent).",
  });
}
