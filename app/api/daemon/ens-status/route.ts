/**
 * Read-only check of the ENS bootstrap prerequisite for B3/B4. Tells you whether Ignis's
 * wallet is authorized to mint subnames under the parent name, and if not, exactly what to do.
 *   curl localhost:3000/api/daemon/ens-status
 */
import { NextResponse } from "next/server";
import { ENS, ENS_PARENT_NAME } from "@/app/lib/chain";
import { canManageParent } from "@/app/lib/ens";
import { ensureAgentWallet } from "@/app/lib/dynamic-server";

export const runtime = "nodejs";

export async function GET() {
  const ignis = await ensureAgentWallet("ignis");
  const operator = ignis.address as `0x${string}`;

  let canManage = false;
  let note: string | undefined;
  try {
    canManage = await canManageParent(ENS_PARENT_NAME, operator);
  } catch (err) {
    note =
      `Could not read owner of ${ENS_PARENT_NAME} — is it wrapped in the NameWrapper? ` +
      (err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json({
    parent: ENS_PARENT_NAME,
    ignisAddress: operator,
    canManage,
    note,
    howToAuthorize: canManage
      ? "Ready — Ignis can mint subnames under the parent."
      : `From the wallet that owns ${ENS_PARENT_NAME}, call setApprovalForAll(${operator}, true) on the NameWrapper at ${ENS.nameWrapper} (Sepolia). The parent must be wrapped.`,
  });
}
