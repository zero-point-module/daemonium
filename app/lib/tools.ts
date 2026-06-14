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
import { publicClient, getIncomingUsdc } from "./evm";
import { USDC, SWAP_TOKENS } from "./chain";
import { getSwapQuote } from "./swap";
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
        "Get the ETH (gas) and USDC balance of your wallet, or a sub-agent's. Defaults to you.",
      inputSchema: z.object({
        subagent: z.string().optional().describe("Sub-agent label, e.g. 'research'"),
      }),
      execute: async ({ subagent }) => {
        const key = keyFor(subagent);
        const address = await addressFor(key);
        const [eth, usdc] = await Promise.all([
          publicClient.getBalance({ address }),
          publicClient.readContract({
            address: USDC.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }),
        ]);
        return {
          agent: key,
          address,
          eth: formatEther(eth),
          usdc: formatUnits(usdc, USDC.decimals),
        };
      },
    }),

    resolve_ens: tool({
      description: "Resolve an ENS name (e.g. alice.eth) to an Ethereum address on Sepolia.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        try {
          const address = await publicClient.getEnsAddress({ name: normalize(name) });
          return address
            ? { name, address }
            : { name, address: null, note: "Name does not resolve on Sepolia" };
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
            resolved = await publicClient.getEnsAddress({ name: normalize(to) });
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
            resolved = await publicClient.getEnsAddress({ name: normalize(to) });
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
        "Propose swapping one token for another via Dynamic's Swap API (runs on Base Sepolia). " +
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
            summary: `Swap ${amount} ${fromS} → ${toS}${estOut} on Base Sepolia`,
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
