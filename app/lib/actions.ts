/**
 * The action executor — the ONLY place agent intents turn into signed, broadcast
 * transactions. Reached exclusively from /api/daemon/execute after a human confirm.
 * (Identity claiming is NOT here — it's auto-provisioned at handle pick, see provision.ts.)
 */
import "server-only";
import {
  createPublicClient,
  http,
  erc20Abi,
  isAddress,
  parseEther,
  parseUnits,
  type Address,
} from "viem";
import {
  CHAIN,
  USDC,
  USDC_SEND_CAP,
  ETH_SEND_CAP,
  agentCardUri,
  ENS_ONCHAIN_MINTING,
  SWAP_CHAIN,
  SWAP_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  SWAP_TOKENS,
  SWAP_CAP_USD,
} from "./chain";
import { publicClient } from "./evm";
import { getSwapQuote } from "./swap";
import { getSigner, ensureAgentWallet } from "./dynamic-server";
import { seedGasIfLow } from "./minter";
import {
  registerSubname as ensRegisterSubname,
  setAgentCardRecord,
  subnameExists,
  canManageParent,
} from "./ens";
import { registerIdentity, ownsIdentity } from "./erc8004";
import { getWallet, updateWallet, appendChild } from "./wallet-store";
import type { ProposalCard, ExecuteResponse, SpawnSubagentDetails, SwapDetails } from "./types";

export async function executeProposal(card: ProposalCard): Promise<ExecuteResponse> {
  switch (card.details.action) {
    case "send_usdc":
      return sendUsdc(card.agent, card.details);
    case "send_eth":
      return sendEth(card.agent, card.details);
    case "swap":
      return swap(card.agent, card.details);
    case "spawn_subagent":
      return spawnSubagent(card.details);
    default:
      return { ok: false, error: `Unknown action` };
  }
}

/** Send native ETH from an agent's wallet. The agent pays gas from the same balance. */
async function sendEth(
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
  if (amount > ETH_SEND_CAP) {
    return { ok: false, error: `Amount ${amount} exceeds the ${ETH_SEND_CAP} ETH cap` };
  }

  const signer = await getSigner(agent);
  const account = signer.account;
  if (!account) return { ok: false, error: "Agent wallet has no account" };

  try {
    const hash = await signer.sendTransaction({
      to: details.to as Address,
      value: parseEther(details.amount),
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

/**
 * Execute a real Dynamic-routed swap on the swap chain (Base Sepolia). Re-quotes FRESH at
 * execute time (quotes are snapshots), enforces a notional USD cap, approves the ERC-20 if the
 * quote asks for it, then signs+broadcasts the swap tx via the agent's server wallet on that
 * chain (same MPC address, different chain).
 */
async function swap(agent: string, details: SwapDetails): Promise<ExecuteResponse> {
  const from = SWAP_TOKENS[details.fromSymbol.toUpperCase()];
  const to = SWAP_TOKENS[details.toSymbol.toUpperCase()];
  if (!from || !to) {
    return { ok: false, error: `Unknown token (supported: ${Object.keys(SWAP_TOKENS).join(", ")})` };
  }
  const amount = Number(details.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `Invalid amount: ${details.amount}` };
  }

  try {
    const w = await getWallet(agent);
    if (!w) return { ok: false, error: `No wallet for "${agent}"` };
    const account = w.address as Address;
    const fromAmount = parseUnits(details.amount, from.decimals).toString();

    const quote = await getSwapQuote({ account, fromToken: from.address, toToken: to.address, fromAmount });

    // Fail CLOSED: if the quote carries no USD notional we can't prove we're under the
    // cap, so refuse rather than letting `?? "0"` silently wave the swap through.
    const usd = quote.from.amountUSD != null ? Number(quote.from.amountUSD) : NaN;
    if (!Number.isFinite(usd)) {
      return { ok: false, error: "Swap quote returned no USD value; refusing to bypass the cap" };
    }
    if (usd > SWAP_CAP_USD) {
      return { ok: false, error: `Swap notional $${usd} exceeds the $${SWAP_CAP_USD} cap` };
    }
    const evmTx = quote.signingPayload.evmTransaction;
    if (!evmTx) return { ok: false, error: "Quote returned no executable transaction" };

    const signer = await getSigner(agent, {
      chain: SWAP_CHAIN,
      chainId: SWAP_CHAIN_ID,
      rpcUrl: BASE_SEPOLIA_RPC_URL,
    });
    const account_ = signer.account;
    if (!account_) return { ok: false, error: "Agent wallet has no account" };
    const swapPublic = createPublicClient({ chain: SWAP_CHAIN, transport: http(BASE_SEPOLIA_RPC_URL) });

    // ERC-20 approval first, if the quote requires one (skip for native-token swaps).
    const approval = quote.signingPayload.evmApproval;
    if (approval) {
      const allowance = (await swapPublic.readContract({
        address: approval.tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, approval.spenderAddress],
      })) as bigint;
      if (allowance < BigInt(approval.amount)) {
        const approveHash = await signer.writeContract({
          address: approval.tokenAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [approval.spenderAddress, BigInt(approval.amount)],
          account: account_,
          chain: SWAP_CHAIN,
        });
        await swapPublic.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    const hash = await signer.sendTransaction({
      to: evmTx.to,
      data: evmTx.data,
      value: BigInt(evmTx.value ?? "0"),
      account: account_,
      chain: SWAP_CHAIN,
    });
    const receipt = await swapPublic.waitForTransactionReceipt({ hash });
    return receipt.status === "success"
      ? { ok: true, hash }
      : { ok: false, hash, error: "Swap transaction reverted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Spawn a sub-agent. The headline (always works): a NEW server wallet, linked into the
 * parent's cluster, funded, with its own ERC-8004 identity. The nested ENS subname is
 * BEST EFFORT — it only mints if the parent agent actually owns its own ENS name (i.e. the
 * ENS parent chain is set up). Otherwise it's deferred, so spawning never hard-fails on the
 * Sepolia ENS-registrar situation. Mirrors provisionIdentity's decoupling.
 */
async function spawnSubagent(
  details: SpawnSubagentDetails,
): Promise<ExecuteResponse> {
  const { label, childKey, parentKey } = details;
  try {
    const parent = await getWallet(parentKey);
    if (!parent?.ensName) return { ok: false, error: `No parent "${parentKey}"` };

    // 1. The sub-agent's own wallet (it IS this address), linked into the parent's cluster.
    //    ensureAgentWallet is idempotent — re-confirming the same spawn returns the existing
    //    wallet instead of minting a second one and orphaning the first one's key shares.
    const child = await ensureAgentWallet(childKey, { parentEnsName: parent.ensName });
    const childAddr = child.address as Address;
    await appendChild(parentKey, childKey);

    // 2. Fund the sub-agent + register its ERC-8004 identity. Independent of ENS.
    await seedGasIfLow(childAddr);
    const uri = agentCardUri(childKey);
    let hash: `0x${string}` | undefined;
    if (!child.agentId && !(await ownsIdentity(childAddr))) {
      const r = await registerIdentity({ agentURI: uri, signerLabel: childKey });
      await updateWallet(childKey, { agentId: r.agentId, agentCardUri: uri });
      hash = r.hash;
    }

    // 3. Nested ENS subname. OFF on Sepolia (ENS_ONCHAIN_MINTING=false) — the sub-agent's ENS
    //    name is a label; its real on-chain identity is its wallet + ERC-8004. v1 minting kept
    //    behind the flag for a v1-live network; best-effort + decoupled so it never fails the spawn.
    if (ENS_ONCHAIN_MINTING) {
      try {
        const parentAddr = parent.address as Address;
        if (!(await subnameExists(childKey)) && (await canManageParent(parent.ensName, parentAddr))) {
          await seedGasIfLow(parentAddr); // parent pays to mint the subname
          const r = await ensRegisterSubname({
            parentName: parent.ensName,
            label,
            owner: childAddr,
            signerLabel: parentKey,
          });
          await setAgentCardRecord({ name: childKey, uri, signerLabel: childKey });
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
