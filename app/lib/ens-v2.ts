/**
 * Read-only view of ENS v2 (the deployment Sepolia actually runs now). We don't mint subnames
 * here — v2 subname issuance needs child-registry contracts not yet published on Sepolia — but
 * `daemonium.eth` IS registered in the v2 .eth PermissionedRegistry, so we read + surface its
 * real on-chain state as the honest ENS integration.
 */
import "server-only";
import { parseAbi, keccak256, toHex, type Address } from "viem";
import { publicClient } from "./evm";
import { ENS_V2_ETH_REGISTRY } from "./chain";

const abi = parseAbi([
  "function getStatus(uint256 anyId) view returns (uint8)",
  "function findOwner(string label) view returns (address)",
]);

const STATUS = ["available", "reserved", "registered"] as const;

export interface EthNameV2 {
  name: string;
  status: "available" | "reserved" | "registered" | string;
  owner: Address | null;
}

/** Read a .eth 2LD's v2 state from the PermissionedRegistry. `label` is the bare label. */
export async function readEthNameV2(label: string): Promise<EthNameV2> {
  const anyId = BigInt(keccak256(toHex(label)));
  const [statusRaw, owner] = await Promise.all([
    publicClient.readContract({
      address: ENS_V2_ETH_REGISTRY,
      abi,
      functionName: "getStatus",
      args: [anyId],
    }),
    publicClient
      .readContract({ address: ENS_V2_ETH_REGISTRY, abi, functionName: "findOwner", args: [label] })
      .catch(() => null),
  ]);
  const zero = "0x0000000000000000000000000000000000000000";
  return {
    name: `${label}.eth`,
    status: STATUS[Number(statusRaw)] ?? String(statusRaw),
    owner: owner && owner !== zero ? (owner as Address) : null,
  };
}
