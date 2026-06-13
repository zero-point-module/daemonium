/**
 * Shared read-only viem client for Sepolia. Server-side only.
 * Signing/broadcasting goes through the Dynamic server wallet (see dynamic-server.ts);
 * this client is for balance reads, log queries, and waiting on receipts.
 */
import "server-only";
import {
  createPublicClient,
  http,
  formatUnits,
  parseAbiItem,
  type Address,
} from "viem";
import { CHAIN, SEPOLIA_RPC_URL, USDC } from "./chain";

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(SEPOLIA_RPC_URL),
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
 * Incoming USDC transfers to `address`. Defaults to scanning the last ~9k blocks; pass
 * `fromBlock` to poll only what's new. Returns the latest block so callers can advance their
 * cursor. Used by the get_activity tool and the proactive /watch endpoint.
 */
export async function getIncomingUsdc(
  address: Address,
  fromBlock?: bigint,
): Promise<{ latestBlock: bigint; transfers: UsdcTransfer[] }> {
  const latestBlock = await publicClient.getBlockNumber();
  const span = BigInt(9000);
  const start = fromBlock ?? (latestBlock > span ? latestBlock - span : BigInt(0));
  const logs = await publicClient.getLogs({
    address: USDC.address,
    event: TRANSFER_EVENT,
    args: { to: address },
    fromBlock: start,
    toBlock: "latest",
  });
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
