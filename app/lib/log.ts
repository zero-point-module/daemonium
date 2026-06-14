/**
 * Tiny structured logger for the server. The app had almost no server-side visibility;
 * this gives every route and lib a consistent, greppable line — timestamp, level, a
 * scope, and an optional per-request trace id. It writes to the console, which `next dev`
 * shows in the terminal locally and the hosting platform captures as function logs in
 * prod. No external service, no dependency.
 *
 * Secrets never get logged: any field whose key looks like a credential (authorization,
 * token, private key, …) is redacted, so passing a whole request/headers/body object
 * here is safe. Errors are expanded to { name, message, stack }.
 *
 * Verbosity: LOG_LEVEL env wins (debug|info|warn|error); otherwise debug in dev, info in prod.
 */
import "server-only";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const THRESHOLD =
  ORDER[(process.env.LOG_LEVEL as LogLevel)] ??
  (process.env.NODE_ENV === "production" ? ORDER.info : ORDER.debug);

const SECRET_KEY =
  /(authorization|cookie|api[-_]?key|secret|token|jwt|private[-_]?key|password|passphrase|mnemonic|seed|shares?|metadata)/i;

/** Strip obviously-sensitive values and expand Errors before anything reaches a log sink. */
function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  // Guard against runaway/cyclic structures — but DON'T return the raw value at the cap,
  // that would leak an unredacted secret nested deep. Truncate instead.
  if (depth > 6) return "[truncated]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const SINK: Record<LogLevel, (...a: unknown[]) => void> = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

export interface Logger {
  debug: (msg: string, fields?: unknown) => void;
  info: (msg: string, fields?: unknown) => void;
  warn: (msg: string, fields?: unknown) => void;
  error: (msg: string, fields?: unknown) => void;
  /** A nested logger, e.g. createLogger("agent").child("tools") → scope "agent:tools". */
  child: (sub: string) => Logger;
}

export function createLogger(scope: string, traceId?: string): Logger {
  const tag = traceId ? `${scope}#${traceId}` : scope;
  const at =
    (level: LogLevel) =>
    (msg: string, fields?: unknown): void => {
      if (ORDER[level] < THRESHOLD) return;
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
      if (fields === undefined) SINK[level](line);
      else SINK[level](line, redact(fields));
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (sub) => createLogger(`${scope}:${sub}`, traceId),
  };
}
