/**
 * ENS provisioning status. With the minter pattern, root subnames are minted by a single
 * backend wallet that the parent's owner approves ONCE — so this reports the MINTER's
 * authorization + balance (the real gating factors), plus the calling user's own Ignis.
 *   curl localhost:3000/api/daemon/ens-status -H "Authorization: Bearer <token>"
 */
import { formatEther } from "viem";
import { ENS, ENS_PARENT_NAME } from "@/app/lib/chain";
import { canManageParent } from "@/app/lib/ens";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";
import { ensureMinter } from "@/app/lib/minter";
import { publicClient } from "@/app/lib/evm";
import { verifyUser, AuthError } from "@/app/lib/auth";
import { rootEnsName } from "@/app/lib/identity";

export const runtime = "nodejs";

export async function GET(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  const ignis = await ensureAgentWallet(rootEnsName(userId));
  const minter = await ensureMinter();
  const minterAddr = minter.address as `0x${string}`;

  let minterApproved = false;
  let note: string | undefined;
  try {
    minterApproved = await canManageParent(ENS_PARENT_NAME, minterAddr);
  } catch (err) {
    note =
      `Could not read owner of ${ENS_PARENT_NAME} — is it wrapped in the NameWrapper? ` +
      (err instanceof Error ? err.message : String(err));
  }
  const minterEth = await publicClient.getBalance({ address: minterAddr });

  return Response.json({
    yourIgnis: { ensName: ignis.ensName, address: ignis.address },
    minter: {
      address: minterAddr,
      approved: minterApproved,
      ethBalance: formatEther(minterEth),
    },
    parent: ENS_PARENT_NAME,
    note,
    setup: minterApproved
      ? "Ready — the minter can provision every user's subname automatically."
      : `ONE-TIME: from the wallet that owns ${ENS_PARENT_NAME}, call setApprovalForAll(${minterAddr}, true) on the NameWrapper ${ENS.nameWrapper} (Sepolia), and fund ${minterAddr} with Sepolia ETH. After that, all users are provisioned automatically.`,
  });
}
