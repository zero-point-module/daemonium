/**
 * LI.FI integration — two flows, both on Base mainnet (the DeFi layer), both confirm-gated.
 *
 *  1. SWAP-AND-ZAP (Composer SDK): swap an input token → USDC (skipped if the input already IS
 *     USDC), then zap USDC into a yield vault (e.g. Aave aBasUSDC) — compiled to ONE atomic tx.
 *  2. BRIDGE (LI.FI REST /v1/quote): move a token across chains. This is the doc-guaranteed
 *     cross-chain primitive; single-Flow cross-chain isn't exposed in the @staging Composer build.
 *
 * Account model: Composer never pools funds. The agent's EOA is the signer + source of funds and
 * gets a deterministic per-signer execution proxy (`result.userProxy`). directDeposit pulls the
 * input token from the EOA via transferFrom after an approval to the proxy. The executor
 * (app/lib/actions.ts) submits approvals first, then the compiled transactionRequest.
 */
import "server-only";
import { createComposeSdk, guards, materialisers, resources } from "@lifi/composer-sdk";
import type { ComposeCompileResult } from "@lifi/compose-spec";
import { parseUnits, type Address } from "viem";
import {
  LIFI_COMPOSER_BASE_URL,
  LIFI_REST_BASE,
  LIFI_CHAIN_ID,
  USDC,
} from "./chain";

function lifiApiKey(): string | undefined {
  return process.env.LIFI_API_KEY;
}

let sdkInstance: ReturnType<typeof createComposeSdk> | null = null;
function sdk() {
  if (!sdkInstance) {
    sdkInstance = createComposeSdk({
      baseUrl: LIFI_COMPOSER_BASE_URL,
      apiKey: lifiApiKey(),
    });
  }
  return sdkInstance;
}

/** Common chains the bridge tool knows by name (for display + name→id resolution). */
export const BRIDGE_CHAINS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};
export function chainNameForId(id: number): string {
  const entry = Object.entries(BRIDGE_CHAINS).find(([, v]) => v === id);
  return entry ? entry[0] : String(id);
}

/**
 * Build + compile a swap-and-zap flow on Base mainnet. Swaps `fromToken` → USDC (skipped when the
 * input already IS USDC), then zaps the USDC into `vaultToken` via LI.FI. Returns the compiled
 * result: { status, transactionRequest, approvals[], userProxy, producedResources, priceImpact }.
 */
export async function composeSwapAndZap(opts: {
  signer: Address;
  fromToken: Address;
  fromDecimals: number;
  amount: string; // human units of the from-token
  vaultToken: Address;
}): Promise<ComposeCompileResult> {
  const chainId = LIFI_CHAIN_ID;
  // directDeposit wants an integer-string (template-typed); base units are always integers.
  const amountBaseUnits = parseUnits(opts.amount, opts.fromDecimals).toString() as `${bigint}`;
  const isUsdcIn = opts.fromToken.toLowerCase() === USDC.address.toLowerCase();

  const builder = sdk().flow(chainId, {
    name: "daemon-swap-and-zap",
    inputs: { amountIn: resources.erc20(opts.fromToken, chainId) },
  });

  // Thread the zap's input from either the raw USDC input or the swap output.
  const zapAmountIn = isUsdcIn
    ? builder.inputs.amountIn
    : builder.lifi.swap("swap", {
        bind: { amountIn: builder.inputs.amountIn },
        config: { resourceOut: resources.erc20(USDC.address, chainId), slippage: 0.03 },
      }).amountOut;

  builder.lifi.zap("zap", {
    bind: { amountIn: zapAmountIn },
    config: { resourceOut: resources.erc20(opts.vaultToken, chainId) },
    guards: [guards.slippage({ port: "amountOut", bps: 100 })],
  });

  return builder.compile({
    signer: opts.signer,
    inputs: { amountIn: materialisers.directDeposit({ amount: amountBaseUnits }) },
    sweepTo: builder.context.sender, // return any terminal balances to our EOA
    checkOnChainAllowances: true,
  });
}

/* ───────────────────────── Bridging (LI.FI REST /v1/quote) ───────────────────────── */

export interface BridgeQuote {
  tool?: string;
  estimate?: {
    toAmount?: string;
    toAmountMin?: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    approvalAddress?: Address;
    executionDuration?: number;
  };
  action?: {
    fromToken?: { symbol?: string; decimals?: number; address?: Address };
    toToken?: { symbol?: string; decimals?: number; address?: Address };
  };
  transactionRequest?: {
    to: Address;
    data: `0x${string}`;
    value?: string;
    chainId?: number;
    gasLimit?: string;
  };
}

function lifiHeaders(): Record<string, string> {
  const key = lifiApiKey();
  return key ? { "x-lifi-api-key": key } : {};
}

/**
 * Fetch a LI.FI route quote. `fromToken`/`toToken` accept a symbol (e.g. "USDC") or a 0x address —
 * LI.FI resolves symbols per chain. `fromAmount` is in smallest units. fromAddress = toAddress =
 * our server-wallet EOA. Works same-chain (a swap) or cross-chain (a bridge).
 */
export async function bridgeQuote(opts: {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  fromAmount: string; // smallest units
  fromAddress: Address;
  toAddress: Address;
  slippage?: number;
}): Promise<BridgeQuote> {
  const url = new URL(`${LIFI_REST_BASE}/quote`);
  url.searchParams.set("fromChain", String(opts.fromChain));
  url.searchParams.set("toChain", String(opts.toChain));
  url.searchParams.set("fromToken", opts.fromToken);
  url.searchParams.set("toToken", opts.toToken);
  url.searchParams.set("fromAmount", opts.fromAmount);
  url.searchParams.set("fromAddress", opts.fromAddress);
  url.searchParams.set("toAddress", opts.toAddress);
  url.searchParams.set("slippage", String(opts.slippage ?? 0.01));

  const res = await fetch(url, { headers: lifiHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LI.FI quote ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as BridgeQuote;
}

export interface BridgeStatus {
  status?: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
  substatus?: string;
  substatusMessage?: string;
  receiving?: { txHash?: string; chainId?: number };
}

/** Poll a cross-chain transfer's status by source tx hash. Cross-chain settles asynchronously. */
export async function bridgeStatus(opts: {
  txHash: string;
  fromChain?: number;
  toChain?: number;
}): Promise<BridgeStatus> {
  const url = new URL(`${LIFI_REST_BASE}/status`);
  url.searchParams.set("txHash", opts.txHash);
  if (opts.fromChain) url.searchParams.set("fromChain", String(opts.fromChain));
  if (opts.toChain) url.searchParams.set("toChain", String(opts.toChain));
  const res = await fetch(url, { headers: lifiHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LI.FI status ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as BridgeStatus;
}
