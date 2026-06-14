/**
 * Read-only provisioning diagnostic. Pinpoints why a dæmon isn't getting an ENS subname / funds.
 * No transactions are sent. Run with the env loaded:
 *   node --env-file=.env.local scripts/diag-provision.mjs
 */
import { createPublicClient, http, namehash, getAddress, formatEther, formatUnits, parseAbi } from "viem";
import { mainnet, base } from "viem/chains";
import { normalize } from "viem/ens";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
const L1_RPC = process.env.MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
const PARENT = process.env.ENS_PARENT_NAME ?? "daemonium.eth";
const NAMEWRAPPER = "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC8004 = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const l1 = createPublicClient({ chain: mainnet, transport: http(L1_RPC) });
const bs = createPublicClient({ chain: base, transport: http(BASE_RPC) });
const nwAbi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

console.log("=== ENV ===");
console.log("REDIS_URL:", REDIS_URL ? "set" : "NOT SET (app would use local file)");
console.log("MINTER_WALLET pin:", process.env.MINTER_WALLET ? "set" : "NOT SET");
console.log("ENS_ONCHAIN_MINTING:", process.env.ENS_ONCHAIN_MINTING ?? "(default: on)");
console.log("L1 RPC:", L1_RPC, "\nBase RPC:", BASE_RPC, "\nparent:", PARENT);

let index = {};
let handles = {};
if (REDIS_URL) {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  try {
    const w = await r.hgetall("daemon:wallets");
    handles = await r.hgetall("daemon:handles");
    for (const [k, v] of Object.entries(w)) index[k] = JSON.parse(v);
  } catch (e) {
    console.log("\n!!! Redis read failed:", e.message);
  } finally {
    await r.quit();
  }
}

console.log("\n=== KV INDEX ===");
console.log("handles (userId→handle):", handles);
console.log("wallet keys:", Object.keys(index));

async function report(label, addrRaw) {
  let addr;
  try { addr = getAddress(addrRaw); } catch { console.log(`  ${label}: bad address ${addrRaw}`); return; }
  const [el1, eb, usdc, has8004] = await Promise.all([
    l1.getBalance({ address: addr }).catch((e) => `ERR(${e.shortMessage ?? e.message})`),
    bs.getBalance({ address: addr }).catch((e) => `ERR(${e.shortMessage ?? e.message})`),
    bs.readContract({ address: USDC_BASE, abi: erc20, functionName: "balanceOf", args: [addr] }).catch(() => null),
    l1.readContract({ address: ERC8004, abi: erc20, functionName: "balanceOf", args: [addr] }).catch(() => null),
  ]);
  console.log(`  ${label}`);
  console.log(`    ${addr}`);
  console.log(`    L1 ETH:   ${typeof el1 === "bigint" ? formatEther(el1) : el1}`);
  console.log(`    Base ETH: ${typeof eb === "bigint" ? formatEther(eb) : eb}    Base USDC: ${usdc == null ? "?" : formatUnits(usdc, 6)}`);
  console.log(`    ERC-8004 NFTs (L1): ${has8004 == null ? "?" : has8004.toString()}`);
}

console.log("\n=== BALANCES (L1 = identity gas, Base = spendable) ===");
for (const [k, w] of Object.entries(index)) await report(k, w.address);

console.log("\n=== ENS PREREQS on L1 ===");
const node = BigInt(namehash(normalize(PARENT)));
const owner = await l1
  .readContract({ address: NAMEWRAPPER, abi: nwAbi, functionName: "ownerOf", args: [node] })
  .catch((e) => `ERR(${e.shortMessage ?? e.message})`);
const wrapped = typeof owner === "string" && owner.startsWith("0x") && owner !== "0x0000000000000000000000000000000000000000";
console.log(`${PARENT} wrapped in NameWrapper? ${wrapped}  (owner: ${owner})`);
if (wrapped && index.minter) {
  const approved = await l1
    .readContract({ address: NAMEWRAPPER, abi: nwAbi, functionName: "isApprovedForAll", args: [owner, getAddress(index.minter.address)] })
    .catch((e) => `ERR(${e.shortMessage ?? e.message})`);
  console.log(`minter (${index.minter.address}) approved by owner? ${approved}`);
} else if (!wrapped) {
  console.log("→ Not wrapped: subname minting CANNOT happen yet. Register + wrap daemonium.eth on L1.");
}
process.exit(0);
