/**
 * One-off: provision the backend "minter" wallet and print its address so the daemonium.eth
 * owner can approve + fund it once. Persists into the same .daemon/wallets.json the app reads
 * (key "minter"), so the running app reuses it. Idempotent.
 *
 * Run:  node --env-file=.env.local scripts/provision-minter.mjs
 */
import { DynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";
import { ThresholdSignatureScheme } from "@dynamic-labs-wallet/node";
import { promises as fs } from "node:fs";
import path from "node:path";

const STORE = path.join(process.cwd(), ".daemon", "wallets.json");
const KEY = "minter";

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

const store = await readStore();
if (store[KEY]) {
  console.log("minter already provisioned:", store[KEY].address);
  process.exit(0);
}

const client = new DynamicEvmWalletClient({
  environmentId: process.env.DYNAMIC_ENVIRONMENT_ID,
});
await client.authenticateApiToken(process.env.DYNAMIC_API_TOKEN);
const res = await client.createWalletAccount({
  thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
  password: process.env.DAEMON_WALLET_PASSWORD,
  backUpToDynamic: true,
});

store[KEY] = {
  label: KEY,
  address: res.walletMetadata.accountAddress,
  walletMetadata: res.walletMetadata,
  externalServerKeyShares: res.externalServerKeyShares,
  createdAt: new Date().toISOString(),
  ensName: KEY,
  children: [],
};
await fs.mkdir(path.dirname(STORE), { recursive: true });
await fs.writeFile(STORE, JSON.stringify(store, null, 2));
console.log("minter created:", store[KEY].address);
