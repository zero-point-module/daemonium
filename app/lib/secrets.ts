/**
 * Per-user secret store — SCAFFOLD, NOT SECURE YET.
 *
 * Holds small per-user secrets — later, the OAuth refresh tokens for email/calendar connectors.
 * Right now it writes values in PLAINTEXT via `kv.ts` (Redis or the local `.daemon` file). That is
 * fine for a scaffold/demo, but it MUST NOT hold real third-party credentials in production.
 *
 * The seam is the put/get interface below. Before connecting a real account, swap the insides for
 * envelope encryption (a KMS-wrapped data key) or a dedicated secrets manager — callers unchanged.
 *
 * Note: revoking a secret (delete) needs a hash-field delete that `kv.ts` doesn't expose yet; it
 * lands with the encryption hardening, not in this scaffold.
 */
import "server-only";
import { kvGet, kvSet } from "./kv";

const NS = "secrets";

// ⚠️ SCAFFOLD: plaintext at rest. Do not store real credentials until this is encrypted.
// `name` is expected to be a trusted constant (e.g. "gmail.refresh_token"); guard the ":" delimiter
// so a stray/crafted name can't collide with another user's field by smuggling a userId boundary.
const field = (userId: string, name: string) => {
  if (name.includes(":")) throw new Error(`secret name must not contain ':' (got "${name}")`);
  return `${userId}:${name}`;
};

/** Store a secret for a user under a name (e.g. "gmail.refresh_token"). Overwrites any existing. */
export function putSecret(userId: string, name: string, value: string): Promise<void> {
  return kvSet(NS, field(userId, name), value);
}

/** Read a secret, or undefined if it isn't set. */
export function getSecret(userId: string, name: string): Promise<string | undefined> {
  return kvGet<string>(NS, field(userId, name));
}
