/**
 * ENS subname registration on Sepolia via the NameWrapper, plus text records on the
 * PublicResolver. This is how an agent gets its NAME and how the cluster nests:
 * Ignis claims `ignis.daemonium.eth` (parent owner = the human, who approves Ignis as an
 * operator), then Ignis itself mints `research.ignis.daemonium.eth` under its own node.
 *
 * Authorization (verified from NameWrapper.sol): the caller of setSubnodeRecord must be the
 * NameWrapper token owner of the parent node, OR an approved operator (setApprovalForAll).
 */
import "server-only";
import { parseAbi, namehash, type Address, type Hash } from "viem";
import { normalize } from "viem/ens";
import { ENS, AGENT_CARD_TEXT_KEY } from "./chain";
import { publicClient } from "./evm";
import { getSigner } from "./dynamic-server";

const nameWrapperAbi = parseAbi([
  "function setSubnodeRecord(bytes32 parentNode, string label, address owner, address resolver, uint64 ttl, uint32 fuses, uint64 expiry) returns (bytes32 node)",
  "function ownerOf(uint256 id) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

const resolverAbi = parseAbi([
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
  "function setAddr(bytes32 node, address a)",
]);

export function nodeOf(name: string): Hash {
  return namehash(normalize(name)) as Hash;
}

/**
 * True if a wrapped name already exists (NameWrapper.ownerOf returns a non-zero owner; it
 * returns address(0) for non-existent names rather than reverting). Used as an idempotency
 * gate, so RPC/transport errors are NOT swallowed — they propagate, aborting provisioning
 * rather than letting a flaky read masquerade as "doesn't exist" and trigger a re-mint.
 */
export async function subnameExists(name: string): Promise<boolean> {
  const owner = (await publicClient.readContract({
    address: ENS.nameWrapper,
    abi: nameWrapperAbi,
    functionName: "ownerOf",
    args: [BigInt(nodeOf(name))],
  })) as `0x${string}`;
  return owner !== "0x0000000000000000000000000000000000000000";
}

/**
 * Can `operator` modify (create subnames under) `parentName` in the NameWrapper?
 * True if it is the wrapped owner or an approved operator of the owner.
 */
export async function canManageParent(
  parentName: string,
  operator: Address,
): Promise<boolean> {
  const node = nodeOf(parentName);
  const owner = (await publicClient.readContract({
    address: ENS.nameWrapper,
    abi: nameWrapperAbi,
    functionName: "ownerOf",
    args: [BigInt(node)],
  })) as Address;
  if (owner.toLowerCase() === operator.toLowerCase()) return true;
  return publicClient.readContract({
    address: ENS.nameWrapper,
    abi: nameWrapperAbi,
    functionName: "isApprovedForAll",
    args: [owner, operator],
  });
}

/**
 * Create `${label}.${parentName}` owned by `owner`, signed by `signerLabel`'s wallet (which
 * must own/operate the parent). Sets the PublicResolver at creation. fuses=0, expiry=0 = the
 * simplest case (no fuses burned). Returns the new node + full name + tx hash.
 */
export async function registerSubname(opts: {
  parentName: string;
  label: string;
  owner: Address;
  signerLabel: string;
}): Promise<{ node: Hash; name: string; hash: Hash }> {
  const { parentName, label, owner, signerLabel } = opts;
  const parentNode = nodeOf(parentName);
  const signer = await getSigner(signerLabel);
  const account = signer.account!;

  const hash = await signer.writeContract({
    address: ENS.nameWrapper,
    abi: nameWrapperAbi,
    functionName: "setSubnodeRecord",
    args: [parentNode, label, owner, ENS.publicResolver, BigInt(0), 0, BigInt(0)],
    account,
    chain: signer.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const name = `${label}.${parentName}`;
  return { node: nodeOf(name), name, hash };
}

/** Point an ENS name's `agent-card` text record at the given URI. */
export async function setAgentCardRecord(opts: {
  name: string;
  uri: string;
  signerLabel: string;
}): Promise<Hash> {
  const node = nodeOf(opts.name);
  const signer = await getSigner(opts.signerLabel);
  const hash = await signer.writeContract({
    address: ENS.publicResolver,
    abi: resolverAbi,
    functionName: "setText",
    args: [node, AGENT_CARD_TEXT_KEY, opts.uri],
    account: signer.account!,
    chain: signer.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
