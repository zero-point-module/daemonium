/**
 * Tiny namespaced key-value store. Each namespace is a Redis hash (field → JSON value).
 *
 * Backend is chosen at runtime:
 *   • If `REDIS_URL` is set (Vercel KV / any Redis), connect over it with ioredis. This is what
 *     makes the app work deployed — no writable filesystem needed.
 *   • Otherwise fall back to a gitignored JSON file under `.daemon/<ns>.json` for local dev.
 *
 * We deliberately store only small, non-sensitive app state here (the agent identity index +
 * userId→handle). Wallet key material is never stored — Dynamic holds the shares, and signable
 * `walletMetadata` is reconstructed from Dynamic at sign time (see dynamic-server.ts).
 */
import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Redis } from "ioredis";
import { withLock } from "./lock";

const REDIS_URL = process.env.REDIS_URL;
const useRedis = Boolean(REDIS_URL);

/** Which backend is active — surfaced for diagnostics. */
export function kvBackend(): "redis" | "file" {
  return useRedis ? "redis" : "file";
}

// Lazily-created, process-wide singleton (reused across warm serverless invocations). Created on
// first use (request time), never at import/build time. ioredis enables TLS automatically for
// rediss:// URLs and auto-reconnects.
let client: Redis | null = null;
function redis(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL!, {
      maxRetriesPerRequest: 3, // don't hang a request forever if Redis is unreachable
      enableAutoPipelining: true,
    });
  }
  return client;
}

const redisKey = (ns: string) => `daemon:${ns}`;

const STORE_DIR = path.join(process.cwd(), ".daemon");
const filePath = (ns: string) => path.join(STORE_DIR, `${ns}.json`);

async function readFileNs(ns: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath(ns), "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}
async function writeFileNs(ns: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(filePath(ns), JSON.stringify(data, null, 2), "utf8");
}

export async function kvGet<T>(ns: string, field: string): Promise<T | undefined> {
  if (useRedis) {
    const r = await redis().hget(redisKey(ns), field);
    return r == null ? undefined : (JSON.parse(r) as T);
  }
  return (await readFileNs(ns))[field] as T | undefined;
}

export async function kvGetAll<T>(ns: string): Promise<Record<string, T>> {
  if (useRedis) {
    const r = await redis().hgetall(redisKey(ns)); // {} when the key is missing
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(r)) out[k] = JSON.parse(v) as T;
    return out;
  }
  return (await readFileNs(ns)) as Record<string, T>;
}

export async function kvSet(ns: string, field: string, value: unknown): Promise<void> {
  if (useRedis) {
    await redis().hset(redisKey(ns), field, JSON.stringify(value));
    return;
  }
  await withLock(`kv:${ns}`, async () => {
    const data = await readFileNs(ns);
    data[field] = value;
    await writeFileNs(ns, data);
  });
}

export async function kvDel(ns: string, field: string): Promise<void> {
  if (useRedis) {
    await redis().hdel(redisKey(ns), field);
    return;
  }
  await withLock(`kv:${ns}`, async () => {
    const data = await readFileNs(ns);
    delete data[field];
    await writeFileNs(ns, data);
  });
}
