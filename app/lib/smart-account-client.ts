"use client";
/**
 * Client-side ERC-4337 co-sign. The DEFAULT control mode: the user's Dynamic embedded wallet (a
 * viem WalletClient, bridged through wagmi) is the sudo owner of their Kernel smart account and
 * signs each action's UserOp itself. The server only supplies the encoded `calls` (from the stored
 * proposal); the owner key never leaves the browser. The first UserOp also counterfactually deploys
 * the account.
 *
 * Address determinism: same owner + index + entryPoint + kernel version as the server's
 * deriveUserKernelAddress, so the account this signs for is the same one the server provisioned.
 */
import {
  createPublicClient,
  http,
  parseEther,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { base, mainnet, arbitrum, optimism, polygon } from "viem/chains";
import { createKernelAccount, createKernelAccountClient, addressToEmptyAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toPermissionValidator, serializePermissionAccount } from "@zerodev/permissions";
import { toCallPolicy, toGasPolicy, toTimestampPolicy, CallPolicyVersion } from "@zerodev/permissions/policies";
import { KERNEL_ACCOUNT_INDEX } from "./chain";

const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;

/** A wallet client with a connected account — what wagmi's useWalletClient() returns once signed in. */
export type ConnectedWalletClient = WalletClient<Transport, Chain | undefined, Account>;

/** Client chain registry — co-sign works on any chain with a NEXT_PUBLIC bundler set. NEXT_PUBLIC_*
 *  must be referenced statically so Next can inline them, so each chain is listed explicitly. Set a
 *  chain's bundler (+ optional RPC) env to switch it on. */
const CLIENT_CHAINS: Record<number, { chain: Chain; rpcUrl?: string; bundlerRpc?: string }> = {
  [base.id]: { chain: base, rpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL, bundlerRpc: process.env.NEXT_PUBLIC_BUNDLER_RPC_BASE },
  [mainnet.id]: { chain: mainnet, rpcUrl: process.env.NEXT_PUBLIC_MAINNET_RPC_URL, bundlerRpc: process.env.NEXT_PUBLIC_BUNDLER_RPC_MAINNET },
  [arbitrum.id]: { chain: arbitrum, rpcUrl: process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL, bundlerRpc: process.env.NEXT_PUBLIC_BUNDLER_RPC_ARBITRUM },
  [optimism.id]: { chain: optimism, rpcUrl: process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL, bundlerRpc: process.env.NEXT_PUBLIC_BUNDLER_RPC_OPTIMISM },
  [polygon.id]: { chain: polygon, rpcUrl: process.env.NEXT_PUBLIC_POLYGON_RPC_URL, bundlerRpc: process.env.NEXT_PUBLIC_BUNDLER_RPC_POLYGON },
};

function clientCfg(chainId: number) {
  const cfg = CLIENT_CHAINS[chainId];
  if (!cfg) throw new Error(`Unsupported chain ${chainId} for co-sign`);
  return cfg;
}

/** Build the user's sudo Kernel client for a chain, from their embedded-wallet signer. */
async function sudoKernelClient(walletClient: ConnectedWalletClient, chainId: number) {
  const { chain, rpcUrl, bundlerRpc } = clientCfg(chainId);
  if (!bundlerRpc) {
    throw new Error(`No client bundler configured for chain ${chainId}. Set its NEXT_PUBLIC_BUNDLER_RPC_* env.`);
  }
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const sudo = await signerToEcdsaValidator(publicClient, {
    signer: walletClient,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    plugins: { sudo },
    index: KERNEL_ACCOUNT_INDEX,
  });
  return createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(bundlerRpc),
    client: publicClient,
    // Default uses ZeroDev's proprietary `zd_getUserOperationGasPrice`, which non-ZeroDev bundlers
    // (Pimlico, Alchemy) don't implement. Use standard EIP-1559 chain pricing so any bundler works.
    userOperation: {
      estimateFeesPerGas: async () => {
        const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
        return { maxFeePerGas, maxPriorityFeePerGas };
      },
    },
  });
}

/** The deterministic smart-account address for the connected owner (matches the server's). */
export async function smartAccountAddress(
  walletClient: ConnectedWalletClient,
  chainId: number,
): Promise<Address> {
  const kernelClient = await sudoKernelClient(walletClient, chainId);
  return kernelClient.account.address;
}

/**
 * CO-SIGN: submit `calls` as one UserOp the user's embedded wallet signs. Returns the broadcast tx
 * hash once the UserOp is mined. Throws if the wallet rejects or the bundler fails.
 */
export async function coSignAndSubmit(opts: {
  walletClient: ConnectedWalletClient;
  calls: { to: Address; data: Hex; value?: bigint }[];
  chainId: number;
}): Promise<Hex> {
  const kernelClient = await sudoKernelClient(opts.walletClient, opts.chainId);
  const userOpHash = await kernelClient.sendUserOperation({
    calls: opts.calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
  });
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
  return receipt.receipt.transactionHash;
}

export interface GrantPolicyInput {
  /** Contracts the agent's session key may call (the on-chain allowlist). */
  targets: Address[];
  /** Native-ETH spend cap per call, in wei (0 = no native value allowed). */
  maxNativeWei?: bigint;
  /** Gas allowance the session key may consume, in wei. */
  gasAllowanceWei?: bigint;
  /** Unix seconds the grant is valid until (on-chain expiry). */
  validUntil?: number;
}

/**
 * GRANT AUTONOMY: the user's embedded wallet signs a ZeroDev permission account that authorizes the
 * agent's session-key signer (`sessionSignerAddress`) under on-chain policy (target allowlist,
 * native cap, gas cap, expiry). Returns the serialized approval blob to hand to the server, which
 * rebuilds it with the agent's real MPC signer to act autonomously within these limits. The user's
 * key signs the enable approval here; the agent's key never touches the browser.
 */
export async function createSessionApproval(opts: {
  walletClient: ConnectedWalletClient;
  chainId: number;
  sessionSignerAddress: Address;
  policy: GrantPolicyInput;
}): Promise<string> {
  const { chain, rpcUrl } = clientCfg(opts.chainId);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const sudo = await signerToEcdsaValidator(publicClient, {
    signer: opts.walletClient,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
  // Address-only placeholder for the agent's session signer; the real MPC signer is supplied
  // server-side at execute time (deserializePermissionAccount).
  const emptySigner = await toECDSASigner({ signer: addressToEmptyAccount(opts.sessionSignerAddress) });

  const policies = [
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_5,
      permissions: opts.policy.targets.map((target) => ({
        target,
        valueLimit: opts.policy.maxNativeWei ?? 0n,
      })),
    }),
    toGasPolicy({ allowed: opts.policy.gasAllowanceWei ?? parseEther("0.02") }),
    ...(opts.policy.validUntil ? [toTimestampPolicy({ validUntil: opts.policy.validUntil })] : []),
  ];

  const permission = await toPermissionValidator(publicClient, {
    signer: emptySigner,
    policies,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    plugins: { sudo, regular: permission },
    index: KERNEL_ACCOUNT_INDEX,
  });
  return serializePermissionAccount(account);
}
