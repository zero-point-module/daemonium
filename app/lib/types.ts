/**
 * The seam between Workstream A (flame/animation) and Workstream B (agent/onchain).
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
export type DaemonAction = "send_usdc" | "send_eth" | "swap" | "spawn_subagent";

/** Per-action detail payloads shown on the confirm card (human-readable). */
export interface SendUsdcDetails {
  to: string;
  /** Whole USDC amount as a string, e.g. "1.5". */
  amount: string;
  /** Optional resolved ENS name for `to`. */
  toEns?: string;
}
export interface SendEthDetails {
  to: string;
  /** ETH amount as a string, e.g. "0.01". */
  amount: string;
  /** Optional resolved ENS name for `to`. */
  toEns?: string;
}
export interface SwapDetails {
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

/** Recursive identity tree. Ignis is the root; sub-agents nest under it. */
export interface DaemonIdentity {
  /** Short handle, e.g. "ignis". */
  label: string;
  /** ENS name, e.g. "ignis.daemonium.eth". */
  ensName: string;
  /** The agent's own server-wallet address — the agent *is* this wallet. */
  address: string;
  /** ERC-8004 token id, once registered. */
  agentId?: string;
  /** URL serving the ERC-8004 agent card JSON. */
  agentCardUri?: string;
  parent?: string; // parent label
  children: string[]; // child labels
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

/** POST /api/tts — body. Returns an audio stream to pipe into an AnalyserNode. */
export interface TtsRequest {
  text: string;
  voice?: string; // default "nova"
}

/** Request body for the confirm tap → POST /api/daemon/execute. */
export interface ExecuteRequest {
  executionId: string;
}
export interface ExecuteResponse {
  ok: boolean;
  hash?: string;
  error?: string;
}
