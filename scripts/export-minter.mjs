/**
 * Export a minter wallet record from a .daemon/wallets.json into the MINTER_WALLET env value,
 * so every environment can pin the SAME funded + approved minter (see app/lib/minter.ts).
 *
 *   npm run minter:export -- [path/to/.daemon/wallets.json]   # defaults to ./.daemon/wallets.json
 *
 * Run it against whichever store holds the minter you want to canonicalize. The printed value
 * contains the minter's MPC key shares — treat it like any other secret: paste it into .env
 * (local) and your deploy's env. Do NOT commit it or paste it into chat/logs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const storePath = process.argv[2] ?? path.join(process.cwd(), ".daemon", "wallets.json");

let store;
try {
  store = JSON.parse(readFileSync(storePath, "utf8"));
} catch (err) {
  console.error(`Could not read ${storePath}: ${err.message}`);
  process.exit(1);
}

const minter = store.minter;
if (!minter?.address) {
  console.error(`No "minter" entry in ${storePath}.`);
  process.exit(1);
}

const value = Buffer.from(JSON.stringify(minter)).toString("base64");
console.error(`# minter ${minter.address}  (from ${storePath})`);
console.error("# Secret — holds MPC key shares. Put in .env (local) + your deploy env:\n");
console.log(`MINTER_WALLET=${value}`);
