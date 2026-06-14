/**
 * Chain + contract constants for Daemonium — a HYBRID two-chain mainnet topology.
 *
 *   • IDENTITY layer → Ethereum mainnet (chainId 1). The agent's wallet identity, its ENS
 *     subname cluster, and its ERC-8004 NFT live here. Ethereum L1 still runs ENS v1 with a
 *     LIVE NameWrapper, so `setSubnodeRecord` subname minting actually works (unlike Sepolia,
 *     which froze v1 in its v2 migration). This is what makes the on-chain cluster real.
 *   • DeFi / value layer → Base mainnet (chainId 8453). The same MPC address holds USDC + ETH
 *     and runs all value ops (send_usdc / send_eth / swap / LI.FI) where gas is cheap and both
 *     Dynamic Swap and LI.FI Composer are native.
 *
 * The Dynamic MPC address is identical on every EVM chain, so one wallet spans both layers;
 * `getSigner` takes a per-call chain override. Every address here was verified against a
 * primary source during planning. Keep this file the single source of truth.
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

/** Back-compat aliases: the agent's "home" chain (where its identity lives) = the identity chain. */
export const CHAIN = IDENTITY_CHAIN;
export const CHAIN_ID = IDENTITY_CHAIN_ID;

/** USDC on Base mainnet (Circle-native USDC, 6 decimals). The DeFi layer's USDC. */
export const USDC: { address: Address; decimals: number } = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
};

/** USDC on Ethereum mainnet (the identity chain) — for cross-chain balance reads + bridging. */
export const USDC_MAINNET: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/**
 * ENS v1 on Ethereum mainnet — LIVE. `NameWrapper.setSubnodeRecord` works here today (the v2
 * rewrite is announced for mainnet but not yet deployed, and won't freeze v1 on day one). This
 * is the real subname-cluster path. The parent `daemonium.eth` must be registered + wrapped on
 * L1 and the minter approved (NameWrapper.setApprovalForAll) — see docs/ens.md.
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

/* ───────────────────────── Dynamic Swap — Base mainnet ───────────────────────── */
export const SWAP_API_BASE = "https://app.dynamicauth.com/api/v0";
export const SWAP_CHAIN = DEFI_CHAIN;
export const SWAP_CHAIN_ID = DEFI_CHAIN_ID; // 8453
export const SWAP_CHAIN_NAME = "EVM"; // Dynamic's chainName for EVM (same on mainnet)
/** Tokens the agent can name in a swap on Base mainnet. */
export const SWAP_TOKENS: Record<string, { address: Address; decimals: number }> = {
  ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { address: USDC.address, decimals: USDC.decimals },
};
/** Notional USD cap per swap (defense in depth), read from the quote's amountUSD. */
export const SWAP_CAP_USD = 25;

/* ───────────────────────── LI.FI Composer — Base mainnet ───────────────────────── */
export const LIFI_CHAIN = DEFI_CHAIN;
export const LIFI_CHAIN_ID = DEFI_CHAIN_ID; // 8453
export const LIFI_RPC_URL = DEFI_RPC_URL;
/** Hackathon Composer endpoint (production + extra features). Default https://composer.li.quest. */
export const LIFI_COMPOSER_BASE_URL =
  process.env.LIFI_COMPOSER_BASE_URL ?? "https://ethglobal-composer.li.quest";
/** LI.FI public REST API (bridge quote + cross-chain status polling). */
export const LIFI_REST_BASE = "https://li.quest/v1";
/** Notional USD cap per LI.FI flow/bridge (read from the compile priceImpact / quote). */
export const LIFI_CAP_USD = 10;
/**
 * Zap targets for the swap-and-zap demo (Base mainnet). Default is Aave V3 Base's aUSDC receipt
 * token. Confirm valid vault tokens against LI.FI's zap-pack discovery / `/compose/manifest`
 * before a live run; the executor surfaces a compile error if a vault isn't routable.
 */
export const LIFI_VAULTS: Record<string, { address: Address; label: string }> = {
  AAVE_USDC: { address: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", label: "Aave aBasUSDC" },
};
export const LIFI_DEFAULT_VAULT = "AAVE_USDC";

/**
 * Claude model (via Vercel AI Gateway) used by Ignis and its sub-agents. Env-tunable so the
 * latency/quality trade-off can be flipped without a code change (e.g. claude-haiku-4.5 for a
 * faster time-to-first-token on the short spoken lines a voice-first app reads aloud).
 */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-4.6";

/* Gas seeds on the IDENTITY chain (L1) — real ETH, kept lean. Covers a dæmon's own ERC-8004
 * register + ENS text record; the minter pays subname mints. Tune for live gas. */
export const SUBAGENT_GAS_SEED = "0.002"; // ETH a parent seeds a freshly spawned sub-agent
export const IGNIS_GAS_SEED = "0.003"; // ETH the minter seeds a user's dæmon at claim time
export const GAS_SEED_THRESHOLD = "0.0015"; // seed only if balance is below this

/** Public base URL of this app. Set APP_BASE_URL on deploy so agent-card URIs resolve. */
export const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";

/** Where an agent's ERC-8004 card JSON is served. Used as the agentURI + ENS text record. */
export const agentCardUri = (label: string) => `${APP_BASE_URL}/api/agent-card/${label}`;

/** ENS text-record key we use to point at the agent card (our convention, not ENS-standard). */
export const AGENT_CARD_TEXT_KEY = "agent-card";

/* Explorers. Identity (ENS/ERC-8004/wallet) on Ethereum L1 → etherscan; value (sends/swaps/LI.FI)
 * on Base → basescan. */
export const explorerTx = (hash: string) => `https://etherscan.io/tx/${hash}`;
export const explorerAddress = (addr: string) => `https://etherscan.io/address/${addr}`;
export const defiExplorerTx = (hash: string) => `https://basescan.org/tx/${hash}`;
export const defiExplorerAddress = (addr: string) => `https://basescan.org/address/${addr}`;
