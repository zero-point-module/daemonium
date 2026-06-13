/**
 * Chain + contract constants for Daemonium, all on Ethereum Sepolia (chainId 11155111).
 *
 * Every address here was verified against a primary source during planning
 * (ENS docs + GitHub deployments + Etherscan; Circle docs; the erc-8004 repo).
 * Keep this file as the single source of truth — do not inline addresses elsewhere.
 */
import { sepolia } from "viem/chains";
import type { Address } from "viem";

export const CHAIN = sepolia;
export const CHAIN_ID = sepolia.id; // 11155111

/** Server-side RPC. Falls back to a public node if SEPOLIA_RPC_URL is unset. */
export const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

/** USDC on Sepolia (Circle testnet USDC, 6 decimals). Verified at circle.com docs. */
export const USDC: { address: Address; decimals: number } = {
  address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  decimals: 6,
};

/** ENS deployments on Sepolia — verified across 3 sources (ENS docs, GH, Etherscan). */
export const ENS = {
  registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as Address,
  nameWrapper: "0x0635513f179D50A207757E05759CbD106d7dFcE8" as Address,
  publicResolver: "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5" as Address,
};

/**
 * ERC-8004 "Trustless Agents" registries on Sepolia.
 * Deterministic CREATE2 addresses (identical on Base Sepolia and ~20 other testnets).
 * NOTE: pull the ABI from github.com/erc-8004/erc-8004-contracts (abis/IdentityRegistry.json),
 * not Etherscan — the source is not verified on Sepolia Etherscan.
 */
export const ERC8004 = {
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
  validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Address,
};

/** CAIP-2-style registry id used inside the ERC-8004 agent card's `registrations[]`. */
export const ERC8004_REGISTRATION_ID = `eip155:${CHAIN_ID}:${ERC8004.identityRegistry}`;

/** The wrapped parent name the user controls; agent subnames nest under it. */
export const ENS_PARENT_NAME = process.env.ENS_PARENT_NAME ?? "daemonium.eth";

/** Per-transaction USDC spending cap enforced in the executor (defense in depth). */
export const USDC_SEND_CAP = 100; // in whole USDC

/** Claude model (via Vercel AI Gateway) used by Ignis and its sub-agents. */
export const AGENT_MODEL = "anthropic/claude-sonnet-4.6";

/** Sepolia ETH a parent seeds a freshly spawned sub-agent with, so it can pay its own gas. */
export const SUBAGENT_GAS_SEED = "0.01"; // in ETH

/** ETH the minter seeds a user's Ignis at identity-claim time (covers ERC-8004 + text record). */
export const IGNIS_GAS_SEED = "0.02"; // in ETH
/** If an agent's ETH balance is below this, seed it. Avoids re-seeding on every claim. */
export const GAS_SEED_THRESHOLD = "0.005"; // in ETH

/** Public base URL of this app. Set APP_BASE_URL on deploy so agent-card URIs resolve. */
export const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";

/** Where an agent's ERC-8004 card JSON is served. Used as the agentURI + ENS text record. */
export const agentCardUri = (label: string) => `${APP_BASE_URL}/api/agent-card/${label}`;

/** ENS text-record key we use to point at the agent card (our convention, not ENS-standard). */
export const AGENT_CARD_TEXT_KEY = "agent-card";

export const explorerTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const explorerAddress = (addr: string) =>
  `https://sepolia.etherscan.io/address/${addr}`;
