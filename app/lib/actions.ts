/**
 * The action executor — the ONLY place agent intents turn into signed, broadcast
 * transactions. Reached exclusively from /api/daemon/execute after a human confirm.
 * B3/B4 extend the switch with register_subname and spawn_subagent.
 */
import "server-only";
import { erc20Abi, isAddress, parseEther, parseUnits, type Address } from "viem";
import {
  CHAIN,
  USDC,
  USDC_SEND_CAP,
  agentCardUri,
  SUBAGENT_GAS_SEED,
} from "./chain";
import { publicClient } from "./evm";
import { getSigner, createAgentWallet } from "./dynamic-server";
import { registerSubname as ensRegisterSubname, setAgentCardRecord } from "./ens";
import { registerIdentity } from "./erc8004";
import { getWallet, updateWallet } from "./wallet-store";
import type {
  ProposalCard,
  ExecuteResponse,
  RegisterSubnameDetails,
  SpawnSubagentDetails,
} from "./types";

export async function executeProposal(card: ProposalCard): Promise<ExecuteResponse> {
  switch (card.details.action) {
    case "send_usdc":
      return sendUsdc(card.agent, card.details);
    case "register_subname":
      return claimIdentity(card.details);
    case "spawn_subagent":
      return spawnSubagent(card.details);
    default:
      return { ok: false, error: `Unknown action` };
  }
}

/**
 * Spawn a sub-agent: a NEW server wallet + a nested ENS subname under the parent (the
 * cluster), then best-effort give it gas and register its own ERC-8004 identity + text
 * record. The wallet + nested subname are the headline; identity is best-effort so a gas
 * hiccup never loses the cluster node.
 */
async function spawnSubagent(
  details: SpawnSubagentDetails,
): Promise<ExecuteResponse> {
  const { label, name, parentLabel } = details;
  try {
    const parent = await getWallet(parentLabel);
    if (!parent?.ensName) return { ok: false, error: `No parent "${parentLabel}"` };

    // 1. The sub-agent's own wallet — it IS this address.
    const child = await createAgentWallet(label, { parentLabel });
    const childAddr = child.address as Address;

    // 2. Link it into the parent's cluster.
    await updateWallet(parentLabel, {
      children: Array.from(new Set([...parent.children, label])),
    });

    // 3. Parent mints the nested subname, owned by the sub-agent.
    const { hash } = await ensRegisterSubname({
      parentName: parent.ensName,
      label,
      owner: childAddr,
      signerLabel: parentLabel,
    });

    // 4. Best-effort: seed gas from the parent, then the sub-agent claims its own identity.
    try {
      const parentSigner = await getSigner(parentLabel);
      const seedHash = await parentSigner.sendTransaction({
        to: childAddr,
        value: parseEther(SUBAGENT_GAS_SEED),
        account: parentSigner.account!,
        chain: parentSigner.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: seedHash });

      const uri = agentCardUri(label);
      const { agentId } = await registerIdentity({ agentURI: uri, signerLabel: label });
      await setAgentCardRecord({ name, uri, signerLabel: label });
      await updateWallet(label, { agentId, agentCardUri: uri });
    } catch {
      // Wallet + nested subname already exist; identity can be retried later.
    }

    return { ok: true, hash };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Claim an agent's onchain identity in one confirmed action: mint the ENS subname,
 * register the ERC-8004 NFT, set the agent-card text record, and persist the result.
 * Requires the signer to control the parent name and the owner agent to have gas.
 */
async function claimIdentity(
  details: RegisterSubnameDetails,
): Promise<ExecuteResponse> {
  const { label, parentName, ownerLabel, signerLabel, name } = details;
  try {
    const ownerWallet = await getWallet(ownerLabel);
    if (!ownerWallet) return { ok: false, error: `No wallet for "${ownerLabel}"` };
    const owner = ownerWallet.address as Address;

    // 1. Mint the (nested) subname, owned by the agent, with the PublicResolver set.
    const { hash } = await ensRegisterSubname({ parentName, label, owner, signerLabel });

    // 2. Register the ERC-8004 identity NFT (signed by the agent itself).
    const uri = agentCardUri(label);
    const { agentId } = await registerIdentity({ agentURI: uri, signerLabel: ownerLabel });

    // 3. Point the ENS name's agent-card text record at the card.
    await setAgentCardRecord({ name, uri, signerLabel: ownerLabel });

    // 4. Persist the identity onto the wallet record.
    await updateWallet(ownerLabel, { agentId, agentCardUri: uri });

    return { ok: true, hash };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendUsdc(
  agent: string,
  details: { to: string; amount: string },
): Promise<ExecuteResponse> {
  if (!isAddress(details.to)) {
    return { ok: false, error: `Invalid recipient address: ${details.to}` };
  }
  const amount = Number(details.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `Invalid amount: ${details.amount}` };
  }
  // Defense in depth: a hard per-tx cap independent of the agent's reasoning.
  if (amount > USDC_SEND_CAP) {
    return { ok: false, error: `Amount ${amount} exceeds the ${USDC_SEND_CAP} USDC cap` };
  }

  const value = parseUnits(details.amount, USDC.decimals);
  const signer = await getSigner(agent);
  const account = signer.account;
  if (!account) return { ok: false, error: "Agent wallet has no account" };

  try {
    const hash = await signer.writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [details.to as Address, value],
      account,
      chain: CHAIN,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success"
      ? { ok: true, hash }
      : { ok: false, hash, error: "Transaction reverted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
