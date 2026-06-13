# Workstream B — agent + onchain backend

Ignis is an AI dæmon that **is** a Dynamic server wallet (Dynamic manages it); sub-agents get
their own wallets and nest as an ENS cluster. Every state-changing action is gated by a human
confirmation. This doc covers the seam for Workstream A and how to run + verify.

## Architecture in one breath
Human logs in with Dynamic (embedded wallet) → Ignis has its **own** Dynamic MPC server wallet
→ agent tools **propose** (never sign) → human taps Confirm → `POST /api/daemon/execute` is the
**only** signer. Identity = ENS subname + wallet address + ERC-8004 card. Sub-agents nest under
`ignis.daemonium.eth`.

## The seam (`app/lib/types.ts`)
- **`DaemonEvent`** stream (server→client, sent as ai-sdk `data-daemon` parts):
  `state` · `speak` · `proposal` · `txResult` · `subagentResult` · `done`.
- **`ProposalCard`** `{ executionId, action, agent, summary, details }` — the confirm tap returns
  only `executionId`.
- **`DaemonIdentity`** (recursive) and **`AgentCard`** (ERC-8004 registration-v1).
- **`mockAgentRun()`** (`app/lib/mock-agent.ts`) — scripted events to build the flame against.

Workstream A: use the **`useDaemon()`** hook (`app/lib/daemon-client.ts`). It exposes
`{ messages, state, proposal, txResult, sendPrompt, confirm, dismissProposal }`. Replace the dev
`Console` (`app/components/console.tsx`) with the flame; the seam is identical.

## Routes
| Route | Method | Purpose |
|---|---|---|
| `/api/agent` | POST | Ignis's streaming brain (ai-sdk → Claude via AI Gateway). |
| `/api/daemon/init` | POST | Provision Ignis's wallet; returns address + balances. |
| `/api/daemon/execute` | POST | **The only signer.** Body `{ executionId }`. |
| `/api/daemon/propose` | POST | Debug: mint a send_usdc proposal without the agent. |
| `/api/daemon/ens-status` | GET | Is Ignis authorized to mint subnames under the parent? |
| `/api/daemon/watch` | GET | Incoming USDC since `?since=<block>` (proactive moment). |
| `/api/agent-card/[label]` | GET | The ERC-8004 agent card JSON (= agentURI + ENS text value). |

## Run it
1. `pnpm install` (already done) — env is in `.env.local` (`DYNAMIC_*`, `DAEMON_WALLET_PASSWORD`,
   `SEPOLIA_RPC_URL`, `ENS_PARENT_NAME`, `AI_GATEWAY_API_KEY`).
2. `pnpm dev` → http://localhost:3000. Log in (email/social) — you get a Sepolia embedded wallet.
3. `curl -X POST localhost:3000/api/daemon/init` → prints **Ignis's address**.
4. Talk to Ignis in the console: "what's my balance?", "send 1 USDC to vitalik.eth" (→ confirm card),
   "claim your identity", "spawn a research sub-agent".

## Two manual prerequisites for the funded flows
1. **Fund Ignis** (gas + tokens): send Sepolia ETH and Circle test USDC to the address from `init`
   (currently `0x0FD5aa0B8161441f52dBf6eFe23bDFccE9F7fDbc`).
2. **ENS authority**: from the wallet that owns `daemonium.eth`, call
   `setApprovalForAll(<ignis address>, true)` on the NameWrapper `0x0635513f179D50A207757E05759CbD106d7dFcE8`
   (Sepolia). Check with `curl localhost:3000/api/daemon/ens-status`.

## Verified working (no funds needed)
Wallet creation + persistence + idempotent reload; the agent loop with tool calls; read tools
(balance/identity/ENS/activity); the propose→confirm gate; `register_subname`/`spawn_subagent`
proposals; the sub-agent delegation loop; agent-card JSON; watch endpoint.

## Blocked on the two prerequisites above (code complete, awaiting on-chain verify)
A real USDC send; Ignis claiming `ignis.daemonium.eth` + ERC-8004; spawning a real sub-agent
(wallet + nested subname + card).

## Verified constants (Sepolia)
USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` · ENS NameWrapper `0x0635513f179D50A207757E05759CbD106d7dFcE8`
· PublicResolver `0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5` · ERC-8004 IdentityRegistry
`0x8004A818BFB912233c491871b3d84c89A494BD9e`. Model: `anthropic/claude-sonnet-4.6` via AI Gateway.

## Not built (stretch)
x402 paywall; receive-any-settle-USDC via Flow (needs Flow enterprise entitlement; would run on
**Base Sepolia**, not Ethereum Sepolia).
