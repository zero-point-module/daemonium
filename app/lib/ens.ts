/**
 * ENS subname registration on Ethereum L1 via the NameWrapper, plus text records on the
 * PublicResolver. L1 still runs v1 with a LIVE NameWrapper, so this mints for real. This is how
 * an agent gets its NAME and how the cluster nests: the minter mints `<handle>.daemonium.eth`
 * (owned by that user's dæmon), then the dæmon itself mints `research.<handle>.daemonium.eth`
 * under its own node.
 *
 * Authorization (verified from NameWrapper.sol): the caller of setSubnodeRecord must be the
 * NameWrapper token owner of the parent node, OR an approved operator (setApprovalForAll).
 */
import "server-only";
import { encodeFunctionData, parseAbi, namehash, type Address, type Hash, type Hex } from "viem";
import { normalize } from "viem/ens";
import { ENS, AGENT_CARD_TEXT_KEY } from "./chain";
import { identityClient } from "./evm";
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
  const owner = (await identityClient.readContract({
    address: ENS.nameWrapper,
    abi: nameWrapperAbi,
    functionName: "ownerOf",
    args: [BigInt(nodeOf(name))],
  })) as `0x${string}`;
  return owner !== "0x0000000000000000000000000000000000000000";
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Read whether `operator` can mint subnames under `parentName`. Returns the wrapped owner, whether
 * the parent is wrapped at all, and whether `operator` is the owner or an approved operator. The
 * two on-chain prerequisites for the cluster, made inspectable (used by GET /api/daemon/ens-status).
 */
export async function parentControl(
  parentName: string,
  operator: Address,
): Promise<{ owner: Address | null; wrapped: boolean; canManage: boolean }> {
  const node = nodeOf(parentName);
  const owner = (await identityClient.readContract({
    address: ENS.nameWrapper,
    abi: nameWrapperAbi,
    functionName: "ownerOf",
    args: [BigInt(node)],
  })) as Address;
  const wrapped = owner.toLowerCase() !== ZERO_ADDR;
  if (!wrapped) return { owner: null, wrapped: false, canManage: false };
  if (owner.toLowerCase() === operator.toLowerCase()) {
    return { owner, wrapped: true, canManage: true };
  }
  const approved = (await identityClient.readContract({
    address: ENS.nameWrapper,
    abi: nameWrapperAbi,
    functionName: "isApprovedForAll",
    args: [owner, operator],
  })) as boolean;
  return { owner, wrapped: true, canManage: approved };
}

/**
 * Can `operator` modify (create subnames under) `parentName` in the NameWrapper?
 * True if it is the wrapped owner or an approved operator of the owner.
 */
export async function canManageParent(
  parentName: string,
  operator: Address,
): Promise<boolean> {
  return (await parentControl(parentName, operator)).canManage;
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
  await identityClient.waitForTransactionReceipt({ hash });

  const name = `${label}.${parentName}`;
  return { node: nodeOf(name), name, hash };
}

/** Encode a `setText(node, "agent-card", uri)` call on the PublicResolver — to run as a UserOp
 *  from the user's smart account, which now owns the subname node (so it's the authorized caller). */
export function buildSetAgentCardCall(name: string, uri: string): { to: Address; data: Hex; value: bigint } {
  return {
    to: ENS.publicResolver,
    data: encodeFunctionData({
      abi: resolverAbi,
      functionName: "setText",
      args: [nodeOf(name), AGENT_CARD_TEXT_KEY, uri],
    }),
    value: 0n,
  };
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
  await identityClient.waitForTransactionReceipt({ hash });
  return hash;
}
