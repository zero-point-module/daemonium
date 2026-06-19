/**
 * Session-key grants — the opt-in AUTONOMY control. The user's embedded wallet builds + signs a
 * scoped permission for an agent (client-side, via createSessionApproval) and POSTs the serialized
 * approval here; we store it (session-grants.ts). After that, value actions by that agent within
 * the on-chain limits run without a per-action signature. POST {revoke:true} turns it off.
 *
 *   GET  ?agentKey=… → { sessionSignerAddress, active, policy? } (agentKey defaults to the dæmon)
 *   POST { agentKey?, approvalBlob, aaChain, policy }            → store the grant
 *   POST { agentKey?, revoke: true }                             → revoke
 */
import { verifyUser, AuthError } from "@/app/lib/auth";
import { resolveUserKey } from "@/app/lib/handles";
import { getSessionSignerAddress, isChainSupported } from "@/app/lib/smart-account";
import { DEFI_CHAIN_ID } from "@/app/lib/chain";
import {
  getActiveGrant,
  setGrant,
  revokeGrant,
  type GrantPolicy,
} from "@/app/lib/session-grants";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";
export const maxDuration = 30;

function authFail(err: unknown) {
  const status = err instanceof AuthError ? err.status : 401;
  return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
}

export const GET = withRoute("grant", getHandler);

async function getHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    return authFail(err);
  }
  const url = new URL(req.url);
  const agentKey = url.searchParams.get("agentKey") ?? (await resolveUserKey(userId));
  if (!agentKey) return Response.json({ error: "Pick a handle first" }, { status: 409 });
  const chainId = Number(url.searchParams.get("chainId")) || DEFI_CHAIN_ID;

  const [sessionSignerAddress, grant] = await Promise.all([
    getSessionSignerAddress(agentKey),
    getActiveGrant(userId, agentKey, chainId),
  ]);
  return Response.json({
    agentKey,
    chainId,
    sessionSignerAddress,
    active: Boolean(grant),
    policy: grant?.policy,
  });
}

export const POST = withRoute("grant", postHandler);

async function postHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyUser(req));
  } catch (err) {
    return authFail(err);
  }

  const body = await req.json().catch(() => null);
  const agentKey = (body?.agentKey as string) ?? (await resolveUserKey(userId));
  if (!agentKey) return Response.json({ error: "Pick a handle first" }, { status: 409 });
  const chainId = Number(body?.chainId) || DEFI_CHAIN_ID;
  if (!isChainSupported(chainId)) {
    return Response.json({ error: `Unsupported chain ${chainId}` }, { status: 400 });
  }

  if (body?.revoke === true) {
    await revokeGrant(userId, agentKey, chainId);
    return Response.json({ ok: true, active: false, chainId });
  }

  const approvalBlob = body?.approvalBlob;
  if (typeof approvalBlob !== "string" || !approvalBlob) {
    return Response.json({ error: "approvalBlob (string) required" }, { status: 400 });
  }
  const policy: GrantPolicy = {
    maxUsdc: typeof body?.policy?.maxUsdc === "number" ? body.policy.maxUsdc : undefined,
    targets: Array.isArray(body?.policy?.targets) ? body.policy.targets : undefined,
    validUntil: typeof body?.policy?.validUntil === "number" ? body.policy.validUntil : undefined,
  };

  await setGrant(userId, {
    agentKey,
    chainId,
    approvalBlob,
    policy,
    active: true,
    createdAt: new Date().toISOString(),
  });
  return Response.json({ ok: true, active: true, agentKey, chainId });
}
