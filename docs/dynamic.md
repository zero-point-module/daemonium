# Dynamic — how a dæmon owns and controls its own wallet

> _What we're doing, why, and the technical detail — grounded in the code we actually run._

## The one-line idea

**The agent _is_ the wallet; Dynamic is the manager.** Ignis isn't a program that asks a
human's wallet to sign — Ignis _has its own wallet_ and signs autonomously on the server.
Dynamic is the infrastructure that makes that wallet exist, stay secure, and be controllable
from our backend. Every sub-agent Ignis spawns gets its own wallet the same way.

This is the heart of the project: a free digital entity that holds and uses value needs a
wallet it actually controls, not a feature bolted onto a human's account.

## Why not just use the human's wallet?

A normal dApp flow is: user connects MetaMask → app asks the wallet to sign → user approves in
a popup. The _human_ is the signer of record. That's wrong for an agent — the agent would be
unable to act unless a human is physically clicking, and it wouldn't "own" anything.

The other naïve option is to give the agent a raw private key (`privateKeyToAccount`). That
works, but the key sits in one place — leak it and the wallet is gone, and there's no managed
infrastructure, no policy, no recovery. Fine as a fallback; not the story we want to tell.

Dynamic's **server wallets** give us the best of both: a wallet the _backend_ controls
programmatically, but whose private key never exists in one piece anywhere.

## The crypto concept: MPC / threshold signatures (TSS)

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
| Embedded wallet | the human | frontend (React SDK) | login, approver, funding source |
| Server wallet | each agent | backend (node-evm SDK) | the agent's own funds + identity |

## The most important technical fact: **Dynamic is the wallet store** (we persist almost nothing)

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

## A gotcha we hit (and the lesson)

The MPC SDK pulls in native/WASM attestation modules (`@evervault/wasm-attestation-bindings`).
Next.js/Turbopack tried to **bundle** the `.wasm` and failed with `Module not found: 'wbg'`.
Fix: tell Next to leave these packages as runtime requires instead of bundling them —

```ts
// next.config.ts
serverExternalPackages: [
  "@dynamic-labs-wallet/node-evm", "@dynamic-labs-wallet/node",
  "@dynamic-labs-wallet/core", "@dynamic-labs-wallet/primitives",
  "@evervault/wasm-attestation-bindings",
],
```

Lesson: any server SDK with native/WASM bits usually needs `serverExternalPackages` in Next.

## What we learned

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
