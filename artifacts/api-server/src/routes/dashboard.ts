import express, { type Response, type Router as ExpressRouter } from "express";
import { db, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { computeDashboardStats } from "../services/dashboard-stats.js";

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function getPgCode(err: unknown): string | null {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : null;
}

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function tableExists(r: DbConn, reg: string): Promise<boolean> {
  const rows = await queryRows(r, sql`SELECT to_regclass(${reg}) AS reg`);
  return Boolean(rows[0]?.reg);
}

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

function buildDashboardDegradedPayload(error?: unknown): Record<string, unknown> {
  const base = {
    ok: false,
    degraded: true,
    error: "Dashboard partially unavailable",
    stats: {
      totalCases: 0,
      activeCases: 0,
      completedCases: 0,
      totalClients: 0,
      totalDevelopers: 0,
      totalProjects: 0,
      totalOutstanding: 0,
      pendingMilestones: [],
      milestoneSections: [],
      recentCases: [],
      alerts: [],
      charts: {},
    },
    dashboard: {
      totalCases: 0,
      activeCases: 0,
      completedCases: 0,
      totalClients: 0,
      totalDevelopers: 0,
      totalProjects: 0,
      milestoneSections: [],
      recentCases: [],
      alerts: [],
    },
  } as Record<string, unknown>;
  return base;
}

router.get("/debug/dashboard", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const allowDetails =
    process.env.API_ERROR_DETAILS === "1" ||
    process.env.NODE_ENV !== "production" ||
    Boolean((res as any)?.locals?.allowErrorDetails) ||
    (() => {
      const headerToken = one(req.headers["x-debug-token"] as any);
      const expected = process.env.API_DEBUG_TOKEN;
      if (!expected) return false;
      return Boolean(headerToken && headerToken === expected);
    })();

  const firmId = req.firmId!;
  const r = rdb(req);

  const roleName = await (async () => {
    const roleId = typeof req.roleId === "number" ? req.roleId : null;
    if (!roleId) return null;
    try {
      const rows = await queryRows(r, sql`SELECT name FROM roles WHERE firm_id = ${firmId} AND id = ${roleId} LIMIT 1`);
      const n = rows[0] && typeof (rows[0] as any).name === "string" ? String((rows[0] as any).name) : null;
      return n;
    } catch {
      return null;
    }
  })();

  const isPartner = Boolean(roleName && roleName.toLowerCase().includes("partner"));
  if (!allowDetails && !isPartner) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const checkTable = async (reg: string) => {
    try {
      const exists = await tableExists(r, reg);
      return { reg, ok: true, exists };
    } catch (err) {
      return {
        reg,
        ok: false,
        exists: false,
        code: getPgCode(err),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const tableChecks = await Promise.all([
    checkTable("public.firm_dashboard_stats_cache"),
    checkTable("public.cases"),
    checkTable("public.clients"),
    checkTable("public.projects"),
    checkTable("public.developers"),
    checkTable("public.case_key_dates"),
    checkTable("public.case_workflow_steps"),
  ]);

  const hasCache = Boolean(tableChecks.find((x) => x.reg === "public.firm_dashboard_stats_cache")?.exists);
  const hasCases = Boolean(tableChecks.find((x) => x.reg === "public.cases")?.exists);
  const hasWorkflow = Boolean(tableChecks.find((x) => x.reg === "public.case_workflow_steps")?.exists);

  const countsProbe = await (async () => {
    if (!hasCases) return { ok: false, reason: "cases_missing" };
    try {
      const rows = await queryRows(r, sql`SELECT COUNT(*)::int AS total_cases FROM cases WHERE firm_id = ${firmId} AND deleted_at IS NULL`);
      return { ok: true, totalCases: Number((rows[0] as any)?.total_cases ?? 0) };
    } catch (err) {
      return { ok: false, code: getPgCode(err), message: err instanceof Error ? err.message : String(err) };
    }
  })();

  const milestonesProbe = await (async () => {
    if (!hasWorkflow) return { ok: false, reason: "case_workflow_steps_missing" };
    try {
      const rows = await queryRows(r, sql`
        SELECT COUNT(DISTINCT ws.case_id)::int AS completed_spa_stamped
        FROM case_workflow_steps ws
        JOIN cases c ON c.id = ws.case_id AND c.firm_id = ws.firm_id
        WHERE ws.firm_id = ${firmId}
          AND c.deleted_at IS NULL
          AND ws.step_key = 'spa_stamped'
          AND ws.status = 'completed'
      `);
      return { ok: true, completedSpaStamped: Number((rows[0] as any)?.completed_spa_stamped ?? 0) };
    } catch (err) {
      return { ok: false, code: getPgCode(err), message: err instanceof Error ? err.message : String(err) };
    }
  })();

  const recentCasesProbe = await (async () => {
    if (!hasCases) return { ok: false, reason: "cases_missing" };
    try {
      const rows = await queryRows(r, sql`
        SELECT id, reference_no, updated_at
        FROM cases
        WHERE firm_id = ${firmId} AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      return { ok: true, row: rows[0] ?? null };
    } catch (err) {
      return { ok: false, code: getPgCode(err), message: err instanceof Error ? err.message : String(err) };
    }
  })();

  const cacheReadProbe = await (async () => {
    if (!hasCache) return { ok: false, reason: "cache_missing" };
    try {
      await queryRows(r, sql`SELECT 1 FROM firm_dashboard_stats_cache WHERE firm_id = ${firmId} LIMIT 1`);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: getPgCode(err), message: err instanceof Error ? err.message : String(err) };
    }
  })();

  const cacheWriteProbe = await (async () => {
    if (!hasCache) return { ok: false, reason: "cache_missing" };
    if (!allowDetails) return { ok: false, reason: "write_probe_requires_debug" };
    try {
      await queryRows(r, sql`
        INSERT INTO firm_dashboard_stats_cache (firm_id, payload_json, computed_at, expires_at)
        VALUES (${firmId}, ${({}) as any}::jsonb, now(), now())
        ON CONFLICT (firm_id) DO UPDATE SET payload_json = EXCLUDED.payload_json, computed_at = EXCLUDED.computed_at, expires_at = EXCLUDED.expires_at
      `);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: getPgCode(err), message: err instanceof Error ? err.message : String(err) };
    }
  })();

  const computeProbe = await (async () => {
    try {
      const payload = await computeDashboardStats(r, firmId);
      return { ok: true, keys: Object.keys(payload ?? {}) };
    } catch (err) {
      return { ok: false, code: getPgCode(err), message: err instanceof Error ? err.message : String(err), stack: allowDetails && err instanceof Error ? err.stack : undefined };
    }
  })();

  res.json({
    ok: true,
    firmId,
    userId: req.userId ?? null,
    roleId: req.roleId ?? null,
    roleName,
    allowDetails,
    tableChecks,
    probes: {
      counts: countsProbe,
      milestones: milestonesProbe,
      recentCases: recentCasesProbe,
      cacheRead: cacheReadProbe,
      cacheWrite: cacheWriteProbe,
      computeDashboardStats: computeProbe,
    },
  });
});

router.get("/dashboard", requireAuth, requireFirmUser, requirePermission("dashboard", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const allowDetails =
    process.env.API_ERROR_DETAILS === "1" ||
    process.env.NODE_ENV !== "production" ||
    Boolean((res as any)?.locals?.allowErrorDetails) ||
    (() => {
      const headerToken = one(req.headers["x-debug-token"] as any);
      const expected = process.env.API_DEBUG_TOKEN;
      if (!expected) return false;
      return Boolean(headerToken && headerToken === expected);
    })();

  try {
    const firmId = req.firmId!;
    const r = rdb(req);
    const refresh = (() => {
      const raw = one((req.query as unknown as Record<string, unknown>)?.refresh as string | string[] | undefined);
      if (!raw) return false;
      const v = raw.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    })();
    const assignedToMe = (() => {
      const raw = one((req.query as unknown as Record<string, unknown>)?.assignedToMe as string | string[] | undefined);
      if (!raw) return false;
      const v = raw.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    })();
    const assignedToUserId = (() => {
      const raw = one((req.query as unknown as Record<string, unknown>)?.assignedToUserId as string | string[] | undefined);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    })();
    if (assignedToMe) {
      const payload = await computeDashboardStats(r, firmId, { assignedToUserId: req.userId ?? undefined });
      res.json(payload);
      return;
    }
    if (assignedToUserId) {
      const payload = await computeDashboardStats(r, firmId, { assignedToUserId });
      res.json(payload);
      return;
    }

    const hasCache = await (async () => {
      try {
        return await tableExists(r, "public.firm_dashboard_stats_cache");
      } catch (err) {
        logger.warn({ err, code: getPgCode(err), firmId, userId: req.userId }, "[dashboard] cache_table_exists_failed");
        return false;
      }
    })();

    if (hasCache && !refresh) {
      const cachedRows = await (async () => {
        try {
          return await queryRows(r, sql`
          SELECT payload_json
          FROM firm_dashboard_stats_cache
          WHERE firm_id = ${firmId} AND expires_at > now()
          LIMIT 1
        `);
        } catch (err) {
          logger.warn({ err, code: getPgCode(err), firmId, userId: req.userId }, "[dashboard] cache_read_failed");
          return [];
        }
      })();
      const cached = cachedRows[0] && typeof cachedRows[0] === "object" ? (cachedRows[0] as any).payload_json : undefined;
      if (cached && typeof cached === "object") {
        res.json(cached);
        return;
      }
    }

    const payload = await computeDashboardStats(r, firmId);

    if (hasCache) {
      const ttlSec = (() => {
        const raw = process.env.DASHBOARD_CACHE_TTL_SEC ? Number.parseInt(process.env.DASHBOARD_CACHE_TTL_SEC, 10) : 300;
        return Number.isFinite(raw) ? Math.min(Math.max(raw, 30), 3600) : 300;
      })();
      try {
        await queryRows(r, sql`
          INSERT INTO firm_dashboard_stats_cache (firm_id, payload_json, computed_at, expires_at)
          VALUES (${firmId}, ${payload as any}::jsonb, now(), now() + (${ttlSec}::text || ' seconds')::interval)
          ON CONFLICT (firm_id) DO UPDATE SET
            payload_json = EXCLUDED.payload_json,
            computed_at = EXCLUDED.computed_at,
            expires_at = EXCLUDED.expires_at
        `);
      } catch (err) {
        logger.warn({ err, code: getPgCode(err), firmId, userId: req.userId }, "[dashboard] cache_write_failed");
      }
    }

    res.json(payload);
  } catch (err) {
    logger.error(
      allowDetails
        ? { err, path: req.path, firmId: req.firmId, userId: req.userId, query: req.query }
        : { err, path: req.path, firmId: req.firmId, userId: req.userId },
      "[dashboard]",
    );
    const payload = buildDashboardDegradedPayload(allowDetails ? err : undefined);
    if (allowDetails) {
      (payload as any).debug = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        code: getPgCode(err),
      };
    }
    res.status(200).json(payload);
    return;
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
