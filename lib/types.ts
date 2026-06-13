/**
 * Daemonium — shared contract (the "seam")
 * ------------------------------------------------------------------
 * This file is the ONLY coupling point between the two halves of the app.
 *
 *   Interface/animation: consumes DaemonEvent, renders the flame + confirm
 *     card, calls the routes, develops against mockAgentRun().
 *   Agentic logic: emits DaemonEvent from the agent loop, implements the
 *     routes, fills in the real onchain calls.
 *
 * Rule: freeze the shapes below FIRST. Build against them in parallel.
 * Change them only by mutual agreement, in this file, never ad hoc.
 * ------------------------------------------------------------------
 */

/* =================================================================
 * 1. IDENTITY MODEL  (recursive — encodes the orchestration cluster)
 * =================================================================
 *
 * The cluster IS the ENS subname subtree. Ignis is the orchestrator:
 *   ignis.daemonium.eth
 *     └─ research.ignis.daemonium.eth   (sub-agent Ignis spawned/controls)
 *
 * Each agent — parent or child — is a real onchain identity:
 *   - its own ENS name (nested subname = position in the org chart)
 *   - its own ERC-8004 agentId (ERC-721 in the Identity Registry)
 *   - its own agent card (served at /.well-known/agent-card.json style URI)
 *
 * `parent` is what makes it a tree. null = root orchestrator (Ignis).
 * "Trusted / allowed interaction" = "same subtree" = shares a root ensName.
 */

/** ERC-8004 registration file ("agent card"). Shape follows the spec's
 *  registration-v1: type/name/description/image/endpoints. We add a small
 *  `daemonium` block for our own metadata (kept outside the standard fields
 *  so the card stays valid for generic 8004 / NFT tooling). */
export interface AgentCard {
  type: string; // e.g. "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
  name: string; // human-readable, e.g. "Ignis"
  description: string; // MAY include capabilities / pricing
  image: string; // avatar URL (the flame art)
  endpoints: AgentEndpoint[];
  daemonium?: {
    role: AgentRole;
    parentEnsName: string | null; // mirrors DaemonIdentity.parent for off-chain readers
  };
}

export interface AgentEndpoint {
  name: string; // "A2A" | "MCP" | "web" | ...
  endpoint: string; // URL or URI
  version?: string;
}

export type AgentRole = 'orchestrator' | 'subagent';

/** A live agent's identity as the app holds it. Recursive via `parent`. */
export interface DaemonIdentity {
  ensName: string; // "ignis.daemonium.eth" | "research.ignis.daemonium.eth"
  agentId: string; // ERC-8004 ERC-721 tokenId (stringified)
  agentCardUri: string; // tokenURI -> the AgentCard JSON
  walletAddress: string; // the agent's own wallet (Dynamic)
  role: AgentRole;
  parent: string | null; // parent ensName, null for the root orchestrator
}

/* =================================================================
 * 2. EVENT PROTOCOL  (agent loop  ->  flame / UI)
 * =================================================================
 *
 * Server emits an ordered stream of these (SSE). The frontend state
 * machine + UI consume them. This is the heartbeat of the app.
 *
 * Why our own events instead of the raw model/SDK stream parts: the flame
 * must not be coupled to SDK internals. The agent loop translates its
 * tool-call lifecycle into these event kinds; if the model or SDK changes,
 * the flame doesn't care.
 */

export type DaemonState =
  | 'idle' // breathing, orange
  | 'listening' // attentive, green        (mic open)
  | 'thinking' // swirling, blue          (model working)
  | 'delegating' // consulting a sub-agent  (orchestration in progress)
  | 'executing' // acting onchain, blue    (after a confirm tap)
  | 'success' // bright-green flare
  | 'error'; // red shift

export type DaemonEvent =
  /** Flame phase change. Frontend maps -> PNG + hue + distortion + particles. */
  | { kind: 'state'; state: DaemonState; label?: string } // label e.g. "consulting research…"

  /** Agent wants to be heard. Frontend calls TTS + drives the flame mouth. */
  | { kind: 'speak'; text: string }

  /** Agent wants to do something that needs the human gate. Frontend raises
   *  the confirm card and WAITS. Agent does NOT proceed on its own. */
  | { kind: 'proposal'; card: ProposalCard }

  /** Result of an executed action (after the user confirmed). Drives the
   *  success/error flare + a spoken confirmation. */
  | {
      kind: 'txResult';
      executionId: string;
      ok: boolean;
      hash?: string;
      error?: string;
    }

  /** A sub-agent produced a result that Ignis is about to relay. Optional
   *  UI hook (e.g. show which child reported). Speaking still comes via `speak`. */
  | { kind: 'subagentResult'; childEnsName: string; summary: string }

  /** Stream finished for this turn. Frontend returns flame to idle. */
  | { kind: 'done' };

/* =================================================================
 * 3. PROPOSAL CARD  (the human-confirmation contract)
 * =================================================================
 *
 * The agent PROPOSES with this object; the frontend RENDERS it; only a
 * tap sends `executionId` to /api/execute. The proposing tool never
 * touches chain state. This object is the entire confirm-before-act gate.
 */

export type ProposalAction =
  | 'send_usdc'
  | 'register_subname'
  | 'spawn_subagent';

export interface ProposalCard {
  executionId: string; // opaque id; echoed back on confirm. The pending
  // action is held server-side keyed by this id.
  action: ProposalAction;
  summary: string; // human sentence: "Send 2 USDC to alejandro.eth"
  details: ProposalDetails;
}

/** Discriminated by ProposalCard.action. Keep each minimal + display-ready. */
export type ProposalDetails =
  | {
      action: 'send_usdc';
      recipientName: string | null; // "alejandro.eth" or null if raw address
      recipientAddress: string; // resolved 0x... (resolution done at propose time)
      amount: string; // human units, e.g. "2" (USDC)
    }
  | {
      action: 'register_subname';
      label: string; // "research"
      fullName: string; // "research.ignis.daemonium.eth"
      parentEnsName: string; // "ignis.daemonium.eth"
    }
  | {
      action: 'spawn_subagent'; // orchestration: create a child identity
      label: string; // "research"
      fullName: string; // "research.ignis.daemonium.eth"
      purpose: string; // what this sub-agent is for
    };

/* =================================================================
 * 4. ROUTE SIGNATURES  (client <-> server)
 * =================================================================
 *
 * Build against these with mocks before they exist. /api/execute is the
 * ONLY route that mutates chain state, and only after a confirm tap.
 */

/** POST /api/agent  — body. Returns: SSE stream of DaemonEvent. */
export interface AgentRequest {
  text: string; // the user's transcribed utterance
  // (auth/session handled by Dynamic + cookies; no secrets in the body)
}

/** POST /api/stt — body: multipart/form-data with the audio blob.
 *  iOS Safari note: blob is usually audio/mp4 — do NOT hardcode webm. */
export interface SttResponse {
  text: string;
}

/** POST /api/tts — body. Returns: audio stream (pipe into AnalyserNode). */
export interface TtsRequest {
  text: string;
  voice?: string; // default "nova"
}

/** POST /api/execute — body. Returns: TxResult.
 *  Fires only after the user taps Confirm. Spending cap enforced here. */
export interface ExecuteRequest {
  executionId: string; // from the ProposalCard the user confirmed
}

export interface TxResult {
  executionId: string;
  ok: boolean;
  hash?: string;
  error?: string;
}

/* =================================================================
 * 5. SAFETY CONSTANTS
 * =================================================================*/

export const MAX_USDC_PER_TX = 10; // hard cap, enforced in /api/execute
export const CONFIRM_REQUIRED_DEFAULT = true; // the human gate, default-on

/* =================================================================
 * 6. MOCK AGENT RUN  (the flame is developed against this)
 * =================================================================
 *
 * Emits a scripted DaemonEvent sequence with realistic delays, so the
 * whole flame + voice + card experience can be built BEFORE /api/agent
 * is real. Swap mockAgentRun() for the SSE consumer at integration.
 *
 * Usage (frontend):
 *   for await (const ev of mockAgentRun("send 2 usdc to alejandro.eth")) {
 *     applyEvent(ev);  // your state machine
 *   }
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function* mockAgentRun(text: string): AsyncGenerator<DaemonEvent> {
  yield { kind: 'state', state: 'thinking' };
  await wait(900);

  const t = text.toLowerCase();

  // --- send flow ---
  if (t.includes('send')) {
    yield { kind: 'speak', text: 'Let me prepare that transfer for you.' };
    await wait(600);
    yield {
      kind: 'proposal',
      card: {
        executionId: 'mock-exec-001',
        action: 'send_usdc',
        summary: 'Send 2 USDC to alejandro.eth',
        details: {
          action: 'send_usdc',
          recipientName: 'alejandro.eth',
          recipientAddress: '0x1111111111111111111111111111111111111111',
          amount: '2',
        },
      },
    };
    // frontend now waits for a confirm tap -> calls /api/execute (mocked).
    return;
  }

  // --- orchestration / sub-agent flow ---
  if (t.includes('research') || t.includes('delegate')) {
    yield { kind: 'state', state: 'delegating', label: 'consulting research…' };
    await wait(1400);
    yield {
      kind: 'subagentResult',
      childEnsName: 'research.ignis.daemonium.eth',
      summary: 'Found 3 relevant items; sentiment mixed.',
    };
    await wait(300);
    yield {
      kind: 'speak',
      text: 'My research dæmon looked into it. Sentiment is mixed across three sources.',
    };
    await wait(400);
    yield { kind: 'done' };
    return;
  }

  // --- balance / status flow ---
  yield {
    kind: 'speak',
    text: "You're holding 12 USDC and a little test ETH. All quiet onchain.",
  };
  await wait(400);
  yield { kind: 'state', state: 'idle' };
  yield { kind: 'done' };
}

/** Mock for the confirm tap -> execute path. */
export async function mockExecute(req: ExecuteRequest): Promise<TxResult> {
  await wait(1200);
  return { executionId: req.executionId, ok: true, hash: '0xdeadbeef' };
}
