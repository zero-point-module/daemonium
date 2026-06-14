/**
 * Dynamic Swap API client (REST). Stateless quote endpoint that returns a route + an
 * `signingPayload` we sign with the agent's server wallet. We only need /swap/quote for
 * same-chain swaps (the tx receipt confirms completion; /swap/status is for cross-chain).
 *
 * Verified working on Base Sepolia (84532) with our env + Bearer auth, despite the docs saying
 * "mainnet only". Quote shape confirmed empirically (signingPayload nests evmApproval +
 * evmTransaction).
 */
import "server-only";
import type { Address } from "viem";
import { SWAP_API_BASE, SWAP_CHAIN_NAME, SWAP_CHAIN_ID } from "./chain";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export interface SwapQuote {
  from: { amount: string; amountUSD?: string; token: { address: string; symbol: string; decimals: number } };
  to: { amount: string; amountUSD?: string; token: { address: string; symbol: string; decimals: number } };
  gasCostUSD?: string;
  /** ERC-20 spender to approve (present only when an approval is needed). */
  approvalAddress?: Address;
  signingPayload: {
    chainId: number;
    chainName: string;
    evmApproval?: { amount: string; spenderAddress: Address; tokenAddress: Address };
    evmTransaction?: { to: Address; data: `0x${string}`; value?: string };
  };
  steps?: Array<{ tool?: string }>;
}

/**
 * Get a same-chain swap quote on the swap chain (Base Sepolia). Exactly one of fromAmount /
 * toAmount; we use exact-in (fromAmount, smallest units). Sends Bearer auth defensively.
 */
export async function getSwapQuote(opts: {
  account: Address;
  fromToken: Address;
  toToken: Address;
  fromAmount: string; // smallest units
  slippage?: number;
}): Promise<SwapQuote> {
  const body = {
    from: {
      address: opts.account,
      chainName: SWAP_CHAIN_NAME,
      chainId: String(SWAP_CHAIN_ID),
      tokenAddress: opts.fromToken,
      amount: opts.fromAmount,
    },
    to: {
      address: opts.account,
      chainName: SWAP_CHAIN_NAME,
      chainId: String(SWAP_CHAIN_ID),
      tokenAddress: opts.toToken,
    },
    slippage: opts.slippage ?? 0.01,
  };
  const res = await fetch(`${SWAP_API_BASE}/sdk/${env("DYNAMIC_ENVIRONMENT_ID")}/swap/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env("DYNAMIC_API_TOKEN")}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`swap quote ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as SwapQuote;
}
