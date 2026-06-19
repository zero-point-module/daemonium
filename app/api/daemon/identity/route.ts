/**
 * SA-held ERC-8004 identity. Registering mints the identity NFT to msg.sender, so to have the
 * USER'S SMART ACCOUNT hold it we run `register` (and the agent-card `setText`, since the SA owns
 * the ENS node) as a co-signed L1 UserOp from the SA — the agent's MPC wallet never signs or pays.
 *
 *   GET  → { needed, chainId, calls, ensName }  — the calls for the client to co-sign on mainnet
 *   POST { hash } → records the agentId parsed from the mined receipt (server reads it, doesn't
 *                   trust a client-sent number)
 *
 * The client (useOnboarding) co-signs the returned calls with the user's embedded wallet and posts
 * the tx hash back. Self-funded: the SA pays this UserOp's gas (seeded on L1 at provision).
 */
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey, getUserSmartAccount } from "@/app/lib/handles";
import { getWallet, updateWallet } from "@/app/lib/wallet-store";
import { buildRegisterCall, ownsIdentity, parseAgentIdFromLogs } from "@/app/lib/erc8004";
import { buildSetAgentCardCall, subnameExists } from "@/app/lib/ens";
import { identityClient } from "@/app/lib/evm";
import { agentCardUri, IDENTITY_CHAIN_ID } from "@/app/lib/chain";
import { withRoute } from "@/app/lib/observe";
import type { Address, Hex } from "viem";

export const runtime = "nodejs";
export const maxDuration = 60;

function authFail(err: unknown) {
  const status = err instanceof AuthError ? err.status : 401;
  return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
}

export const GET = withRoute("identity", getHandler);

async function getHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    return authFail(err);
  }
  const ensName = await resolveUserKey(userId);
  const sa = await getUserSmartAccount(userId);
  if (!ensName || !sa) {
    return Response.json({ needed: false, error: "Not provisioned yet" }, { status: 409 });
  }
  const smartAccount = sa.smartAccount as Address;

  // Already held by the SA → nothing to do (idempotent; a retry won't double-mint).
  if (await ownsIdentity(smartAccount)) {
    return Response.json({ needed: false });
  }

  const uri = agentCardUri(ensName);
  const calls = [buildRegisterCall(uri)];
  // The agent-card text record only if the subname exists (the SA owns the node, so it can setText).
  try {
    if (await subnameExists(ensName)) calls.push(buildSetAgentCardCall(ensName, uri));
  } catch {
    /* skip the text record if the subname check fails — register alone is the core identity */
  }

  return Response.json({
    needed: true,
    chainId: IDENTITY_CHAIN_ID,
    ensName,
    calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value.toString() })),
  });
}

export const POST = withRoute("identity", postHandler);

async function postHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    return authFail(err);
  }
  const ensName = await resolveUserKey(userId);
  if (!ensName) return Response.json({ error: "Not provisioned yet" }, { status: 409 });

  const body = (await req.json().catch(() => null)) as { hash?: string } | null;
  if (!body?.hash) return Response.json({ error: "hash required" }, { status: 400 });

  // Read the mined receipt and parse the agentId from its logs — don't trust a client-sent id.
  let agentId: string | undefined;
  try {
    const receipt = await identityClient.getTransactionReceipt({ hash: body.hash as Hex });
    agentId = parseAgentIdFromLogs(receipt.logs);
  } catch (err) {
    return Response.json(
      { error: `Could not read identity receipt: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    );
  }
  if (!agentId) {
    return Response.json({ error: "No ERC-8004 registration found in that tx" }, { status: 422 });
  }

  const wallet = await getWallet(ensName);
  if (!wallet) return Response.json({ error: "No dæmon wallet" }, { status: 404 });
  await updateWallet(ensName, { agentId, agentCardUri: agentCardUri(ensName) });
  return Response.json({ ok: true, agentId });
}
