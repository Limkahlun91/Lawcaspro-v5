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
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lowered = message.toLowerCase();

  if (lowered.includes("connection terminated due to connection timeout") || lowered.includes("connect timeout") || lowered.includes("connection timeout")) {
    return "connection_timeout";
  }
  if (
    lowered.includes("connection terminated unexpectedly") ||
    lowered.includes("server closed the connection unexpectedly") ||
    lowered.includes("terminating connection due to administrator command") ||
    lowered.includes("connection ended unexpectedly")
  ) {
    return "connection_terminated";
  }
  if (lowered.includes("socket hang up") || lowered.includes("econnreset") || lowered.includes("ecconnreset") || lowered.includes("econnrefused")) {
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
  try {
    return await runWithAuthSafeDbOnce(fn, opts?.ctx);
  } catch (err) {
    if (!isTransientDbConnectionError(err) || !opts?.retry) {
      throw err;
    }

    const kind = classifyTransientDbConnectionError(err) ?? "unknown";
    logger.warn({ ...opts?.ctx, err, kind, retryCount: 1 }, "auth-safe-db.retrying_transient_connection_error");
    return await runWithAuthSafeDbOnce(fn, opts?.ctx);
  }
}
