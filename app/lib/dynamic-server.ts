/**
 * Dynamic server-wallet integration — "the agent IS the wallet; Dynamic is the manager".
 *
 * Each agent (a user's dæmon, and every sub-agent it spawns) gets its OWN MPC server wallet via
 * createWalletAccount. We key every wallet by its ENS name, so the same string is the index key,
 * the signer key, and the identity. We persist NO key material and NOT even Dynamic's
 * `walletMetadata`: wallets are created with `backUpToDynamic: true`, and signable metadata is
 * reconstructed from Dynamic's `getEvmWallets()` at sign time (then shares are recovered from
 * Dynamic's backup via the password). Our store holds only a thin name→address index.
 */
import "server-only";
import { DynamicEvmWalletClient, createAccountAdapter } from "@dynamic-labs-wallet/node-evm";
import { ThresholdSignatureScheme, type WalletMetadata } from "@dynamic-labs-wallet/node";
import type { WalletClient, Chain, Account } from "viem";
import { IDENTITY_CHAIN, IDENTITY_CHAIN_ID, IDENTITY_RPC_URL } from "./chain";
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

/* ── Dynamic is the wallet store ──────────────────────────────────────────────────────────────
 * `getEvmWallets()` returns each wallet's identity + `externalServerKeySharesBackupInfo` (the
 * backup pointer) — i.e. everything needed to rebuild a signable `WalletMetadata`. We cache the
 * reconstruction per process (keyed by lowercase address), refreshing on a miss. createWallet
 * also seeds the cache so a freshly minted wallet signs immediately, before it propagates to the
 * list (eventual consistency). */
const metaCache = new Map<string, WalletMetadata>();

/** Seed the metadata cache (used right after creating a wallet, and for any pinned wallet). */
export function seedWalletMetadata(address: string, metadata: WalletMetadata): void {
  metaCache.set(address.toLowerCase(), metadata);
}

async function refreshWalletMetadata(): Promise<void> {
  const client = await getServerClient();
  const wallets = await client.getEvmWallets();
  for (const w of wallets) {
    metaCache.set(w.accountAddress.toLowerCase(), {
      walletId: w.walletId,
      accountAddress: w.accountAddress,
      chainName: w.chainName,
      thresholdSignatureScheme: w.thresholdSignatureScheme,
      derivationPath: w.derivationPath,
      externalServerKeySharesBackupInfo: w.externalServerKeySharesBackupInfo,
    } as WalletMetadata);
  }
}

/** Signable `walletMetadata` for an address, reconstructed from Dynamic (cached per process). */
export async function getWalletMetadataForAddress(address: string): Promise<WalletMetadata> {
  const key = address.toLowerCase();
  if (!metaCache.has(key)) await refreshWalletMetadata();
  const meta = metaCache.get(key);
  if (!meta) throw new Error(`No Dynamic wallet found for address ${address}`);
  return meta;
}

/**
 * Create a brand-new MPC wallet for an agent (keyed by its ENS name) and index it. Call once per
 * agent — this is what makes each (sub-)agent its own wallet. We store only the address (the
 * index); the signable metadata is seeded into the in-process cache and otherwise comes from
 * Dynamic.
 */
export async function createAgentWallet(
  ensName: string,
  opts: { parentEnsName?: string } = {},
): Promise<StoredWallet> {
  const client = await getServerClient();
  const password = requireEnv("DAEMON_WALLET_PASSWORD");

  // backUpToDynamic:true → Dynamic stores + can recover the key share; we keep no share locally.
  let result;
  try {
    result = await client.createWalletAccount({
      thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
      password,
      backUpToDynamic: true,
    });
  } catch (err) {
    // A 401 from /waas/create means DYNAMIC_API_TOKEN authenticated but the resulting session
    // isn't authorized to create server wallets (e.g. scope "userDataForm"). This is a token/
    // environment config issue, not a code one — surface it clearly instead of a raw Axios dump.
    const status = (err as { status?: number; response?: { status?: number } })?.status ??
      (err as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      throw new Error(
        "Dynamic rejected server-wallet creation (401). DYNAMIC_API_TOKEN is authenticating but " +
          "isn't authorized for WaaS — regenerate a Server Wallets API token in the Dynamic " +
          "dashboard (Developers → API tokens) for this environment, and make sure Server Wallets " +
          "are enabled and no required user-data form is gating it.",
      );
    }
    throw err;
  }

  const address = result.walletMetadata.accountAddress;
  seedWalletMetadata(address, result.walletMetadata); // sign immediately, pre-propagation

  const record: StoredWallet = {
    label: ensName, // index key = ENS name
    address,
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
 * A viem WalletClient backed by the agent's MPC wallet. We look up the agent's address in our
 * index, reconstruct its `walletMetadata` from Dynamic, and pass `walletMetadata` + `password`;
 * the SDK recovers the key share from Dynamic's backup (one round-trip per sign — no local share
 * storage). writeContract/sendTransaction on this client sign via MPC AND broadcast. Defaults to
 * the IDENTITY chain (Ethereum mainnet — ENS/ERC-8004); pass `opts` to target the DeFi chain
 * (Base mainnet for sends/swaps/LI.FI). `key` is the agent's ENS name.
 */
export async function getSigner(
  key: string,
  opts: { chain?: Chain; chainId?: number; rpcUrl?: string } = {},
): Promise<WalletClient> {
  const wallet = await getWallet(key);
  if (!wallet) throw new Error(`No wallet for agent "${key}"`);
  const walletMetadata = await getWalletMetadataForAddress(wallet.address);
  const client = await getServerClient();
  return client.getWalletClient({
    walletMetadata,
    password: requireEnv("DAEMON_WALLET_PASSWORD"),
    chain: opts.chain ?? IDENTITY_CHAIN,
    chainId: opts.chainId ?? IDENTITY_CHAIN_ID,
    rpcUrl: opts.rpcUrl ?? IDENTITY_RPC_URL,
  });
}

/**
 * A viem `Account` backed by the agent's MPC wallet, for wiring the agent in as a ZeroDev
 * **session-key signer** (`toECDSASigner`). Unlike `getSigner` (a chain-bound `WalletClient` that
 * signs+broadcasts ordinary txs), this is a chain-agnostic signer used INSIDE UserOp validation:
 * it signs the UserOp hash via MPC, and ZeroDev/the bundler handle broadcast. `key` is the agent's
 * ENS name. Shares are still recovered from Dynamic's backup via the password — no local key.
 */
export async function getAgentAccount(key: string): Promise<Account> {
  const wallet = await getWallet(key);
  if (!wallet) throw new Error(`No wallet for agent "${key}"`);
  const walletMetadata = await getWalletMetadataForAddress(wallet.address);
  const client = await getServerClient();
  return createAccountAdapter({
    evmClient: client,
    walletMetadata,
    password: requireEnv("DAEMON_WALLET_PASSWORD"),
  });
}
