/**
 * Pending-execution store. Agent tools (B2) and the debug /propose route mint a
 * ProposalCard here; the confirm tap hands back only the executionId, and
 * /api/daemon/execute looks the validated payload up by id. Nothing state-changing is
 * ever driven by client-supplied amounts/addresses — only by what was stashed here.
 *
 * In-memory (single server process) — fine for the hackathon. A restart clears pending
 * proposals, which is the safe direction (you just re-ask).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { ProposalCard, ProposalDetails, DaemonAction } from "./types";

const pending = new Map<string, ProposalCard>();

export function createExecution(input: {
  action: DaemonAction;
  agent: string;
  summary: string;
  details: ProposalDetails;
}): ProposalCard {
  const executionId = randomUUID();
  const card: ProposalCard = { executionId, ...input };
  pending.set(executionId, card);
  return card;
}

/** Fetch and remove a pending execution (single-use). */
export function takeExecution(executionId: string): ProposalCard | undefined {
  const card = pending.get(executionId);
  if (card) pending.delete(executionId);
  return card;
}

export function peekExecution(executionId: string): ProposalCard | undefined {
  return pending.get(executionId);
}
