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
import { USDC, USDC_MAINNET, SWAP_TOKENS, NATIVE_SEND_CHAINS } from "./chain";
import { getSwapQuote } from "./swap";
import { getWallet } from "./wallet-store";
import { createExecution } from "./executions";
import { runSubagent } from "./subagent";
import { startSpell, finishSpell } from "./spells";
import { remember } from "./memory";
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

  // The address the agent ACTS AS for value: the user's smart account, where funds live and where
  // the human funds it. The agent's own MPC address is just the session-key signer (used internally
  // to sign UserOps) — it is NOT surfaced as "your wallet", which is what confused the user when the
  // funding modal showed the smart account but the agent reported its signer address.
  async function addressFor(key: string): Promise<Address> {
    const w = await getWallet(key);
    if (!w) throw new Error(`Agent "${key}" has no wallet yet`);
    return (w.ownerSmartAccount ?? w.address) as Address;
  }

  return {
    get_balance: tool({
      description:
        "Get your balances across BOTH chains — Ethereum mainnet (your identity chain, often where " +
        "your ETH starts) and Base (the DeFi chain, where swaps run). Defaults to you; pass a " +
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
        // Unified, chain-spanning view: the same account holds funds on both chains, so report a
        // total and which chain each balance sits on, instead of treating each chain as a separate
        // wallet.
        const ethUsdc = Number(formatUnits(l1Usdc, 6));
        const baseUsdcNum = Number(formatUnits(baseUsdc, USDC.decimals));
        return {
          agent: key,
          address,
          ethereum: { eth: formatEther(l1Eth), usdc: formatUnits(l1Usdc, 6) },
          base: { eth: formatEther(baseEth), usdc: formatUnits(baseUsdc, USDC.decimals) },
          // One account across chains — totals + where the value currently sits.
          totalUsdc: (ethUsdc + baseUsdcNum).toString(),
          usdcByChain: { ethereum: ethUsdc.toString(), base: baseUsdcNum.toString() },
          note:
            "This is ONE account across both chains. Swaps/sends run on Base; identity on " +
            "Ethereum. Act on the chain where the funds already are; if they're on the other " +
            "chain, say so plainly.",
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
          // The account that owns your identity + holds your funds (the human's smart account).
          address: w.ownerSmartAccount ?? w.address,
          // Your session-key signer (the MPC wallet that signs on the account's behalf).
          signer: w.address,
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

        const card = await createExecution(
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
        "Propose sending native ETH from your wallet on a chosen chain (for gas, or to fund " +
        "another agent). Pick the chain where you actually hold the ETH — check get_balance first, " +
        "since you may have ETH on Ethereum and/or Base. Does NOT send — it asks the human to confirm.",
      inputSchema: z.object({
        to: z.string().describe("Recipient: a 0x address or an ENS name"),
        amount: z.string().describe('ETH amount as a string, e.g. "0.01"'),
        chain: z
          .enum(["ethereum", "base"])
          .describe("Which chain to send the ETH on — the one where you hold it"),
      }),
      execute: async ({ to, amount, chain }) => {
        const net = NATIVE_SEND_CHAINS[chain];
        if (!net) {
          return { proposed: false, error: `Supported chains: ${Object.keys(NATIVE_SEND_CHAINS).join(", ")}` };
        }
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

        const card = await createExecution(
          {
            action: "send_eth",
            agent: selfKey,
            summary: `Send ${amount} ETH to ${toEns ?? resolved} on ${net.label}`,
            details: { action: "send_eth", to: resolved, amount, toEns, chainId: net.chainId, chain: net.label },
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
              account: (me.ownerSmartAccount ?? me.address) as Address,
              fromToken: from.address,
              toToken: to.address,
              fromAmount: parseUnits(amount, from.decimals).toString(),
            });
            estOut = ` (~${formatUnits(BigInt(q.to.amount), q.to.token.decimals)} ${toS})`;
          }
        } catch {
          /* no route / quote unavailable — still propose; executor surfaces the error */
        }
        const card = await createExecution(
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
        const card = await createExecution(
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
        // Register a live spell so the Cluster screen shows this dæmon actually working.
        const spellId = startSpell(userId, { agent: label, title: task });
        try {
          const summary = await runSubagent({ label, task });
          finishSpell(spellId, { ok: true, summary });
          emit({ type: "subagentResult", agent: label, summary });
          emit({ type: "state", state: "thinking" });
          return { agent: label, summary };
        } catch (err) {
          finishSpell(spellId, { ok: false });
          emit({ type: "state", state: "thinking" });
          throw err;
        }
      },
    }),

    remember: tool({
      description:
        "Save something worth keeping about your human or your shared history — a preference, a " +
        "fact about them, something that happened between you — so you can recall it in later " +
        "sessions. Runs now; it's your own memory, so no confirmation is needed. Use it sparingly, " +
        "for things that genuinely matter, not every passing detail.",
      inputSchema: z.object({
        text: z.string().max(500).describe("The thing to remember, in one plain sentence."),
        kind: z.string().optional().describe('Loose category, e.g. "preference", "fact", "event".'),
      }),
      execute: async ({ text, kind }) => {
        await remember(userId, { kind: kind ?? "note", text });
        return { remembered: true, note: `Noted: ${text}` };
      },
    }),
  };
}
