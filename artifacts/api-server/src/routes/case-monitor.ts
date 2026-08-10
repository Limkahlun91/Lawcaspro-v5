import express from "express";
import type { Response } from "express";
import { z } from "zod";
import { and, eq, inArray, isNull, ne, desc, sql, count } from "drizzle-orm";
import {
  caseBottleneckSnapshotsTable,
  caseMonitorLogsTable,
  casesTable,
  paymentVouchersTable,
  accountingSettingsTable,
  db,
  rolesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog, requireManagementRoleForDashboard } from "../lib/auth.js";
import { extractDbErrorInfo } from "../lib/db-error.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  use: (...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const rdb = (req: AuthRequest) => req.rlsDb ?? db;

const one = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return typeof v[0] !== "object" ? String(v[0]) : undefined;
  if (typeof v === "object") return undefined;
  return String(v);
};

const asInt = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

const ResolveSchema = z.object({
  note: z.string().trim().min(3, "Resolve note is required (minimum 3 characters)").max(1000),
});

const EscalateSchema = z.object({
  targetPartnerUserId: z.string().optional(),
  note: z.string().trim().max(1000).optional(),
});

type BottleneckKind = "case_no_movement" | "case_waiting" | "case_on_hold" | "pv_delay" | "urgent" | "approval_waiting";

type CaseMonitorErrorClass =
  | "CASE_MONITOR_DEPENDENCY_UNAVAILABLE"
  | "CASE_MONITOR_QUERY_FAILED"
  | "CASE_MONITOR_SCHEMA_MISMATCH"
  | "CASE_MONITOR_PERMISSION"
  | "CASE_MONITOR_MUTATION_FAILED";

function emitCaseMonitorErrorLog(
  req: AuthRequest,
  route: string,
  err: unknown,
  defaultClass: CaseMonitorErrorClass = "CASE_MONITOR_QUERY_FAILED",
): { errorCode: CaseMonitorErrorClass; sqlState: string | null | undefined; schemaObject: { table?: string | null; column?: string | null; constraint?: string | null } } {
  const info = extractDbErrorInfo(err);
  const sqlState = info.sqlstate ?? info.sqlState ?? null;
  const schemaObject = { table: info.table ?? null, column: info.column ?? null, constraint: info.constraint ?? null };
  let resolvedClass: CaseMonitorErrorClass = defaultClass;
  if (sqlState === "42P01" || sqlState === "42703" || sqlState === "42804" || schemaObject.table || schemaObject.column) {
    resolvedClass = "CASE_MONITOR_SCHEMA_MISMATCH";
  } else if (sqlState === "42501") {
    resolvedClass = "CASE_MONITOR_PERMISSION";
  } else if (sqlState === "57014" || sqlState === "57P01" || sqlState === "08006" || sqlState === "08001" || sqlState === "53300") {
    resolvedClass = "CASE_MONITOR_DEPENDENCY_UNAVAILABLE";
  }
  const payload: Record<string, unknown> = {
    event: "case_monitor_query_failed",
    route,
    firmId: req.firmId ?? null,
    userId: req.userId ?? null,
    requestId: (req as any).id ?? (req as any).requestId ?? null,
    sqlState,
    errorCode: resolvedClass,
    schemaObject,
  };
  try {
    const logFn: any = (req as any).log ?? console;
    if (logFn && typeof logFn.error === "function") {
      logFn.error({ err, ...payload }, "case_monitor_query_failed");
    } else {
      console.error("[case_monitor_query_failed]", JSON.stringify(payload));
    }
  } catch {
    console.error("[case_monitor_query_failed]", JSON.stringify(payload));
  }
  return { errorCode: resolvedClass, sqlState, schemaObject };
}

export type SummaryShape = {
  total: number;
  bySeverity: Record<string, number>;
  byKind: Record<string, number>;
  byLawyer: Array<{ userId: number; userName: string; count: number }>;
  byManager: Array<{ userId: number; userName: string; count: number }>;
  pvDelays: number;
  waitingCount: number;
  onHoldCount: number;
  approvalWaitingCount: number;
  urgentCount: number;
  attentionCount: number;
  criticalCount: number;
  escalatedToPartnerCount: number;
  partnerEscalationMode: "never" | "attention" | "urgent" | "critical";
};

router.get(
  "/case-monitor/summary",
  requireAuth,
  requireFirmUser,
  requirePermission("case_monitor", "view"),
  requireManagementRoleForDashboard,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const firmId = Number(req.firmId);
      if (!Number.isFinite(firmId)) { res.status(400).json({ error: "Invalid firm context" }); return; }
      const orm = rdb(req);
      const totalsRows = await orm
        .select({ total: count(caseBottleneckSnapshotsTable.id).mapWith(Number) })
        .from(caseBottleneckSnapshotsTable)
        .where(and(
          eq(caseBottleneckSnapshotsTable.firmId, firmId),
          isNull(caseBottleneckSnapshotsTable.resolvedAt),
        ));

      const escalatedRows = await orm
        .select({ count: count(caseBottleneckSnapshotsTable.id).mapWith(Number) })
        .from(caseBottleneckSnapshotsTable)
        .where(and(
          eq(caseBottleneckSnapshotsTable.firmId, firmId),
          isNull(caseBottleneckSnapshotsTable.resolvedAt),
          eq(caseBottleneckSnapshotsTable.escalatedToPartner, true),
        ));

      const sevGrp = await orm
        .select({
          severity: caseBottleneckSnapshotsTable.severity,
          count: count(caseBottleneckSnapshotsTable.id).mapWith(Number),
        })
        .from(caseBottleneckSnapshotsTable)
        .where(and(
          eq(caseBottleneckSnapshotsTable.firmId, firmId),
          isNull(caseBottleneckSnapshotsTable.resolvedAt),
        ))
        .groupBy(caseBottleneckSnapshotsTable.severity);

      const kindGrp = await orm
        .select({
          monitorKind: caseBottleneckSnapshotsTable.monitorKind,
          count: count(caseBottleneckSnapshotsTable.id).mapWith(Number),
        })
        .from(caseBottleneckSnapshotsTable)
        .where(and(
          eq(caseBottleneckSnapshotsTable.firmId, firmId),
          isNull(caseBottleneckSnapshotsTable.resolvedAt),
        ))
        .groupBy(caseBottleneckSnapshotsTable.monitorKind);

      const lawyerGrp = await orm
        .select({
          userId: caseBottleneckSnapshotsTable.responsibleLawyerUserId,
          count: count(caseBottleneckSnapshotsTable.id).mapWith(Number),
        })
        .from(caseBottleneckSnapshotsTable)
        .where(and(
          eq(caseBottleneckSnapshotsTable.firmId, firmId),
          isNull(caseBottleneckSnapshotsTable.resolvedAt),
          ne(caseBottleneckSnapshotsTable.responsibleLawyerUserId, sql`NULL`),
        ))
        .groupBy(caseBottleneckSnapshotsTable.responsibleLawyerUserId);

      const managerGrp = await orm
        .select({
          userId: caseBottleneckSnapshotsTable.responsibleManagerUserId,
          count: count(caseBottleneckSnapshotsTable.id).mapWith(Number),
        })
        .from(caseBottleneckSnapshotsTable)
        .where(and(
          eq(caseBottleneckSnapshotsTable.firmId, firmId),
          isNull(caseBottleneckSnapshotsTable.resolvedAt),
          ne(caseBottleneckSnapshotsTable.responsibleManagerUserId, sql`NULL`),
        ))
        .groupBy(caseBottleneckSnapshotsTable.responsibleManagerUserId);

      const escalationCfgRows = await orm
        .select({ approvalRules: accountingSettingsTable.approvalRules })
        .from(accountingSettingsTable)
        .where(eq(accountingSettingsTable.firmId, firmId))
        .limit(1);

      const blob: any = (escalationCfgRows[0] as any)?.approvalRules ?? {};
      const candidate = typeof blob === "object" && blob && "bottleneckEscalation" in blob ? (blob as any).bottleneckEscalation : {};
      const partnerEscalationMode: SummaryShape["partnerEscalationMode"] =
        candidate?.escalateToPartnerAtSeverity === "critical" ||
        candidate?.escalateToPartnerAtSeverity === "urgent" ||
        candidate?.escalateToPartnerAtSeverity === "attention"
          ? candidate.escalateToPartnerAtSeverity
          : "never";

      const lawyerIds = lawyerGrp.map((r) => r.userId).filter((n): n is number => Number.isFinite(n));
      const managerIds = managerGrp.map((r) => r.userId).filter((n): n is number => Number.isFinite(n));
      const bothIds = Array.from(new Set<number>([...lawyerIds, ...managerIds]));
      const users = bothIds.length > 0
        ? await orm.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, bothIds))
        : [];
      const userNameMap = new Map<number, string>(users.map((u) => [u.id, u.name]));

      const bySeverity: Record<string, number> = {};
      for (const r of sevGrp) bySeverity[String(r.severity)] = r.count;
      const byKind: Record<string, number> = {};
      for (const r of kindGrp) byKind[String(r.monitorKind)] = r.count;

      const summary: SummaryShape = {
        total: totalsRows[0]?.total ?? 0,
        bySeverity,
        byKind,
        byLawyer: lawyerGrp
          .filter((r) => Number.isFinite(r.userId))
          .map((r) => ({
            userId: r.userId as number,
            userName: userNameMap.get(r.userId as number) ?? `#${r.userId}`,
            count: r.count,
          }))
          .sort((a, b) => b.count - a.count),
        byManager: managerGrp
          .filter((r) => Number.isFinite(r.userId))
          .map((r) => ({
            userId: r.userId as number,
            userName: userNameMap.get(r.userId as number) ?? `#${r.userId}`,
            count: r.count,
          }))
          .sort((a, b) => b.count - a.count),
        pvDelays: byKind["pv_delay"] ?? 0,
        waitingCount: byKind["case_waiting"] ?? 0,
        onHoldCount: byKind["case_on_hold"] ?? 0,
        approvalWaitingCount: byKind["approval_waiting"] ?? 0,
        urgentCount: bySeverity["urgent"] ?? 0,
        attentionCount: bySeverity["attention"] ?? 0,
        criticalCount: bySeverity["critical"] ?? 0,
        escalatedToPartnerCount: escalatedRows[0]?.count ?? 0,
        partnerEscalationMode,
      };
      res.json(summary);
    } catch (err) {
      const diag = emitCaseMonitorErrorLog(req, "/case-monitor/summary", err, "CASE_MONITOR_DEPENDENCY_UNAVAILABLE");
      const httpStatus =
        diag.errorCode === "CASE_MONITOR_SCHEMA_MISMATCH" || diag.errorCode === "CASE_MONITOR_DEPENDENCY_UNAVAILABLE"
          ? 503
          : 500;
      res.status(httpStatus).json({
        error: diag.errorCode,
        dependency: diag.errorCode === "CASE_MONITOR_DEPENDENCY_UNAVAILABLE" ? "case_bottleneck_snapshots" : undefined,
        sqlState: diag.sqlState ?? undefined,
        schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      });
    }
  }
);

router.get(
  "/case-monitor/bottlenecks",
  requireAuth,
  requireFirmUser,
  requirePermission("case_monitor", "view"),
  requireManagementRoleForDashboard,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const firmId = Number(req.firmId);
      if (!Number.isFinite(firmId)) { res.status(400).json({ error: "Invalid firm context" }); return; }
      const orm = rdb(req);

      const includeResolvedRaw = one(req.query.includeResolved);
      const kindRaw = one(req.query.kind);
      const severityRaw = one(req.query.severity);
      const lawyerId = asInt(one(req.query.lawyerId));
      const managerId = asInt(one(req.query.managerId));
      const caseId = asInt(one(req.query.case_id));
      const paymentVoucherId = asInt(one(req.query.payment_voucher_id));
      const onlyEscalated = one(req.query.onlyEscalated) === "1";
      const limit = Math.min(asInt(one(req.query.limit)) ?? 100, 500);
      const offset = asInt(one(req.query.offset)) ?? 0;

      const where = [eq(caseBottleneckSnapshotsTable.firmId, firmId)];
      if (includeResolvedRaw !== "1") where.push(isNull(caseBottleneckSnapshotsTable.resolvedAt));
      if (kindRaw) where.push(eq(caseBottleneckSnapshotsTable.monitorKind, kindRaw as BottleneckKind));
      if (severityRaw) where.push(eq(caseBottleneckSnapshotsTable.severity, severityRaw as any));
      if (lawyerId) where.push(eq(caseBottleneckSnapshotsTable.responsibleLawyerUserId, lawyerId));
      if (managerId) where.push(eq(caseBottleneckSnapshotsTable.responsibleManagerUserId, managerId));
      if (caseId) where.push(eq(caseBottleneckSnapshotsTable.caseId, caseId));
      if (paymentVoucherId) where.push(eq(caseBottleneckSnapshotsTable.paymentVoucherId, paymentVoucherId));
      if (onlyEscalated) where.push(eq(caseBottleneckSnapshotsTable.escalatedToPartner, true));

      const rows = await orm
        .select({
          id: caseBottleneckSnapshotsTable.id,
          monitorKind: caseBottleneckSnapshotsTable.monitorKind,
          severity: caseBottleneckSnapshotsTable.severity,
          daysStuck: caseBottleneckSnapshotsTable.daysStuck,
          title: caseBottleneckSnapshotsTable.title,
          detail: caseBottleneckSnapshotsTable.detail,
          metadata: caseBottleneckSnapshotsTable.metadata,
          escalatedToPartner: caseBottleneckSnapshotsTable.escalatedToPartner,
          escalatedAt: caseBottleneckSnapshotsTable.escalatedAt,
          resolvedAt: caseBottleneckSnapshotsTable.resolvedAt,
          caseId: caseBottleneckSnapshotsTable.caseId,
          paymentVoucherId: caseBottleneckSnapshotsTable.paymentVoucherId,
          responsibleLawyerUserId: caseBottleneckSnapshotsTable.responsibleLawyerUserId,
          responsibleManagerUserId: caseBottleneckSnapshotsTable.responsibleManagerUserId,
          createdAt: caseBottleneckSnapshotsTable.createdAt,
          updatedAt: caseBottleneckSnapshotsTable.updatedAt,
          caseReferenceNo: casesTable.referenceNo,
          caseType: casesTable.caseType,
          voucherNo: paymentVouchersTable.voucherNo,
          lawyerName: usersTable.name,
        })
        .from(caseBottleneckSnapshotsTable)
        .leftJoin(casesTable, eq(casesTable.id, caseBottleneckSnapshotsTable.caseId))
        .leftJoin(paymentVouchersTable, eq(paymentVouchersTable.id, caseBottleneckSnapshotsTable.paymentVoucherId))
        .leftJoin(usersTable, eq(usersTable.id, caseBottleneckSnapshotsTable.responsibleLawyerUserId))
        .where(and(...where))
        .orderBy(desc(caseBottleneckSnapshotsTable.severity), desc(caseBottleneckSnapshotsTable.daysStuck), desc(caseBottleneckSnapshotsTable.createdAt))
        .limit(limit)
        .offset(offset);

      res.json({
        items: rows.map((r) => ({
          id: r.id,
          monitorKind: r.monitorKind,
          severity: r.severity,
          daysStuck: r.daysStuck,
          title: r.title,
          detail: r.detail,
          metadata: r.metadata ?? {},
          escalatedToPartner: r.escalatedToPartner,
          escalatedAt: r.escalatedAt,
          resolvedAt: r.resolvedAt,
          caseId: r.caseId,
          caseReferenceNo: r.caseReferenceNo,
          caseType: r.caseType,
          paymentVoucherId: r.paymentVoucherId,
          voucherNo: r.voucherNo,
          responsibleLawyerUserId: r.responsibleLawyerUserId,
          lawyerName: r.lawyerName,
          responsibleManagerUserId: r.responsibleManagerUserId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        limit,
        offset,
      });
    } catch (err) {
      const diag = emitCaseMonitorErrorLog(req, "/case-monitor/bottlenecks", err, "CASE_MONITOR_DEPENDENCY_UNAVAILABLE");
      const httpStatus =
        diag.errorCode === "CASE_MONITOR_SCHEMA_MISMATCH" || diag.errorCode === "CASE_MONITOR_DEPENDENCY_UNAVAILABLE"
          ? 503
          : 500;
      res.status(httpStatus).json({
        error: diag.errorCode,
        dependency: diag.errorCode === "CASE_MONITOR_DEPENDENCY_UNAVAILABLE" ? "case_bottleneck_snapshots" : undefined,
        sqlState: diag.sqlState ?? undefined,
        schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      });
    }
  }
);

router.post(
  "/case-monitor/bottlenecks/:id/resolve",
  requireAuth,
  requireFirmUser,
  requirePermission("case_monitor", "view"),
  requireManagementRoleForDashboard,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const firmId = Number(req.firmId);
      if (!Number.isFinite(firmId)) { res.status(400).json({ error: "Invalid firm context" }); return; }
      const id = asInt(one(req.params.id as any));
      if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid bottleneck id" }); return; }
      const parsed = ResolveSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Invalid payload", details: parsed.error.issues }); return; }

      const orm = rdb(req);
      const existing = await orm
        .select({
          id: caseBottleneckSnapshotsTable.id,
          firmId: caseBottleneckSnapshotsTable.firmId,
          resolvedAt: caseBottleneckSnapshotsTable.resolvedAt,
          caseId: caseBottleneckSnapshotsTable.caseId,
        })
        .from(caseBottleneckSnapshotsTable)
        .where(eq(caseBottleneckSnapshotsTable.id, id))
        .limit(1);
      if (existing.length === 0) { res.status(404).json({ error: "Bottleneck not found" }); return; }
      if (existing[0].firmId !== firmId) { res.status(403).json({ error: "Firm mismatch" }); return; }
      if (existing[0].resolvedAt) { res.status(400).json({ error: "Already resolved" }); return; }

      const actorUserId = Number(req.userId);
      const now = new Date();
      await orm
        .update(caseBottleneckSnapshotsTable)
        .set({
          resolvedAt: now,
          resolvedBy: actorUserId,
          resolvedNote: parsed.data.note,
          updatedAt: now,
        })
        .where(eq(caseBottleneckSnapshotsTable.id, id));

      await orm.insert(caseMonitorLogsTable).values({
        firmId,
        snapshotId: id,
        caseId: existing[0].caseId ?? null,
        actorUserId,
        action: "resolve",
        notes: parsed.data.note,
        ipAddress: String((req as any).ip ?? req.headers["x-forwarded-for"] ?? "").slice(0, 64) || null,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 255) || null,
      });

      await writeAuditLog({
        firmId,
        actorId: actorUserId,
        entityType: "case_bottleneck",
        entityId: id,
        action: "resolve",
        detail: parsed.data.note,
        ipAddress: String((req as any).ip ?? req.headers["x-forwarded-for"] ?? "").slice(0, 64) || null,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 255) || null,
      });

      res.json({ ok: true, resolvedAt: now });
    } catch (err) {
      const diag = emitCaseMonitorErrorLog(req, "/case-monitor/bottlenecks/:id/resolve", err, "CASE_MONITOR_MUTATION_FAILED");
      res.status(diag.errorCode === "CASE_MONITOR_SCHEMA_MISMATCH" ? 503 : 500).json({
        error: diag.errorCode,
        sqlState: diag.sqlState ?? undefined,
        schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      });
    }
  }
);

router.post(
  "/case-monitor/bottlenecks/:id/escalate",
  requireAuth,
  requireFirmUser,
  requirePermission("case_monitor", "view"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const firmId = Number(req.firmId);
      if (!Number.isFinite(firmId)) { res.status(400).json({ error: "Invalid firm context" }); return; }
      const id = asInt(one(req.params.id as any));
      if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid bottleneck id" }); return; }
      const parsed = EscalateSchema.safeParse(req.body ?? {});
      if (!parsed.success) { res.status(400).json({ error: "Invalid payload", details: parsed.error.issues }); return; }

      const orm = rdb(req);
      const existing = await orm
        .select({
          id: caseBottleneckSnapshotsTable.id,
          firmId: caseBottleneckSnapshotsTable.firmId,
          resolvedAt: caseBottleneckSnapshotsTable.resolvedAt,
          caseId: caseBottleneckSnapshotsTable.caseId,
        })
        .from(caseBottleneckSnapshotsTable)
        .where(eq(caseBottleneckSnapshotsTable.id, id))
        .limit(1);
      if (existing.length === 0) { res.status(404).json({ error: "Bottleneck not found" }); return; }
      if (existing[0].firmId !== firmId) { res.status(403).json({ error: "Firm mismatch" }); return; }
      if (existing[0].resolvedAt) { res.status(400).json({ error: "Already resolved, cannot escalate" }); return; }

      let targetPartnerUserId: number | null = null;
      if (parsed.data.targetPartnerUserId) {
        const maybe = asInt(parsed.data.targetPartnerUserId);
        if (!Number.isFinite(maybe)) { res.status(400).json({ error: "Invalid targetPartnerUserId" }); return; }
        const checkPartner = await orm
          .select({ userId: usersTable.id })
          .from(usersTable)
          .innerJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
          .where(and(
            eq(usersTable.firmId, firmId),
            eq(usersTable.status, "active"),
            eq(usersTable.id, maybe),
            sql`LOWER(${rolesTable.name}) = 'partner'`,
          ))
          .limit(1);
        if (checkPartner.length === 0) { res.status(400).json({ error: "Target user is not an active Partner in this firm" }); return; }
        targetPartnerUserId = maybe;
      }

      const actorUserId = Number(req.userId);
      const now = new Date();
      await orm
        .update(caseBottleneckSnapshotsTable)
        .set({
          escalatedToPartner: true,
          escalatedAt: now,
          updatedAt: now,
        })
        .where(eq(caseBottleneckSnapshotsTable.id, id));

      const noteContent = parsed.data.note || (targetPartnerUserId ? `Escalated to user #${targetPartnerUserId}` : "Escalated to all Partners");
      await orm.insert(caseMonitorLogsTable).values({
        firmId,
        snapshotId: id,
        caseId: existing[0].caseId ?? null,
        actorUserId,
        action: "escalate",
        notes: noteContent,
        metadata: targetPartnerUserId ? { targetPartnerUserId } : { allPartners: true },
        ipAddress: String((req as any).ip ?? req.headers["x-forwarded-for"] ?? "").slice(0, 64) || null,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 255) || null,
      });

      await writeAuditLog({
        firmId,
        actorId: actorUserId,
        entityType: "case_bottleneck",
        entityId: id,
        action: "escalate",
        detail: noteContent,
        ipAddress: String((req as any).ip ?? req.headers["x-forwarded-for"] ?? "").slice(0, 64) || null,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 255) || null,
      });

      res.json({ ok: true, escalatedAt: now, targetPartnerUserId, allPartners: targetPartnerUserId == null });
    } catch (err) {
      const diag = emitCaseMonitorErrorLog(req, "/case-monitor/bottlenecks/:id/escalate", err, "CASE_MONITOR_MUTATION_FAILED");
      res.status(diag.errorCode === "CASE_MONITOR_SCHEMA_MISMATCH" ? 503 : 500).json({
        error: diag.errorCode,
        sqlState: diag.sqlState ?? undefined,
        schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      });
    }
  }
);

export default router;
