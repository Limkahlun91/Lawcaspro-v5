import { clearTenantContext, makeRlsDb, pool, setFounderContext } from "@workspace/db";
import { logger } from "./logger";

export type AuthSafeDbContext = {
  route?: string;
  stage?: string;
  reqId?: unknown;
  firmId?: number | null;
  userId?: number | null;
  emailHash?: string;
};

type TransientDbErrorKind =
  | "connection_timeout"
  | "connection_terminated"
  | "socket_reset"
  | "pool_timeout"
  | "unknown";

function classifyTransientDbConnectionError(err: unknown): TransientDbErrorKind | null {
  const code = (() => {
    if (!err || typeof err !== "object") return undefined;
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  })();
  if (code) {
    const loweredCode = code.toLowerCase();
    if (loweredCode === "etimedout" || loweredCode === "econnrefused" || loweredCode === "ehostunreach") {
      return "connection_timeout";
    }
    if (loweredCode === "econnreset" || loweredCode === "epipe") {
      return "socket_reset";
    }
    if (loweredCode === "08000" || loweredCode === "08003" || loweredCode === "08006" || loweredCode === "57p01" || loweredCode === "57p02" || loweredCode === "57p03") {
      return "connection_terminated";
    }
  }

  const message = err instanceof Error ? err.message : String(err ?? "");
  const lowered = message.toLowerCase();

  if (lowered.includes("connection terminated due to connection timeout") || lowered.includes("connect timeout") || lowered.includes("connection timeout")) {
    return "connection_timeout";
  }
  if (
    lowered.includes("connection terminated unexpectedly") ||
    lowered.includes("server closed the connection unexpectedly") ||
    lowered.includes("terminating connection due to administrator command") ||
    lowered.includes("connection ended unexpectedly") ||
    lowered.includes("client was closed and is not queryable") ||
    lowered.includes("connection terminated") ||
    lowered.includes("connection ended")
  ) {
    return "connection_terminated";
  }
  if (
    lowered.includes("socket hang up") ||
    lowered.includes("econnreset") ||
    lowered.includes("econnrefused") ||
    lowered.includes("etimedout") ||
    lowered.includes("broken pipe") ||
    lowered.includes("epipe")
  ) {
    return "socket_reset";
  }
  if (lowered.includes("timeout exceeded when trying to connect") || lowered.includes("pool") && lowered.includes("timeout")) {
    return "pool_timeout";
  }
  return null;
}

export function isTransientDbConnectionError(err: unknown): boolean {
  return classifyTransientDbConnectionError(err) !== null;
}

async function runWithAuthSafeDbOnce<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
  ctx?: AuthSafeDbContext,
  allowUnsafe?: boolean,
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query("BEGIN");
    if (allowUnsafe) {
      try {
        await setFounderContext(client);
      } catch (err) {
        const errMessageShort =
          err instanceof Error ? err.message.slice(0, 180) : String(err ?? "").slice(0, 180);
        logger.error(
          { ...ctx, stage: "set_founder_context", errMessageShort, err },
          "auth-safe-db.founder_context_failed",
        );
        try {
          await client.query("SET LOCAL app.is_founder = 'true'");
          await client.query("SET LOCAL app.current_firm_id = '0'");
          await client.query("SET LOCAL app.current_user_id = '0'");
        } catch {
        }
      }
    } else {
      await setFounderContext(client);
    }
    const authDb = makeRlsDb(client);
    const result = await fn(authDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    destroyClient = isTransientDbConnectionError(err);
    try {
      await client.query("ROLLBACK");
    } catch {
      destroyClient = true;
    }
    const kind = classifyTransientDbConnectionError(err) ?? "unknown";
    if (destroyClient) {
      logger.warn({ ...ctx, err, kind }, "auth-safe-db.destroying_client_due_to_error");
    }
    throw err;
  } finally {
    try {
      await clearTenantContext(client);
    } catch {
    }
    client.release(destroyClient);
  }
}

export async function withAuthSafeDb<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
  opts?: { retry?: boolean; maxRetries?: number; ctx?: AuthSafeDbContext; allowUnsafe?: boolean },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? (opts?.retry ? 1 : 0);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
    const startedAt = Date.now();
    try {
      return await runWithAuthSafeDbOnce(fn, opts?.ctx, opts?.allowUnsafe);
    } catch (err) {
      lastErr = err;
      const kind = classifyTransientDbConnectionError(err) ?? "unknown";
      const shouldRetry = isTransientDbConnectionError(err) && attempt <= maxRetries;
      if (!shouldRetry) throw err;
      logger.warn({ ...opts?.ctx, err, kind, attempt, ms: Date.now() - startedAt }, "auth-safe-db.attempt_failed");
    }
  }

  throw lastErr;
}
