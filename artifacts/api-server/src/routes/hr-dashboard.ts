import express, { type Response, type Router as ExpressRouter } from "express";
import { and, eq, count, or, sql, inArray, like, desc, isNotNull, gte, lte } from "drizzle-orm";
import {
  db,
  hrEmployeesTable,
  hrFirmFeatureFlagsTable,
  hrAttendanceRecordsTable,
  hrLeaveRequestsTable,
  hrClaimsTable,
  hrPayrollRunsTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";
import { isPartnerRoleName } from "../services/user-feature-access.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

export type HrModuleStatus = "ready" | "not_configured";
export type HrDashboardPayrollLabel = "Not Started" | "Draft" | "Processing" | "Completed";
export type HrDashboardSummary = {
  totalEmployees: number;
  activeToday: number | null;
  onLeaveToday: number | null;
  pendingLeave: number | null;
  pendingClaims: number | null;
  payroll: { label: HrDashboardPayrollLabel; period: string | null } | null;
  metricStatus: {
    attendance: HrModuleStatus;
    leave: HrModuleStatus;
    claims: HrModuleStatus;
    payroll: HrModuleStatus;
  };
};

export type LegacyHrDashboardStats = {
  headcount: number;
  pendingLeaves: number;
  pendingClaims: number;
};

const todayStr = (): string => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const isSchemaParityError = (err: unknown): boolean => {
  const code = err != null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return code === "42P01" || code === "42703";
};

export async function getHrDashboardSummary(input: {
  firmId: number;
  userId: number;
  roleName: string | null;
  roleId: number | null;
  tx?: any;
}): Promise<HrDashboardSummary> {
  const firmId = input.firmId;
  const r = input.tx ?? db;
  const today = todayStr();

  let totalEmployees = 0;
  try {
    const [row] = await r
      .select({ n: count() })
      .from(hrEmployeesTable as any)
      .where(and(
        eq((hrEmployeesTable as any).firmId, firmId),
        or(
          eq((hrEmployeesTable as any).employmentStatus, "active"),
          like((hrEmployeesTable as any).employmentStatus as any, "%Active%"),
        ),
      ))
      .execute();
    totalEmployees = Number(row?.n ?? 0);
  } catch (countErr) {
    if (!isSchemaParityError(countErr)) {
      throw createHRError(
        HR_ERROR_CODES.HR_DASHBOARD_DB_FAILURE,
        "Headcount count failed",
        { details: { metric: "totalEmployees" } },
      );
    }
    totalEmployees = 0;
  }

  const metricStatus: HrDashboardSummary["metricStatus"] = {
    attendance: "not_configured",
    leave: "not_configured",
    claims: "not_configured",
    payroll: "not_configured",
  };

  let activeToday: number | null = null;
  try {
    const [row] = await r
      .select({ n: count(sql`distinct ${(hrAttendanceRecordsTable as any).employeeId}`) })
      .from(hrAttendanceRecordsTable as any)
      .where(and(
        eq((hrAttendanceRecordsTable as any).firmId, firmId),
        eq((hrAttendanceRecordsTable as any).attendanceDate, today),
        or(isNotNull((hrAttendanceRecordsTable as any).clockInAt), isNotNull((hrAttendanceRecordsTable as any).clockOutAt)),
      ))
      .execute();
    metricStatus.attendance = "ready";
    activeToday = Number(row?.n ?? 0);
  } catch (countErr) {
    if (isSchemaParityError(countErr)) {
      metricStatus.attendance = "not_configured";
      activeToday = null;
    } else {
      throw createHRError(
        HR_ERROR_CODES.HR_DASHBOARD_DB_FAILURE,
        "Attendance count failed",
        { details: { metric: "activeToday" } },
      );
    }
  }

  let onLeaveToday: number | null = null;
  try {
    const [row] = await r
      .select({ n: count() })
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, firmId),
        eq((hrLeaveRequestsTable as any).status, "approved"),
        lte((hrLeaveRequestsTable as any).startDate, today),
        gte((hrLeaveRequestsTable as any).endDate, today),
      ))
      .execute();
    metricStatus.leave = "ready";
    onLeaveToday = Number(row?.n ?? 0);
  } catch (countErr) {
    if (isSchemaParityError(countErr)) {
      metricStatus.leave = "not_configured";
      onLeaveToday = null;
    } else {
      throw createHRError(
        HR_ERROR_CODES.HR_DASHBOARD_DB_FAILURE,
        "Leave count failed",
        { details: { metric: "onLeaveToday" } },
      );
    }
  }

  let pendingLeave: number | null = null;
  if (metricStatus.leave === "ready") {
    try {
      const [row] = await r
        .select({ n: count() })
        .from(hrLeaveRequestsTable as any)
        .where(and(
          eq((hrLeaveRequestsTable as any).firmId, firmId),
          eq((hrLeaveRequestsTable as any).status, "pending"),
        ))
        .execute();
      pendingLeave = Number(row?.n ?? 0);
    } catch (countErr) {
      if (isSchemaParityError(countErr)) {
        pendingLeave = null;
      } else {
        throw createHRError(
          HR_ERROR_CODES.HR_DASHBOARD_DB_FAILURE,
          "Pending leave count failed",
          { details: { metric: "pendingLeave" } },
        );
      }
    }
  }

  let pendingClaims: number | null = null;
  try {
    const [row] = await r
      .select({ n: count() })
      .from(hrClaimsTable as any)
      .where(and(
        eq((hrClaimsTable as any).firmId, firmId),
        or(
          eq((hrClaimsTable as any).status, "pending"),
          eq((hrClaimsTable as any).status, "submitted"),
        ),
      ))
      .execute();
    metricStatus.claims = "ready";
    pendingClaims = Number(row?.n ?? 0);
  } catch (countErr) {
    if (isSchemaParityError(countErr)) {
      metricStatus.claims = "not_configured";
      pendingClaims = null;
    } else {
      throw createHRError(
        HR_ERROR_CODES.HR_DASHBOARD_DB_FAILURE,
        "Pending claims count failed",
        { details: { metric: "pendingClaims" } },
      );
    }
  }

  let payroll: HrDashboardSummary["payroll"] = null;
  try {
    const latestRows = await r
      .select()
      .from(hrPayrollRunsTable as any)
      .where(eq((hrPayrollRunsTable as any).firmId, firmId))
      .orderBy(desc((hrPayrollRunsTable as any).createdAt))
      .limit(1)
      .execute();
    metricStatus.payroll = "ready";
    if (latestRows && latestRows[0]) {
      const r0 = latestRows[0];
      let label: HrDashboardPayrollLabel = "Draft";
      if (r0.status === "finalised") label = "Completed";
      else if (r0.status === "approved") label = "Processing";
      else if (r0.status === "processing") label = "Processing";
      else if (r0.status === "draft") label = "Draft";
      else label = "Not Started";
      payroll = { label, period: r0.periodName ? String(r0.periodName) : null };
    } else {
      payroll = { label: "Not Started", period: null };
    }
  } catch (countErr) {
    if (isSchemaParityError(countErr)) {
      metricStatus.payroll = "not_configured";
      payroll = null;
    } else {
      throw createHRError(
        HR_ERROR_CODES.HR_DASHBOARD_DB_FAILURE,
        "Payroll latest failed",
        { details: { metric: "payroll" } },
      );
    }
  }

  return {
    totalEmployees,
    activeToday,
    onLeaveToday,
    pendingLeave,
    pendingClaims,
    payroll,
    metricStatus,
  };
}

function resolveRoleName(req: AuthRequest): string | null {
  const cache = (req as any)._roleCache as { name?: string } | undefined;
  if (cache?.name) return String(cache.name);
  if (typeof (req as any).roleName === "string") return String((req as any).roleName);
  return null;
}

// ---------------------------------------------------------------------------
// Shared handler for admin dashboard routes (summary response)
// ---------------------------------------------------------------------------
async function handleDashboardSummary(req: AuthRequest, res: Response): Promise<void> {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;
    const roleName = resolveRoleName(req);
    const isPartner = isPartnerRoleName(roleName) || Boolean((req as any).isFirmManagement);
    const summary = await getHrDashboardSummary({ firmId, userId, roleName, roleId, tx: req.rlsDb });
    res.json({
      ok: true,
      data: summary,
      meta: {
        request_id: (req as any).id ?? `hr-dash-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`,
        scope: isPartner ? "firm" : "admin",
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    const code4xx = err?.status && err.status >= 400 && err.status < 500;
    if (code4xx) {
      res.status(err.status).json(serializeHRError(createHRError(
        err?.code ?? HR_ERROR_CODES.HR_PERMISSION_DENIED,
        err?.message ?? "Denied",
      )));
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId, stage: "hr_dashboard_summary" }, "hr.dashboard_summary_failed");
    res.status(500).json({
      ok: false,
      error: {
        code: err?.code ?? "HR_DASHBOARD_UNAVAILABLE",
        message: "HR dashboard is temporarily unavailable.",
        retryable: true,
      },
      requestId: (req as any).id ?? `hr-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`,
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// §11 Canonical ADMIN / MANAGEMENT route
// Guards: requireAuth → requireFirmUser → requireHRModuleEnabled (module.hr)
//         → requireUserFeatureAccess("hr.dashboard") (firm: hr.dashboard + user access, Partner auto-allowed via STEP2)
//         → requirePermission("hr_dashboard", "read") (RBAC layer if present)
// ---------------------------------------------------------------------------
router.get("/hr/dashboard/summary",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.dashboard"),
  requirePermission("hr_dashboard", "read"),
  handleDashboardSummary,
);

// ---------------------------------------------------------------------------
// §12 Backward Compatibility: DEPRECATED COMPATIBILITY alias for /hr/me/dashboard
// Uses SAME ADMIN guards as /hr/dashboard/summary (NOT self-service guards)
// Logs deprecation warning then proxies to same handler
// ---------------------------------------------------------------------------
router.get("/hr/me/dashboard",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.dashboard"),
  requirePermission("hr_dashboard", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const requestId = (req as any).id ?? `hr-deprecated-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`;
    req.log?.warn?.({
      route: req.originalUrl,
      firmId: req.firmId,
      userId: req.userId,
      requestId,
      routeDeprecation: "hr_me_dashboard_alias",
      recommended: "/hr/dashboard/summary",
    }, "DEPRECATED: /hr/me/dashboard called — use /hr/dashboard/summary instead");
    await handleDashboardSummary(req, res);
  },
);

// ---------------------------------------------------------------------------
// §10 Compatibility: Legacy /hr/dashboard/stats. Calls SAME SERVICE as summary
// to eliminate conflicting business definitions
// ---------------------------------------------------------------------------
router.get("/hr/dashboard/stats", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.dashboard"), requirePermission("hr_dashboard", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;
    const roleName = resolveRoleName(req);
    const summary = await getHrDashboardSummary({ firmId, userId, roleName, roleId, tx: req.rlsDb });
    const legacy: LegacyHrDashboardStats = {
      headcount: summary.totalEmployees,
      pendingLeaves: summary.pendingLeave,
      pendingClaims: summary.pendingClaims,
    };
    res.json({
      ok: true,
      data: legacy,
      _canonicalSummary: summary,
      meta: {
        request_id: (req as any).id ?? `hr-legacy-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId, stage: "hr_dashboard_stats" }, "hr.dashboard_stats_failed");
    res.status(500).json({
      ok: false,
      error: {
        code: err?.code ?? "HR_DASHBOARD_STATS_UNAVAILABLE",
        message: "HR dashboard stats are temporarily unavailable.",
        retryable: true,
      },
      requestId: (req as any).id ?? `hr-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`,
    });
    return;
  }
});

export default expressRouter;
