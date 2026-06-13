/**
 * ERC-8004 "Trustless Agents" Identity Registry on Sepolia. Registering mints an ERC-721
 * whose tokenURI is the agent card (served by /api/agent-card/[label]). We use the
 * single-arg register(string agentURI) overload and read the agentId back from the
 * Registered event in the receipt.
 *
 * ABI fragments are hand-pinned from github.com/erc-8004/erc-8004-contracts (the Sepolia
 * source is not verified on Etherscan).
 */
import "server-only";
import { parseAbi, parseEventLogs, type Hash } from "viem";
import { ERC8004 } from "./chain";
import { publicClient } from "./evm";
import { getSigner } from "./dynamic-server";

const identityRegistryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

/** Register a new ERC-8004 identity for `signerLabel`, pointing at `agentURI`. */
export async function registerIdentity(opts: {
  agentURI: string;
  signerLabel: string;
}): Promise<{ agentId: string; hash: Hash }> {
  const signer = await getSigner(opts.signerLabel);
  const hash = await signer.writeContract({
    address: ERC8004.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [opts.agentURI],
    account: signer.account!,
    chain: signer.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  const events = parseEventLogs({
    abi: identityRegistryAbi,
    logs: receipt.logs,
    eventName: "Registered",
  });
  const agentId = events[0]?.args.agentId;
  if (agentId === undefined) {
    throw new Error("register() succeeded but no Registered event was found");
  }
  return { agentId: agentId.toString(), hash };
}
