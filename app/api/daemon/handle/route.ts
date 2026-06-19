/**
 * Per-user handle: GET to check if the caller has one yet (the frontend shows the picker
 * modal if not), POST to claim one. Claiming a handle AUTO-PROVISIONS the user's dæmon
 * identity (mints <handle>.daemonium.eth + ERC-8004 + text record via the minter) —
 * no separate "claim" step. This is the slow call (several Ethereum txs); the modal shows a
 * loading state.
 */
import { isAddress, type Address } from "viem";
import { verifyUser, AuthError } from "@/app/lib/auth";
import {
  getHandle,
  claimHandle,
  ensNameForHandle,
  setUserSmartAccount,
  getUserSmartAccount,
} from "@/app/lib/handles";
import { provisionIdentity } from "@/app/lib/provision";
import { deriveUserKernelAddress } from "@/app/lib/smart-account";
import { getWallet } from "@/app/lib/wallet-store";
import { withRoute } from "@/app/lib/observe";

export const runtime = "nodejs";
export const maxDuration = 120;

async function user(req: Request) {
  return verifyUser(req);
}
function authFail(err: unknown) {
  const status = err instanceof AuthError ? err.status : 401;
  return Response.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
}

export const GET = withRoute("handle", getHandler);

async function getHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await user(req));
  } catch (err) {
    return authFail(err);
  }
  const handle = await getHandle(userId);
  if (!handle) {
    return Response.json({ handle: null, ensName: null, identityComplete: false });
  }
  const ensName = ensNameForHandle(handle);
  const [wallet, sa] = await Promise.all([getWallet(ensName), getUserSmartAccount(userId)]);
  // The app is usable once the user's smart account is bound (that's what co-signs value actions).
  // `smartAccount: null` means a LEGACY/half-provisioned account — the client re-POSTs with
  // ownerEoa to backfill it. `identityComplete` (the ERC-8004 step) is informational + best-effort.
  return Response.json({
    handle,
    ensName,
    smartAccount: sa?.smartAccount ?? null,
    identityComplete: Boolean(wallet?.agentId),
  });
}

export const POST = withRoute("handle", postHandler);

async function postHandler(req: Request) {
  let userId: string;
  try {
    ({ userId } = await user(req));
  } catch (err) {
    return authFail(err);
  }

  const body = await req.json().catch(() => null);
  const raw = body?.handle;
  if (typeof raw !== "string") {
    return Response.json({ error: "handle (string) required" }, { status: 400 });
  }

  // The user's embedded-wallet EOA — sudo owner of their Kernel smart account. We derive the SA
  // address from it (server-side, never trusting a client-sent SA) and make it the on-chain owner.
  const rawOwner = body?.ownerEoa;
  if (typeof rawOwner !== "string" || !isAddress(rawOwner)) {
    return Response.json({ error: "ownerEoa (wallet address) required" }, { status: 400 });
  }
  const ownerEoa = rawOwner as Address;

  const claimed = await claimHandle(userId, raw);
  if (!claimed.ok) {
    // invalid format → 400 (client bug); reserved/taken → 409 (conflict).
    const status = claimed.code === "invalid" ? 400 : 409;
    return Response.json({ error: claimed.error, code: claimed.code }, { status });
  }

  try {
    // Derive + persist the user→SA binding BEFORE provisioning, so a retry can recover the SA
    // even if a later step hiccups. The SA address is deterministic from the owner EOA.
    const smartAccount = await deriveUserKernelAddress(ownerEoa);
    await setUserSmartAccount(userId, { ownerEoa, smartAccount });

    const result = await provisionIdentity(claimed.handle, { ownerEoa, smartAccount });
    return Response.json({ handle: claimed.handle, ...result });
  } catch (err) {
    // Handle is reserved for the user even if provisioning hiccups; they can retry.
    return Response.json(
      { handle: claimed.handle, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
