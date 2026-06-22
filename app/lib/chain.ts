/**
 * Chain + contract constants for Daemonium — a HYBRID two-chain mainnet topology.
 *
 *   • IDENTITY layer → Ethereum mainnet (chainId 1). The agent's wallet identity, its ENS
 *     subname cluster, and its ERC-8004 NFT live here. Ethereum L1 still runs ENS v1 with a
 *     LIVE NameWrapper, so `setSubnodeRecord` subname minting actually works (unlike Sepolia,
 *     which froze v1 in its v2 migration). This is what makes the on-chain cluster real.
 *   • DeFi / value layer → Base mainnet (chainId 8453). The user's smart account holds USDC + ETH
 *     and runs all value ops (send_usdc / send_eth / swap) where gas is cheap and Dynamic Swap
 *     is native; the agent's MPC wallet is only a scoped session-key signer, never the fund owner.
 *
 * Both the smart account and the Dynamic MPC signer address are identical on every EVM chain, so
 * one identity spans both layers; `getSigner` takes a per-call chain override. Every address here
 * was verified against a primary source during planning. Keep this file the single source of truth.
 */
import { mainnet, base } from "viem/chains";
import type { Address } from "viem";

/* ───────────────────────── Identity layer: Ethereum mainnet ───────────────────────── */
export const IDENTITY_CHAIN = mainnet;
export const IDENTITY_CHAIN_ID = mainnet.id; // 1
/** Server-side L1 RPC. Set MAINNET_RPC_URL to a real provider for a live run. */
export const IDENTITY_RPC_URL =
  process.env.MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com";

/* ───────────────────────── DeFi / value layer: Base mainnet ───────────────────────── */
export const DEFI_CHAIN = base;
export const DEFI_CHAIN_ID = base.id; // 8453
/** Server-side Base RPC. Set BASE_RPC_URL to a real provider for a live run. */
export const DEFI_RPC_URL =
  process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";

/** USDC on Base mainnet (Circle-native USDC, 6 decimals). The DeFi layer's USDC. */
export const USDC: { address: Address; decimals: number } = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
};

/** USDC on Ethereum mainnet (the identity chain) — for cross-chain balance reads. */
export const USDC_MAINNET: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/**
 * ENS v1 on Ethereum mainnet — LIVE. `NameWrapper.setSubnodeRecord` works here today (the v2
 * rewrite is announced for mainnet but not yet deployed, and won't freeze v1 on day one). This
 * is the real subname-cluster path. The parent `daemonium.eth` must be registered + wrapped on
 * L1 and the minter approved (NameWrapper.setApprovalForAll).
 */
export const ENS = {
  registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as Address,
  nameWrapper: "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401" as Address,
  // Current ENS mainnet PublicResolver (used by app.ens.domains). Verify before a live run.
  publicResolver: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" as Address,
};

/**
 * On-chain ENS subname minting. ON by default now — Ethereum L1 v1 is live, so the cluster
 * mints for real. Set ENS_ONCHAIN_MINTING=false to fall back to a label-only layer. Minting is
 * still best-effort + decoupled in provision.ts: if the parent isn't wrapped/approved yet,
 * canManageParent returns false and the dæmon still gets its wallet + ERC-8004 identity.
 */
export const ENS_ONCHAIN_MINTING = process.env.ENS_ONCHAIN_MINTING !== "false";

/**
 * ERC-8004 "Trustless Agents" registries — MAINNET canonical addresses (identical on Ethereum,
 * Base, Arbitrum, Optimism via a deterministic deploy). NOTE: these differ from the TESTNET
 * vanity address 0x8004A818… (which exists on mainnet with 0 supply — a trap). The Identity
 * Registry is an upgradeable ERC-721; register()/ownerOf/tokenURI are unchanged from testnet.
 */
export const ERC8004 = {
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
};

/** CAIP-2-style registry id used inside the ERC-8004 agent card's `registrations[]` (L1). */
export const ERC8004_REGISTRATION_ID = `eip155:${IDENTITY_CHAIN_ID}:${ERC8004.identityRegistry}`;

/** The wrapped parent name the minter controls; agent subnames nest under it. */
export const ENS_PARENT_NAME = process.env.ENS_PARENT_NAME ?? "daemonium.eth";

/* Spending caps — REAL MONEY on mainnet now. Keep tiny (defense in depth, on top of confirm). */
export const USDC_SEND_CAP = 25; // whole USDC
export const ETH_SEND_CAP = 0.02; // ETH

/** Chains the agent can send native ETH on (send_eth). The dæmon may hold ETH on either. */
export const NATIVE_SEND_CHAINS: Record<string, { chainId: number; label: string }> = {
  ethereum: { chainId: IDENTITY_CHAIN_ID, label: "Ethereum" },
  base: { chainId: DEFI_CHAIN_ID, label: "Base" },
};

/* ───────────────────────── Dynamic Swap — Base mainnet ───────────────────────── */
export const SWAP_API_BASE = "https://app.dynamicauth.com/api/v0";
export const SWAP_CHAIN_NAME = "EVM"; // Dynamic's chainName for EVM (same on mainnet)
/** Tokens the agent can name in a swap on Base mainnet. */
export const SWAP_TOKENS: Record<string, { address: Address; decimals: number }> = {
  ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { address: USDC.address, decimals: USDC.decimals },
};
/** Notional USD cap per swap (defense in depth), read from the quote's amountUSD. */
export const SWAP_CAP_USD = 25;

/**
 * Claude model (via Vercel AI Gateway) used by Ignis and its sub-agents. Env-tunable so the
 * latency/quality trade-off can be flipped without a code change (e.g. claude-haiku-4.5 for a
 * faster time-to-first-token on the short spoken lines a voice-first app reads aloud).
 */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-4.6";

/* Gas seeds on the IDENTITY chain (L1) — real ETH, kept lean. Now the minter seeds the USER'S
 * SMART ACCOUNT (not the agent): self-funded UserOps pay their own gas, and the FIRST L1 UserOp
 * also counterfactually DEPLOYS the account, so the dæmon seed is higher than a plain register.
 * Tune for live gas. */
export const IGNIS_GAS_SEED = "0.0003"; // ETH seeded to a user's smart account (deploy + register + setText)
export const GAS_SEED_THRESHOLD = "0.0015"; // seed only if balance is below this
/** ETH seeded to the smart account on the DeFi chain (Base) so value UserOps can pay their gas. */
export const DEFI_GAS_SEED = "0.0008";
export const DEFI_GAS_SEED_THRESHOLD = "0.0004";

/* ───────────────────────── Account abstraction (ERC-4337 / ZeroDev Kernel) ─────────────────────
 * Each user owns ONE Kernel smart account (same deterministic address on every chain, derived from
 * their Dynamic embedded wallet as the sudo owner). Agents are scoped session keys on it. The
 * EntryPoint/Kernel-version SDK objects live in smart-account.ts (server-only) to keep the heavy
 * @zerodev/sdk out of any client bundle that imports this data-only module. */
/** Salt/index used when deriving the Kernel account address; 0 = the user's primary account. */
export const KERNEL_ACCOUNT_INDEX = 0n;

/** Public base URL of this app. Set APP_BASE_URL on deploy so agent-card URIs resolve. */
const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";

/** Where an agent's ERC-8004 card JSON is served. Used as the agentURI + ENS text record. */
export const agentCardUri = (label: string) => `${APP_BASE_URL}/api/agent-card/${label}`;

/** ENS text-record key we use to point at the agent card (our convention, not ENS-standard). */
export const AGENT_CARD_TEXT_KEY = "agent-card";

/* Explorers. Identity (ENS/ERC-8004/wallet) on Ethereum L1 → etherscan; value (sends/swaps)
 * on Base → basescan. */
export const explorerAddress = (addr: string) => `https://etherscan.io/address/${addr}`;
export const defiExplorerAddress = (addr: string) => `https://basescan.org/address/${addr}`;

/**
 * Chain-aware explorer lookup — so a tx links to the chain it ACTUALLY ran on: identity/spawn on
 * L1 → Etherscan, sends/swaps on Base → Basescan.
 */
const EXPLORERS: Record<number, { name: string; base: string }> = {
  1: { name: "Etherscan", base: "https://etherscan.io" },
  8453: { name: "Basescan", base: "https://basescan.org" },
  42161: { name: "Arbiscan", base: "https://arbiscan.io" },
  10: { name: "OP Explorer", base: "https://optimistic.etherscan.io" },
  137: { name: "Polygonscan", base: "https://polygonscan.com" },
};
const explorerFor = (chainId?: number) =>
  (chainId ? EXPLORERS[chainId] : undefined) ?? EXPLORERS[IDENTITY_CHAIN_ID];
/** Tx-link URL on the chain the tx ran on; defaults to L1 (Etherscan) when the chain is unknown. */
export const explorerTxUrl = (hash: string, chainId?: number) =>
  `${explorerFor(chainId).base}/tx/${hash}`;
/** Display name of that explorer ("Basescan", "Etherscan", …), for the link copy. */
export const explorerName = (chainId?: number) => explorerFor(chainId).name;
