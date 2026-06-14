/**
 * Persistence for agent wallets. The Dynamic server-wallet SDK is STATELESS — we own
 * `walletMetadata` + `externalServerKeyShares` and must reload both before every sign.
 * Lose the shares → the wallet (and its funds) is unrecoverable.
 *
 * Hackathon store: a gitignored JSON file under .daemon/. Production would use a vault/KMS
 * for the shares and a DB for the metadata. The file doubles as the agent identity tree.
 */
import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WalletMetadata, ServerKeyShare } from "@dynamic-labs-wallet/node";
import { withLock } from "./lock";

export interface StoredWallet {
  label: string;
  address: string;
  /** Opaque, from createWalletAccount — do not depend on internal fields. */
  walletMetadata: WalletMetadata;
  externalServerKeyShares: ServerKeyShare[];
  createdAt: string;
  // Identity — set during provisioning (ENS name, ERC-8004 id + agent-card URI).
  ensName?: string;
  agentId?: string;
  agentCardUri?: string;
  parent?: string;
  children: string[];
}

type Store = Record<string, StoredWallet>; // keyed by label

const STORE_DIR = path.join(process.cwd(), ".daemon");
const STORE_PATH = path.join(STORE_DIR, "wallets.json");

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw) as Store;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function getWallet(label: string): Promise<StoredWallet | undefined> {
  return (await readStore())[label];
}

export function putWallet(w: StoredWallet): Promise<void> {
  // Serialized so concurrent writes to different keys don't clobber the whole file.
  return withLock("wallets", async () => {
    const store = await readStore();
    store[w.label] = w;
    await writeStore(store);
  });
}

export function updateWallet(
  label: string,
  patch: Partial<StoredWallet>,
): Promise<StoredWallet> {
  // Re-read INSIDE the lock so field merges (e.g. children append) can't lose updates.
  return withLock("wallets", async () => {
    const store = await readStore();
    const existing = store[label];
    if (!existing) throw new Error(`No wallet for label "${label}"`);
    const next = { ...existing, ...patch };
    store[label] = next;
    await writeStore(store);
    return next;
  });
}

/**
 * Append a child label to a parent's `children`, deduped, ATOMICALLY inside the store lock.
 * Unlike `updateWallet(parent, { children: [...] })` — where the array is computed from a
 * snapshot read before the lock — this reads the parent inside the lock, so two concurrent
 * spawns under the same parent can't clobber each other's child.
 */
export function appendChild(
  parentLabel: string,
  childLabel: string,
): Promise<StoredWallet> {
  return withLock("wallets", async () => {
    const store = await readStore();
    const existing = store[parentLabel];
    if (!existing) throw new Error(`No wallet for label "${parentLabel}"`);
    const children = existing.children.includes(childLabel)
      ? existing.children
      : [...existing.children, childLabel];
    const next = { ...existing, children };
    store[parentLabel] = next;
    await writeStore(store);
    return next;
  });
}
