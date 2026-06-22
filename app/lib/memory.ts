/**
 * Per-user memory — SCAFFOLD.
 *
 * A running, append-only log of things worth remembering, plus a dumb `recall`. Built on `kv.ts`
 * exactly like `wallet-store.ts` (Redis when REDIS_URL is set, else the gitignored `.daemon` file),
 * so it deploys with no extra infra.
 *
 * Intentionally simple — the point is the INTERFACE, not the insides:
 *   • storage is one JSON array per user (fine for hundreds of items, not millions)
 *   • `recall` is recency + case-insensitive substring match (a placeholder for embeddings)
 * Later we swap the insides for a real store with semantic search; `remember`/`recall` callers
 * don't change. Not for secrets (see `secrets.ts`). Not yet wired into the agent loop — that's Phase 1.
 */
import "server-only";
import { kvGet, kvSet } from "./kv";
import { withLock } from "./lock";

const NS = "memory";

/** One remembered thing. Keep it small and human-readable. */
export interface MemoryItem {
  /** ISO timestamp when it was remembered. */
  at: string;
  /** Loose category, e.g. "fact", "event", "preference", "interaction". */
  kind: string;
  /** The memory itself, in plain text. */
  text: string;
}

/**
 * Append a memory for a user. Read-modify-write under a per-user lock so concurrent appends can't
 * clobber each other — same approach as `wallet-store.appendChild` (process-local; a multi-instance
 * deploy would want an atomic list push, which the real store will provide).
 */
export function remember(userId: string, item: { kind: string; text: string }): Promise<void> {
  return withLock(`memory:${userId}`, async () => {
    const log = (await kvGet<MemoryItem[]>(NS, userId)) ?? [];
    log.push({ at: new Date().toISOString(), kind: item.kind, text: item.text });
    await kvSet(NS, userId, log);
  });
}

/**
 * Recall a user's memories, most-recent first.
 *   • no query  → the latest `limit` items
 *   • a query   → the latest `limit` items whose text loosely matches (substring, case-insensitive)
 * The substring match is the placeholder that real semantic search replaces behind this same signature.
 */
export async function recall(
  userId: string,
  opts: { query?: string; limit?: number } = {},
): Promise<MemoryItem[]> {
  const { query, limit = 10 } = opts;
  const log = (await kvGet<MemoryItem[]>(NS, userId)) ?? [];
  const matched = query
    ? log.filter((m) => m.text.toLowerCase().includes(query.toLowerCase()))
    : log;
  return matched.slice(-limit).reverse();
}
