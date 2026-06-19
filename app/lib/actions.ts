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
  type Chain,
} from "viem";
import { mainnet, base, arbitrum, optimism, polygon } from "viem/chains";
import {
  USDC,
  USDC_SEND_CAP,
  ETH_SEND_CAP,
  agentCardUri,
  ENS_ONCHAIN_MINTING,
  IDENTITY_CHAIN,
  IDENTITY_CHAIN_ID,
  IDENTITY_RPC_URL,
  DEFI_CHAIN,
  DEFI_CHAIN_ID,
  DEFI_RPC_URL,
  SWAP_CHAIN,
  SWAP_TOKENS,
  SWAP_CAP_USD,
  LIFI_VAULTS,
  LIFI_CAP_USD,
} from "./chain";
import { defiClient, identityClient } from "./evm";
import { getSwapQuote } from "./swap";
import { composeSwapAndZap, bridgeQuote } from "./lifi";
import { getSigner, ensureAgentWallet } from "./dynamic-server";
import { seedGasIfLow } from "./minter";
import {
  registerSubname as ensRegisterSubname,
  subnameExists,
  canManageParent,
} from "./ens";
import { registerIdentity, ownsIdentity } from "./erc8004";
import { getWallet, updateWallet, appendChild } from "./wallet-store";
import type {
  ProposalCard,
  ExecuteResponse,
  SpawnSubagentDetails,
  SendEthDetails,
  SwapDetails,
  LifiZapDetails,
  LifiBridgeDetails,
} from "./types";

/** Signer options for the DeFi/value layer (Base mainnet — swaps, LI.FI, default sends). */
const DEFI_SIGNER = { chain: DEFI_CHAIN, chainId: DEFI_CHAIN_ID, rpcUrl: DEFI_RPC_URL };
/** Signer options for the identity layer (Ethereum mainnet). */
const IDENTITY_SIGNER = { chain: IDENTITY_CHAIN, chainId: IDENTITY_CHAIN_ID, rpcUrl: IDENTITY_RPC_URL };

/** Resolve a chainId to its signer opts, viem chain, and read client. null if unsupported. */
function nativeChainCtx(chainId: number) {
  if (chainId === DEFI_CHAIN_ID) return { signer: DEFI_SIGNER, chain: DEFI_CHAIN, pub: defiClient };
  if (chainId === IDENTITY_CHAIN_ID) return { signer: IDENTITY_SIGNER, chain: IDENTITY_CHAIN, pub: identityClient };
  return null;
}

/** viem chains the bridge executor can sign a SOURCE tx on (uses each chain's default RPC). */
const BRIDGE_VIEM_CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  10: optimism,
  137: polygon,
};

export async function executeProposal(card: ProposalCard): Promise<ExecuteResponse> {
  const result = await runAction(card);
  // Tag the chain the tx actually ran on, so the UI links to the right block explorer
  // (value actions broadcast on Base, identity/spawn on L1, a bridge on its source chain).
  return result.hash ? { ...result, chainId: chainIdForAction(card) } : result;
}

/** Which chain a confirmed action's tx lands on. */
function chainIdForAction(card: ProposalCard): number {
  switch (card.details.action) {
    case "spawn_subagent":
      return IDENTITY_CHAIN_ID; // ENS subname + ERC-8004 register live on Ethereum L1
    case "lifi_bridge":
      return card.details.fromChainId; // the source-chain tx we actually broadcast
    case "send_eth":
      return card.details.chainId; // send_eth runs on the chain the agent chose
    default:
      return DEFI_CHAIN_ID; // send_usdc / swap / lifi_zap all run on Base
  }
}

async function runAction(card: ProposalCard): Promise<ExecuteResponse> {
  switch (card.details.action) {
    case "send_usdc":
      return sendUsdc(card.agent, card.details);
    case "send_eth":
      return sendEth(card.agent, card.details);
    case "swap":
      return swap(card.agent, card.details);
    case "lifi_zap":
      return lifiZap(card.agent, card.details);
    case "lifi_bridge":
      return lifiBridge(card.agent, card.details);
    case "spawn_subagent":
      return spawnSubagent(card.details);
    default:
      return { ok: false, error: `Unknown action` };
  }
}

/** Send native ETH from an agent's wallet on the chosen chain (Ethereum L1 or Base). The agent
 *  pays gas from the same balance on that chain. */
async function sendEth(agent: string, details: SendEthDetails): Promise<ExecuteResponse> {
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
  const ctx = nativeChainCtx(details.chainId);
  if (!ctx) return { ok: false, error: `Unsupported chain ${details.chainId} for ETH send` };

  const signer = await getSigner(agent, ctx.signer);
  const account = signer.account;
  if (!account) return { ok: false, error: "Agent wallet has no account" };

  try {
    const hash = await signer.sendTransaction({
      to: details.to as Address,
      value: parseEther(details.amount),
      account,
      chain: ctx.chain,
    });
    const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
    return receipt.status === "success"
      ? { ok: true, hash }
      : { ok: false, hash, error: "Transaction reverted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Execute a real Dynamic-routed swap on Base mainnet. Re-quotes FRESH at execute time (quotes are
 * snapshots), enforces a notional USD cap, approves the ERC-20 if the quote asks for it, then
 * signs+broadcasts the swap tx via the agent's server wallet on Base (same MPC address).
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

    // Fail CLOSED: if the quote carries no USD notional we can't prove we're under the cap,
    // so refuse rather than letting `?? "0"` silently wave the swap through.
    const usd = quote.from.amountUSD != null ? Number(quote.from.amountUSD) : NaN;
    if (!Number.isFinite(usd)) {
      return { ok: false, error: "Swap quote returned no USD value; refusing to bypass the cap" };
    }
    if (usd > SWAP_CAP_USD) {
      return { ok: false, error: `Swap notional $${usd} exceeds the $${SWAP_CAP_USD} cap` };
    }
    const evmTx = quote.signingPayload.evmTransaction;
    if (!evmTx) return { ok: false, error: "Quote returned no executable transaction" };

    const signer = await getSigner(agent, DEFI_SIGNER);
    const account_ = signer.account;
    if (!account_) return { ok: false, error: "Agent wallet has no account" };

    // ERC-20 approval first, if the quote requires one (skip for native-token swaps).
    const approval = quote.signingPayload.evmApproval;
    if (approval) {
      const allowance = (await defiClient.readContract({
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
        await defiClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    const hash = await signer.sendTransaction({
      to: evmTx.to,
      data: evmTx.data,
      value: BigInt(evmTx.value ?? "0"),
      account: account_,
      chain: SWAP_CHAIN,
    });
    const receipt = await defiClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success"
      ? { ok: true, hash }
      : { ok: false, hash, error: "Swap transaction reverted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Execute a LI.FI swap-and-zap on Base mainnet. Re-compiles FRESH (quotes are snapshots),
 * enforces a notional USD cap, approves the execution proxy for each input token, then submits
 * the compiled flow tx (one atomic swap→zap). The agent's EOA is the signer + source of funds;
 * `result.userProxy` is its deterministic execution proxy (read from the compile, never hardcoded).
 */
async function lifiZap(agent: string, details: LifiZapDetails): Promise<ExecuteResponse> {
  const from = SWAP_TOKENS[details.fromSymbol.toUpperCase()];
  if (!from) {
    return { ok: false, error: `Unknown token (supported: ${Object.keys(SWAP_TOKENS).join(", ")})` };
  }
  const vault = LIFI_VAULTS[details.vault.toUpperCase()];
  if (!vault) {
    return { ok: false, error: `Unknown vault (supported: ${Object.keys(LIFI_VAULTS).join(", ")})` };
  }
  const amount = Number(details.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `Invalid amount: ${details.amount}` };
  }

  try {
    const w = await getWallet(agent);
    if (!w) return { ok: false, error: `No wallet for "${agent}"` };
    const signerAddr = w.address as Address;

    const result = await composeSwapAndZap({
      signer: signerAddr,
      fromToken: from.address,
      fromDecimals: from.decimals,
      amount: details.amount,
      vaultToken: vault.address,
    });

    if (result.status !== "success") {
      const reason =
        result.status === "partial"
          ? result.error?.message ?? "simulation reverted"
          : "compile failed";
      return { ok: false, error: `LI.FI compile ${result.status}: ${reason}` };
    }

    // Notional cap (defense in depth) from the compile's price impact. Fail CLOSED: a missing
    // USD value means we can't prove we're under the cap, so refuse rather than wave it through.
    const usd = result.priceImpact?.inputValueUsd;
    if (usd == null || !Number.isFinite(usd)) {
      return { ok: false, error: "LI.FI compile returned no USD value; refusing to bypass the cap" };
    }
    if (usd > LIFI_CAP_USD) {
      return { ok: false, error: `Flow notional $${usd.toFixed(2)} exceeds the $${LIFI_CAP_USD} cap` };
    }

    const signer = await getSigner(agent, DEFI_SIGNER);
    const account = signer.account;
    if (!account) return { ok: false, error: "Agent wallet has no account" };

    // Approvals first: approve the execution proxy for each input token (prebuilt approve tx).
    for (const a of result.approvals ?? []) {
      const allowance = (await defiClient.readContract({
        address: a.token as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [signerAddr, a.spender as Address],
      })) as bigint;
      if (allowance < BigInt(a.amount)) {
        const approveHash = await signer.sendTransaction({
          to: a.transactionRequest.to as Address,
          data: a.transactionRequest.data as `0x${string}`,
          value: BigInt(a.transactionRequest.value ?? "0"),
          account,
          chain: DEFI_CHAIN,
        });
        await defiClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    // The compiled flow tx — `to` is the execution proxy (or the ProxyFactory on first use).
    const tx = result.transactionRequest;
    const hash = await signer.sendTransaction({
      to: tx.to as Address,
      data: tx.data as `0x${string}`,
      value: BigInt(tx.value ?? "0"),
      account,
      chain: DEFI_CHAIN,
    });
    const receipt = await defiClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success"
      ? { ok: true, hash }
      : { ok: false, hash, error: "Flow transaction reverted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Execute a LI.FI cross-chain bridge via the REST /v1/quote primitive. Re-quotes fresh, enforces
 * the USD cap, approves the ERC-20 spender if needed, then signs+broadcasts the source-chain tx
 * (funds settle on the destination asynchronously). Returns the source tx hash once confirmed.
 */
async function lifiBridge(agent: string, details: LifiBridgeDetails): Promise<ExecuteResponse> {
  const amount = Number(details.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `Invalid amount: ${details.amount}` };
  }
  const srcChain = BRIDGE_VIEM_CHAINS[details.fromChainId];
  if (!srcChain) {
    return { ok: false, error: `Unsupported source chain ${details.fromChainId}` };
  }
  const srcRpc = srcChain.rpcUrls.default.http[0];

  try {
    const w = await getWallet(agent);
    if (!w) return { ok: false, error: `No wallet for "${agent}"` };
    const addr = w.address as Address;

    const quote = await bridgeQuote({
      fromChain: details.fromChainId,
      toChain: details.toChainId,
      fromToken: details.token,
      toToken: details.token,
      fromAmount: parseUnits(details.amount, 6).toString(), // demo token (USDC) is 6 decimals
      fromAddress: addr,
      toAddress: addr,
    });

    // Fail CLOSED: a missing USD value means we can't prove we're under the cap.
    const usd = quote.estimate?.fromAmountUSD != null ? Number(quote.estimate.fromAmountUSD) : NaN;
    if (!Number.isFinite(usd)) {
      return { ok: false, error: "Bridge quote returned no USD value; refusing to bypass the cap" };
    }
    if (usd > LIFI_CAP_USD) {
      return { ok: false, error: `Bridge notional $${usd} exceeds the $${LIFI_CAP_USD} cap` };
    }
    const tx = quote.transactionRequest;
    if (!tx) return { ok: false, error: "Quote returned no executable transaction (no route?)" };

    const srcPublic = createPublicClient({ chain: srcChain, transport: http(srcRpc) });
    const signer = await getSigner(agent, {
      chain: srcChain,
      chainId: details.fromChainId,
      rpcUrl: srcRpc,
    });
    const account = signer.account;
    if (!account) return { ok: false, error: "Agent wallet has no account" };

    // Approve the LI.FI spender if the source token needs it.
    const spender = quote.estimate?.approvalAddress;
    const fromTokenAddr = quote.action?.fromToken?.address;
    if (spender && fromTokenAddr) {
      const need = parseUnits(details.amount, quote.action?.fromToken?.decimals ?? 6);
      const allowance = (await srcPublic.readContract({
        address: fromTokenAddr,
        abi: erc20Abi,
        functionName: "allowance",
        args: [addr, spender],
      })) as bigint;
      if (allowance < need) {
        const approveHash = await signer.writeContract({
          address: fromTokenAddr,
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, need],
          account,
          chain: srcChain,
        });
        await srcPublic.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    const hash = await signer.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? "0"),
      account,
      chain: srcChain,
    });
    const receipt = await srcPublic.waitForTransactionReceipt({ hash });
    // Source confirmed = bridge initiated; destination settles asynchronously (poll /v1/status).
    return receipt.status === "success"
      ? { ok: true, hash }
      : { ok: false, hash, error: "Bridge source transaction reverted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Spawn a sub-agent. The headline (always works): a NEW server wallet, linked into the
 * parent's cluster, funded, with its own ERC-8004 identity (all on Ethereum L1). The nested ENS
 * subname is BEST EFFORT — it only mints if the parent dæmon actually owns its own ENS name on
 * L1 (i.e. the cluster is set up). Otherwise it's deferred, so spawning never hard-fails.
 * Mirrors provisionIdentity's decoupling.
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
  const signer = await getSigner(agent, DEFI_SIGNER);
  const account = signer.account;
  if (!account) return { ok: false, error: "Agent wallet has no account" };

  try {
    const hash = await signer.writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [details.to as Address, value],
      account,
      chain: DEFI_CHAIN,
    });
    const receipt = await defiClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success"
      ? { ok: true, hash }
      : { ok: false, hash, error: "Transaction reverted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
