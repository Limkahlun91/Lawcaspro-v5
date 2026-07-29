import { createPoolFromDatabaseUrl, makeRlsDb, type Pool, clearTenantContext, setFounderContextSession } from "@workspace/db";
import { logger } from "./logger.js";

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

let cached: { url: string; pool: Pool } | null = null;

function getAuthAdminPoolOrThrow(): Pool {
  const url = getAuthAdminDatabaseUrl();
  if (!url) {
    const e = new Error("AUTH_DATABASE_URL/ADMIN_DATABASE_URL is not configured") as AuthAdminDbNotConfiguredError;
    e.code = "AUTH_ADMIN_DB_NOT_CONFIGURED";
    throw e;
  }
  if (cached?.url === url) return cached.pool;
  const pool = createPoolFromDatabaseUrl(url);
  cached = { url, pool };
  return pool;
}

export async function withAuthAdminDb<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
  ctx?: { stage?: string; route?: string; reqId?: string | null },
): Promise<T> {
  const pool = getAuthAdminPoolOrThrow();
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await setFounderContextSession(client);
    const adminDb = makeRlsDb(client);
    const result = await fn(adminDb);
    return result;
  } catch (err) {
    destroyClient = true;
    logger.error({ ...ctx, err }, "auth-admin-db.query_failed");
    throw err;
  } finally {
    try {
      await clearTenantContext(client);
    } catch {
      destroyClient = true;
    }
    client.release(destroyClient);
  }
}
