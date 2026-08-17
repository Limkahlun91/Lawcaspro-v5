import express, { type Response, type Router as ExpressRouter } from "express";
import { and, eq, count, or, sql, inArray, like } from "drizzle-orm";
import {
  db,
  hrEmployeesTable,
  hrFirmFeatureFlagsTable,
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

export type HrDashboardPayrollLabel = "Not Started" | "Draft" | "Processing" | "Completed";
export type HrDashboardSummary = {
  totalEmployees: number;
  activeToday: number;
  onLeaveToday: number;
  pendingLeave: number;
  pendingClaims: number;
  payroll: { label: HrDashboardPayrollLabel; period: string | null } | null;
};

export type LegacyHrDashboardStats = {
  headcount: number;
  pendingLeaves: number;
  pendingClaims: number;
};

// ---------------------------------------------------------------------------
// Canonical service (one aggregate DB query per metric, no 6 separate HTTP).
// NOTE: Current drizzle schema ships hrEmployeesTable + hrFirmFeatureFlagsTable.
// Attendance / LeaveRequests / Claims / PayrollRuns tables are NOT yet part of
// @workspace/db canonical schema — those routes remain scaffold-level (mock).
// We compute totalEmployees from the real table and return zeros for
// metrics without schema (consistent with scaffold services).
// ---------------------------------------------------------------------------
export async function getHrDashboardSummary(input: {
  firmId: number;
  userId: number;
  roleName: string | null;
  roleId: number | null;
  tx?: any;
}): Promise<HrDashboardSummary> {
  const firmId = input.firmId;
  const r = input.tx ?? db;

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
  } catch {
    totalEmployees = 0;
  }

  const activeToday = 0;
  const onLeaveToday = 0;
  const pendingLeave = 0;
  const pendingClaims = 0;
  const payroll: HrDashboardSummary["payroll"] = null;

  return {
    totalEmployees,
    activeToday,
    onLeaveToday,
    pendingLeave,
    pendingClaims,
    payroll,
  };
}

function resolveRoleName(req: AuthRequest): string | null {
  const cache = (req as any)._roleCache as { name?: string } | undefined;
  if (cache?.name) return String(cache.name);
  if (typeof (req as any).roleName === "string") return String((req as any).roleName);
  return null;
}

// ---------------------------------------------------------------------------
// §10: Canonical dashboard route (ME dashboard — self or admin scope)
// ---------------------------------------------------------------------------
router.get("/hr/me/dashboard", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.dashboard"), requirePermission("hr_dashboard", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;
    const roleName = resolveRoleName(req);
    const isPartner = isPartnerRoleName(roleName) || Boolean((req as any).isFirmManagement);
    const summary = await getHrDashboardSummary({ firmId, userId, roleName, roleId, tx: req.rlsDb });
    // Self service: if user is NOT Partner/admin, still return canonical 6 fields.
    // UI will render Quick Actions filtered by feature access.
    res.json({
      ok: true,
      data: summary,
      meta: {
        request_id: (req as any).id ?? `hr-dash-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`,
        scope: isPartner ? "firm" : "self",
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
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId, stage: "hr_me_dashboard" }, "hr.me_dashboard_failed");
    // §14 safe wrap: never expose SQL / params / NRIC
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
});

// ---------------------------------------------------------------------------
// §10 Compatibility: Legacy /hr/dashboard/stats. Calls SAME SERVICE as me/dashboard
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
