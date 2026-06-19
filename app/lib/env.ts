/**
 * Central environment validation. Parsed once when this module is first imported; a missing or
 * empty REQUIRED var throws a single aggregated error listing everything that's wrong, instead
 * of a missing var surfacing as a confusing 500 deep inside a request (e.g. the minter snag).
 *
 * It's imported from next.config.ts, so it runs at BUILD time (and again at dev/start) and
 * fails fast. Server-side only — it reads secrets; never import it from a client component.
 */
import { z } from "zod";

const required = z.string().min(1);

const schema = z.object({
  // --- Required: the app cannot run without these (no in-code default). ---
  OPENAI_API_KEY: required, //          speech-to-text — /api/stt
  ELEVENLABS_API_KEY: required, //      text-to-speech — /api/tts (character voices)
  AI_GATEWAY_API_KEY: required, //      the agent — Claude via the Vercel AI Gateway
  DYNAMIC_ENVIRONMENT_ID: required, //  auth (JWKS) + server MPC wallets
  DYNAMIC_API_TOKEN: required, //       server-wallet API client
  DAEMON_WALLET_PASSWORD: required, //  decrypts the wallets' MPC key shares

  // --- Optional: these have safe defaults in chain.ts / log.ts / minter.ts. ---
  MAINNET_RPC_URL: z.string().optional(), //   identity layer (Ethereum L1) RPC
  BASE_RPC_URL: z.string().optional(), //       DeFi layer (Base mainnet) RPC
  REDIS_URL: z.string().optional(), //          KV store (Vercel KV); falls back to a local file
  LIFI_API_KEY: z.string().optional(), //       LI.FI Composer + REST (the lifi_* tools)
  LIFI_COMPOSER_BASE_URL: z.string().optional(), // override the hackathon Composer endpoint
  ENS_ONCHAIN_MINTING: z.string().optional(), // "false" to disable L1 subname minting
  ENS_PARENT_NAME: z.string().optional(),
  APP_BASE_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  MINTER_WALLET: z.string().optional(),

  // --- Account abstraction (ERC-4337) bundlers. Optional: provisioning/value ops that need a
  //     UserOp surface a clear error if unset. Use a ZeroDev or Pimlico endpoint per chain. A chain
  //     is "active" for smart-account ops once its bundler is set. ---
  BUNDLER_RPC_MAINNET: z.string().optional(), //  identity-layer UserOps (Ethereum L1)
  BUNDLER_RPC_BASE: z.string().optional(), //     value-layer UserOps (Base, server-side autonomy)
  BUNDLER_RPC_ARBITRUM: z.string().optional(), // optional extra value chains (server autonomy)
  BUNDLER_RPC_OPTIMISM: z.string().optional(),
  BUNDLER_RPC_POLYGON: z.string().optional(),
  ARBITRUM_RPC_URL: z.string().optional(), //     server reads for the extra chains (default: public)
  OPTIMISM_RPC_URL: z.string().optional(),
  POLYGON_RPC_URL: z.string().optional(),

  // --- Optional, client-exposed (fallbacks live in app/providers.tsx). ---
  NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID: z.string().optional(),
  NEXT_PUBLIC_SEPOLIA_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_BASE_RPC_URL: z.string().optional(), //    client reads + co-sign public client (Base)
  NEXT_PUBLIC_MAINNET_RPC_URL: z.string().optional(), // client reads + co-sign public client (L1)
  NEXT_PUBLIC_BUNDLER_RPC_BASE: z.string().optional(), // client co-sign UserOp submission (Base)
  NEXT_PUBLIC_BUNDLER_RPC_MAINNET: z.string().optional(), // client co-sign UserOp submission (L1)
  // Optional extra value chains for client co-sign — set bundler (+ RPC) to switch each on.
  NEXT_PUBLIC_BUNDLER_RPC_ARBITRUM: z.string().optional(),
  NEXT_PUBLIC_BUNDLER_RPC_OPTIMISM: z.string().optional(),
  NEXT_PUBLIC_BUNDLER_RPC_POLYGON: z.string().optional(),
  NEXT_PUBLIC_ARBITRUM_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_OPTIMISM_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_POLYGON_RPC_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  • ${i.path.join(".") || "(env)"}: ${i.message}`)
    .join("\n");
  throw new Error(
    `Invalid environment — set these in .env (see .env.example) before building or running:\n${details}\n`,
  );
}

/** Validated, typed environment. Server-side only. */
export const env = parsed.data;
