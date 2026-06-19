/**
 * Session-key grants. When a user opts an agent into AUTONOMY, their embedded wallet signs a
 * ZeroDev permission account (serializePermissionAccount, client-side) scoping that agent's MPC
 * wallet to on-chain limits (targets / spend cap / expiry). We store the serialized approval here,
 * keyed by (userId, agentKey). At execute time, if an active grant covers the acting agent, the
 * server submits the UserOp with the agent's session key — no per-action user signature. Revoking
 * flips `active` off (and the policy carries an on-chain expiry as a backstop).
 *
 * The blob is NOT a secret — it cannot sign anything without the agent's MPC key share (held by
 * Dynamic) AND the on-chain policy. It's an authorization the user already signed.
 */
import "server-only";
import { kvGet, kvSet } from "./kv";

// Grants are PER CHAIN: a serialized permission account is chain-specific, so multi-chain autonomy
// is one grant per (agent, chainId). field = `${userId}:${agentKey}:${chainId}`.
const NS = "grants";

export interface GrantPolicy {
  /** Max USDC per transfer the agent may move (whole USDC). */
  maxUsdc?: number;
  /** Allowed target contracts (lowercased addresses). */
  targets?: string[];
  /** Unix seconds the grant is valid until. */
  validUntil?: number;
}

export interface SessionGrant {
  agentKey: string;
  /** The chain this grant authorizes the agent to act on (autonomy spans chains via one grant each). */
  chainId: number;
  /** Serialized permission account the user signed (serializePermissionAccount). */
  approvalBlob: string;
  policy: GrantPolicy;
  active: boolean;
  createdAt: string;
}

const field = (userId: string, agentKey: string, chainId: number) =>
  `${userId}:${agentKey}:${chainId}`;

export function setGrant(userId: string, grant: SessionGrant): Promise<void> {
  return kvSet(NS, field(userId, grant.agentKey, grant.chainId), grant);
}

/** The active, unexpired grant for an agent on a specific chain, or undefined. */
export async function getActiveGrant(
  userId: string,
  agentKey: string,
  chainId: number,
): Promise<SessionGrant | undefined> {
  const g = await kvGet<SessionGrant>(NS, field(userId, agentKey, chainId));
  if (!g || !g.active) return undefined;
  if (g.policy.validUntil && g.policy.validUntil * 1000 < Date.now()) return undefined;
  return g;
}

export async function revokeGrant(userId: string, agentKey: string, chainId: number): Promise<void> {
  const g = await kvGet<SessionGrant>(NS, field(userId, agentKey, chainId));
  if (g) await kvSet(NS, field(userId, agentKey, chainId), { ...g, active: false });
}
