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

export interface StoredWallet {
  label: string;
  address: string;
  /** Opaque, from createWalletAccount — do not depend on internal fields. */
  walletMetadata: WalletMetadata;
  externalServerKeyShares: ServerKeyShare[];
  createdAt: string;
  // Identity (filled in B3 once ENS/ERC-8004 are wired)
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

export async function getWalletByAddress(
  address: string,
): Promise<StoredWallet | undefined> {
  const store = await readStore();
  const lower = address.toLowerCase();
  return Object.values(store).find((w) => w.address.toLowerCase() === lower);
}

export async function listWallets(): Promise<StoredWallet[]> {
  return Object.values(await readStore());
}

export async function putWallet(w: StoredWallet): Promise<void> {
  const store = await readStore();
  store[w.label] = w;
  await writeStore(store);
}

export async function updateWallet(
  label: string,
  patch: Partial<StoredWallet>,
): Promise<StoredWallet> {
  const store = await readStore();
  const existing = store[label];
  if (!existing) throw new Error(`No wallet for label "${label}"`);
  const next = { ...existing, ...patch };
  store[label] = next;
  await writeStore(store);
  return next;
}
