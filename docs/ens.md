# ENS — giving a dæmon a name, and a cluster an org chart

> _What we're doing, why, and the technical detail — grounded in the code we actually run._

## The one-line idea

A wallet address (`0x0FD5…fDbc`) is unreadable and says nothing about _who_ an agent is. We
give each dæmon an **ENS name** as its identity backbone — `ignis.daemonium.eth` — and when
Ignis spawns a sub-agent, that sub-agent gets a **nested subname** — `research.ignis.daemonium.eth`.

The key insight (and our headline for the ENS prize): **the subname subtree _is_ the cluster.**
The namespace doubles as the org chart and the trust boundary. "Under `ignis.daemonium.eth`" =
"part of Ignis's cluster" = "allowed to interact." A name isn't decoration; it's structure.

> **Per-user naming.** Every user gets their _own_ Ignis, so they can't all share
> `ignis.daemonium.eth`. We derive a stable, collision-resistant name from the user's Dynamic id:
> `ignis-<id>.daemonium.eth` (e.g. `ignis-a1b2c3d4.daemonium.eth`), computed in
> `app/lib/identity.ts` and used _as the agent's key_ everywhere (store key, signer key, identity).
> A user's sub-agents nest under their own dæmon: `research.ignis-<id>.daemonium.eth`. The examples
> below use plain `ignis.daemonium.eth` for readability — mentally append the per-user suffix.

## Background: the four pieces of ENS you need

1. **The Registry** — the root contract mapping each name (as a hash) to its owner + resolver.
2. **Resolvers** — where the actual data lives. The **PublicResolver** stores an address
   (`addr`), arbitrary **text records** (key→value), and more, per name.
3. **`namehash` / `labelhash`** — names aren't stored as strings on-chain; they're hashed.
   - `labelhash("research")` = keccak256 of a single label.
   - `namehash("research.ignis.daemonium.eth")` = a recursive hash of all labels → a `bytes32`
     **node** that identifies the name everywhere in ENS.
   - We use viem's helpers: `namehash(normalize(name))` and `labelhash(normalize(label))`.
4. **The NameWrapper** — the modern way to own names. It "wraps" a name into an **ERC-1155 NFT**,
   which (a) makes ownership transferable like a token, (b) lets the owner mint **subnames**
   cheaply, and (c) adds **fuses** — permission bits an owner can _burn_ to permanently
   restrict what can be done to a name (e.g. "parent can no longer control this subname").

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

- `parentNode` = `namehash("daemonium.eth")` (or `namehash("ignis.daemonium.eth")` for a nested one).
- `label` = the new leftmost piece, e.g. `"ignis"` or `"research"`.
- `owner` = the **agent's own wallet address** — so the agent owns its name.
- `resolver` = the PublicResolver, set at creation so we can immediately write records.
- `ttl/fuses/expiry = 0/0/0` — the simplest case: no fuses burned. (If you burn any fuse you
  _must_ set a non-zero expiry; we don't need that yet.)

Then we point a **text record** at the agent's off-chain card:

```ts
// PublicResolver.setText(node, key, value) — node = namehash of the NEW name
await signer.writeContract({
  address: ENS.publicResolver, abi: resolverAbi, functionName: "setText",
  args: [nodeOf(name), "agent-card", agentCardUri(label)],
});
```

So a fully-formed dæmon identity is three things:
**ENS name** (who) + **wallet address** (the agent itself — see [`dynamic.md`](./dynamic.md)) +
**agent card** (what it can do).

## Authorization — the part that bites you

`setSubnodeRecord` is guarded by `onlyTokenOwner(parentNode)`. Reading the NameWrapper source,
the caller must be **the wrapped owner of the parent**, _or_ an operator the owner approved via
`setApprovalForAll`. This has direct consequences for our cluster:

- To create `ignis-<id>.daemonium.eth`, the caller must control **`daemonium.eth`** — owned by
  the human. We **don't** approve each user's Ignis individually (that wouldn't scale: every
  user is a fresh address). Instead we use a **minter**: one backend wallet (`app/lib/minter.ts`)
  that the parent's owner approves **once** via `NameWrapper.setApprovalForAll(<minter>, true)`.
  After that the minter mints every user's root subname — with `owner` set to that user's Ignis —
  so each user still **owns** its own name without any per-user approval.
- To create `research.ignis-<id>.daemonium.eth`, the caller must control the user's own Ignis
  name — which that Ignis now owns, so **Ignis signs it itself**. No minter, no human approval
  for a user's own subtree.

That's the trust boundary made literal: you can only mint under a name you control. `setApprovalForAll`
is **per-operator, not per-name**, which is exactly why one approved minter covers unlimited users.
`GET /api/daemon/ens-status` reports the minter's approval + balance (the real gating factors) and
the caller's own Ignis; it confirms the parent is wrapped (if it weren't, `ownerOf` would revert).

The minter also **seeds each user's Ignis a little gas** at claim time (`claimIdentity` in
`app/lib/actions.ts`), so the user's Ignis can register its own ERC-8004 NFT + text record without
the user pre-funding gas. The minter pays for the root mint; the one-time human setup is just
"approve the minter + keep it funded with Sepolia ETH."

One more source-verified rule: **every intermediate parent must itself be wrapped**. Subnames
minted via NameWrapper are auto-wrapped, so once `daemonium.eth` is wrapped, the whole cluster
below it is wrapped automatically.

## The cluster, signing, and gas

When Ignis spawns `research` (`app/lib/actions.ts → spawnSubagent`):

1. A **new server wallet** is created for `research` (it _is_ that wallet).
2. **Ignis** (owner of `ignis.daemonium.eth`) mints `research.ignis.daemonium.eth`, owned by the
   research wallet — the subname is created and paid for by the parent.
3. Best-effort: Ignis **seeds the child a little Sepolia ETH** for gas, then the child registers
   _its own_ ERC-8004 identity and sets _its own_ text record. (Best-effort so a gas hiccup never
   loses the cluster node — the wallet + nested subname, the headline, are already done.)

So the namespace mirrors authority: parents mint children; children own their own subtrees.

## How ENS composes with ERC-8004

ENS gives the **name**; **ERC-8004** ("Trustless Agents") gives the on-chain **identity record**
— an ERC-721 NFT in the Identity Registry whose `tokenURI` resolves to the agent card JSON. We
link them both ways:

- The ENS `agent-card` text record → the card URL (our convention).
- The card's `registrations[]` → back to the NFT (`agentId` + registry), and the card lists the
  ENS name as a service: `{ "name": "ENS", "endpoint": "ignis.daemonium.eth", "version": "v1" }`.

Note: the ERC-8004 spec does **not** define an ENS text-record key for the card — using
`agent-card` is _our_ convention. The spec's canonical link is `tokenURI` ↔ `registrations[]`.
We do both so the identity is discoverable from either direction.

## Verified Sepolia addresses (cross-checked: ENS docs + GitHub deployments + Etherscan)

| Contract | Address |
|---|---|
| ENS Registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |
| NameWrapper | `0x0635513f179D50A207757E05759CbD106d7dFcE8` |
| PublicResolver | `0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5` |

All live in `app/lib/chain.ts` as the single source of truth.

## What we learned

- Names are hashes on-chain; `namehash`/`labelhash` (via viem) are how you talk to ENS.
- The NameWrapper turns names into NFTs and makes subname minting + permissioning first-class.
- Authorization (`onlyTokenOwner`) makes the namespace _enforce_ the org chart: minting under a
  name requires owning it. The cluster's trust boundary is the subtree, for free.
- The prerequisites are environment state, not code: the parent must be **wrapped**, and the
  minter must **own or be approved**. We surfaced both via `ens-status` instead of guessing.

## Why it matters

For the ENS prize specifically, the strong story is **subname clusters as an orchestration tree**:
Ignis spawns sub-agents whose subnames nest under its own, each with its own ERC-8004 card, and
the subtree _is_ the cluster — org chart and trust boundary in one. More broadly, a human-readable,
verifiable identity is what lets dæmons eventually **discover and trust each other by name** rather
than by raw address — the basis for an agent service network.

See also [`dynamic.md`](./dynamic.md) for how each named identity is backed by a wallet the agent
actually controls.
```
