# Daemonium — architecture at a glance

> _The system, in diagrams. Deep-dives: [`dynamic.md`](./dynamic.md) (the wallet),
> [`ens.md`](./ens.md) (the name + cluster), [`lifi.md`](./lifi.md) (DeFi on Base)._

**One idea:** _the agent IS the wallet; Dynamic is the manager._ A user's dæmon (Ignis) owns its own
MPC server wallet and acts onchain by itself — every state-changing action gated by a single human
confirm. It runs across **two mainnets at once**: its **identity** (ENS name + ERC-8004 card) lives on
**Ethereum L1**; its **value** (USDC/ETH, swaps, yield, bridges) lives on **Base**. Three sponsor
integrations, composed: **Dynamic** (server wallets), **ENS** (subname cluster), **LI.FI** (swap-and-zap
+ bridge).

---

## 1. System overview

```mermaid
flowchart TB
  U["👤 Human"]
  EW["Dynamic embedded wallet<br/>(login + the approver)"]
  U --> EW

  subgraph BE["Daemonium backend — Next.js"]
    API["/api/agent<br/>ai-sdk loop (Claude)"]
    TOOLS["Agent tools<br/>(propose-only, never sign)"]
    GATE{{"Confirm gate<br/>/api/daemon/execute<br/>the ONLY signer"}}
    KV[("KV index<br/>name → address")]
  end

  EW -->|"Dynamic JWT"| API
  API --> TOOLS
  TOOLS -->|"ProposalCard (executionId)"| U
  U -->|"Confirm"| GATE
  API -.->|"resolve handle → ENS key"| KV

  subgraph DYN["Dynamic — the manager"]
    MPC["MPC server wallets<br/>+ key-share backup"]
  end
  GATE -->|"getSigner"| MPC

  subgraph L1["Ethereum mainnet — IDENTITY"]
    ENSC["ENS cluster<br/>handle.daemonium.eth"]
    E8004["ERC-8004 Identity NFT"]
  end
  subgraph BASE["Base mainnet — VALUE / DeFi"]
    DSWAP["Dynamic Swap"]
    LIFI["LI.FI Composer<br/>swap-and-zap + bridge"]
    FUNDS["USDC / ETH"]
  end

  MPC ==>|"signs identity ops"| L1
  MPC ==>|"signs value ops"| BASE
```

The dæmon's **one MPC address** is identical on every EVM chain, so a single wallet spans both layers.

---

## 2. The confirm gate (propose → confirm → execute)

The agent can reason and quote freely, but it **physically cannot sign** — its tools only mint a
proposal. Signing happens in exactly one route, after the human taps Confirm.

```mermaid
sequenceDiagram
  actor H as Human
  participant A as Agent (Ignis)
  participant X as /api/daemon/execute
  participant D as Dynamic MPC
  participant C as Chain (Base / L1)

  H->>A: "swap 3 USDC into a vault"
  A->>A: build + quote the flow (read-only)
  A-->>H: ProposalCard + executionId  (no signing)
  H->>X: Confirm (sends executionId only)
  X->>D: getSigner(walletMetadata + password)
  D-->>X: WalletClient (key share recovered from backup)
  X->>C: approve + execute (MPC-signed tx)
  C-->>X: receipt
  X-->>H: txResult (hash)
```

Hard caps (`USDC_SEND_CAP`, `SWAP_CAP_USD`, `LIFI_CAP_USD`, …) are enforced server-side as defense in
depth on top of the confirm.

---

## 3. The ENS cluster — the namespace IS the org chart

The minter mints each user's `handle.daemonium.eth` (owned by that user's dæmon); each dæmon then mints
its own sub-agents. The subtree _is_ the cluster — org chart and trust boundary in one. Every node owns
its own wallet and ERC-8004 card.

```mermaid
flowchart TD
  ROOT["daemonium.eth<br/>(wrapped · minter approved)"]
  ROOT --> A["alice.daemonium.eth<br/>= Alice's dæmon"]
  ROOT --> B["bob.daemonium.eth<br/>= Bob's dæmon"]
  A --> AR["research.alice.daemonium.eth"]
  A --> AT["trader.alice.daemonium.eth"]
  B --> BR["research.bob.daemonium.eth"]

  classDef node fill:#1b1b1b,stroke:#ff7a18,color:#fff;
  class ROOT,A,B,AR,AT,BR node;
```

Authority flows downward: you can only mint under a name you own (`onlyTokenOwner`), so the minter (one
approved operator) bootstraps the `handle` level and dæmons own everything below themselves.

---

## 4. Hybrid two chains — and bridging between them

```mermaid
flowchart LR
  subgraph WALLET["One MPC address (same on every chain)"]
    ID["identity"]
    VAL["value"]
  end

  subgraph L1["Ethereum mainnet"]
    ENSC["ENS cluster"]
    E8004["ERC-8004 NFT"]
    L1F["ETH / USDC"]
  end
  subgraph BASE["Base mainnet"]
    SW["Dynamic Swap"]
    ZAP["LI.FI swap-and-zap"]
    BF["ETH / USDC"]
  end

  ID --- L1
  VAL --- BASE
  L1F -->|"bridge_tokens (LI.FI)"| BF
  BF -->|"swap / lifi_zap"| ZAP
```

`get_balance` reports **both** chains. If the agent's funds are on L1 but it needs to act on Base, it
bridges with `bridge_tokens` (LI.FI) first, then swaps/zaps on Base.

---

## 5. Provisioning a dæmon (auto, at handle pick)

```mermaid
sequenceDiagram
  actor H as Human
  participant HR as /api/daemon/handle
  participant P as provision.ts
  participant DM as Dynamic
  participant M as Minter (L1)
  participant L1 as Ethereum L1

  H->>HR: pick handle "alice"
  HR->>P: provisionIdentity("alice")
  P->>DM: createWalletAccount → dæmon MPC wallet
  P->>M: seedGasIfLow(dæmon)  (L1 gas)
  P->>L1: register ERC-8004  (dæmon signs)
  P->>M: mint alice.daemonium.eth  (minter signs)
  Note over P,L1: ENS step is best-effort — skipped<br/>if daemonium.eth isn't wrapped/approved yet
  P-->>H: { ensName, address, agentId }
```

Each step is **decoupled + idempotent**: a gas hiccup or a missing ENS prereq never loses the wallet or
the identity — re-running provisioning self-heals the rest.

---

## 6. Where state lives (almost nowhere, on our side)

```mermaid
flowchart LR
  subgraph OURS["Our backend — minimal state"]
    KV[("KV: name→address index<br/>+ userId→handle")]
  end
  subgraph DYN["Dynamic"]
    WM["wallet metadata + key-share backup"]
  end
  subgraph CHAIN["On-chain — source of truth"]
    OC["ERC-8004 NFTs · ENS names"]
  end

  KV -->|"address"| WM
  WM -->|"reconstruct metadata → sign"| CHAIN
```

We persist **no key material and no wallet metadata** — only a tiny name→address index (Vercel KV, with a
local-file fallback). Signable `walletMetadata` is reconstructed from Dynamic's `getEvmWallets()` on
demand, and shares are recovered from Dynamic's backup at sign time. So the app deploys with no writable
filesystem and no secrets in our store. See [`dynamic.md`](./dynamic.md#the-most-important-technical-fact-dynamic-is-the-wallet-store-we-persist-almost-nothing).
