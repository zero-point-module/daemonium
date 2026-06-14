<p align="center">
  <img src="public/daemon/idle/full.webp" width="150" alt="Ignis — idle" />
  <img src="public/daemon/happy/full.webp" width="150" alt="Ignis — happy" />
  <img src="public/daemon/executing/full.webp" width="150" alt="Ignis — executing" />
  <img src="public/daemon/delegating/full.webp" width="150" alt="Ignis — delegating" />
</p>

<h1 align="center">Daemonium</h1>

<p align="center">
  A voice-first flame companion that lives on your screen and acts onchain — always behind your confirmation.
</p>

---

Daemonium is our implementation of an agent companion, built with a few principles at heart:

- **Joy** — interacting with Daemonium should be a source of delight, not a chore.
- **Real value** — it has to be genuinely useful, not a toy.
- **Autonomy** — it should be able to move and act freely, on its own.

Daemonium has native blockchain capabilities. Loaded with its own wallet, an ENS subdomain, and an
ERC-8004 card, it can send tokens, bridge across chains, swap, read on-chain activity, and perform
DeFi operations on approved protocols.

On top of the background tasks you can set your Daemonium to run while you do other things, it can
summon and orchestrate sub-agents — called *Daemons*. These can be specialized and customized, and
can offer their own services behind a paywall with x402. Just like their orchestrator, each one also
owns an ENS subdomain and an ERC-8004 card of its own.

Daemonium can talk, browse, bet, use your computer — and whatever else you want it to do.

<p align="center">
  <img src="public/1.png" width="30%" alt="Voice home — talking to Ignis" />
  <img src="public/2.png" width="30%" alt="Ignis reasoning about where your value lives" />
  <img src="public/3.png" width="30%" alt="The cluster — sub-dæmons and live spells" />
</p>

## How it's built

**Frontend.** Mobile-first, built with Next.js (App Router) and the usual onchain frontend stack —
viem, wagmi, TanStack React Query. The flame companion, *Ignis*, is rendered in raw WebGL:
hand-written GLSL shaders generate the procedural fire (heat-haze distortion, additive glow,
state-driven hue), composited per layer and driven by a `requestAnimationFrame` loop in React. The
character art was generated and edited with Claude + ChatGPT/DALL·E.

**Agentic loop.** Orchestrated with the Vercel AI SDK; the agent reasons with Claude (Sonnet 4.6)
via the Vercel AI Gateway. The backend is built entirely on Next.js serverless API routes.

**Voice.** Text-to-speech and the custom character voices are ElevenLabs (`eleven_flash_v2_5`,
~75ms latency). Speech-to-text is OpenAI, called through the AI SDK.

**Wallets & auth.** We integrate Dynamic to create and manage each agent's MPC server wallet — no
private key ever lives in our infrastructure, and signing happens only behind an explicit human
confirmation. Dynamic also provides user authentication (server-verified session JWTs) and powers
token swaps via its Swap API.

**Cross-chain & DeFi.** We integrate LI.FI for cross-chain bridging (e.g. USDC between Ethereum and
Base) and atomic swap-and-zap into yield vaults (e.g. Aave on Base), so a dæmon can put idle funds
to work. Hybrid topology: identity on Ethereum mainnet, value/DeFi on Base — one address across both.

**Identity.** Every agent owns its own ENS subdomain of `daemonium.eth` (`<name>.daemonium.eth`) as
a human-readable identity. Each specialized sub-agent (dæmon) it spawns is minted a subdomain of its
parent's ENS (`<sub>.<parent>.daemonium.eth`), forming an ownership hierarchy that nests the cluster.
Each agent is also registered with an ERC-8004 identity card describing its services and endpoints —
built to advertise x402-payable services as the next step.

---

<p align="center">
  Built for ETHGlobal New York with 🔥 from 🇦🇷
</p>
