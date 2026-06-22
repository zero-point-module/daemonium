/**
 * Confirmed-proposal execution. Value actions (send/swap) NO LONGER run here — they
 * execute on the USER'S smart account via the co-sign or session-key path (see app/lib/action-calls.ts
 * + /api/daemon/execute). The only thing this module still executes is `spawn_subagent` (identity
 * provisioning on Ethereum L1, which moves no user funds). Keeping value execution out of here is
 * deliberate: routing a fund move through the agent's MPC wallet would bypass the smart-account
 * ownership + confirm/grant gate.
 */
import "server-only";
import { type Address } from "viem";
import { agentCardUri, ENS_ONCHAIN_MINTING, IDENTITY_CHAIN_ID } from "./chain";
import { ensureAgentWallet } from "./dynamic-server";
import { seedGasIfLow } from "./minter";
import {
  registerSubname as ensRegisterSubname,
  subnameExists,
  canManageParent,
} from "./ens";
import { registerIdentity, ownsIdentity } from "./erc8004";
import { getWallet, updateWallet, appendChild } from "./wallet-store";
import type { ProposalCard, ExecuteResponse, SpawnSubagentDetails } from "./types";

/**
 * Execute a confirmed proposal. ONLY `spawn_subagent` is handled (it provisions identity on L1 and
 * moves no user funds). Value actions are explicitly rejected — they run on the smart account; this
 * guard stops a future caller from accidentally signing a fund move with the agent's MPC wallet and
 * bypassing the SA / co-sign / grant gate.
 */
export async function executeProposal(card: ProposalCard): Promise<ExecuteResponse> {
  if (card.details.action !== "spawn_subagent") {
    return {
      ok: false,
      error: `executeProposal does not handle "${card.details.action}" — value actions run on the smart account`,
    };
  }
  const result = await spawnSubagent(card.details);
  // Spawn lands on Ethereum L1 (ENS subname + ERC-8004); tag it so the UI links to the right explorer.
  return result.hash ? { ...result, chainId: IDENTITY_CHAIN_ID } : result;
}

/**
 * Spawn a sub-agent. The headline (always works): a NEW server wallet, linked into the
 * parent's cluster, funded, with its own ERC-8004 identity (all on Ethereum L1). The nested ENS
 * subname is BEST EFFORT — it only mints if the parent dæmon actually owns its own ENS name on
 * L1 (i.e. the cluster is set up). Otherwise it's deferred, so spawning never hard-fails.
 * Mirrors provisionIdentity's decoupling.
 */
async function spawnSubagent(details: SpawnSubagentDetails): Promise<ExecuteResponse> {
  const { label, childKey, parentKey } = details;
  try {
    const parent = await getWallet(parentKey);
    if (!parent?.ensName) return { ok: false, error: `No parent "${parentKey}"` };

    // 1. The sub-agent's own wallet (it IS this address), linked into the parent's cluster.
    //    ensureAgentWallet is idempotent — re-confirming the same spawn returns the existing
    //    wallet instead of minting a second Dynamic wallet and orphaning the first. appendChild
    //    reads the parent inside the store lock, so concurrent spawns can't clobber the cluster.
    const child = await ensureAgentWallet(childKey, { parentEnsName: parent.ensName });
    const childAddr = child.address as Address;
    await appendChild(parentKey, childKey);

    // The user's smart account owns the whole cluster's identity. Inherited from the parent dæmon
    // (set at provision). A child is a SESSION KEY on that same SA, not an owner.
    const userSA = parent.ownerSmartAccount as Address | undefined;
    if (userSA) await updateWallet(childKey, { ownerSmartAccount: userSA, ownerEoa: parent.ownerEoa });

    // 2. Fund + register the sub-agent's ERC-8004 identity (agent-signed; relocating it to the SA
    //    is a co-signed UserOp). The child's L1 wallet pays its own register gas.
    await seedGasIfLow(childAddr, { chain: "identity" });
    const uri = agentCardUri(childKey);
    let hash: `0x${string}` | undefined;
    if (!child.agentId && !(await ownsIdentity(childAddr))) {
      const r = await registerIdentity({ agentURI: uri, signerLabel: childKey });
      await updateWallet(childKey, { agentId: r.agentId, agentCardUri: uri });
      hash = r.hash;
    }

    // 3. Nested ENS subname on L1, owned by the USER'S SMART ACCOUNT. The parent node is now owned
    //    by the SA, so minting a nested subname requires the SA to sign (a UserOp) — until that
    //    co-sign path is wired, canManageParent is false for the parent agent and this skips
    //    cleanly. Best-effort + decoupled so a gas hiccup never loses the cluster node.
    if (ENS_ONCHAIN_MINTING) {
      try {
        const parentAddr = parent.address as Address;
        if (!(await subnameExists(childKey)) && (await canManageParent(parent.ensName, parentAddr))) {
          await seedGasIfLow(parentAddr, { chain: "identity" }); // signer pays to mint the subname
          const r = await ensRegisterSubname({
            parentName: parent.ensName,
            label,
            owner: userSA ?? childAddr,
            signerLabel: parentKey,
          });
          hash = r.hash;
        }
      } catch {
        // ENS deferred — the sub-agent still has its wallet + 8004.
      }
    }

    return { ok: true, hash };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
