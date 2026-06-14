/**
 * Dynamic server-wallet integration — "the agent IS the wallet; Dynamic is the manager".
 *
 * Each agent (a user's Ignis, and every sub-agent it spawns) gets its OWN MPC server wallet
 * via createWalletAccount. We key every wallet by its ENS name (e.g.
 * "ignis-a1b2.daemonium.eth"), so the same string is the store key, the signer key, and the
 * identity. The backend holds the key shares and signs autonomously; the human confirmation
 * gate lives one layer up in /api/daemon/execute.
 */
import "server-only";
import { DynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";
import { ThresholdSignatureScheme } from "@dynamic-labs-wallet/node";
import type { WalletClient, Chain } from "viem";
import { CHAIN, CHAIN_ID, SEPOLIA_RPC_URL } from "./chain";
import { getWallet, putWallet, type StoredWallet } from "./wallet-store";
import { withLock } from "./lock";

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

/**
 * Create a brand-new MPC wallet for an agent (keyed by its ENS name) and persist it.
 * Call once per agent — this is what makes each (sub-)agent its own wallet.
 */
export async function createAgentWallet(
  ensName: string,
  opts: { parentEnsName?: string } = {},
): Promise<StoredWallet> {
  const client = await getServerClient();
  const password = requireEnv("DAEMON_WALLET_PASSWORD");

  const result = await client.createWalletAccount({
    thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
    password,
    backUpToDynamic: true,
  });

  const record: StoredWallet = {
    label: ensName, // store key = ENS name
    address: result.walletMetadata.accountAddress,
    walletMetadata: result.walletMetadata,
    externalServerKeyShares: result.externalServerKeyShares,
    createdAt: new Date().toISOString(),
    ensName,
    parent: opts.parentEnsName,
    children: [],
  };
  await putWallet(record);
  return record;
}

/**
 * Get an agent's wallet by ENS-name key, creating it if it doesn't exist yet. Idempotent and
 * serialized per key, so two concurrent calls (double-clicked modal, two tabs) can't both mint
 * a wallet for the same agent.
 */
export function ensureAgentWallet(
  ensName: string,
  opts: { parentEnsName?: string } = {},
): Promise<StoredWallet> {
  return withLock(`wallet:${ensName}`, async () => {
    return (await getWallet(ensName)) ?? (await createAgentWallet(ensName, opts));
  });
}

/**
 * A viem WalletClient backed by the agent's MPC key shares. Every call reloads the shares
 * from the store (the SDK is stateless). writeContract/sendTransaction on this client sign
 * via MPC AND broadcast. Defaults to Ethereum Sepolia; pass `opts` to target another chain
 * (e.g. Base Sepolia for swaps — the same MPC address works on any EVM chain). `key` is the
 * agent's ENS name.
 */
export async function getSigner(
  key: string,
  opts: { chain?: Chain; chainId?: number; rpcUrl?: string } = {},
): Promise<WalletClient> {
  const wallet = await getWallet(key);
  if (!wallet) throw new Error(`No wallet for agent "${key}"`);
  const client = await getServerClient();
  return client.getWalletClient({
    walletMetadata: wallet.walletMetadata,
    externalServerKeyShares: wallet.externalServerKeyShares,
    password: requireEnv("DAEMON_WALLET_PASSWORD"),
    chain: opts.chain ?? CHAIN,
    chainId: opts.chainId ?? CHAIN_ID,
    rpcUrl: opts.rpcUrl ?? SEPOLIA_RPC_URL,
  });
}
