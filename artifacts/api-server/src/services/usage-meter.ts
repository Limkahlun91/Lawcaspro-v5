/**
 * Unified Usage Meter — source-of-truth for both Platform Admin and Firm views.
 *
 * Metrics are persisted in usage_counters table with period_key = "YYYY-MM"
 * (monthly) or special "all_time" key. Real-time metrics can either be
 * pre-computed and incremented atomically (UPDATE ... SET counter = counter + 1)
 * or recomputed from transactional tables (COUNT(*) FROM cases WHERE ...).
 *
 * To keep correctness:
 *   - Counters are NOT the only source — we also support on-demand
 *     "live recompute" for metrics with transactional source-of-truth tables
 *     (users, cases, storage, generated docs).
 *   - Incremental APIs exist for OCR / AI token / generated docs / email sends
 *     where you want atomic bump with strict ordering.
 *
 * Metric key convention: prefix matches platform_features.limit.* where possible.
 *   - users.active
 *   - cases.active
 *   - cases.monthly_new
 *   - storage.gb_used
 *   - documents.generated_monthly
 *   - ai.ocr_pages_monthly
 *   - ai.draft_tokens_monthly
 *   - comms.email_sent_monthly
 *   - comms.whatsapp_sent_monthly
 *   - api.requests_monthly
 */

import { and, eq, gte, sql, count, sum, desc } from "drizzle-orm";
import {
  db,
  usageCountersTable,
  usersTable,
  casesTable,
  caseDocumentsTable,
  type AppDb,
  type RlsDb,
} from "@workspace/db";
import { getFeatureLimit, getEffectiveEntitlement } from "./entitlement-resolver.js";
import { ApiError } from "../lib/api-response.js";

const STORAGE_BYTES_PER_GB = 1_073_741_824n;

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

export function currentMonthlyPeriod(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export const ALL_TIME_PERIOD = "all_time";

// ---------------------------------------------------------------------------
// Counter helpers
// ---------------------------------------------------------------------------

/**
 * Atomically increment a usage counter (monthly + all_time).
 * Safe for high-throughput metrics like OCR pages / email sends.
 */
export async function bumpUsageCounter(
  conn: AppDb | RlsDb,
  firmId: number,
  metricKey: string,
  delta: number | bigint = 1,
): Promise<void> {
  const deltaNum = typeof delta === "bigint" ? Number(delta) : delta;
  const periods = [currentMonthlyPeriod(), ALL_TIME_PERIOD];
  for (const period of periods) {
    await conn
      .insert(usageCountersTable)
      .values({
        firmId,
        metricKey,
        periodKey: period,
        counter: String(deltaNum) as unknown as any,
      })
      .onConflictDoUpdate({
        target: [
          usageCountersTable.firmId,
          usageCountersTable.metricKey,
          usageCountersTable.periodKey,
        ],
        set: {
          counter: sql`${usageCountersTable.counter} + ${String(deltaNum)}::numeric`,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * Overwrite (recompute and store) a metric counter.
 */
export async function setUsageCounter(
  conn: AppDb | RlsDb,
  firmId: number,
  metricKey: string,
  periodKey: string,
  value: number | string,
): Promise<void> {
  await conn
    .insert(usageCountersTable)
    .values({
      firmId,
      metricKey,
      periodKey,
      counter: String(value) as unknown as any,
    })
    .onConflictDoUpdate({
      target: [
        usageCountersTable.firmId,
        usageCountersTable.metricKey,
        usageCountersTable.periodKey,
      ],
      set: { counter: String(value) as unknown as any, updatedAt: new Date() },
    });
}

/**
 * Read a stored counter value directly from usage_counters.
 */
export async function getUsageCounter(
  conn: AppDb | RlsDb,
  firmId: number,
  metricKey: string,
  periodKey: string = currentMonthlyPeriod(),
): Promise<number> {
  const rows = await conn
    .select({ counter: usageCountersTable.counter })
    .from(usageCountersTable)
    .where(
      and(
        eq(usageCountersTable.firmId, firmId),
        eq(usageCountersTable.metricKey, metricKey),
        eq(usageCountersTable.periodKey, periodKey),
      ),
    )
    .limit(1);
  const raw = rows[0]?.counter;
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// On-demand live-recompute for metrics backed by transactional tables
// ---------------------------------------------------------------------------

async function countWhere(
  conn: AppDb | RlsDb,
  table: { $inferSelect: unknown },
  cond: ReturnType<typeof and> | any,
): Promise<number> {
  const r = await conn.select({ c: count() }).from(table as any).where(cond).limit(1);
  const raw = (r[0] as any)?.c;
  const n = typeof raw === "bigint" ? Number(raw) : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function recomputeUsersActive(conn: AppDb | RlsDb, firmId: number): Promise<number> {
  return countWhere(
    conn,
    usersTable,
    and(eq(usersTable.firmId, firmId), eq(usersTable.status, "active")),
  );
}

export async function recomputeCasesActive(conn: AppDb | RlsDb, firmId: number): Promise<number> {
  return countWhere(
    conn,
    casesTable,
    and(eq(casesTable.firmId, firmId), sql`${casesTable.deletedAt} IS NULL`),
  );
}

export async function recomputeCasesMonthlyNew(conn: AppDb | RlsDb, firmId: number, period: string): Promise<number> {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return 0;
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return countWhere(
    conn,
    casesTable,
    and(
      eq(casesTable.firmId, firmId),
      gte(casesTable.createdAt, start),
      sql`${casesTable.createdAt} < ${end}`,
    ),
  );
}

export async function recomputeDocumentsGeneratedMonthly(
  conn: AppDb | RlsDb,
  firmId: number,
  period: string,
): Promise<number> {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return 0;
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return countWhere(
    conn,
    caseDocumentsTable,
    and(
      eq(caseDocumentsTable.firmId, firmId),
      gte(caseDocumentsTable.createdAt, start),
      sql`${caseDocumentsTable.createdAt} < ${end}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Unified "get usage" — returns {used, limit, status} for a single metric.
// Status can be: "ok" | "warning_80pct" | "at_cap" | "over"
// ---------------------------------------------------------------------------

export interface MetricUsage {
  metricKey: string;
  periodKey: string;
  used: number;
  limit: number | null; // null => unlimited / undefined limit
  status: "ok" | "warning_80pct" | "at_cap" | "over";
  source: "counter" | "recompute";
}

export interface GetUsageOptions {
  recomputeIfMissing?: boolean;
  periodKey?: string;
  conn?: AppDb | RlsDb;
}

function classify(used: number, limit: number | null): MetricUsage["status"] {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return "ok";
  const ratio = used / limit;
  if (ratio >= 1.0) return "over";
  if (ratio >= 0.99) return "at_cap";
  if (ratio >= 0.8) return "warning_80pct";
  return "ok";
}

export async function getMetricUsage(
  firmId: number,
  metricKey: string,
  opts: GetUsageOptions = {},
): Promise<MetricUsage> {
  const conn = opts.conn ?? db;
  const period = opts.periodKey ?? currentMonthlyPeriod();

  let used = await getUsageCounter(conn, firmId, metricKey, period);
  let source: MetricUsage["source"] = "counter";

  // Live-recompute missing well-known metrics (only if flag enabled)
  if (used === 0 && opts.recomputeIfMissing) {
    switch (metricKey) {
      case "users.active":
        used = await recomputeUsersActive(conn, firmId);
        source = "recompute";
        break;
      case "cases.active":
        used = await recomputeCasesActive(conn, firmId);
        source = "recompute";
        break;
      case "cases.monthly_new":
        used = await recomputeCasesMonthlyNew(conn, firmId, period);
        source = "recompute";
        break;
      case "documents.generated_monthly":
        used = await recomputeDocumentsGeneratedMonthly(conn, firmId, period);
        source = "recompute";
        break;
    }
  }

  // Map metricKey → featureKey for the limit lookup (matches seed):
  //   users.active               → limit.users.max
  //   cases.active               → limit.cases.max
  //   cases.monthly_new          → limit.cases.monthly_new
  //   storage.gb_used            → limit.storage.gb
  //   documents.generated_monthly→ limit.documents.generation_monthly
  //   ai.ocr_pages_monthly       → limit.ai.ocr_pages_monthly
  //   ai.draft_tokens_monthly    → limit.ai.draft_tokens_monthly
  const featureMap: Record<string, string> = {
    "users.active": "limit.users.max",
    "cases.active": "limit.cases.max",
    "cases.monthly_new": "limit.cases.monthly_new",
    "storage.gb_used": "limit.storage.gb",
    "documents.generated_monthly": "limit.documents.generation_monthly",
    "ai.ocr_pages_monthly": "limit.ai.ocr_pages_monthly",
    "ai.draft_tokens_monthly": "limit.ai.draft_tokens_monthly",
  };
  const featureKey = featureMap[metricKey] ?? metricKey;
  const limit = await getFeatureLimit(firmId, featureKey, { conn });

  return {
    metricKey,
    periodKey: period,
    used,
    limit,
    status: classify(used, limit),
    source,
  };
}

/**
 * Check quota and throw 403 if limit exceeded.
 * Use before mutating actions that consume limit (user creation, case opening, OCR calls).
 */
export async function assertUsageBelowLimit(
  firmId: number,
  metricKey: string,
  opts: GetUsageOptions & { projectedDelta?: number } = {},
): Promise<void> {
  const u = await getMetricUsage(firmId, metricKey, opts);
  const delta = opts.projectedDelta ?? 1;
  if (u.limit === null || !Number.isFinite(u.limit)) return;
  if (u.used + delta > u.limit) {
    throw new ApiError({
      status: 403,
      code: "USAGE_LIMIT_EXCEEDED",
      message: `Usage limit exceeded for ${metricKey}: ${u.used} + ${delta} > ${u.limit}`,
      retryable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Firm-level usage summary (for both platform admin and firm dashboard widgets)
// ---------------------------------------------------------------------------

const STANDARD_METRICS = [
  "users.active",
  "cases.active",
  "cases.monthly_new",
  "storage.gb_used",
  "documents.generated_monthly",
  "ai.ocr_pages_monthly",
  "ai.draft_tokens_monthly",
] as const;

export async function getFirmUsageSummary(
  firmId: number,
  opts: GetUsageOptions = {},
): Promise<MetricUsage[]> {
  return Promise.all(
    STANDARD_METRICS.map((m) => getMetricUsage(firmId, m, opts)),
  );
}
