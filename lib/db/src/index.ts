import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const allowMissingDatabaseUrl =
  process.env.NODE_ENV === "test" && process.env.VITEST_SKIP_DB === "1";
if (!process.env.DATABASE_URL && !allowMissingDatabaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const rawConnectTimeoutMs = process.env.PG_CONNECT_TIMEOUT_MS;
const connectTimeoutMs =
  rawConnectTimeoutMs && !Number.isNaN(Number(rawConnectTimeoutMs))
    ? Number(rawConnectTimeoutMs)
    : 10_000;

const rawPoolMax = process.env.PG_POOL_MAX;
const poolMax =
  rawPoolMax && !Number.isNaN(Number(rawPoolMax)) && Number(rawPoolMax) > 0
    ? Number(rawPoolMax)
    : undefined;

const rawIdleTimeoutMs = process.env.PG_IDLE_TIMEOUT_MS;
const idleTimeoutMs =
  rawIdleTimeoutMs && !Number.isNaN(Number(rawIdleTimeoutMs)) && Number(rawIdleTimeoutMs) >= 0
    ? Number(rawIdleTimeoutMs)
    : 30_000;

const rawKeepAlive = process.env.PG_KEEPALIVE;
const keepAlive =
  rawKeepAlive && (rawKeepAlive === "0" || rawKeepAlive.toLowerCase() === "false")
    ? false
    : true;

const rawKeepAliveDelayMs = process.env.PG_KEEPALIVE_DELAY_MS;
const keepAliveDelayMs =
  rawKeepAliveDelayMs && !Number.isNaN(Number(rawKeepAliveDelayMs)) && Number(rawKeepAliveDelayMs) >= 0
    ? Number(rawKeepAliveDelayMs)
    : 10_000;

const isSupabasePoolerDatabaseUrl = (databaseUrl: string): boolean =>
  databaseUrl.toLowerCase().includes("pooler.supabase.com");

const stripSslmodeFromDatabaseUrl = (
  databaseUrl: string,
): { url: string; hadSslmode: boolean } => {
  const [beforeHash, hash] = databaseUrl.split("#", 2);
  const [base, query] = beforeHash.split("?", 2);
  if (!query) return { url: databaseUrl, hadSslmode: false };

  let hadSslmode = false;
  const filtered = query
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const eq = part.indexOf("=");
      const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
      if (key === "sslmode") hadSslmode = true;
      return key !== "sslmode";
    });

  const rebuilt = filtered.length ? `${base}?${filtered.join("&")}` : base;
  return { url: hash ? `${rebuilt}#${hash}` : rebuilt, hadSslmode };
};

const normalizeSupabaseDatabaseUrlHost = (databaseUrl: string): string => {
  try {
    const u = new URL(databaseUrl);
    const hostname = u.hostname.toLowerCase();
    if (hostname.endsWith(".supabase.co") || hostname.endsWith(".supabase.com")) return databaseUrl;

    const supabaseUrl = process.env.SUPABASE_URL;
    const suffixFromSupabaseUrl = (() => {
      if (!supabaseUrl) return null;
      try {
        const supaHost = new URL(supabaseUrl).hostname.toLowerCase();
        if (supaHost.endsWith(".supabase.co")) return ".supabase.co";
        if (supaHost.endsWith(".supabase.com")) return ".supabase.com";
      } catch {
      }
      return null;
    })();

    const isTruncatedSupabaseHost = (() => {
      const parts = hostname.split(".").filter(Boolean);
      if (parts.length !== 2) return false;
      const [prefix, ref] = parts;
      if (prefix !== "postgres" && prefix !== "db") return false;
      return /^[a-z0-9]{10,}$/i.test(ref);
    })();

    const suffix = suffixFromSupabaseUrl ?? (isTruncatedSupabaseHost ? ".supabase.co" : null);
    if (!suffix) return databaseUrl;

    if (isTruncatedSupabaseHost) {
      u.hostname = `${hostname}${suffix}`;
      return u.toString();
    }
  } catch {
  }
  return databaseUrl;
};

const databaseUrl = normalizeSupabaseDatabaseUrlHost(
  process.env.DATABASE_URL ?? "postgres://127.0.0.1:1/postgres",
);
const isPooler = isSupabasePoolerDatabaseUrl(databaseUrl);
const loweredDatabaseUrl = databaseUrl.toLowerCase();
const stripped = stripSslmodeFromDatabaseUrl(databaseUrl);
const shouldUseSsl =
  isPooler || stripped.hadSslmode || loweredDatabaseUrl.includes("supabase.co") || loweredDatabaseUrl.includes("supabase.com");

export const pool = new Pool({
  connectionString: stripped.url,
  connectionTimeoutMillis: connectTimeoutMs,
  idleTimeoutMillis: idleTimeoutMs,
  ...(poolMax ? { max: poolMax } : {}),
  ...(keepAlive ? { keepAlive: true, keepAliveInitialDelayMillis: keepAliveDelayMs } : {}),
  ...(shouldUseSsl ? (isPooler ? { ssl: { rejectUnauthorized: false } } : { ssl: true }) : {}),
});
export const db = drizzle(pool, { schema });

export { schema };
export type AppDb = typeof db;

export * from "./schema";
export * from "./tenant-context";
export type { RlsDb } from "./tenant-context";
export { auditLogsTable } from "./schema";

export {
  clearTenantContext,
  makeRlsDb,
  assertSafeRlsRole,
  setFounderContextSession,
  setTenantContextSession,
} from "./tenant-context";

export {
  firmsTable,
  permissionsTable,
  rolesTable,
  sessionsTable,
  usersTable,
} from "./schema";

export {
  casesTable,
  casePurchasersTable,
  caseAssignmentsTable,
  caseWorkflowStepsTable,
  caseNotesTable,
  caseKeyDatesTable,
  caseListSavedViewsTable,
  systemFoldersTable,
  platformDocumentsTable,
  platformClausesTable,
  platformMessagesTable,
  platformMessageAttachmentsTable,
} from "./schema";

export { developersTable, projectsTable, clientsTable } from "./schema";

export { caseWorkflowDocumentsTable, caseLoanStampingItemsTable } from "./schema";

export { sql } from "drizzle-orm";
export type { SQL } from "drizzle-orm";
