/**
 * The seam between the two halves of the app: the flame/animation frontend and the
 * agent/onchain backend.
 *
 * The agent backend emits a stream of `DaemonEvent`s (carried as ai-sdk `data-daemon`
 * parts); the flame consumes them. State-changing actions surface as a `ProposalCard`
 * that the UI renders as a human-confirm card; the only thing the confirm tap sends
 * back is the opaque `executionId`. Nothing here imports server-only code, so it is
 * safe to use from client components.
 */

/** What the flame is doing right now. Drives color/motion. */
export type DaemonState =
  | "idle"
  | "listening"
  | "thinking"
  | "delegating"
  | "executing"
  | "success"
  | "error";

/**
 * State-changing actions, each gated by a human confirmation. (Identity claiming is no longer
 * here — it's auto-provisioned at handle pick, see app/lib/provision.ts.)
 */
export type DaemonAction =
  | "send_usdc"
  | "send_eth"
  | "swap"
  | "spawn_subagent";

/** Per-action detail payloads shown on the confirm card (human-readable). */
interface SendUsdcDetails {
  to: string;
  /** Whole USDC amount as a string, e.g. "1.5". */
  amount: string;
  /** Optional resolved ENS name for `to`. */
  toEns?: string;
}
interface SendEthDetails {
  to: string;
  /** ETH amount as a string, e.g. "0.01". */
  amount: string;
  /** Optional resolved ENS name for `to`. */
  toEns?: string;
  /** Chain to send native ETH on (the dæmon may hold ETH on Ethereum and/or Base). */
  chainId: number;
  /** Display label for that chain, e.g. "Ethereum" or "Base". */
  chain: string;
}
interface SwapDetails {
  /** Token symbol the agent swaps FROM (e.g. "WETH"), on the swap chain. */
  fromSymbol: string;
  /** Token symbol the agent swaps TO (e.g. "ETH"). */
  toSymbol: string;
  /** Human amount of the from-token, e.g. "0.001". */
  amount: string;
}
export interface SpawnSubagentDetails {
  /** Proposed sub-agent local label, e.g. "research". */
  label: string;
  /** Full nested ENS name it will receive = its agent key. */
  childKey: string;
  /** Parent agent key (= ENS name) that spawns + owns the subtree. */
  parentKey: string;
  purpose: string;
}

export type ProposalDetails =
  | ({ action: "send_usdc" } & SendUsdcDetails)
  | ({ action: "send_eth" } & SendEthDetails)
  | ({ action: "swap" } & SwapDetails)
  | ({ action: "spawn_subagent" } & SpawnSubagentDetails);

/** A pending action awaiting human confirmation. */
export interface ProposalCard {
  /** Opaque id; the only thing the confirm tap returns to /api/daemon/execute. */
  executionId: string;
  action: DaemonAction;
  /** Which agent will act (its label, e.g. "ignis"). */
  agent: string;
  /** One-line human summary, e.g. "Send 1 USDC to research.ignis.daemonium.eth". */
  summary: string;
  details: ProposalDetails;
}

/**
 * ERC-8004 registration-v1 agent card (off-chain JSON the tokenURI resolves to).
 * `type` MUST be the exact spec URL. Our own metadata lives under `daemonium`.
 */
export interface AgentCard {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  image?: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{ agentId: string; agentRegistry: string }>;
  supportedTrust: string[];
  daemonium?: {
    label: string;
    parent?: string;
    children?: string[];
  };
}

/** Server→client event stream. Carried as ai-sdk `data-daemon` parts. */
export type DaemonEvent =
  | { type: "state"; state: DaemonState }
  | { type: "speak"; text: string }
  | { type: "proposal"; card: ProposalCard }
  | { type: "txResult"; executionId: string; ok: boolean; hash?: string; error?: string }
  | { type: "subagentResult"; agent: string; summary: string }
  | { type: "done" };

/** The custom data-part name used on the ai-sdk UI message stream. */
export const DAEMON_DATA_PART = "data-daemon" as const;

/** POST /api/tts — body. Returns JSON { audio (base64 mp3), words } (TtsResponse in lib/voice). */
export interface TtsRequest {
  text: string;
  voice?: string; // app voice id from lib/voices (default "alien-3")
}

/** Request body for the confirm tap → POST /api/daemon/execute. */
export interface ExecuteRequest {
  executionId: string;
}
export interface ExecuteResponse {
  ok: boolean;
  hash?: string;
  error?: string;
  /** Chain id the tx ran on, so the UI links to the right block explorer (Base vs L1). */
  chainId?: number;
}

/** One contract call in a UserOp the user's smart account will run. `value` is a decimal wei string
 *  (JSON-safe; the client parses it to bigint). */
interface PreparedCall {
  to: string;
  data: string;
  value: string;
}

/**
 * The confirm tap first calls POST /api/daemon/execute, which DECIDES how the action runs:
 *  • "server" — already executed on the server (an autonomous session key signed it, or a
 *    non-value action like spawn ran server-side). The outcome is returned inline.
 *  • "cosign" — the user must sign the UserOp themselves: the server returns the encoded `calls`
 *    (built from the stored proposal — never client input), the client co-signs with the embedded
 *    wallet and submits, then POSTs /api/daemon/execute/complete to record + consume the proposal.
 */
export type PrepareResponse =
  | { mode: "server"; ok: boolean; hash?: string; error?: string; chainId?: number }
  | { mode: "cosign"; executionId: string; calls: PreparedCall[]; chainId: number };
