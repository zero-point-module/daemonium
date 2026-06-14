/**
 * An agent's tools (ai-sdk v6). Built per-request via a factory that closes over the live
 * event `emit`, the acting agent's key (= its ENS name), and the verified userId. Two kinds:
 *  - READ-ONLY tools execute immediately and return data.
 *  - STATE-CHANGING tools NEVER sign. They validate, mint a per-user pending execution, emit a
 *    `proposal` DaemonEvent, and return a note. Signing happens later in /api/daemon/execute
 *    only after the human taps Confirm.
 */
import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { erc20Abi, formatEther, formatUnits, isAddress, parseUnits, type Address } from "viem";
import { normalize } from "viem/ens";
import { identityClient, defiClient, getIncomingUsdc } from "./evm";
import { USDC, USDC_MAINNET, SWAP_TOKENS, LIFI_VAULTS, LIFI_DEFAULT_VAULT } from "./chain";
import { getSwapQuote } from "./swap";
import { composeSwapAndZap, bridgeQuote, BRIDGE_CHAINS, chainNameForId } from "./lifi";
import { getWallet } from "./wallet-store";
import { createExecution } from "./executions";
import { runSubagent } from "./subagent";
import type { DaemonEvent } from "./types";

export type Emit = (ev: DaemonEvent) => void;

export function buildTools({
  emit,
  selfKey,
  userId,
}: {
  emit: Emit;
  selfKey: string; // the acting agent's ENS name
  userId: string;
}) {
  // Resolve an optional sub-agent label to a full agent key within this user's cluster.
  const keyFor = (subagent?: string) => (subagent ? `${subagent}.${selfKey}` : selfKey);

  async function addressFor(key: string): Promise<Address> {
    const w = await getWallet(key);
    if (!w) throw new Error(`Agent "${key}" has no wallet yet`);
    return w.address as Address;
  }

  return {
    get_balance: tool({
      description:
        "Get your balances across BOTH chains — Ethereum mainnet (your identity chain, often where " +
        "your ETH starts) and Base (the DeFi chain, where swaps/zaps run). Defaults to you; pass a " +
        "sub-agent label for theirs.",
      inputSchema: z.object({
        subagent: z.string().optional().describe("Sub-agent label, e.g. 'research'"),
      }),
      execute: async ({ subagent }) => {
        const key = keyFor(subagent);
        const address = await addressFor(key);
        const usdcAbi = { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [address] } as const;
        const [l1Eth, l1Usdc, baseEth, baseUsdc] = await Promise.all([
          identityClient.getBalance({ address }),
          identityClient
            .readContract({ address: USDC_MAINNET, abi: erc20Abi, functionName: "balanceOf", args: [address] })
            .catch(() => 0n),
          defiClient.getBalance({ address }),
          defiClient.readContract(usdcAbi).catch(() => 0n),
        ]);
        return {
          agent: key,
          address,
          ethereum: { eth: formatEther(l1Eth), usdc: formatUnits(l1Usdc, 6) },
          base: { eth: formatEther(baseEth), usdc: formatUnits(baseUsdc, USDC.decimals) },
          note:
            "Swaps, zaps and sends run on Base. If your funds are on Ethereum and you need to act " +
            "on Base, bridge them over first with bridge_tokens.",
        };
      },
    }),

    resolve_ens: tool({
      description: "Resolve an ENS name (e.g. alice.eth) to an Ethereum address (Ethereum mainnet).",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        try {
          // Real ENS lives on Ethereum L1.
          const address = await identityClient.getEnsAddress({ name: normalize(name) });
          return address
            ? { name, address }
            : { name, address: null, note: "Name does not resolve" };
        } catch (err) {
          return { name, address: null, note: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    get_activity: tool({
      description: "List recent incoming USDC transfers to your wallet (best effort).",
      inputSchema: z.object({ subagent: z.string().optional() }),
      execute: async ({ subagent }) => {
        const key = keyFor(subagent);
        const address = await addressFor(key);
        try {
          const { transfers } = await getIncomingUsdc(address);
          return { agent: key, address, incoming: transfers.slice(-5) };
        } catch {
          return { agent: key, address, incoming: [], note: "Could not fetch logs" };
        }
      },
    }),

    get_identity: tool({
      description: "Get your onchain identity: ENS name, wallet address, and cluster relations.",
      inputSchema: z.object({ subagent: z.string().optional() }),
      execute: async ({ subagent }) => {
        const key = keyFor(subagent);
        const w = await getWallet(key);
        if (!w) return { agent: key, exists: false };
        return {
          ensName: w.ensName,
          address: w.address,
          agentId: w.agentId ?? null,
          agentCardUri: w.agentCardUri ?? null,
          parent: w.parent ?? null,
          children: w.children,
        };
      },
    }),

    send_usdc: tool({
      description:
        "Propose sending USDC from your wallet to an address or ENS name. This does NOT send — " +
        "it asks the human to confirm. Always use this for payments.",
      inputSchema: z.object({
        to: z.string().describe("Recipient: a 0x address or an ENS name"),
        amount: z.string().describe('Whole USDC amount as a string, e.g. "1.5"'),
      }),
      execute: async ({ to, amount }) => {
        let resolved: string | null = isAddress(to) ? to : null;
        let toEns: string | undefined;
        if (!resolved) {
          try {
            resolved = await identityClient.getEnsAddress({ name: normalize(to) });
            if (resolved) toEns = to;
          } catch {
            resolved = null;
          }
        }
        if (!resolved) return { proposed: false, error: `Could not resolve recipient "${to}"` };

        const card = createExecution(
          {
            action: "send_usdc",
            agent: selfKey,
            summary: `Send ${amount} USDC to ${toEns ?? resolved}`,
            details: { action: "send_usdc", to: resolved, amount, toEns },
          },
          userId,
        );
        emit({ type: "proposal", card });
        return {
          proposed: true,
          executionId: card.executionId,
          note: `Proposed: ${card.summary}. Awaiting the human's confirmation.`,
        };
      },
    }),

    send_eth: tool({
      description:
        "Propose sending native ETH from your wallet to an address or ENS name (for gas, or " +
        "to fund another agent). This does NOT send — it asks the human to confirm.",
      inputSchema: z.object({
        to: z.string().describe("Recipient: a 0x address or an ENS name"),
        amount: z.string().describe('ETH amount as a string, e.g. "0.01"'),
      }),
      execute: async ({ to, amount }) => {
        let resolved: string | null = isAddress(to) ? to : null;
        let toEns: string | undefined;
        if (!resolved) {
          try {
            resolved = await identityClient.getEnsAddress({ name: normalize(to) });
            if (resolved) toEns = to;
          } catch {
            resolved = null;
          }
        }
        if (!resolved) return { proposed: false, error: `Could not resolve recipient "${to}"` };

        const card = createExecution(
          {
            action: "send_eth",
            agent: selfKey,
            summary: `Send ${amount} ETH to ${toEns ?? resolved}`,
            details: { action: "send_eth", to: resolved, amount, toEns },
          },
          userId,
        );
        emit({ type: "proposal", card });
        return {
          proposed: true,
          executionId: card.executionId,
          note: `Proposed: ${card.summary}. Awaiting the human's confirmation.`,
        };
      },
    }),

    swap: tool({
      description:
        "Propose swapping one token for another via Dynamic's Swap API (runs on Base mainnet). " +
        "Use for converting between tokens. Supported tokens: " +
        Object.keys(SWAP_TOKENS).join(", ") +
        ". Does NOT execute until the human confirms.",
      inputSchema: z.object({
        fromSymbol: z.string().describe("Token to swap FROM, e.g. WETH"),
        toSymbol: z.string().describe("Token to swap TO, e.g. ETH"),
        amount: z.string().describe('Amount of the from-token, e.g. "0.001"'),
      }),
      execute: async ({ fromSymbol, toSymbol, amount }) => {
        const fromS = fromSymbol.toUpperCase();
        const toS = toSymbol.toUpperCase();
        const from = SWAP_TOKENS[fromS];
        const to = SWAP_TOKENS[toS];
        if (!from || !to) {
          return { proposed: false, error: `Supported tokens: ${Object.keys(SWAP_TOKENS).join(", ")}` };
        }
        // Best-effort quote to enrich the confirm card; the executor re-quotes fresh.
        let estOut = "";
        try {
          const me = await getWallet(selfKey);
          if (me) {
            const q = await getSwapQuote({
              account: me.address as Address,
              fromToken: from.address,
              toToken: to.address,
              fromAmount: parseUnits(amount, from.decimals).toString(),
            });
            estOut = ` (~${formatUnits(BigInt(q.to.amount), q.to.token.decimals)} ${toS})`;
          }
        } catch {
          /* no route / quote unavailable — still propose; executor surfaces the error */
        }
        const card = createExecution(
          {
            action: "swap",
            agent: selfKey,
            summary: `Swap ${amount} ${fromS} → ${toS}${estOut} on Base`,
            details: { action: "swap", fromSymbol: fromS, toSymbol: toS, amount },
          },
          userId,
        );
        emit({ type: "proposal", card });
        return {
          proposed: true,
          executionId: card.executionId,
          note: `Proposed: ${card.summary}. Awaiting the human's confirmation.`,
        };
      },
    }),

    lifi_zap: tool({
      description:
        "Propose a LI.FI swap-and-zap on Base mainnet: swap a token into USDC (skipped if it's " +
        "already USDC) and deposit it into a yield vault in one atomic flow. Vaults: " +
        Object.keys(LIFI_VAULTS).join(", ") +
        ". Use when the human wants to put funds to work earning yield. Does NOT execute until " +
        "the human confirms.",
      inputSchema: z.object({
        fromSymbol: z
          .string()
          .describe(`Input token on Base to start from, e.g. ${Object.keys(SWAP_TOKENS).join(", ")}`),
        amount: z.string().describe('Human amount of the from-token, e.g. "3"'),
        vault: z
          .string()
          .optional()
          .describe(`Vault key (default ${LIFI_DEFAULT_VAULT}): ${Object.keys(LIFI_VAULTS).join(", ")}`),
      }),
      execute: async ({ fromSymbol, amount, vault }) => {
        const fromS = fromSymbol.toUpperCase();
        const from = SWAP_TOKENS[fromS];
        if (!from) {
          return { proposed: false, error: `Supported input tokens: ${Object.keys(SWAP_TOKENS).join(", ")}` };
        }
        const vaultKey = (vault ?? LIFI_DEFAULT_VAULT).toUpperCase();
        const v = LIFI_VAULTS[vaultKey];
        if (!v) {
          return { proposed: false, error: `Supported vaults: ${Object.keys(LIFI_VAULTS).join(", ")}` };
        }
        // Best-effort compile to enrich the card; the executor re-compiles fresh at execute time.
        let est = "";
        try {
          const me = await getWallet(selfKey);
          if (me) {
            const r = await composeSwapAndZap({
              signer: me.address as Address,
              fromToken: from.address,
              fromDecimals: from.decimals,
              amount,
              vaultToken: v.address,
            });
            if (r.status === "success" && r.priceImpact) {
              est = ` (~$${r.priceImpact.inputValueUsd.toFixed(2)})`;
            }
          }
        } catch {
          /* no route / compile error — still propose; executor surfaces the error */
        }
        const card = createExecution(
          {
            action: "lifi_zap",
            agent: selfKey,
            summary: `Swap ${amount} ${fromS} → deposit into ${v.label}${est} on Base`,
            details: { action: "lifi_zap", fromSymbol: fromS, amount, vault: vaultKey, vaultLabel: v.label },
          },
          userId,
        );
        emit({ type: "proposal", card });
        return {
          proposed: true,
          executionId: card.executionId,
          note: `Proposed: ${card.summary}. Awaiting the human's confirmation.`,
        };
      },
    }),

    bridge_tokens: tool({
      description:
        "Propose bridging USDC across chains via LI.FI (only USDC is supported). Chains: " +
        Object.keys(BRIDGE_CHAINS).join(", ") +
        ". Use to move funds between networks. Does NOT execute until the human confirms.",
      inputSchema: z.object({
        token: z.string().describe('Token to bridge — only "USDC" is supported'),
        amount: z.string().describe('Human amount, e.g. "5"'),
        fromChain: z.string().describe(`Source chain: ${Object.keys(BRIDGE_CHAINS).join(", ")}`),
        toChain: z.string().describe(`Destination chain: ${Object.keys(BRIDGE_CHAINS).join(", ")}`),
      }),
      execute: async ({ token, amount, fromChain, toChain }) => {
        const fromId = BRIDGE_CHAINS[fromChain.toLowerCase()];
        const toId = BRIDGE_CHAINS[toChain.toLowerCase()];
        if (!fromId || !toId) {
          return { proposed: false, error: `Supported chains: ${Object.keys(BRIDGE_CHAINS).join(", ")}` };
        }
        if (fromId === toId) {
          return { proposed: false, error: "Source and destination chains must differ (use swap instead)." };
        }
        const tokenS = token.toUpperCase();
        // Only USDC is wired (the enrich quote + executor assume 6 decimals). Reject anything else
        // so a non-6-decimal token can't be mis-sized 10^12× into a misleading card / wrong-size tx.
        if (tokenS !== "USDC") {
          return { proposed: false, error: "Only USDC bridging is supported right now." };
        }
        // Best-effort quote to enrich the card (USDC is 6 decimals; LI.FI resolves the symbol).
        let est = "";
        try {
          const me = await getWallet(selfKey);
          if (me) {
            const q = await bridgeQuote({
              fromChain: fromId,
              toChain: toId,
              fromToken: tokenS,
              toToken: tokenS,
              fromAmount: parseUnits(amount, 6).toString(),
              fromAddress: me.address as Address,
              toAddress: me.address as Address,
            });
            const out = q.estimate?.toAmount && q.action?.toToken?.decimals !== undefined
              ? formatUnits(BigInt(q.estimate.toAmount), q.action.toToken.decimals)
              : null;
            if (out) est = ` (~${out} ${tokenS}${q.tool ? ` via ${q.tool}` : ""})`;
          }
        } catch {
          /* no route — still propose; executor surfaces the error */
        }
        const card = createExecution(
          {
            action: "lifi_bridge",
            agent: selfKey,
            summary: `Bridge ${amount} ${tokenS} ${fromChain} → ${toChain}${est}`,
            details: {
              action: "lifi_bridge",
              token: tokenS,
              amount,
              fromChainId: fromId,
              toChainId: toId,
              fromChain: chainNameForId(fromId),
              toChain: chainNameForId(toId),
            },
          },
          userId,
        );
        emit({ type: "proposal", card });
        return {
          proposed: true,
          executionId: card.executionId,
          note: `Proposed: ${card.summary}. Awaiting the human's confirmation.`,
        };
      },
    }),

    spawn_subagent: tool({
      description:
        "Propose spawning a new sub-agent under you. It gets its OWN wallet, a nested ENS " +
        "subname in your cluster, and its own ERC-8004 card. Needs human confirmation.",
      inputSchema: z.object({
        label: z.string().describe("Short handle, e.g. 'research'"),
        purpose: z.string().describe("What this sub-agent is for"),
      }),
      execute: async ({ label, purpose }) => {
        const childKey = `${label}.${selfKey}`;
        const card = createExecution(
          {
            action: "spawn_subagent",
            agent: selfKey,
            summary: `Spawn sub-agent ${childKey} (own wallet + nested subname + card)`,
            details: { action: "spawn_subagent", label, childKey, parentKey: selfKey, purpose },
          },
          userId,
        );
        emit({ type: "proposal", card });
        return {
          proposed: true,
          executionId: card.executionId,
          note: `Proposed: ${card.summary}. Awaiting the human's confirmation.`,
        };
      },
    }),

    delegate_to_subagent: tool({
      description:
        "Delegate a research task to one of your existing sub-agents. It is read-only " +
        "(fetches + summarizes) and returns a summary you should relay. Runs immediately.",
      inputSchema: z.object({
        label: z.string().describe("An existing sub-agent label under you"),
        task: z.string().describe("The task to delegate"),
      }),
      execute: async ({ label, task }) => {
        const childKey = `${label}.${selfKey}`;
        const sub = await getWallet(childKey);
        if (!sub || sub.parent !== selfKey) {
          return { error: `No sub-agent "${label}" in your cluster` };
        }
        emit({ type: "state", state: "delegating" });
        const summary = await runSubagent({ label, task });
        emit({ type: "subagentResult", agent: label, summary });
        emit({ type: "state", state: "thinking" });
        return { agent: label, summary };
      },
    }),
  };
}
