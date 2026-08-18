import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

declare const globalThis: {
  __lawcasproDbPool?: pg.Pool;
  __lawcasproDrizzleDb?: ReturnType<typeof drizzle>;
  __lawcasproDbPoolRegistry?: Map<string, pg.Pool>;
  __lawcasproDbPoolInstrumentation?: DbPoolInstrumentationState;
};

export type DbPoolInstrumentationState = {
  coldConnectCount: number;
  coldConnectTotalMs: number;
  warmConnectCount: number;
  warmConnectTotalMs: number;
  authLookupCount: number;
  authLookupTotalMs: number;
  firstConnectAtMs: number | null;
  firstConnectWarmDetectedMs: number | null;
};

function newInstrumentationState(): DbPoolInstrumentationState {
  return {
    coldConnectCount: 0,
    coldConnectTotalMs: 0,
    warmConnectCount: 0,
    warmConnectTotalMs: 0,
    authLookupCount: 0,
    authLookupTotalMs: 0,
    firstConnectAtMs: null,
    firstConnectWarmDetectedMs: null,
  };
}

export const dbPoolInstrumentation: DbPoolInstrumentationState =
  globalThis.__lawcasproDbPoolInstrumentation ?? newInstrumentationState();
if (!globalThis.__lawcasproDbPoolInstrumentation) {
  globalThis.__lawcasproDbPoolInstrumentation = dbPoolInstrumentation;
}

export type DbPoolSnapshot = {
  max: number | null;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  instrumented: DbPoolInstrumentationState & {
    coldConnectAvgMs: number | null;
    warmConnectAvgMs: number | null;
    authLookupAvgMs: number | null;
  };
};

export function getPoolSnapshot(p: pg.Pool = pool): DbPoolSnapshot {
  const max =
    typeof (p as unknown as { options?: { max?: number } | null }).options?.max === "number"
      ? (p as unknown as { options: { max: number } }).options.max
      : null;
  const totalCount = typeof (p as unknown as { totalCount?: number }).totalCount === "number"
    ? (p as unknown as { totalCount: number }).totalCount
    : 0;
  const idleCount = typeof (p as unknown as { idleCount?: number }).idleCount === "number"
    ? (p as unknown as { idleCount: number }).idleCount
    : 0;
  const waitingCount = typeof (p as unknown as { waitingCount?: number }).waitingCount === "number"
    ? (p as unknown as { waitingCount: number }).waitingCount
    : 0;
  const inst = dbPoolInstrumentation;
  return {
    max,
    totalCount,
    idleCount,
    waitingCount,
    instrumented: {
      ...inst,
      coldConnectAvgMs: inst.coldConnectCount > 0 ? Math.round((inst.coldConnectTotalMs / inst.coldConnectCount) * 100) / 100 : null,
      warmConnectAvgMs: inst.warmConnectCount > 0 ? Math.round((inst.warmConnectTotalMs / inst.warmConnectCount) * 100) / 100 : null,
      authLookupAvgMs: inst.authLookupCount > 0 ? Math.round((inst.authLookupTotalMs / inst.authLookupCount) * 100) / 100 : null,
    },
  };
}

export function recordColdConnect(durationMs: number): void {
  dbPoolInstrumentation.coldConnectCount += 1;
  dbPoolInstrumentation.coldConnectTotalMs += Math.max(0, durationMs);
  if (dbPoolInstrumentation.firstConnectAtMs === null) dbPoolInstrumentation.firstConnectAtMs = Date.now();
}

export function recordWarmConnect(durationMs: number): void {
  dbPoolInstrumentation.warmConnectCount += 1;
  dbPoolInstrumentation.warmConnectTotalMs += Math.max(0, durationMs);
  if (dbPoolInstrumentation.firstConnectWarmDetectedMs === null)
    dbPoolInstrumentation.firstConnectWarmDetectedMs = Date.now();
}

export function recordAuthLookup(durationMs: number): void {
  dbPoolInstrumentation.authLookupCount += 1;
  dbPoolInstrumentation.authLookupTotalMs += Math.max(0, durationMs);
}

function instrumentPool(p: pg.Pool): void {
  try {
    const originalConnect = p.connect.bind(p);
    (p as unknown as { connect: typeof p.connect }).connect = async function instrumentedConnect(...args: any[]) {
      const start = process.hrtime.bigint();
      const snapshotBefore = getPoolSnapshot(p);
      const result = await (originalConnect as any)(...args);
      const durationMs = Math.max(0, Number(process.hrtime.bigint() - start) / 1_000_000);
      const isWarm = snapshotBefore.idleCount > 0;
      if (isWarm) recordWarmConnect(durationMs);
      else recordColdConnect(durationMs);
      return result;
    };
  } catch {
  }
}

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
  const p = new Pool(opts);
  instrumentPool(p);
  return p;
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
  const p = new Pool(opts);
  instrumentPool(p);
  return p;
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
