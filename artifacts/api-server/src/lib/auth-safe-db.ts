import { makeRlsDb, pool, setFounderContext } from "@workspace/db";
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
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query("BEGIN");
    await setFounderContext(client);
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
    client.release(destroyClient);
  }
}

export async function withAuthSafeDb<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
  opts?: { retry?: boolean; ctx?: AuthSafeDbContext },
): Promise<T> {
  const attempt1StartedAt = Date.now();
  try {
    return await runWithAuthSafeDbOnce(fn, opts?.ctx);
  } catch (err) {
    const kind = classifyTransientDbConnectionError(err) ?? "unknown";
    if (isTransientDbConnectionError(err)) {
      logger.warn(
        { ...opts?.ctx, err, kind, attempt: 1, ms: Date.now() - attempt1StartedAt },
        "auth-safe-db.first_attempt_failed",
      );
    }

    if (!isTransientDbConnectionError(err) || !opts?.retry) throw err;

    logger.warn({ ...opts?.ctx, err, kind, retryCount: 1 }, "auth-safe-db.retrying_transient_connection_error");
    logger.warn({ ...opts?.ctx, err, kind, retryCount: 1 }, "auth-safe-db.retry_started");

    const attempt2StartedAt = Date.now();
    try {
      const result = await runWithAuthSafeDbOnce(fn, opts?.ctx);
      logger.info({ ...opts?.ctx, kind, retryCount: 1, ms: Date.now() - attempt2StartedAt }, "auth-safe-db.retry_success");
      return result;
    } catch (err2) {
      logger.error(
        { ...opts?.ctx, err: err2, firstErr: err, kind, retryCount: 1, ms: Date.now() - attempt2StartedAt },
        "auth-safe-db.retry_failed",
      );
      throw err2;
    }
  }
}
