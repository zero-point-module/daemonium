/**
 * Builds an ERC-8004 registration-v1 agent card from a stored wallet. Served as JSON by
 * /api/agent-card/[label] and pointed to by both the ERC-8004 tokenURI and the ENS text
 * record. The card advertises the agent's ENS name and wallet as services, and links back
 * to its NFT via registrations[] (the two-way identity link the spec calls for).
 */
import "server-only";
import { ERC8004_REGISTRATION_ID, agentCardUri } from "./chain";
import type { StoredWallet } from "./wallet-store";
import type { AgentCard } from "./types";
import { IDENTITY_CHAIN_ID } from "./chain";

export function buildAgentCard(w: StoredWallet): AgentCard {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: w.ensName ?? w.label,
    description:
      w.parent === undefined
        ? `Ignis — a living flame dæmon that controls its own wallet (${w.label}).`
        : `A ${w.label} sub-agent in the ${w.parent} cluster.`,
    image: `${agentCardUri(w.label).replace("/api/agent-card/", "/")}.png`,
    services: [
      { name: "ENS", endpoint: w.ensName ?? "", version: "v1" },
      { name: "agentWallet", endpoint: `eip155:${IDENTITY_CHAIN_ID}:${w.address}` },
    ].filter((s) => s.endpoint),
    x402Support: false,
    active: true,
    registrations: w.agentId
      ? [{ agentId: w.agentId, agentRegistry: ERC8004_REGISTRATION_ID }]
      : [],
    supportedTrust: ["reputation"],
    daemonium: {
      label: w.label,
      parent: w.parent,
      children: w.children,
    },
  };
}
