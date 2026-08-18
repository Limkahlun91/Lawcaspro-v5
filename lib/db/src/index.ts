import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

declare const globalThis: {
  __lawcasproDbPool?: pg.Pool;
  __lawcasproDrizzleDb?: ReturnType<typeof drizzle>;
  __lawcasproDbPoolRegistry?: Map<string, pg.Pool>;
};

const allowMissingDatabaseUrl =
  process.env.NODE_ENV === "test" && process.env.VITEST_SKIP_DB === "1";
if (!process.env.DATABASE_URL && !allowMissingDatabaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const isServerlessEnv =
  process.env.VERCEL === "1" ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
  process.env.NEXT_RUNTIME === "edge" ||
  process.env.FUNCTIONS_WORKER === "1";

const rawConnectTimeoutMs = process.env.PG_CONNECT_TIMEOUT_MS;
const connectTimeoutMs =
  rawConnectTimeoutMs && !Number.isNaN(Number(rawConnectTimeoutMs))
    ? Number(rawConnectTimeoutMs)
    : isServerlessEnv
      ? 4_000
      : 10_000;

const rawPoolMax = process.env.PG_POOL_MAX;
const poolMax =
  rawPoolMax && !Number.isNaN(Number(rawPoolMax)) && Number(rawPoolMax) > 0
    ? Number(rawPoolMax)
    : isServerlessEnv
      ? 5
      : undefined;

const rawIdleTimeoutMs = process.env.PG_IDLE_TIMEOUT_MS;
const idleTimeoutMs =
  rawIdleTimeoutMs && !Number.isNaN(Number(rawIdleTimeoutMs)) && Number(rawIdleTimeoutMs) >= 0
    ? Number(rawIdleTimeoutMs)
    : isServerlessEnv
      ? 3_000
      : 30_000;

const rawKeepAlive = process.env.PG_KEEPALIVE;
const keepAlive =
  rawKeepAlive && (rawKeepAlive === "0" || rawKeepAlive.toLowerCase() === "false")
    ? false
    : !isServerlessEnv;

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

type PoolOptions = ConstructorParameters<typeof Pool>[0];

function buildPoolOptions(
  strippedConnectionUrl: string,
  isPoolerFlag: boolean,
  loweredDatabaseUrlRaw: string,
  hadSslmodeFlag: boolean,
): PoolOptions {
  const shouldUseSsl =
    isPoolerFlag ||
    hadSslmodeFlag ||
    loweredDatabaseUrlRaw.includes("supabase.co") ||
    loweredDatabaseUrlRaw.includes("supabase.com");
  return {
    connectionString: strippedConnectionUrl,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
    ...(poolMax ? { max: poolMax } : {}),
    ...(keepAlive ? { keepAlive: true, keepAliveInitialDelayMillis: keepAliveDelayMs } : {}),
    ...(shouldUseSsl ? (isPoolerFlag ? { ssl: { rejectUnauthorized: false } } : { ssl: true }) : {}),
    allowExitOnIdle: isServerlessEnv ? true : undefined,
  };
}

const databaseUrl = process.env.DATABASE_URL ?? "postgres://127.0.0.1:1/postgres";
const isPooler = isSupabasePoolerDatabaseUrl(databaseUrl);
const loweredDatabaseUrl = databaseUrl.toLowerCase();
const stripped = stripSslmodeFromDatabaseUrl(databaseUrl);
const defaultPoolKey = stripped.url;

const poolRegistry: Map<string, pg.Pool> =
  globalThis.__lawcasproDbPoolRegistry ?? new Map<string, pg.Pool>();
globalThis.__lawcasproDbPoolRegistry = poolRegistry;

function normalizedKeyForPool(databaseUrlRaw: string): string {
  const strippedKey = stripSslmodeFromDatabaseUrl(databaseUrlRaw.trim());
  return strippedKey.url;
}

function instantiateDefaultPool(): pg.Pool {
  const opts = buildPoolOptions(stripped.url, isPooler, loweredDatabaseUrl, stripped.hadSslmode);
  return new Pool(opts);
}

const cachedPool: pg.Pool | undefined = globalThis.__lawcasproDbPool;
export const pool: pg.Pool = cachedPool ?? instantiateDefaultPool();
if (!cachedPool) {
  globalThis.__lawcasproDbPool = pool;
}
if (!poolRegistry.has(defaultPoolKey)) {
  poolRegistry.set(defaultPoolKey, pool);
}

const cachedDb: ReturnType<typeof drizzle> | undefined = globalThis.__lawcasproDrizzleDb;
export const db = cachedDb ?? drizzle(pool, { schema });
if (!cachedDb) {
  globalThis.__lawcasproDrizzleDb = db;
}

export { schema };
export type AppDb = typeof db;

export function createPoolFromDatabaseUrl(databaseUrlRaw: string) {
  const databaseUrl = databaseUrlRaw?.trim();
  if (!databaseUrl) throw new Error("databaseUrl is required");
  const isPooler = isSupabasePoolerDatabaseUrl(databaseUrl);
  const loweredDatabaseUrl = databaseUrl.toLowerCase();
  const stripped = stripSslmodeFromDatabaseUrl(databaseUrl);
  const opts = buildPoolOptions(stripped.url, isPooler, loweredDatabaseUrl, stripped.hadSslmode);
  return new Pool(opts);
}

export function getOrCreateSharedPool(databaseUrlRaw: string): pg.Pool {
  const key = normalizedKeyForPool(databaseUrlRaw);
  const existing = poolRegistry.get(key);
  if (existing) return existing;
  const fresh = createPoolFromDatabaseUrl(databaseUrlRaw);
  poolRegistry.set(key, fresh);
  return fresh;
}

export * from "./schema";
export * from "./tenant-context";
export type { RlsDb } from "./tenant-context";
export { auditLogsTable } from "./schema";

export {
  clearTenantContext,
  clearTenantContextStrict,
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

export { caseDocumentVariableOverridesTable } from "./schema";

export { sql } from "drizzle-orm";
export type { SQL } from "drizzle-orm";
export type { Pool, PoolClient } from "pg";

export * from "./feature-registry";
export * from "./legacy-case-import.contract";
