/**
 * The agent identity index. This holds only small, non-sensitive APPLICATION state — which
 * address is which dæmon, and the cluster tree — keyed by the agent's ENS name. It does NOT hold
 * wallet key material or even Dynamic's `walletMetadata`: Dynamic is the source of truth for
 * wallets (shares live in its backup; signable metadata is reconstructed from `getEvmWallets()`
 * at sign time — see dynamic-server.ts). The only thing Dynamic can't tell us is which wallet is
 * which dæmon, so we keep this thin name→address index.
 *
 * Backed by `kv.ts` — a serverless Redis (Upstash / Vercel KV) when configured, else a gitignored
 * JSON file for local dev. No JSON file is required to deploy.
 */
import "server-only";
import { kvGet, kvSet } from "./kv";
import { withLock } from "./lock";

const NS = "wallets";

export interface StoredWallet {
  label: string;
  /** The agent's Dynamic MPC address. Under the smart-account model this is the agent's
   *  SESSION-KEY signer, not the on-chain owner of funds/identity. */
  address: string;
  createdAt: string;
  ensName?: string;
  agentId?: string;
  agentCardUri?: string;
  parent?: string;
  children: string[];
  /** The user's Kernel smart-account address — the on-chain OWNER of this agent's identity and
   *  funds. Same address across chains. Set at provision time on the user's root dæmon record. */
  ownerSmartAccount?: string;
  /** The user's embedded-wallet EOA that is the smart account's sudo owner (the SA is derived
   *  deterministically from it). */
  ownerEoa?: string;
}

export function getWallet(label: string): Promise<StoredWallet | undefined> {
  return kvGet<StoredWallet>(NS, label);
}

export function putWallet(w: StoredWallet): Promise<void> {
  // Per-field set is atomic (Redis HSET; the file backend locks the namespace internally).
  return kvSet(NS, w.label, w);
}

export function updateWallet(label: string, patch: Partial<StoredWallet>): Promise<StoredWallet> {
  // Read-modify-write under a per-label lock so concurrent merges (e.g. children append) can't
  // lose updates. (Process-local; a multi-instance deploy would want an atomic field update.)
  return withLock(`wallet:${label}`, async () => {
    const existing = await kvGet<StoredWallet>(NS, label);
    if (!existing) throw new Error(`No wallet for label "${label}"`);
    const next = { ...existing, ...patch };
    await kvSet(NS, label, next);
    return next;
  });
}

/**
 * Append a child label to a parent's `children`, deduped, ATOMICALLY inside the per-label lock:
 * the parent is read INSIDE the lock and the child appended, so two concurrent spawns under the
 * same parent can't clobber each other's child — unlike `updateWallet(parent, { children })`,
 * whose array is computed from a snapshot taken before the lock.
 */
export function appendChild(parentLabel: string, childLabel: string): Promise<StoredWallet> {
  return withLock(`wallet:${parentLabel}`, async () => {
    const existing = await kvGet<StoredWallet>(NS, parentLabel);
    if (!existing) throw new Error(`No wallet for label "${parentLabel}"`);
    const children = existing.children.includes(childLabel)
      ? existing.children
      : [...existing.children, childLabel];
    const next = { ...existing, children };
    await kvSet(NS, parentLabel, next);
    return next;
  });
}
