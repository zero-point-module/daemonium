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
import { ENS_PARENT_NAME, ENS_ONCHAIN_MINTING } from "./chain";
import { ensureAgentWallet } from "./dynamic-server";
import { ensureMinter, seedGasIfLow, MINTER_KEY } from "./minter";
import { registerSubname, subnameExists, canManageParent } from "./ens";
import { getWallet, updateWallet } from "./wallet-store";
import { ensNameForHandle } from "./handles";
import { withLock } from "./lock";

export interface ProvisionResult {
  ensName: string;
  address: string;
  /** The user's Kernel smart account — the on-chain owner of this dæmon's name and funds. */
  smartAccount: string;
  agentId?: string;
  /** True once the dæmon has gas + an ERC-8004 identity (the parts that don't need ENS). */
  identityComplete: boolean;
  /** True if the ENS subname cluster was minted (needs a parent the minter controls). */
  ensRegistered: boolean;
}

/** The user's smart-account ownership binding, derived + persisted by the handle route. */
export interface ProvisionOwner {
  ownerEoa: Address;
  smartAccount: Address;
}

export async function provisionIdentity(
  handle: string,
  owner: ProvisionOwner,
): Promise<ProvisionResult> {
  // Serialize per handle so concurrent calls (modal retry, two tabs) can't double-submit the
  // same mints while the first tx is still pending (the on-chain subnameExists check only
  // flips true after a receipt).
  return withLock(`provision:${handle}`, () => provisionInner(handle, owner));
}

async function provisionInner(handle: string, owner: ProvisionOwner): Promise<ProvisionResult> {
  const ensName = ensNameForHandle(handle); // <handle>.daemonium.eth — the dæmon itself
  const sa = owner.smartAccount; // the on-chain OWNER of the name + funds

  // 1. The dæmon's session-signer wallet (Dynamic MPC) — keyed by its ENS name. Under the
  //    smart-account model this address is the agent's SESSION KEY, not the on-chain owner.
  await ensureAgentWallet(ensName);
  // Bind the user's smart account to this dæmon so every later step (and /init) can resolve it.
  await updateWallet(ensName, { ownerSmartAccount: sa, ownerEoa: owner.ownerEoa });

  // 2. Fund gas (self-funded model): seed the SMART ACCOUNT on BOTH chains. The SA now pays for its
  //    own identity UserOp on L1 (register + agent-card record) AND its value UserOps on Base — the
  //    agent's MPC wallet needs no gas at all. Best-effort + decoupled: a minter snag must NOT fail
  //    provisioning, since the SA binding above is already persisted (the dæmon is usable and gas
  //    can be topped up later).
  try {
    await seedGasIfLow(sa, { chain: "identity" });
  } catch {
    /* L1 gas seed deferred — top up the smart account on Ethereum if needed */
  }
  try {
    await seedGasIfLow(sa, { chain: "defi" });
  } catch {
    /* Base gas seed deferred — top up the smart account on Base if needed */
  }

  // 3. ERC-8004 identity is now REGISTERED + HELD BY THE SMART ACCOUNT, via a co-signed L1 UserOp
  //    the client runs during onboarding (GET/POST /api/daemon/identity) — so the NFT belongs to
  //    the user's account, not the agent. Nothing to sign server-side here; agentId is recorded by
  //    the identity route once the UserOp lands.

  // 4. ENS subname cluster (Ethereum L1). The minter mints `<handle>.daemonium.eth` owned by the
  //    USER'S SMART ACCOUNT — so the user, not the agent, owns their name on-chain. The agent-card
  //    text record is now set by the SA via a UserOp (it owns the node), so we skip the old
  //    agent-signed setText here; the card is served off-chain meanwhile. Best-effort + decoupled:
  //    if `daemonium.eth` isn't wrapped/approved for the minter yet, we skip cleanly.
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
          await registerSubname({ parentName: ENS_PARENT_NAME, label: handle, owner: sa, signerLabel: MINTER_KEY });
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
    smartAccount: sa,
    agentId: updated.agentId,
    identityComplete: Boolean(updated.agentId),
    ensRegistered,
  };
}
