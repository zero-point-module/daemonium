/**
 * ENS / identity status. Identity lives on Ethereum L1, where ENS v1 is live and the subname
 * cluster mints for real. We surface the two on-chain prerequisites (is `daemonium.eth` wrapped,
 * and is the minter approved to mint under it) plus the caller's own dæmon (its ENS name, wallet,
 * and ERC-8004 NFT — the verifiable on-chain identity).
 *   curl localhost:3000/api/daemon/ens-status -H "Authorization: Bearer <token>"
 */
import { ENS_PARENT_NAME, ENS_ONCHAIN_MINTING, explorerAddress } from "@/app/lib/chain";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";
import { ensureMinter } from "@/app/lib/minter";
import { parentControl } from "@/app/lib/ens";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey } from "@/app/lib/handles";
import { withRoute } from "@/app/lib/observe";
import type { Address } from "viem";

export const runtime = "nodejs";

export const GET = withRoute("ens-status", getHandler);

async function getHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const key = await resolveUserKey(userId);
  const ignis = key ? await ensureAgentWallet(key) : null;

  // The parent's real L1 control state — the gating factors for on-chain subname minting.
  const minterAddr = (await ensureMinter()).address as Address;
  const parent = await parentControl(ENS_PARENT_NAME, minterAddr).catch((e) => ({
    owner: null,
    wrapped: false,
    canManage: false,
    error: e instanceof Error ? e.message : String(e),
  }));

  return Response.json({
    yourDaemon: ignis
      ? {
          ensName: ignis.ensName, // <handle>.daemonium.eth — minted on L1 when the cluster is set up
          address: ignis.address,
          erc8004AgentId: ignis.agentId ?? null, // the verifiable on-chain identity
          agentCardUri: ignis.agentCardUri ?? null,
          explorer: explorerAddress(ignis.address),
        }
      : null,
    ensParent: {
      name: ENS_PARENT_NAME,
      wrapped: parent.wrapped, // true once daemonium.eth is registered + wrapped on L1
      owner: parent.owner,
      minterAddress: minterAddr,
      minterApproved: parent.canManage, // true once the owner approved the minter (setApprovalForAll)
    },
    onChainSubnameMinting: ENS_ONCHAIN_MINTING,
    note:
      "Identity is on Ethereum L1 (v1 ENS live). Subname minting needs daemonium.eth wrapped in " +
      "the NameWrapper and the minter approved (setApprovalForAll). Until then, each agent still " +
      "has its wallet + ERC-8004 NFT (the verifiable identity); the ENS name is a label.",
  });
}
