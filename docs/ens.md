# ENS — giving a dæmon a name, and a cluster an org chart

> _What we're doing, why, and the technical detail — grounded in the code we actually run._

> ## ✅ Status: the on-chain cluster is REAL on Ethereum L1
> Identity (the ENS cluster + ERC-8004 + the agent wallet) lives on **Ethereum mainnet**, where
> ENS still runs **v1 with a LIVE NameWrapper** (`0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401`).
> So `NameWrapper.setSubnodeRecord` subname minting **works today** — unlike Sepolia, which froze
> v1 when it migrated to ENS v2. (ENS v2 is announced for mainnet but not yet deployed, and the
> team has said the L1 resolver keeps reflecting non-migrated names during migration, so v1 won't
> hard-freeze on day one.) The DeFi side (swaps, LI.FI, USDC) lives on **Base mainnet** for cheap
> gas — see [`dynamic.md`](./dynamic.md) and [`lifi.md`](./lifi.md). The agent's MPC address is the
> same on both chains.
>
> On-chain minting is controlled by `ENS_ONCHAIN_MINTING` (`app/lib/chain.ts`, **default on**). It
> is still **best-effort + decoupled** in `provision.ts`/`actions.ts`: if `daemonium.eth` isn't
> wrapped/approved for the minter yet, `canManageParent` returns false and we skip cleanly — the
> dæmon still gets its **wallet + ERC-8004 identity** (both real). So a setup gap degrades the name
> to a label; it never blocks the dæmon. The prerequisites (register + wrap `daemonium.eth`, approve
> the minter) are spelled out at the end.

## The one-line idea

A wallet address (`0x0FD5…fDbc`) is unreadable and says nothing about _who_ an agent is. We give
each dæmon an **ENS name** as its identity backbone — `<handle>.daemonium.eth` — and when it spawns
a sub-agent, that sub-agent gets a **nested subname** — `research.<handle>.daemonium.eth`.

The key insight (and our headline for the ENS prize): **the subname subtree _is_ the cluster.** The
namespace doubles as the org chart and the trust boundary. "Under `alice.daemonium.eth`" = "part of
Alice's dæmon cluster" = "allowed to interact." A name isn't decoration; it's structure.

> **Per-user naming (handles).** Every user gets their own dæmon. At first login they pick a
> **handle** and their dæmon IS `<handle>.daemonium.eth` — minted directly under the parent and
> owned by that user's dæmon wallet. So the cluster is 3 levels:
> `daemonium.eth` → `<handle>.daemonium.eth` (the dæmon) → `research.<handle>.daemonium.eth` (a sub-agent).
> (We dropped an earlier `ignis.` level — the dæmon _is_ the handle name now.) The full ENS name is
> the agent's key everywhere (store key, signer key, identity); the `userId → handle` map lives in
> `app/lib/handles.ts`. Identity is **auto-claimed** at handle pick (`app/lib/provision.ts`) — no confirm.

## Background: the four pieces of ENS you need

1. **The Registry** — the root contract mapping each name (as a hash) to its owner + resolver.
2. **Resolvers** — where the actual data lives. The **PublicResolver** stores an address (`addr`),
   arbitrary **text records** (key→value), and more, per name.
3. **`namehash` / `labelhash`** — names aren't stored as strings on-chain; they're hashed.
   - `labelhash("research")` = keccak256 of a single label.
   - `namehash("research.alice.daemonium.eth")` = a recursive hash of all labels → a `bytes32`
     **node** that identifies the name everywhere in ENS.
   - We use viem's helpers: `namehash(normalize(name))` and `labelhash(normalize(label))`.
4. **The NameWrapper** — the modern way to own names. It "wraps" a name into an **ERC-1155 NFT**,
   which (a) makes ownership transferable like a token, (b) lets the owner mint **subnames**
   cheaply, and (c) adds **fuses** — permission bits an owner can _burn_ to permanently restrict
   what can be done to a name.

## What we actually do

Creating a subname is one NameWrapper call. From `app/lib/ens.ts`:

```ts
// setSubnodeRecord(parentNode, label, owner, resolver, ttl, fuses, expiry)
await signer.writeContract({
  address: ENS.nameWrapper,
  abi: nameWrapperAbi,
  functionName: "setSubnodeRecord",
  args: [parentNode, label, owner, ENS.publicResolver, 0n, 0, 0n],
  // ...
});
```

- `parentNode` = `namehash("daemonium.eth")` (or `namehash("alice.daemonium.eth")` for a nested one).
- `label` = the new leftmost piece, e.g. `"alice"` or `"research"`.
- `owner` = the **agent's own wallet address** — so the agent owns its name.
- `resolver` = the PublicResolver, set at creation so we can immediately write records.
- `ttl/fuses/expiry = 0/0/0` — the simplest case: no fuses burned. (We avoid burning fuses, partly
  so names stay clean for the eventual v2 migration.)

Then we point a **text record** at the agent's off-chain card:

```ts
// PublicResolver.setText(node, key, value) — node = namehash of the NEW name
await signer.writeContract({
  address: ENS.publicResolver, abi: resolverAbi, functionName: "setText",
  args: [nodeOf(name), "agent-card", agentCardUri(label)],
});
```

So a fully-formed dæmon identity is three things: **ENS name** (who) + **wallet address** (the agent
itself — see [`dynamic.md`](./dynamic.md)) + **agent card** (what it can do).

## Authorization — the part that bites you

`setSubnodeRecord` is guarded by `onlyTokenOwner(parentNode)`. Reading the NameWrapper source, the
caller must be **the wrapped owner of the parent**, _or_ an operator the owner approved via
`setApprovalForAll`. This has direct consequences for our cluster:

- The top level is minted by a **minter** (`app/lib/minter.ts`) — one backend wallet the parent's
  owner approves **once** via `NameWrapper.setApprovalForAll(<minter>, true)`. The minter mints
  `<handle>.daemonium.eth` for any user, owned by that user's dæmon. No per-user approval —
  `setApprovalForAll` is per-operator, so one approval covers unlimited users. (This is one mint per
  user now; the dropped `ignis.` level means the minter no longer mints a second level.)
- To create `research.<handle>.daemonium.eth`, the caller must control `<handle>.daemonium.eth` —
  which the dæmon owns, so **the dæmon signs it itself**. No minter, no human approval for a user's
  own subtree.

That's the trust boundary made literal: you can only mint under a name you control. `GET
/api/daemon/ens-status` reports the parent's real L1 state — whether `daemonium.eth` is wrapped and
whether the minter is approved (the two gating factors) — plus the caller's own dæmon.

The minter also **seeds each user's dæmon a little L1 gas** at claim time (`seedGasIfLow` in
`app/lib/minter.ts`), so the dæmon can register its own ERC-8004 NFT + text record without the user
pre-funding gas. One more source-verified rule: **every intermediate parent must itself be wrapped**;
subnames minted via NameWrapper are auto-wrapped, so once `daemonium.eth` is wrapped the whole cluster
below it is wrapped automatically.

## The cluster, signing, and gas

When a dæmon spawns `research` (`app/lib/actions.ts → spawnSubagent`):

1. A **new server wallet** is created for `research` (it _is_ that wallet).
2. The **dæmon** (owner of `<handle>.daemonium.eth`) mints `research.<handle>.daemonium.eth`, owned
   by the research wallet — the subname is created and paid for by the parent.
3. Best-effort: the dæmon **seeds the child a little L1 ETH** for gas, then the child registers _its
   own_ ERC-8004 identity and sets _its own_ text record. (Best-effort so a gas hiccup never loses
   the cluster node — the wallet + nested subname, the headline, are already done.)

So the namespace mirrors authority: parents mint children; children own their own subtrees.

## How ENS composes with ERC-8004

ENS gives the **name**; **ERC-8004** ("Trustless Agents") gives the on-chain **identity record** — an
ERC-721 NFT in the Identity Registry whose `tokenURI` resolves to the agent card JSON. On mainnet the
Identity Registry is `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (same implementation/ABI as the
testnet deploy — only the address differs). We link them both ways:

- The ENS `agent-card` text record → the card URL (our convention).
- The card's `registrations[]` → back to the NFT (`agentId` + registry), and the card lists the ENS
  name as a service.

Note: the ERC-8004 spec does **not** define an ENS text-record key for the card — using `agent-card`
is _our_ convention. The spec's canonical link is `tokenURI` ↔ `registrations[]`. We do both so the
identity is discoverable from either direction.

## Verified mainnet addresses (ENS docs + Etherscan, live June 2026)

| Contract | Address |
|---|---|
| ENS Registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |
| NameWrapper | `0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401` |
| PublicResolver | `0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63` |

All live in `app/lib/chain.ts` as the single source of truth.

## Prerequisites (one-time, real money on L1)

The cluster mints for real, which means real L1 setup + gas:

1. **Register `daemonium.eth` on Ethereum mainnet** (~$5/yr for a 5+ char name + gas) via
   app.ens.domains, and **wrap** it in the NameWrapper.
2. **Approve the minter:** `NameWrapper.setApprovalForAll(<minter address>, true)` from the parent
   owner. Fund the minter with L1 ETH (it pays for subname mints + seeds each dæmon's gas).
3. Per dæmon, expect **~$6–10** of L1 gas for the subname mint + `setText` + the dæmon's own
   ERC-8004 register, at moderate gas (cheaper in quiet periods, post-Fusaka).

`ens-status` surfaces whether (1) and (2) are done; until they are, names stay labels and the dæmon
still has its wallet + ERC-8004 NFT.

## What we learned

- Names are hashes on-chain; `namehash`/`labelhash` (via viem) are how you talk to ENS.
- The NameWrapper turns names into NFTs and makes subname minting + permissioning first-class.
- Authorization (`onlyTokenOwner`) makes the namespace _enforce_ the org chart: minting under a name
  requires owning it. The cluster's trust boundary is the subtree, for free.
- The prerequisites are environment state, not code: the parent must be **wrapped**, and the minter
  must be **approved**. We surfaced both via `ens-status` instead of guessing — and decoupled minting
  so a missing prereq degrades to a label rather than failing the dæmon.

## Why it matters

For the ENS prize specifically, the strong story is **subname clusters as an orchestration tree**: a
dæmon spawns sub-agents whose subnames nest under its own, each with its own ERC-8004 card, and the
subtree _is_ the cluster — org chart and trust boundary in one. More broadly, a human-readable,
verifiable identity is what lets dæmons eventually **discover and trust each other by name** rather
than by raw address — the basis for an agent service network.

See also [`dynamic.md`](./dynamic.md) for how each named identity is backed by a wallet the agent
actually controls, and [`lifi.md`](./lifi.md) for what these wallets do with value on Base.
