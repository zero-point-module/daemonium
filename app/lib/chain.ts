/**
 * Chain + contract constants for Daemonium, all on Ethereum Sepolia (chainId 11155111).
 *
 * Every address here was verified against a primary source during planning
 * (ENS docs + GitHub deployments + Etherscan; Circle docs; the erc-8004 repo).
 * Keep this file as the single source of truth — do not inline addresses elsewhere.
 */
import { sepolia, baseSepolia } from "viem/chains";
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

/** ENS v1 deployments on Sepolia (NameWrapper et al). NOTE: Sepolia migrated to ENS v2 — the
 * v1 NameWrapper is frozen for new registrations, so on-chain subname minting via this path is
 * dead on Sepolia. Kept for reference / a v1-live network. See ENS_ONCHAIN_MINTING below. */
export const ENS = {
  registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as Address,
  nameWrapper: "0x0635513f179D50A207757E05759CbD106d7dFcE8" as Address,
  publicResolver: "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5" as Address,
};

/** ENS v2 .eth PermissionedRegistry on Sepolia — where `daemonium.eth` is actually REGISTERED. */
export const ENS_V2_ETH_REGISTRY = "0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67" as Address;

/**
 * Whether to attempt ON-CHAIN ENS subname minting during provisioning. FALSE on Sepolia:
 * v1 NameWrapper is frozen and v2 subname-issuance contracts (VerifiableFactory / UserRegistry
 * impl / writable resolver) are not published on Sepolia yet. So agent ENS names are a
 * human-readable LABEL layer; the real on-chain identity is the ERC-8004 NFT + the wallet.
 * Flip to true only on a network where v1 NameWrapper (or a complete v2 path) is live.
 */
export const ENS_ONCHAIN_MINTING = process.env.ENS_ONCHAIN_MINTING === "true";

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
/** Per-transaction native ETH spending cap (defense in depth). */
export const ETH_SEND_CAP = 1; // in ETH

/**
 * Dynamic Swap config. The Swap API is NOT mainnet-only as the docs claim — verified that
 * Base Sepolia (84532) IS supported (Ethereum Sepolia is genuinely not). So the agent's swaps
 * run on Base Sepolia via the real Dynamic Swap API; the same MPC server-wallet address signs
 * there. The only routable testnet pair via the aggregator is WETH<->ETH (USDC pairs 404 on
 * testnet) — richer pairs work on any supported chain.
 */
export const SWAP_API_BASE = "https://app.dynamicauth.com/api/v0";
export const SWAP_CHAIN = baseSepolia;
export const SWAP_CHAIN_ID = baseSepolia.id; // 84532
export const SWAP_CHAIN_NAME = "EVM"; // Dynamic's chainName for EVM
export const BASE_SEPOLIA_RPC_URL =
  process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
/** Tokens the agent can name in a swap on the swap chain (Base Sepolia). */
export const SWAP_TOKENS: Record<string, { address: Address; decimals: number }> = {
  ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
};
/** Notional USD cap per swap (defense in depth), read from the quote's amountUSD. */
export const SWAP_CAP_USD = 50;

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
