/**
 * Shared read-only viem clients. Server-side only. Signing/broadcasting goes through the
 * Dynamic server wallet (see dynamic-server.ts); these clients are for balance reads, log
 * queries, and waiting on receipts.
 *
 * Two clients for the hybrid topology:
 *   • identityClient → Ethereum mainnet (ENS resolution, ERC-8004 reads, identity receipts).
 *   • defiClient     → Base mainnet (USDC/ETH balances, swap/send receipts, USDC logs).
 */
import "server-only";
import {
  createPublicClient,
  http,
  formatUnits,
  parseAbiItem,
  type Address,
} from "viem";
import {
  IDENTITY_CHAIN,
  IDENTITY_RPC_URL,
  DEFI_CHAIN,
  DEFI_RPC_URL,
  USDC,
} from "./chain";

/** Ethereum mainnet — identity layer (ENS, ERC-8004, wallet identity). */
export const identityClient = createPublicClient({
  chain: IDENTITY_CHAIN,
  transport: http(IDENTITY_RPC_URL),
});

/** Base mainnet — DeFi / value layer (USDC, swaps, sends). */
export const defiClient = createPublicClient({
  chain: DEFI_CHAIN,
  transport: http(DEFI_RPC_URL),
});

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface UsdcTransfer {
  from: string;
  amount: string;
  tx: string;
  block: string;
}

/**
 * Incoming USDC transfers to `address` on Base mainnet (where value lives). Defaults to scanning
 * the last ~9k blocks; pass `fromBlock` to poll only what's new. Returns the latest block so
 * callers can advance their cursor. Used by the get_activity tool and the proactive /watch route.
 */
export async function getIncomingUsdc(
  address: Address,
  fromBlock?: bigint,
): Promise<{ latestBlock: bigint; transfers: UsdcTransfer[] }> {
  const latestBlock = await defiClient.getBlockNumber();
  const span = BigInt(9000);
  const start = fromBlock ?? (latestBlock > span ? latestBlock - span : BigInt(0));
  let logs;
  try {
    logs = await defiClient.getLogs({
      address: USDC.address,
      event: TRANSFER_EVENT,
      args: { to: address },
      fromBlock: start,
      toBlock: "latest",
    });
  } catch {
    // Some free public RPCs (e.g. base-rpc.publicnode.com) refuse eth_getLogs as an "archive"
    // request needing a paid token. Funding detection is best-effort, so degrade to "no new
    // transfers" + advance the cursor rather than 500-ing the poll loop. Set BASE_RPC_URL to a
    // getLogs-capable provider (Alchemy free tier works) to actually see incoming transfers.
    return { latestBlock, transfers: [] };
  }
  return {
    latestBlock,
    transfers: logs.map((l) => ({
      from: l.args.from!,
      amount: formatUnits(l.args.value ?? BigInt(0), USDC.decimals),
      tx: l.transactionHash,
      block: (l.blockNumber ?? BigInt(0)).toString(),
    })),
  };
}
