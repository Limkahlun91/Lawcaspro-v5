import express, { type Response, type Router as ExpressRouter } from "express";
import { db, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { computeDashboardStats } from "../services/dashboard-stats.js";

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;
type TransactionCapable = { transaction: <T>(fn: (tx: DbConn) => Promise<T>) => Promise<T> };
const asTransactionCapable = (conn: DbConn): TransactionCapable => conn as unknown as TransactionCapable;

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
    ok: true,
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

type DashboardSummaryData = {
  totalCases: number;
  totalClients: number;
  totalProjects: number;
  totalDevelopers: number;
};

async function computeDashboardSummary(r: DbConn, args: { firmId: number; assignedToUserId?: number | null }): Promise<{ ok: true; data: DashboardSummaryData; errors: Array<{ section: string; code: string | null; message: string }> } | { ok: false; error: string }> {
  const errors: Array<{ section: string; code: string | null; message: string }> = [];
  const firmId = args.firmId;
  const assignedToUserId = typeof args.assignedToUserId === "number" && args.assignedToUserId > 0 ? args.assignedToUserId : null;
  const summary: DashboardSummaryData = { totalCases: 0, totalClients: 0, totalProjects: 0, totalDevelopers: 0 };

  const countCases = await (async () => {
    try {
      const rows = assignedToUserId
        ? await queryRows(r, sql`
          SELECT COUNT(DISTINCT c.id)::int AS c
          FROM cases c
          JOIN case_assignments ca ON ca.case_id = c.id AND ca.user_id = ${assignedToUserId} AND ca.unassigned_at IS NULL
          WHERE c.firm_id = ${firmId} AND c.deleted_at IS NULL
        `)
        : await queryRows(r, sql`SELECT COUNT(*)::int AS c FROM cases WHERE firm_id = ${firmId} AND deleted_at IS NULL`);
      summary.totalCases = Number((rows[0] as any)?.c ?? 0);
      return true;
    } catch (err) {
      errors.push({ section: "cases.count", code: getPgCode(err), message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  })();

  await (async () => {
    try {
      const rows = await queryRows(r, sql`SELECT COUNT(*)::int AS c FROM clients WHERE firm_id = ${firmId}`);
      summary.totalClients = Number((rows[0] as any)?.c ?? 0);
    } catch (err) {
      errors.push({ section: "clients.count", code: getPgCode(err), message: err instanceof Error ? err.message : String(err) });
    }
  })();

  await (async () => {
    try {
      const rows = await queryRows(r, sql`SELECT COUNT(*)::int AS c FROM projects WHERE firm_id = ${firmId}`);
      summary.totalProjects = Number((rows[0] as any)?.c ?? 0);
    } catch (err) {
      errors.push({ section: "projects.count", code: getPgCode(err), message: err instanceof Error ? err.message : String(err) });
    }
  })();

  await (async () => {
    try {
      const rows = await queryRows(r, sql`SELECT COUNT(*)::int AS c FROM developers WHERE firm_id = ${firmId}`);
      summary.totalDevelopers = Number((rows[0] as any)?.c ?? 0);
    } catch (err) {
      errors.push({ section: "developers.count", code: getPgCode(err), message: err instanceof Error ? err.message : String(err) });
    }
  })();

  if (!countCases && errors.length === 0) return { ok: false, error: "Dashboard summary failed" };
  return { ok: true, data: summary, errors };
}

router.get("/dashboard/summary", requireAuth, requireFirmUser, requirePermission("dashboard", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const firmId = req.firmId!;
  const r = rdb(req);
  const requestId = one(req.headers["x-request-id"] as any) || one(req.headers["x-vercel-id"] as any) || undefined;
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
  const effectiveAssignedToUserId = assignedToMe ? (req.userId ?? null) : assignedToUserId;

  const timeoutMs = 1800;
  type SummaryOk = { ok: true; data: DashboardSummaryData; errors: Array<{ section: string; code: string | null; message: string }> };
  type SummaryErr = { ok: false; error: string };
  const out: SummaryOk | SummaryErr = await (async () => {
    try {
      return await Promise.race([
        computeDashboardSummary(r, { firmId, assignedToUserId: effectiveAssignedToUserId }),
        new Promise<SummaryErr>((resolve) => setTimeout(() => resolve({ ok: false, error: "Dashboard summary timed out" }), timeoutMs)),
      ]);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies SummaryErr;
    }
  })();

  if (out.ok === true) {
    res.status(200).json({ ok: true, partial: out.errors.length > 0, data: out.data, errors: out.errors, requestId });
    return;
  }
  res.status(200).json({ ok: true, partial: true, data: { totalCases: 0, totalClients: 0, totalProjects: 0, totalDevelopers: 0 }, errors: [{ section: "summary", code: null, message: out.error }], requestId });
});

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
      const payload = await computeDashboardStats(r, firmId, { includeErrorDetails: allowDetails });
      const warnings = Array.isArray((payload as any)?.warnings) ? (payload as any).warnings : [];
      const unavailableFields = Array.isArray((payload as any)?.unavailableFields) ? (payload as any).unavailableFields : [];
      return {
        ok: true,
        degraded: Boolean((payload as any)?.degraded) || Boolean((payload as any)?.ok === false),
        warningsCount: warnings.length,
        unavailableFields,
        keys: Object.keys(payload ?? {}),
      };
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
    const requestId = one(req.headers["x-request-id"] as any) || one(req.headers["x-vercel-id"] as any) || undefined;
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
    const effectiveAssignedToUserId = assignedToMe ? (req.userId ?? null) : assignedToUserId;
    type SummaryOk = { ok: true; data: DashboardSummaryData; errors: Array<{ section: string; code: string | null; message: string }> };
    type SummaryErr = { ok: false; error: string };
    const summaryTimeoutMs = 1600;
    const summaryPromise: Promise<SummaryOk | SummaryErr> = Promise.race([
      computeDashboardSummary(r, { firmId, assignedToUserId: effectiveAssignedToUserId ?? undefined }),
      new Promise<SummaryErr>((resolve) => setTimeout(() => resolve({ ok: false, error: "Dashboard summary timed out" }), summaryTimeoutMs)),
    ]);

    const includeStats = (() => {
      const raw = one((req.query as unknown as Record<string, unknown>)?.includeStats as string | string[] | undefined);
      if (!raw) return false;
      const v = raw.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    })();
    const statsTimeoutMs = includeStats ? 4200 : 1;
    const statsPromise: Promise<{ ok: true; stats: Record<string, unknown> } | { ok: false; error: string }> = includeStats
      ? Promise.race([
          (async () => {
            const stats = await computeDashboardStats(r, firmId, {
              assignedToUserId: effectiveAssignedToUserId ?? undefined,
              includeErrorDetails: allowDetails,
              deadlineAt: Date.now() + 3_600,
            });
            return { ok: true, stats } as const;
          })(),
          new Promise<{ ok: false; error: string }>((resolve) => setTimeout(() => resolve({ ok: false, error: "DASHBOARD_TIMEOUT" }), statsTimeoutMs)),
        ])
      : Promise.resolve({ ok: false, error: "SKIPPED" });

    const [summaryOut, statsOut] = await Promise.all([summaryPromise, statsPromise]);
    const summaryData = summaryOut.ok === true ? summaryOut.data : { totalCases: 0, totalClients: 0, totalProjects: 0, totalDevelopers: 0 };

    const stats = statsOut.ok === true ? statsOut.stats : null;
    const degraded = statsOut.ok === false || Boolean((stats as any)?.degraded) || Boolean((stats as any)?.ok === false);
    const warnings = [
      ...(Array.isArray((stats as any)?.warnings) ? ((stats as any).warnings as any[]) : []),
      ...(summaryOut.ok === true
        ? (summaryOut.errors ?? []).map((e) => ({ module: e.section, code: e.code, message: e.message }))
        : [{ module: "summary", code: null, message: (summaryOut as SummaryErr).error }]),
      ...(statsOut.ok === false ? [{ module: "dashboard", code: "TIMEOUT", message: statsOut.error }] : []),
    ];
    const unavailableFields: string[] = Array.isArray((stats as any)?.unavailableFields) ? ((stats as any).unavailableFields as string[]) : [];
    if (statsOut.ok === false) {
      for (const f of [
        "milestoneCards",
        "milestoneSections",
        "recentCases",
        "billing",
        "outstandingAdvances",
        "commsThisMonth",
        "completionSlaOverdue",
        "cashCases",
        "loanCases",
        "masterTitleCases",
        "individualTitleCases",
        "strataTitleCases",
        "activeCases",
        "completedCases",
      ]) {
        if (!unavailableFields.includes(f)) unavailableFields.push(f);
      }
    }

    res.status(200).json({
      ok: true,
      degraded,
      requestId,
      warnings,
      unavailableFields,
      dashboard: {
        totalCases: (stats as any)?.totalCases ?? summaryData.totalCases ?? 0,
        activeCases: (stats as any)?.activeCases ?? 0,
        completedCases: (stats as any)?.completedCases ?? 0,
        totalClients: (stats as any)?.totalClients ?? summaryData.totalClients ?? 0,
        totalDevelopers: (stats as any)?.totalDevelopers ?? summaryData.totalDevelopers ?? 0,
        totalProjects: (stats as any)?.totalProjects ?? summaryData.totalProjects ?? 0,
        cashCases: (stats as any)?.cashCases ?? 0,
        loanCases: (stats as any)?.loanCases ?? 0,
        masterTitleCases: (stats as any)?.masterTitleCases ?? 0,
        individualTitleCases: (stats as any)?.individualTitleCases ?? 0,
        strataTitleCases: (stats as any)?.strataTitleCases ?? 0,
        billing: (stats as any)?.billing ?? { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
        outstandingAdvances: (stats as any)?.outstandingAdvances ?? [],
        commsThisMonth: (stats as any)?.commsThisMonth ?? 0,
        completionSlaOverdue: (stats as any)?.completionSlaOverdue ?? [],
        milestoneSections: Array.isArray((stats as any)?.milestoneSections) ? (stats as any).milestoneSections : [],
        milestoneCards: Array.isArray((stats as any)?.milestoneCards) ? (stats as any).milestoneCards : [],
        recentCases: Array.isArray((stats as any)?.recentCases) ? (stats as any).recentCases : [],
        alerts: [],
      },
    });
    return;
  } catch (err) {
    const requestId = one(req.headers["x-request-id"] as any) || one(req.headers["x-vercel-id"] as any) || undefined;
    const timeout = err instanceof Error && err.message === "DASHBOARD_TIMEOUT";
    logger.error(
      allowDetails
        ? { err, path: req.path, firmId: req.firmId, userId: req.userId, query: req.query, requestId, timeout }
        : { err, path: req.path, firmId: req.firmId, userId: req.userId, requestId, timeout },
      "[dashboard]",
    );
    const payload = buildDashboardDegradedPayload(allowDetails ? err : undefined);
    (payload as any).reason = timeout ? "timeout" : "exception";
    if (requestId) (payload as any).requestId = requestId;
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
