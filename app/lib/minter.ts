/**
 * The "minter" — a single backend-controlled wallet that mints every user's root subname
 * under the parent (`daemonium.eth`). This is what automates ENS provisioning: the parent's
 * owner approves the minter ONCE (NameWrapper.setApprovalForAll(minter, true)), and from then
 * on the minter can create `ignis-<id>.daemonium.eth` for any user — no per-user approval.
 *
 * The minter sets each subname's owner to that user's Ignis, so each user still OWNS its own
 * name and subtree (and can mint sub-agents itself). The minter only bootstraps the root.
 */
import "server-only";
import { parseEther, type Address } from "viem";
import { ensureAgentWallet, getSigner } from "./dynamic-server";
import { publicClient } from "./evm";
import { IGNIS_GAS_SEED, GAS_SEED_THRESHOLD } from "./chain";
import type { StoredWallet } from "./wallet-store";

/** Reserved store key for the minter (not an ENS name — it never gets one). */
export const MINTER_KEY = "minter";

export function ensureMinter(): Promise<StoredWallet> {
  return ensureAgentWallet(MINTER_KEY);
}

/**
 * Top up `target` with gas from the minter if it's below the threshold. This is the gas
 * subsidy that lets identity-claim and spawn run without the user pre-funding ETH. No-op if
 * the target already has enough. Returns the funding tx hash, or null if nothing was needed.
 */
export async function seedGasIfLow(target: Address): Promise<`0x${string}` | null> {
  const balance = await publicClient.getBalance({ address: target });
  if (balance >= parseEther(GAS_SEED_THRESHOLD)) return null;
  await ensureMinter();
  const minter = await getSigner(MINTER_KEY);
  const hash = await minter.sendTransaction({
    to: target,
    value: parseEther(IGNIS_GAS_SEED),
    account: minter.account!,
    chain: minter.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
