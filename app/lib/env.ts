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
  OPENAI_API_KEY: required, //          voice — /api/tts + /api/stt
  AI_GATEWAY_API_KEY: required, //      the agent — Claude via the Vercel AI Gateway
  DYNAMIC_ENVIRONMENT_ID: required, //  auth (JWKS) + server MPC wallets
  DYNAMIC_API_TOKEN: required, //       server-wallet API client
  DAEMON_WALLET_PASSWORD: required, //  decrypts the wallets' MPC key shares

  // --- Optional: these have safe defaults in chain.ts / log.ts / minter.ts. ---
  SEPOLIA_RPC_URL: z.string().optional(),
  ENS_PARENT_NAME: z.string().optional(),
  APP_BASE_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  MINTER_WALLET: z.string().optional(),

  // --- Optional, client-exposed (fallbacks live in app/providers.tsx). ---
  NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID: z.string().optional(),
  NEXT_PUBLIC_SEPOLIA_RPC_URL: z.string().optional(),
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
