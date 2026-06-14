/**
 * Per-user handles. The agent's ENS name is no longer derivable from the Dynamic userId — the
 * user CHOOSES a handle at first login, and we map `userId → handle`. Their dæmon IS
 * `<handle>.daemonium.eth` (minted directly under the parent), and sub-agents nest under it as
 * `<sub>.<handle>.daemonium.eth`. Handles are globally unique (first-come).
 *
 * Hackathon store: a gitignored JSON file. Production would use a DB with a unique index.
 */
import "server-only";
import { ENS_PARENT_NAME } from "./chain";
import { withLock } from "./lock";
import { kvGet, kvGetAll, kvSet } from "./kv";
import {
  normalizeHandle,
  validateHandle,
  HANDLE_ERROR_MESSAGE,
  type HandleError,
} from "./handle-format";

const NS = "handles"; // field = userId, value = handle

/** The dæmon's full ENS name (= its agent key everywhere): `<handle>.daemonium.eth`. */
export function ensNameForHandle(handle: string): string {
  return `${handle}.${ENS_PARENT_NAME}`;
}

export function getHandle(userId: string): Promise<string | undefined> {
  return kvGet<string>(NS, userId);
}

/** The user's agent key (= ENS name), or null if they haven't picked a handle yet. */
export async function resolveUserKey(userId: string): Promise<string | null> {
  const handle = await getHandle(userId);
  return handle ? ensNameForHandle(handle) : null;
}

type ClaimError = HandleError | "taken";

/**
 * Claim a handle for a user. Validates, enforces global uniqueness, and is idempotent: if the
 * user already has a handle, returns it unchanged (no rename in v1). The check-then-set runs
 * under a process lock so two users can't win the same handle (which would alias them to the
 * SAME dæmon wallet). `code` lets the route map invalid→400 vs taken/reserved→409.
 */
export async function claimHandle(
  userId: string,
  rawHandle: string,
): Promise<
  { ok: true; handle: string } | { ok: false; error: string; code: ClaimError }
> {
  const handle = normalizeHandle(rawHandle);
  const invalid = validateHandle(handle);
  if (invalid) return { ok: false, error: HANDLE_ERROR_MESSAGE[invalid], code: invalid };

  return withLock("handles", async () => {
    const store = await kvGetAll<string>(NS);
    const existing = store[userId];
    if (existing) return { ok: true as const, handle: existing };

    const takenBy = Object.entries(store).find(([uid, h]) => h === handle && uid !== userId);
    if (takenBy) {
      return { ok: false as const, error: "That handle is already taken.", code: "taken" as const };
    }

    await kvSet(NS, userId, handle);
    return { ok: true as const, handle };
  });
}
