/**
 * ERC-8004 "Trustless Agents" Identity Registry on Ethereum mainnet (the identity layer).
 * Registering mints an ERC-721 whose tokenURI is the agent card (served by /api/agent-card/[label]).
 * We use the single-arg register(string agentURI) overload and read the agentId back from the
 * Registered event in the receipt. The mainnet registry shares the same implementation/ABI as the
 * testnet one — only the address differs (see chain.ts ERC8004).
 *
 * ABI fragments are hand-pinned from github.com/erc-8004/erc-8004-contracts.
 */
import "server-only";
import { parseAbi, parseEventLogs, type Address, type Hash } from "viem";
import { ERC8004 } from "./chain";
import { identityClient } from "./evm";
import { getSigner } from "./dynamic-server";

const ZERO = "0x0000000000000000000000000000000000000000";

const identityRegistryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  // ERC-721 base event — the identity NFT is minted to the caller; tokenId == agentId.
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

/** Does `owner` already hold an ERC-8004 identity NFT? Guards against duplicate mints on retry. */
export async function ownsIdentity(owner: Address): Promise<boolean> {
  const balance = (await identityClient.readContract({
    address: ERC8004.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  return balance > BigInt(0);
}

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
  const receipt = await identityClient.waitForTransactionReceipt({ hash });

  // Prefer the custom Registered event; fall back to the ERC-721 mint Transfer log so a
  // mismatched/renamed event can't make us throw (and then re-mint a duplicate on retry).
  const registered = parseEventLogs({
    abi: identityRegistryAbi,
    logs: receipt.logs,
    eventName: "Registered",
  });
  let agentId = registered[0]?.args.agentId;
  if (agentId === undefined) {
    const mints = parseEventLogs({
      abi: identityRegistryAbi,
      logs: receipt.logs,
      eventName: "Transfer",
    }).filter((l) => l.args.from === ZERO);
    agentId = mints[0]?.args.tokenId;
  }
  if (agentId === undefined) {
    throw new Error("register() mined but neither Registered nor a mint Transfer was found");
  }
  return { agentId: agentId.toString(), hash };
}
