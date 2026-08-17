import { getOrCreateSharedPool, makeRlsDb, type Pool, clearTenantContext } from "@workspace/db";
import { logger } from "./logger.js";
import { extractDbErrorInfo } from "./db-error.js";

export type AuthAdminDbNotConfiguredError = Error & { code: "AUTH_ADMIN_DB_NOT_CONFIGURED" };

function getAuthAdminDatabaseUrl(): string | null {
  const raw =
    (typeof process.env.AUTH_DATABASE_URL === "string" ? process.env.AUTH_DATABASE_URL : "") ||
    (typeof process.env.ADMIN_DATABASE_URL === "string" ? process.env.ADMIN_DATABASE_URL : "");
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function isAuthAdminDbConfigured(): boolean {
  return Boolean(getAuthAdminDatabaseUrl());
}

function getAuthAdminPoolOrThrow(): Pool {
  const url = getAuthAdminDatabaseUrl();
  if (!url) {
    const e = new Error("AUTH_DATABASE_URL/ADMIN_DATABASE_URL is not configured") as AuthAdminDbNotConfiguredError;
    e.code = "AUTH_ADMIN_DB_NOT_CONFIGURED";
    throw e;
  }
  return getOrCreateSharedPool(url);
}

export async function withAuthAdminDb<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
  ctx?: { stage?: string; route?: string; reqId?: string | null },
): Promise<T> {
  const pool = getAuthAdminPoolOrThrow();
  const connectStartedAt = Date.now();
  const client = await pool.connect();
  const connectMs = Date.now() - connectStartedAt;
  if (connectMs > 250) {
    logger.warn(
      {
        ...ctx,
        connectMs,
        poolTotal: typeof (pool as any)?.totalCount === "number" ? (pool as any).totalCount : null,
        poolIdle: typeof (pool as any)?.idleCount === "number" ? (pool as any).idleCount : null,
        poolWaiting: typeof (pool as any)?.waitingCount === "number" ? (pool as any).waitingCount : null,
      },
      "auth-admin-db.pool_connect_slow",
    );
  }
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.is_founder = 'true'");
    await client.query("SET LOCAL app.current_firm_id = '0'");
    await client.query("SET LOCAL app.firm_id = '0'");
    await client.query("SET LOCAL app.current_user_id = '0'");
    const adminDb = makeRlsDb(client);
    const result = await fn(adminDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    destroyClient = true;
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    const info = extractDbErrorInfo(err);
    const sqlState = info.sqlstate ?? info.sqlState;
    const errMessageShort =
      err instanceof Error ? err.message.slice(0, 180) : typeof info.message === "string" ? info.message.slice(0, 180) : String(err ?? "").slice(0, 180);
    if (sqlState === "28P01") {
      logger.error({ ...ctx, safeCategory: "INVALID_DB_CREDENTIALS" }, "auth-admin-db.query_failed");
    } else {
      logger.error({ ...ctx, sqlState: sqlState ?? null, errMessageShort }, "auth-admin-db.query_failed");
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
