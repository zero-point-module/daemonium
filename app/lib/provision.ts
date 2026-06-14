/**
 * Auto-provision a user's dæmon identity from their chosen handle. Idempotent and safe to
 * retry — each step checks on-chain/store state before acting. This is the "auto-claim on
 * login" path: no human confirmation (claiming a name isn't a value transfer), all gas paid
 * by the minter.
 *
 * Builds the 3-level cluster:
 *   daemonium.eth (owner) → <handle>.daemonium.eth (minter) → ignis.<handle>.daemonium.eth (dæmon)
 */
import "server-only";
import { type Address } from "viem";
import { agentCardUri, ENS_PARENT_NAME, ENS_ONCHAIN_MINTING } from "./chain";
import { ensureAgentWallet } from "./dynamic-server";
import { ensureMinter, seedGasIfLow, MINTER_KEY } from "./minter";
import { registerSubname, setAgentCardRecord, subnameExists, canManageParent } from "./ens";
import { registerIdentity, ownsIdentity } from "./erc8004";
import { getWallet, updateWallet } from "./wallet-store";
import { ensNameForHandle, userRootName } from "./handles";
import { withLock } from "./lock";

export interface ProvisionResult {
  ensName: string;
  address: string;
  agentId?: string;
  /** True once the dæmon has gas + an ERC-8004 identity (the parts that don't need ENS). */
  identityComplete: boolean;
  /** True if the ENS subname cluster was minted (needs a parent the minter controls). */
  ensRegistered: boolean;
}

export async function provisionIdentity(handle: string): Promise<ProvisionResult> {
  // Serialize per handle so concurrent calls (modal retry, two tabs) can't double-submit the
  // same mints while the first tx is still pending (the on-chain subnameExists check only
  // flips true after a receipt).
  return withLock(`provision:${handle}`, () => provisionInner(handle));
}

async function provisionInner(handle: string): Promise<ProvisionResult> {
  const ensName = ensNameForHandle(handle); // ignis.<handle>.daemonium.eth
  const userRoot = userRootName(handle); // <handle>.daemonium.eth
  const uri = agentCardUri(ensName);

  // 1. The dæmon's own wallet — keyed by its ENS name.
  const ignis = await ensureAgentWallet(ensName);
  const owner = ignis.address as Address;

  // 2. Fund the dæmon (gas) from the minter. Independent of ENS.
  await seedGasIfLow(owner);

  // 3. Register the dæmon's ERC-8004 identity. This does NOT depend on ENS — the registry is
  //    live and the dæmon just needs gas. Guarded by ownsIdentity() so a retry can't duplicate.
  let agentId = ignis.agentId;
  if (!agentId) {
    if (!(await ownsIdentity(owner))) {
      const r = await registerIdentity({ agentURI: uri, signerLabel: ensName });
      agentId = r.agentId;
    }
    if (agentId) await updateWallet(ensName, { agentId, agentCardUri: uri });
  }

  // 4. ENS subname cluster. On Sepolia this is OFF (ENS_ONCHAIN_MINTING=false): v1 NameWrapper is
  //    frozen and v2 subname-issuance contracts aren't published, so the ENS name is a label and
  //    the real on-chain identity is the ERC-8004 NFT above. The v1 minting path is kept behind
  //    the flag for a v1-live network. Best-effort + decoupled either way — never blocks the dæmon.
  let ensRegistered = false;
  if (ENS_ONCHAIN_MINTING) {
    try {
      ensRegistered = await subnameExists(ensName);
    } catch {
      ensRegistered = false;
    }
    if (!ensRegistered) {
      try {
        const minterAddr = (await ensureMinter()).address as Address;
        if (await canManageParent(ENS_PARENT_NAME, minterAddr)) {
          if (!(await subnameExists(userRoot))) {
            await registerSubname({ parentName: ENS_PARENT_NAME, label: handle, owner: minterAddr, signerLabel: MINTER_KEY });
          }
          if (!(await subnameExists(ensName))) {
            await registerSubname({ parentName: userRoot, label: "ignis", owner, signerLabel: MINTER_KEY });
          }
          await setAgentCardRecord({ name: ensName, uri, signerLabel: ensName });
          ensRegistered = true;
        }
      } catch {
        ensRegistered = false; // ENS deferred — the dæmon still works without it
      }
    }
  }

  const updated = (await getWallet(ensName))!;
  return {
    ensName,
    address: updated.address,
    agentId: updated.agentId,
    identityComplete: Boolean(updated.agentId),
    ensRegistered,
  };
}
