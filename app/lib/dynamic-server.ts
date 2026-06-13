/**
 * Dynamic server-wallet integration — "the agent IS the wallet; Dynamic is the manager".
 *
 * Each agent (Ignis, and every sub-agent it spawns) gets its OWN MPC server wallet via
 * createWalletAccount. The backend holds the key shares (in wallet-store) and signs
 * autonomously; the human's confirmation gate lives one layer up in /api/daemon/execute.
 */
import "server-only";
import { DynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";
import { ThresholdSignatureScheme } from "@dynamic-labs-wallet/node";
import type { WalletClient } from "viem";
import { CHAIN, CHAIN_ID, SEPOLIA_RPC_URL, ENS_PARENT_NAME } from "./chain";
import {
  getWallet,
  putWallet,
  type StoredWallet,
} from "./wallet-store";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

let clientPromise: Promise<DynamicEvmWalletClient> | null = null;

/** Authenticated Dynamic client, memoized for the process lifetime. */
export function getServerClient(): Promise<DynamicEvmWalletClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new DynamicEvmWalletClient({
        environmentId: requireEnv("DYNAMIC_ENVIRONMENT_ID"),
      });
      await client.authenticateApiToken(requireEnv("DYNAMIC_API_TOKEN"));
      return client;
    })().catch((err) => {
      clientPromise = null; // allow retry on next call
      throw err;
    });
  }
  return clientPromise;
}

/** Build the ENS name for an agent from its label and (optional) parent's ENS name. */
function ensNameFor(label: string, parentEnsName?: string): string {
  return parentEnsName ? `${label}.${parentEnsName}` : `${label}.${ENS_PARENT_NAME}`;
}

/**
 * Create a brand-new MPC wallet for an agent and persist it. Returns the stored record.
 * Call once per agent — this is what makes each (sub-)agent its own wallet.
 */
export async function createAgentWallet(
  label: string,
  opts: { parentLabel?: string } = {},
): Promise<StoredWallet> {
  const client = await getServerClient();
  const password = requireEnv("DAEMON_WALLET_PASSWORD");

  const result = await client.createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    password,
    backUpToDynamic: true,
  });

  let parentEnsName: string | undefined;
  if (opts.parentLabel) {
    const parent = await getWallet(opts.parentLabel);
    parentEnsName = parent?.ensName;
  }

  const record: StoredWallet = {
    label,
    address: result.walletMetadata.accountAddress,
    walletMetadata: result.walletMetadata,
    externalServerKeyShares: result.externalServerKeyShares,
    createdAt: new Date().toISOString(),
    ensName: ensNameFor(label, parentEnsName),
    parent: opts.parentLabel,
    children: [],
  };
  await putWallet(record);
  return record;
}

/** Get an agent's wallet, creating it if it doesn't exist yet. Idempotent. */
export async function ensureAgentWallet(
  label: string,
  opts: { parentLabel?: string } = {},
): Promise<StoredWallet> {
  return (await getWallet(label)) ?? (await createAgentWallet(label, opts));
}

/**
 * A viem WalletClient backed by the agent's MPC key shares. Every call reloads the shares
 * from the store (the SDK is stateless). writeContract/sendTransaction on this client
 * sign via MPC AND broadcast on Sepolia.
 */
export async function getSigner(label: string): Promise<WalletClient> {
  const wallet = await getWallet(label);
  if (!wallet) throw new Error(`No wallet for agent "${label}"`);
  const client = await getServerClient();
  return client.getWalletClient({
    walletMetadata: wallet.walletMetadata,
    externalServerKeyShares: wallet.externalServerKeyShares,
    password: requireEnv("DAEMON_WALLET_PASSWORD"),
    chain: CHAIN,
    chainId: CHAIN_ID,
    rpcUrl: SEPOLIA_RPC_URL,
  });
}
