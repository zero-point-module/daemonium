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
import { erc20Abi, formatEther, formatUnits, isAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import { publicClient, getIncomingUsdc } from "./evm";
import { USDC } from "./chain";
import { getWallet } from "./wallet-store";
import { parentOf } from "./ens";
import { leftLabel } from "./identity";
import { MINTER_KEY } from "./minter";
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

    register_subname: tool({
      description:
        "Propose claiming your onchain identity: mint your ENS subname, register your " +
        "ERC-8004 card, and set the text record. Use this once to 'claim your name'. Does " +
        "NOT execute until the human confirms.",
      inputSchema: z.object({}),
      execute: async () => {
        const me = await getWallet(selfKey);
        if (!me?.ensName) return { proposed: false, error: "You have no wallet/name yet" };
        const card = createExecution(
          {
            action: "register_subname",
            agent: selfKey,
            summary: `Claim identity ${me.ensName} (ENS subname + ERC-8004 card)`,
            details: {
              action: "register_subname",
              name: me.ensName,
              ensLabel: leftLabel(me.ensName),
              parentName: parentOf(me.ensName),
              ownerKey: selfKey,
              // The minter (approved once on the parent) mints the root subname — no per-user
              // owner approval needed. Ignis still ends up OWNING the name.
              signerKey: MINTER_KEY,
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
