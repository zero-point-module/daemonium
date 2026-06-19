# Dynamic — how a dæmon owns and controls its own wallet

> _What we're doing, why, and the technical detail — grounded in the code we actually run._
> Big picture + diagrams: [`architecture.md`](./architecture.md).

## The idea

**The agent _is_ the wallet; Dynamic is the manager.** Ignis isn't a program that asks a
human's wallet to sign — Ignis _has its own wallet_ and signs autonomously on the server.
Dynamic is the infrastructure that makes that wallet exist, stay secure, and be controllable
from our backend. Every sub-agent Ignis spawns gets its own wallet the same way.

This is the heart of the project: a free digital entity that holds and uses value needs a
wallet it actually controls, not a feature bolted onto a human's account.

## Ownership: the user owns the account; the agent is a session key

> _This is the current ownership model. It supersedes the older "the agent's MPC wallet is the
> on-chain owner" framing — that wallet is now the agent's **session key**, not the owner._

Autonomy is only safe if the **human is the on-chain owner and is accountable**. So each user owns a
single **ERC-4337 smart account** (a [ZeroDev](https://zerodev.app) **Kernel** account), with their
**Dynamic embedded wallet** (`primaryWallet`) as the **sudo owner**. That one smart account owns
**both** layers: **money** on Base and **identity** (ENS subnames + ERC-8004) on Ethereum mainnet.
It has the **same deterministic address on both chains** (multi-chain ECDSA validator).

Each agent and sub-agent's Dynamic **server (MPC) wallet** is registered on that account as a
**scoped session key** (a ZeroDev permission validator), **not** an owner. A session key carries
**on-chain-enforced** policy: allowed target contracts, per-call/native spend caps, an ERC-20 amount
ceiling, and an expiry. Even a fully compromised backend cannot exceed what the chain enforces, and
the user can revoke a key at any time.

**The "before-action click" is now a real signature**, with two modes:

| Mode | Who signs the UserOp | When |
|---|---|---|
| **Co-sign** (default) | the **user's embedded wallet**, per action | every action, unless an agent has been granted autonomy |
| **Autonomy** (opt-in) | the **agent's session key**, server-side, within policy | after the user signs a one-time grant scoping that agent (caps/targets/expiry) |

So the user authorizes either each action (a genuine cryptographic approval, not a UI gesture) or a
bounded, revocable session the agent then operates within. Funds and identity live in **one** place
the user owns; agents are guests on a leash the user holds.

```
User's Dynamic embedded wallet (primaryWallet)  ── sudo owner
        │ owns (same address on mainnet + Base)
        ▼
User Kernel Smart Account (ERC-4337, EntryPoint 0.7, Kernel v3.x)
   ├─ holds funds (Base) + ENS subnames & ERC-8004 NFTs (mainnet)
   ├─ session key: ignis       → policy: caps / targets / expiry
   └─ session key: research.*  → tighter policy
```

**Gas is self-funded:** the minter seeds the smart account with ETH on both chains (no paymaster).
The smart account pays for its own UserOps; the first L1 UserOp also counterfactually deploys it.

The MPC / server-wallet machinery below is unchanged — it's still how each agent's **session-key
signer** exists and signs. What changed is *who owns the assets*: the user's smart account, not the
agent.

## Why not just use the human's wallet?

A normal dApp flow is: user connects MetaMask → app asks the wallet to sign → user approves in
a popup. The _human_ is the signer of record. That's wrong for an agent — the agent would be
unable to act unless a human is physically clicking, and it wouldn't "own" anything.

The other naïve option is to give the agent a raw private key (`privateKeyToAccount`). That
works, but the key sits in one place — leak it and the wallet is gone, and there's no managed
infrastructure, no policy, no recovery. Fine as a fallback; not the story we want to tell.

Dynamic's **server wallets** give us the best of both: a wallet the _backend_ controls
programmatically, but whose private key never exists in one piece anywhere.

## MPC / threshold signatures (TSS)

A server wallet is an **MPC (multi-party computation)** wallet using **TSS (threshold
signature scheme)**. Instead of one private key, the key is mathematically split into
**shares** held by different parties. To sign, a _threshold_ of those shares cooperate in a
protocol — and the full private key is **never reconstructed** in memory, on any machine.

We use **`TWO_OF_TWO`**: two shares exist, and _both_ are needed to sign. One is the
**external server key share**; the other is held by **Dynamic's** MPC relay. So a signature
requires both halves to participate — neither alone can move funds.

We create wallets with **`backUpToDynamic: true`**, which means Dynamic also stores our share in
its **key-share backup service**, encrypted under our `password`. The payoff (see the storage
section below): we **don't persist the sensitive share ourselves** — Dynamic supplies it from
backup at sign time. The security model still holds: signing needs both shares, and the backup is
locked behind `DAEMON_WALLET_PASSWORD` (a server-only secret). (Other schemes exist —
`TWO_OF_THREE`, `THREE_OF_FIVE` — for richer recovery trade-offs; `2-of-2` + backup is the
simplest and right for a hackathon.)

```ts
// app/lib/dynamic-server.ts
const result = await client.createWalletAccount({
  thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
  password,            // protects the backed-up key share
  backUpToDynamic: true, // Dynamic stores the share → we persist only walletMetadata
});
// → { walletMetadata, ... }  (we keep only walletMetadata)
```

## The packages

- `@dynamic-labs/sdk-react-core` + `@dynamic-labs/ethereum` + `@dynamic-labs/wagmi-connector`
  — **frontend**: the human's login + embedded wallet (a different, lighter MPC wallet for the
  _user_, created on signup). This is the React/JS SDK.
- `@dynamic-labs-wallet/node-evm` + `@dynamic-labs-wallet/node` — **backend**: the server-wallet
  SDK that gives Ignis (and sub-agents) their autonomous wallets. This is a _separate package
  family_ from the React SDK and is what makes "Dynamic Agents" work.

So there are **two kinds of wallet** in Daemonium:

| Wallet | Who | Where it lives | Role |
|---|---|---|---|
| Embedded wallet | the human | frontend (React SDK) | login + **sudo owner** of the user's smart account; signs co-sign UserOps and session-key grants |
| Server wallet | each agent | backend (node-evm SDK) | the agent's **session-key signer** on the user's smart account (no longer the on-chain owner) |

The user's assets don't live in either of these directly — they live in the **Kernel smart account**
the embedded wallet owns (see the ownership section above). `createAccountAdapter`
(`@dynamic-labs-wallet/node-evm`) turns a server wallet into a viem `Account` so it can be wired in as
a ZeroDev session-key signer.

## **Dynamic is the wallet store** (we persist almost nothing)

`createWalletAccount` returns and **then forgets** everything — but we lean on Dynamic so hard that
we persist **no wallet data at all**, not even metadata. Two facts make this work:

1. Wallets are created with **`backUpToDynamic: true`**, so the key share lives in Dynamic's backup,
   recovered with our `password` at sign time (we never store or pass shares).
2. **`getEvmWallets()` returns each wallet's `externalServerKeySharesBackupInfo`** — the backup
   pointer. That plus `walletId`/`accountAddress`/`chainName`/`scheme`/`derivationPath` is exactly a
   signable **`WalletMetadata`**. So we **reconstruct metadata from Dynamic on demand** (cached per
   process) and never persist it. Dynamic _is_ the wallet store.

The one thing Dynamic can't tell us is **which wallet is which dæmon** (`createWalletAccount` takes no
alias), so we keep a thin **name→address index** — the agent's ENS name → its address, plus the
cluster tree (`agentId`, `parent`, `children`). That's small and non-sensitive. It lives in
`app/lib/kv.ts`: a serverless Redis (Upstash / Vercel KV) when configured, else a gitignored JSON file
for local dev — **so nothing requires a writable filesystem to deploy.**

```ts
// app/lib/dynamic-server.ts — no local shares, no stored metadata.
export async function getSigner(key: string, opts = {}): Promise<WalletClient> {
  const wallet = await getWallet(key);                          // index → address (from KV)
  const walletMetadata = await getWalletMetadataForAddress(wallet.address); // rebuilt from Dynamic
  const client = await getServerClient();
  return client.getWalletClient({
    walletMetadata,
    password: process.env.DAEMON_WALLET_PASSWORD!,              // decrypts the backed-up share
    chain: opts.chain ?? IDENTITY_CHAIN,                        // default L1; opts → Base
    chainId: opts.chainId ?? IDENTITY_CHAIN_ID,
    rpcUrl: opts.rpcUrl ?? IDENTITY_RPC_URL,
  });
}
```

This removed an entire class of risk — there is **no key material and no wallet metadata in our store
at all**, only an address index. (Trade-offs: a `getEvmWallets()` round-trip on a cache miss to rebuild
metadata, and a share-recovery round-trip per signature. We seed the cache on wallet creation so a
freshly minted wallet signs immediately, before it propagates to the list.) Verify the loop the right
way: create → **restart** → reload the index → sign with reconstructed metadata + password → a real tx
broadcasts.

### One wallet, two chains (the hybrid topology)

`getSigner` takes a per-call chain override because the same MPC address is identical on every EVM
chain. Daemonium uses that to split layers: **identity** (ENS + ERC-8004) on **Ethereum mainnet**
(the default), and **value** (sends, swaps, LI.FI) on **Base mainnet** (cheap gas) via the
`DEFI_SIGNER` override. See [`ens.md`](./ens.md) and [`lifi.md`](./lifi.md).

## Signing + broadcasting

The server-wallet SDK gives us a real **viem `WalletClient`**. That's deliberate — it means the
rest of our code is ordinary viem:

```ts
const signer = await getSigner("ignis");
const hash = await signer.writeContract({         // MPC-signs AND broadcasts, returns the hash
  address: USDC.address, abi: erc20Abi, functionName: "transfer",
  args: [to, parseUnits(amount, 6)],
  account: signer.account, chain: CHAIN,
});
```

There's also a lower-level `signTransaction(...)` that returns a _serialized signed tx_ for you
to broadcast yourself — but then you must fill nonce/gas/fees manually. The `getWalletClient` →
viem path auto-populates all of that, so we use it.

## Authentication + the wallet manager

The backend authenticates once with an **API token** (dashboard → Developers → API, scoped to
wallet permissions), then can create/sign for any wallet under the environment:

```ts
const client = new DynamicEvmWalletClient({ environmentId: process.env.DYNAMIC_ENVIRONMENT_ID! });
await client.authenticateApiToken(process.env.DYNAMIC_API_TOKEN!);
```

Calling `createWalletAccount` again mints another independent wallet — this is how each
sub-agent becomes its own wallet, and they all show up in the Dynamic dashboard (the "manager"
view). Secrets (`DYNAMIC_API_TOKEN`, `DAEMON_WALLET_PASSWORD`, and the KV credentials) live only
on the server; only the public `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` reaches the browser. (Key
shares are held by Dynamic's backup, not by us — see the storage section.)

## Where the human comes back in: the confirm gate

Autonomy is powerful and dangerous, so safety is structural, not cosmetic. The agent's
state-changing tools **never sign** — they only _propose_ (mint a `ProposalCard` with an opaque
`executionId` and emit a `proposal` event). The gated actions all run on **Base mainnet** (the
value layer): **`send_usdc`**, **`send_eth`** (native ETH, for gas or funding another agent),
**`swap`** (token swap via Dynamic's Swap API on Base mainnet — `app/lib/swap.ts` quotes, the
executor re-quotes + approves + signs via the same MPC address), **`lifi_zap`** and
**`bridge_tokens`** (LI.FI swap-and-zap + cross-chain bridge — see [`lifi.md`](./lifi.md)), and
**`spawn_subagent`** (which provisions identity on L1). The **only** code that signs is one route,
`POST /api/daemon/execute`, which runs after the human taps Confirm. (Identity claiming is *not*
gated — it's auto-provisioned per-user at handle pick; see `docs/ens.md` and `app/lib/provision.ts`.
Read-only tools — balance/activity/ENS-resolve/delegate-to-subagent — run immediately.)

Because real money now lives on mainnet, each executor also enforces a hard per-tx cap
(`USDC_SEND_CAP`, `ETH_SEND_CAP`, `SWAP_CAP_USD`, `LIFI_CAP_USD`) as defense in depth on top of
the confirm gate.

We chose this **propose/execute split over a private key in the client** _and_ over ai-sdk's
built-in `needsApproval`. Why: the client physically cannot sign (it has no shares), so a
mis-wired or jailbroken agent still can't move funds — the gate is a hard boundary, not a UX
affordance. There is exactly one auditable choke point.

**With user-owned smart accounts, the gate is now cryptographic, not just procedural.** In the
default **co-sign** mode the execute route returns the action's encoded calls for the `executionId`;
the **user's embedded wallet signs the resulting UserOp** and submits it — the backend cannot move
funds without that signature. In **autonomy** mode the backend signs with the agent's session key, but
the smart account enforces the granted policy **on-chain** (caps/targets/expiry), so the agent can
only act within bounds the user signed for, and reverts otherwise. Either way the per-tx caps above
still apply as defense in depth.


any server SDK with native/WASM bits usually needs `serverExternalPackages` in Next.

## What we found

- Server wallets make "an agent that owns value" real, without a bare private key.
- MPC/TSS means the key is never whole anywhere — signing is a _protocol_. With
  `backUpToDynamic: true` we persist only the non-sensitive `walletMetadata` and let Dynamic
  recover the share from backup, so our store holds **no** key material (one round-trip/sign is
  the cost).
- The SDK handing back a viem `WalletClient` keeps everything downstream boringly standard.
- The safest place for a confirmation gate is a structural one: keep signing in a single
  server route the client can't reach, not in the agent's reasoning.

## Why it matters

This is the foundation of an **agent economy**: dæmons that hold their own funds, earn, and pay
each other. Dynamic's server wallets + delegation are exactly the "AI agent that transacts
autonomously" primitive, and modeling Ignis (and its sub-agents) as first-class wallets is what
lets the rest of the system — ENS identity, payments, the cluster — hang together.

See also [`ens.md`](./ens.md) for how each of these wallets gets a human-readable identity.
```
