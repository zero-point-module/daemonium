/**
 * ERC-4337 smart-account core (server side). Each USER owns one ZeroDev Kernel smart account whose
 * sudo owner is their Dynamic embedded wallet; the account has the SAME deterministic address on
 * every chain. Agents are scoped session keys on it — their Dynamic MPC wallet (via
 * `getAgentAccount` → a viem `Account`) is wrapped as a ZeroDev permission signer.
 *
 * This module holds the SERVER-side pieces:
 *   • deriveUserKernelAddress — the deterministic account address from the owner EOA alone.
 *   • getSessionSigner / getSessionSignerAddress — the agent's session-key signer.
 *   • submitWithSessionKey — submit a batch of calls as a UserOp signed by an agent's GRANTED
 *     session key (the "autonomy" path); on-chain policy enforces the user's limits.
 *
 * The default CO-SIGN path is driven client-side (smart-account-client.ts): the server only builds
 * the calls (see actions.ts buildActionCalls); the user's embedded wallet signs the UserOp. The
 * owner private key never reaches the server.
 */
import "server-only";
import { createPublicClient, http, type Address, type Chain, type Hex, type LocalAccount, type PublicClient } from "viem";
import { mainnet, base, arbitrum, optimism, polygon } from "viem/chains";
import { createKernelAccountClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { getKernelAddressFromECDSA } from "@zerodev/ecdsa-validator";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { deserializePermissionAccount } from "@zerodev/permissions";
import { IDENTITY_CHAIN_ID, DEFI_CHAIN_ID, KERNEL_ACCOUNT_INDEX } from "./chain";
import { defiClient, identityClient } from "./evm";
import { getAgentAccount } from "./dynamic-server";

/** EntryPoint + Kernel version this app standardizes on (kept here, not in chain.ts, so the heavy
 *  @zerodev/sdk never leaks into a client bundle that imports chain.ts data). */
export const ENTRY_POINT = getEntryPoint("0.7");
export const KERNEL_VERSION = KERNEL_V3_1;

/**
 * Multi-chain registry. The SA has the SAME address on every EVM chain, so we can run UserOps on
 * any chain we have a bundler + RPC for. Each chain is "active" only once its BUNDLER_RPC_<id> env
 * is set; mainnet (identity) + Base (value) are the defaults, with Arbitrum/Optimism/Polygon ready
 * to switch on by setting their env. Per-chain env: BUNDLER_RPC_<id>, RPC_URL_<id> (id = chainId).
 */
const VIEM_CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [polygon.id]: polygon,
};
const SERVER_BUNDLERS: Record<number, string | undefined> = {
  [mainnet.id]: process.env.BUNDLER_RPC_MAINNET,
  [base.id]: process.env.BUNDLER_RPC_BASE,
  [arbitrum.id]: process.env.BUNDLER_RPC_ARBITRUM,
  [optimism.id]: process.env.BUNDLER_RPC_OPTIMISM,
  [polygon.id]: process.env.BUNDLER_RPC_POLYGON,
};
const SERVER_RPCS: Record<number, string | undefined> = {
  [mainnet.id]: process.env.MAINNET_RPC_URL,
  [base.id]: process.env.BASE_RPC_URL,
  [arbitrum.id]: process.env.ARBITRUM_RPC_URL,
  [optimism.id]: process.env.OPTIMISM_RPC_URL,
  [polygon.id]: process.env.POLYGON_RPC_URL,
};

/** Chain ids the SA can transact on at all (we have a viem chain for them). */
export const SUPPORTED_CHAIN_IDS = Object.keys(VIEM_CHAINS).map(Number);
export const isChainSupported = (chainId: number) => chainId in VIEM_CHAINS;

const pcCache = new Map<number, PublicClient>();
function publicClientFor(chainId: number): PublicClient {
  // Reuse the prebuilt clients for the two core chains; build + cache others on demand.
  if (chainId === IDENTITY_CHAIN_ID) return identityClient as unknown as PublicClient;
  if (chainId === DEFI_CHAIN_ID) return defiClient as unknown as PublicClient;
  let pc = pcCache.get(chainId);
  if (!pc) {
    const chain = VIEM_CHAINS[chainId];
    if (!chain) throw new Error(`Unsupported chain ${chainId}`);
    pc = createPublicClient({ chain, transport: http(SERVER_RPCS[chainId]) });
    pcCache.set(chainId, pc);
  }
  return pc;
}

interface AAChainCfg {
  viemChain: Chain;
  chainId: number;
  bundlerRpc: string | undefined;
  publicClient: PublicClient;
}

function aaCfg(chainId: number): AAChainCfg {
  const viemChain = VIEM_CHAINS[chainId];
  if (!viemChain) throw new Error(`Unsupported chain ${chainId} for smart-account execution`);
  return {
    viemChain,
    chainId,
    bundlerRpc: SERVER_BUNDLERS[chainId],
    publicClient: publicClientFor(chainId),
  };
}

function requireBundler(cfg: AAChainCfg): string {
  if (!cfg.bundlerRpc) {
    throw new Error(`No bundler configured for chain ${cfg.chainId}. Set BUNDLER_RPC_<chain> for it.`);
  }
  return cfg.bundlerRpc;
}

/**
 * The deterministic Kernel smart-account address for a user, from their owner EOA alone (no signer
 * needed — computed server-side from the address the client sends at handle claim). Same address on
 * every chain, so we derive it once on the identity chain.
 */
export function deriveUserKernelAddress(ownerEoa: Address): Promise<Address> {
  return getKernelAddressFromECDSA({
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    eoaAddress: ownerEoa,
    index: KERNEL_ACCOUNT_INDEX,
    publicClient: publicClientFor(IDENTITY_CHAIN_ID),
  });
}

/** The agent's MPC wallet wrapped as a ZeroDev permission (session-key) signer. The adapter is
 *  declared as the broad viem `Account` union but is a real signing `LocalAccount` (MPC-backed). */
export async function getSessionSigner(agentKey: string) {
  const account = (await getAgentAccount(agentKey)) as LocalAccount;
  return toECDSASigner({ signer: account });
}

/** The agent session signer's address — what the client scopes a session grant to. */
export async function getSessionSignerAddress(agentKey: string): Promise<Address> {
  const account = await getAgentAccount(agentKey);
  return account.address;
}

/**
 * AUTONOMY path: submit `calls` as a single UserOp on the user's smart account, signed by the
 * agent's GRANTED session key. `approvalBlob` is the serialized permission account the user signed
 * (serializePermissionAccount, client-side); we rebuild it with the agent's MPC signer and submit.
 * On-chain policy (caps/targets/expiry) is enforced by the account — an out-of-policy call reverts
 * at validation regardless of anything here. Returns the broadcast tx hash.
 */
export async function submitWithSessionKey(opts: {
  approvalBlob: string;
  agentKey: string;
  calls: { to: Address; data: Hex; value?: bigint }[];
  chainId: number;
}): Promise<Hex> {
  const cfg = aaCfg(opts.chainId);
  const bundlerRpc = requireBundler(cfg);
  const sessionSigner = await getSessionSigner(opts.agentKey);

  const account = await deserializePermissionAccount(
    cfg.publicClient,
    ENTRY_POINT,
    KERNEL_VERSION,
    opts.approvalBlob,
    sessionSigner,
  );

  const kernelClient = createKernelAccountClient({
    account,
    chain: cfg.viemChain,
    bundlerTransport: http(bundlerRpc),
    client: cfg.publicClient,
    // Standard EIP-1559 pricing — avoids ZeroDev's proprietary `zd_getUserOperationGasPrice` so
    // non-ZeroDev bundlers (Pimlico, Alchemy) work.
    userOperation: {
      estimateFeesPerGas: async () => {
        const { maxFeePerGas, maxPriorityFeePerGas } = await cfg.publicClient.estimateFeesPerGas();
        return { maxFeePerGas, maxPriorityFeePerGas };
      },
    },
  });

  const userOpHash = await kernelClient.sendUserOperation({
    calls: opts.calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
  });
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
  return receipt.receipt.transactionHash;
}
