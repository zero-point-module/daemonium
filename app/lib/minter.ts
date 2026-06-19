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
import { defiClient, identityClient } from "./evm";
import {
  IGNIS_GAS_SEED,
  GAS_SEED_THRESHOLD,
  DEFI_GAS_SEED,
  DEFI_GAS_SEED_THRESHOLD,
  IDENTITY_CHAIN,
  IDENTITY_CHAIN_ID,
  IDENTITY_RPC_URL,
  DEFI_CHAIN,
  DEFI_CHAIN_ID,
  DEFI_RPC_URL,
} from "./chain";
import { getWallet, putWallet, type StoredWallet } from "./wallet-store";
import { withLock } from "./lock";

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
 * Top up `target` with gas from the minter if it's below the threshold, on the chosen chain. This
 * is the self-funded gas subsidy: the IDENTITY chain (L1) funds the dæmon's ERC-8004 register and
 * any SA identity UserOps; the DEFI chain (Base) funds the user smart account's value UserOps.
 * No-op if the target already has enough. Returns the funding tx hash, or null if nothing was needed.
 */
export async function seedGasIfLow(
  target: Address,
  opts: { chain?: "identity" | "defi" } = {},
): Promise<`0x${string}` | null> {
  const onDefi = opts.chain === "defi";
  const pub = onDefi ? defiClient : identityClient;
  const seed = onDefi ? DEFI_GAS_SEED : IGNIS_GAS_SEED;
  const threshold = onDefi ? DEFI_GAS_SEED_THRESHOLD : GAS_SEED_THRESHOLD;
  const signerOpts = onDefi
    ? { chain: DEFI_CHAIN, chainId: DEFI_CHAIN_ID, rpcUrl: DEFI_RPC_URL }
    : { chain: IDENTITY_CHAIN, chainId: IDENTITY_CHAIN_ID, rpcUrl: IDENTITY_RPC_URL };

  // Serialize minter sends PER CHAIN: the minter is one EOA per chain, so concurrent seeds on the
  // same chain would otherwise fetch the same nonce and collide. Different chains have independent
  // nonces, so they need not block each other. Re-checking the balance inside the lock also stops
  // two callers from double-seeding the same target.
  return withLock(`minter:${onDefi ? DEFI_CHAIN_ID : IDENTITY_CHAIN_ID}`, async () => {
    const balance = await pub.getBalance({ address: target });
    if (balance >= parseEther(threshold)) return null;
    await ensureMinter();
    const minter = await getSigner(MINTER_KEY, signerOpts);
    const hash = await minter.sendTransaction({
      to: target,
      value: parseEther(seed),
      account: minter.account!,
      chain: signerOpts.chain,
    });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  });
}
