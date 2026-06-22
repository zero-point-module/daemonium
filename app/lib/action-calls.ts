/**
 * Build the encoded calls for a VALUE action, to run as a UserOp on the USER'S smart account. This
 * is the single source of the on-chain calls for BOTH paths: the default co-sign (calls returned to
 * the client, the user's embedded wallet signs) and autonomy (the server signs with the agent's
 * granted session key). The funds + funder are the smart account — never the agent's MPC wallet.
 *
 * Caps (USDC_SEND_CAP / ETH_SEND_CAP / SWAP_CAP_USD) are re-enforced here as defense
 * in depth, on top of the on-chain session-key policy and the human confirm.
 */
import "server-only";
import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  USDC,
  USDC_SEND_CAP,
  ETH_SEND_CAP,
  DEFI_CHAIN_ID,
  SWAP_TOKENS,
  SWAP_CAP_USD,
} from "./chain";
import { getSwapQuote } from "./swap";
import type { ProposalCard } from "./types";
import { isChainSupported } from "./smart-account";

export interface ValueCalls {
  calls: { to: Address; data: Hex; value: bigint }[];
  chainId: number;
}

/** Throw unless we can run a UserOp on `chainId` (have a viem chain + can be given a bundler). */
function assertChainSupported(chainId: number): number {
  if (!isChainSupported(chainId)) {
    throw new Error(`Chain ${chainId} is not supported for smart-account execution`);
  }
  return chainId;
}

const approveData = (spender: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });

/**
 * Encode `card`'s value action as smart-account calls. `smartAccount` is the funder/owner — swap
 * quotes are fetched FOR the smart account, and any ERC-20 approval is batched ahead of the
 * action in the same UserOp (atomic approve+act). Throws for non-value actions.
 */
export async function buildValueCalls(
  card: ProposalCard,
  smartAccount: Address,
): Promise<ValueCalls> {
  const d = card.details;
  switch (d.action) {
    case "send_usdc": {
      if (!isAddress(d.to)) throw new Error(`Invalid recipient address: ${d.to}`);
      const amount = Number(d.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid amount: ${d.amount}`);
      if (amount > USDC_SEND_CAP) throw new Error(`Amount ${amount} exceeds the ${USDC_SEND_CAP} USDC cap`);
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [d.to as Address, parseUnits(d.amount, USDC.decimals)],
      });
      return { calls: [{ to: USDC.address, data, value: 0n }], chainId: DEFI_CHAIN_ID };
    }

    case "send_eth": {
      if (!isAddress(d.to)) throw new Error(`Invalid recipient address: ${d.to}`);
      const amount = Number(d.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid amount: ${d.amount}`);
      if (amount > ETH_SEND_CAP) throw new Error(`Amount ${amount} exceeds the ${ETH_SEND_CAP} ETH cap`);
      return {
        calls: [{ to: d.to as Address, data: "0x", value: parseEther(d.amount) }],
        chainId: assertChainSupported(d.chainId),
      };
    }

    case "swap": {
      const from = SWAP_TOKENS[d.fromSymbol.toUpperCase()];
      const to = SWAP_TOKENS[d.toSymbol.toUpperCase()];
      if (!from || !to) throw new Error(`Unknown token (supported: ${Object.keys(SWAP_TOKENS).join(", ")})`);
      const fromAmount = parseUnits(d.amount, from.decimals).toString();
      const quote = await getSwapQuote({
        account: smartAccount,
        fromToken: from.address,
        toToken: to.address,
        fromAmount,
      });
      const usd = quote.from.amountUSD != null ? Number(quote.from.amountUSD) : NaN;
      if (!Number.isFinite(usd)) throw new Error("Swap quote returned no USD value; refusing to bypass the cap");
      if (usd > SWAP_CAP_USD) throw new Error(`Swap notional $${usd} exceeds the $${SWAP_CAP_USD} cap`);
      const evmTx = quote.signingPayload.evmTransaction;
      if (!evmTx) throw new Error("Quote returned no executable transaction");

      const calls: ValueCalls["calls"] = [];
      const approval = quote.signingPayload.evmApproval;
      if (approval) {
        calls.push({
          to: approval.tokenAddress,
          data: approveData(approval.spenderAddress, BigInt(approval.amount)),
          value: 0n,
        });
      }
      calls.push({ to: evmTx.to, data: evmTx.data, value: BigInt(evmTx.value ?? "0") });
      return { calls, chainId: DEFI_CHAIN_ID };
    }

    case "spawn_subagent":
      throw new Error("spawn_subagent is not a value action");
  }
}
