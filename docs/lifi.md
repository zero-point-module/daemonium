# LI.FI — letting a dæmon move and deploy value across DeFi

> _What we're doing, why, and the technical detail — grounded in the code we actually run._
> Big picture + diagrams: [`architecture.md`](./architecture.md).

## The idea

A dæmon that holds value should be able to **put it to work** and **move it where it's needed** —
not just send it. LI.FI gives Ignis two confirm-gated DeFi powers on **Base mainnet**:

1. **Swap-and-zap** (`lifi_zap`) — swap a token into USDC and deposit it into a yield vault (e.g.
   Aave) in **one atomic transaction**, built with LI.FI's **Composer SDK**.
2. **Bridge** (`bridge_tokens`) — move a token across chains via LI.FI's routing.

Both follow the same propose → human-confirm → execute contract as every other action (see
[`dynamic.md`](./dynamic.md)); only `POST /api/daemon/execute` ever signs.

## LI.FI Composer

Composer lets you express a **Flow** — an ordered graph of operations — and compile it server-side
into a **single executable transaction**. The pieces:

- **Operations** — `lifi.swap`, `lifi.zap`, `core.merge`, etc. Each takes typed input/output
  **handles**, so you thread one op's output into the next (the swap's `amountOut` feeds the zap's
  `amountIn`).
- **Resources** — `resources.erc20(addr, chainId)` / `resources.native(chainId)` declare the tokens
  a flow consumes/produces.
- **Materialisers** — tell the runtime how to source an input amount on-chain. We use
  `materialisers.directDeposit({ amount })` (pull a fixed amount from the signer via `transferFrom`).
- **Guards** — post-conditions, e.g. `guards.slippage({ port: 'amountOut', bps: 100 })` asserts the
  output is within 1%.
- **Compile** — `builder.compile({ signer, inputs, sweepTo, checkOnChainAllowances })` returns
  `{ status, transactionRequest, approvals[], userProxy, producedResources, priceImpact }`.

Our integration lives in `app/lib/lifi.ts` (`composeSwapAndZap`, `bridgeQuote`, `bridgeStatus`); the
swap-and-zap flow mirrors LI.FI's own `swapAndZap` example.

## The account model (the part that matters for a server wallet)

Composer **never pools funds.** Each signer gets a **deterministic per-signer execution proxy**
(`result.userProxy`). Our dæmon's MPC EOA is the signer **and** the source of funds:

- The EOA must **hold the input token** on Base mainnet.
- Before the flow, the EOA must **approve the execution proxy** as spender for each input token —
  `directDeposit` pulls the token via `transferFrom(signer)` into the proxy. The compile returns the
  exact `approvals[]` to submit (each with a prebuilt approve tx); our executor checks the on-chain
  allowance and submits any that are short, **then** the compiled flow tx.
- The flow tx's `to` is the **proxy** (or the **ProxyFactory** on the proxy's first-ever use, which
  deploys it and runs the flow atomically). We read `userProxy` from the compile — never hardcode it.
- `sweepTo: builder.context.sender` returns any terminal balances to our EOA when the flow ends.

So: no proxy pre-funding, just **hold + approve** on the EOA. `getSigner(agent, DEFI_SIGNER)` (Base
mainnet override) signs+broadcasts. The executor is in `app/lib/actions.ts` (`lifiZap`), and it
mirrors the allowance-check + approve + send pattern of the existing `swap` executor.

```ts
// app/lib/lifi.ts (shape) — swap fromToken → USDC (skipped if already USDC), then zap into a vault
const builder = sdk.flow(8453, { name: "daemon-swap-and-zap",
  inputs: { amountIn: resources.erc20(fromToken, 8453) } });
const zapIn = isUsdcIn ? builder.inputs.amountIn
  : builder.lifi.swap("swap", { bind: { amountIn: builder.inputs.amountIn },
      config: { resourceOut: resources.erc20(USDC, 8453), slippage: 0.03 } }).amountOut;
builder.lifi.zap("zap", { bind: { amountIn: zapIn },
  config: { resourceOut: resources.erc20(vaultToken, 8453) },
  guards: [guards.slippage({ port: "amountOut", bps: 100 })] });
const result = await builder.compile({ signer: eoa,
  inputs: { amountIn: materialisers.directDeposit({ amount }) },
  sweepTo: builder.context.sender, checkOnChainAllowances: true });
```

## Bridging

Single-Flow **cross-chain** compose isn't exposed in the `@staging` Composer build, so bridging uses
LI.FI's **REST `/v1/quote`** — the doc-guaranteed cross-chain primitive. We GET a route quote
(`fromChain`/`toChain`/`fromToken`/`toToken`, with `fromAddress = toAddress` = our EOA), approve the
returned spender if needed, sign+broadcast the source tx, and the funds settle on the destination
asynchronously (poll `/v1/status`). Token symbols (e.g. `"USDC"`) are resolved per chain by LI.FI.
Since the dæmon's value lives on Base, the natural bridge is **out of Base** to another chain.

## The mainnet / small-amounts reality

LI.FI Composer is **mainnet-only** — there is no testnet deployment — so these flows run on **real
Base mainnet with real (tiny) funds**. The hackathon Composer endpoint
(`https://ethglobal-composer.li.quest`) is explicitly **unaudited / alpha**; LI.FI's own guidance is
*"keep amounts small."* We honor that two ways: a hard `LIFI_CAP_USD` (a few dollars) enforced in the
executor from the compile's `priceImpact.inputValueUsd` / the quote's USD value, on top of the
human confirm gate. Install: `@lifi/composer-sdk@staging` + `@lifi/compose-spec@staging`;
`LIFI_API_KEY` from the portal; `baseUrl` is the hackathon endpoint (production is
`https://composer.li.quest`). Vault tokens for the zap (default: Aave Base aUSDC) should be confirmed
against LI.FI's zap-pack discovery / `/compose/manifest` before a live run — an invalid vault simply
returns a compile error, which the executor surfaces.

## The demo

> *"Ignis, swap 3 USDC into a yield vault on Base."*

→ `lifi_zap` proposes a `Swap & Zap` card (best-effort compile enriches it with the ~USD value) →
human taps Confirm → the executor re-compiles fresh, approves the execution proxy, and submits one
atomic swap-and-zap tx on Base. One signature, one receipt; `producedResources` shows the vault
(aToken) the dæmon now holds. Reliable for a live stage run because it's atomic and same-chain.

`bridge_tokens` is the cross-chain counterpart — *"bridge 5 USDC from Base to Arbitrum"* — which
shows LI.FI's headline routing value, at the cost of asynchronous (two-tx) settlement.

## Why it matters

Holding value is table stakes; **deploying and moving it** is what makes a dæmon economically alive.
Swap-and-zap turns idle USDC into a yield position in one human-approved tap; bridging lets a dæmon
follow opportunity across chains. Composed with Dynamic (the wallet) and ENS (the identity), LI.FI is
the dæmon's hands in DeFi — under the same single confirm-before-act boundary as everything else.

See also [`dynamic.md`](./dynamic.md) (the wallet + confirm gate) and [`ens.md`](./ens.md) (identity).
