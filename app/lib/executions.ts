/**
 * Pending-execution store. Agent tools mint a ProposalCard here; the confirm tap hands back
 * only the executionId, and /api/daemon/execute looks the validated payload up by id. Nothing
 * state-changing is ever driven by client-supplied amounts/addresses — only by what was
 * stashed here. Each execution is bound to the userId that created it, so one user cannot
 * execute another user's proposal even with a leaked id.
 *
 * In-memory (single server process) — fine for the hackathon. A restart clears pending
 * proposals, which is the safe direction (you just re-ask).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { ProposalCard, ProposalDetails, DaemonAction } from "./types";

interface Entry {
  card: ProposalCard;
  userId: string;
}

const pending = new Map<string, Entry>();

export function createExecution(
  input: {
    action: DaemonAction;
    agent: string;
    summary: string;
    details: ProposalDetails;
  },
  userId: string,
): ProposalCard {
  const executionId = randomUUID();
  const card: ProposalCard = { executionId, ...input };
  pending.set(executionId, { card, userId });
  return card;
}

/** Look up a pending execution WITHOUT consuming it, so an unauthorized or losing-race tap can't
 *  burn a valid proposal before the caller has been checked. */
export function peekExecution(executionId: string): Entry | undefined {
  return pending.get(executionId);
}

/** Remove a pending execution (single-use). Call synchronously, after the owner check and right
 *  before running it, so a double-tap can't double-execute. */
export function consumeExecution(executionId: string): void {
  pending.delete(executionId);
}
