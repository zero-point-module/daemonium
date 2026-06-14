/**
 * Auto-provision a user's dæmon identity from their chosen handle. Idempotent and safe to
 * retry — each step checks on-chain/store state before acting. This is the "auto-claim on
 * login" path: no human confirmation (claiming a name isn't a value transfer), all gas paid
 * by the minter. Identity (wallet + ENS + ERC-8004) lives on Ethereum L1.
 *
 * Builds the cluster:
 *   daemonium.eth (minter) → <handle>.daemonium.eth (the dæmon) → <sub>.<handle>.daemonium.eth
 */
import "server-only";
import { type Address } from "viem";
import { agentCardUri, ENS_PARENT_NAME, ENS_ONCHAIN_MINTING } from "./chain";
import { ensureAgentWallet } from "./dynamic-server";
import { ensureMinter, seedGasIfLow, MINTER_KEY } from "./minter";
import { registerSubname, setAgentCardRecord, subnameExists, canManageParent } from "./ens";
import { registerIdentity, ownsIdentity } from "./erc8004";
import { getWallet, updateWallet } from "./wallet-store";
import { ensNameForHandle } from "./handles";
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
  const ensName = ensNameForHandle(handle); // <handle>.daemonium.eth — the dæmon itself
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

  // 4. ENS subname cluster (Ethereum L1). The minter mints ONE level — `<handle>.daemonium.eth`,
  //    owned directly by the dæmon — then the dæmon sets its own agent-card text record. ON by
  //    default (L1 v1 NameWrapper is live); still best-effort + decoupled: if `daemonium.eth`
  //    isn't wrapped/approved for the minter yet, canManageParent is false and we skip cleanly,
  //    leaving the dæmon with its wallet + ERC-8004 identity (the real on-chain identity).
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
          await registerSubname({ parentName: ENS_PARENT_NAME, label: handle, owner, signerLabel: MINTER_KEY });
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
