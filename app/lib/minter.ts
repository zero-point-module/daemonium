/**
 * The "minter" — a single backend-controlled wallet that mints every user's root subname
 * under the parent (`daemonium.eth`). This is what automates ENS provisioning: the parent's
 * owner approves the minter ONCE (NameWrapper.setApprovalForAll(minter, true)), and from then
 * on the minter can create `<handle>.daemonium.eth` for any user — no per-user approval.
 *
 * The minter sets each subname's owner to that user's dæmon, so each user still OWNS its own
 * name and subtree (and can mint sub-agents itself). The minter only bootstraps that one level.
 */
import "server-only";
import { parseEther, type Address } from "viem";
import type { WalletMetadata } from "@dynamic-labs-wallet/node";
import { ensureAgentWallet, getSigner, seedWalletMetadata } from "./dynamic-server";
import { identityClient } from "./evm";
import { IGNIS_GAS_SEED, GAS_SEED_THRESHOLD } from "./chain";
import { getWallet, putWallet, type StoredWallet } from "./wallet-store";

/** Reserved store key for the minter (not an ENS name — it never gets one). */
export const MINTER_KEY = "minter";

/**
 * Optional pin. The minter is a Dynamic MPC wallet, so its address alone can't sign — the key
 * shares are what sign. Set MINTER_WALLET to a (base64 of, or raw) minter wallet record and
 * EVERY environment — each local worktree and the deploy — loads that SAME funded + approved
 * minter, instead of each .daemon store auto-minting its own throwaway. Unset → legacy
 * behaviour. Capture the value with `npm run minter:export`. Shares live in Dynamic's backup
 * (backUpToDynamic), recovered via DAEMON_WALLET_PASSWORD — keep that consistent across environments.
 */
function loadPinnedMinter(): StoredWallet | null {
  const raw = process.env.MINTER_WALLET?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("MINTER_WALLET is set but is not valid JSON nor base64-encoded JSON.");
  }
  const w = parsed as Partial<StoredWallet> & { walletMetadata?: WalletMetadata };
  if (!w.address) {
    throw new Error("MINTER_WALLET is missing the required field: address.");
  }
  // If a legacy pin carries walletMetadata, seed the cache so the minter signs immediately;
  // otherwise its signable metadata is reconstructed from Dynamic's getEvmWallets() on demand.
  if (w.walletMetadata) seedWalletMetadata(w.address, w.walletMetadata);
  return {
    label: MINTER_KEY, // always canonical, whatever the export was keyed as
    address: w.address,
    createdAt: w.createdAt ?? new Date().toISOString(),
    children: w.children ?? [],
  };
}

export async function ensureMinter(): Promise<StoredWallet> {
  const pinned = loadPinnedMinter();
  if (!pinned) return ensureAgentWallet(MINTER_KEY); // legacy: per-store auto-mint

  // Seed the pinned record into THIS store so getSigner(MINTER_KEY) signs as it.
  const existing = await getWallet(MINTER_KEY);
  if (existing?.address.toLowerCase() !== pinned.address.toLowerCase()) {
    await putWallet(pinned);
  }
  return pinned;
}

/**
 * Top up `target` with gas from the minter if it's below the threshold. This is the gas
 * subsidy that lets identity-claim and spawn run without the user pre-funding ETH. No-op if
 * the target already has enough. Returns the funding tx hash, or null if nothing was needed.
 */
export async function seedGasIfLow(target: Address): Promise<`0x${string}` | null> {
  const balance = await identityClient.getBalance({ address: target });
  if (balance >= parseEther(GAS_SEED_THRESHOLD)) return null;
  await ensureMinter();
  const minter = await getSigner(MINTER_KEY);
  const hash = await minter.sendTransaction({
    to: target,
    value: parseEther(IGNIS_GAS_SEED),
    account: minter.account!,
    chain: minter.chain,
  });
  await identityClient.waitForTransactionReceipt({ hash });
  return hash;
}
