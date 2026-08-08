import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db, paymentVouchersTable, permissionsTable, rolesTable, userNotificationsTable, usersTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { extractDbErrorInfo } from "../lib/db-error.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const rdb = (req: AuthRequest) => req.rlsDb ?? db;

const one = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === "string") return v || undefined;
  if (Array.isArray(v)) {
    const first = (v as unknown[])[0];
    return typeof first === "string" ? first || undefined : undefined;
  }
  if (typeof v === "number") return String(v);
  return undefined;
};
const asInt = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
};
const asBoolean = (v: string | undefined): boolean | undefined => {
  if (v == null) return undefined;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
};

const ACTIVE_STATUSES = ["unread", "read", "acknowledged", "escalated"] as const;
const SEVERITY_ORDER: Record<string, number> = { critical: 4, urgent: 3, high: 2, normal: 1, info: 0 };

type NotifErrorClass = "NOTIFICATION_QUERY_FAILED" | "NOTIFICATION_SCHEMA_MISMATCH" | "NOTIFICATION_PERMISSION" | "NOTIFICATION_MUTATION_FAILED";

function emitNotifQueryErrorLog(
  req: AuthRequest,
  route: string,
  err: unknown,
  errorClass: NotifErrorClass = "NOTIFICATION_QUERY_FAILED",
): { errorCode: NotifErrorClass; sqlState: string | null | undefined; schemaObject: { table?: string | null; column?: string | null; constraint?: string | null } } {
  const info = extractDbErrorInfo(err);
  const sqlState = info.sqlstate ?? info.sqlState ?? null;
  const schemaObject = {
    table: info.table ?? null,
    column: info.column ?? null,
    constraint: info.constraint ?? null,
  };
  let resolvedClass: NotifErrorClass = errorClass;
  if (sqlState === "42703" || sqlState === "42P01" || sqlState === "42804" || schemaObject.table || schemaObject.column) {
    resolvedClass = "NOTIFICATION_SCHEMA_MISMATCH";
  } else if (sqlState === "42501") {
    resolvedClass = "NOTIFICATION_PERMISSION";
  }
  const payload: Record<string, unknown> = {
    event: "user_notifications_query_failed",
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
      logFn.error({ err, ...payload }, "user_notifications_query_failed");
    } else {
      console.error("[user_notifications_query_failed]", JSON.stringify(payload));
    }
  } catch {
    console.error("[user_notifications_query_failed]", JSON.stringify(payload));
  }
  return { errorCode: resolvedClass, sqlState, schemaObject };
}

const UN_PERM_CACHE_KEY = Symbol.for("user_notifications_perm_cache");
type UnPermRow = { module: string; action: string; allowed: boolean };
async function getOrLoadUnPerms(req: AuthRequest): Promise<UnPermRow[]> {
  const anyReq = req as unknown as { [UN_PERM_CACHE_KEY]?: Promise<UnPermRow[]> | UnPermRow[] };
  if (anyReq[UN_PERM_CACHE_KEY]) {
    return (await anyReq[UN_PERM_CACHE_KEY]) ?? [];
  }
  const prom = (async (): Promise<UnPermRow[]> => {
    if (!req.firmId || !req.roleId) return [];
    try {
      return await rdb(req)
        .select({ module: permissionsTable.module, action: permissionsTable.action, allowed: permissionsTable.allowed })
        .from(permissionsTable)
        .where(and(eq(permissionsTable.roleId, req.roleId), eq(permissionsTable.allowed, true)));
    } catch {
      return [];
    }
  })();
  anyReq[UN_PERM_CACHE_KEY] = prom;
  return await prom;
}
async function hasPerm(req: AuthRequest, moduleName: string, action: string): Promise<boolean> {
  const list = await getOrLoadUnPerms(req);
  return list.some((p) => p.module === moduleName && p.action === action && p.allowed);
}
async function getRoleName(req: AuthRequest): Promise<string> {
  return String((req as { roleName?: unknown }).roleName ?? "").trim();
}

const MarkReadSchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500).optional() });
const MarkAcknowledgeSchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500).optional(), note: z.string().trim().max(1000).optional() });
const DismissSchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500).optional(), reason: z.string().trim().max(1000).optional() });
const EscalateSchema = z.object({ targetPartnerUserId: z.string().optional(), note: z.string().trim().max(1000).optional() });

router.get("/user-notifications/unread-count", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const countRow = await rdb(req)
      .select({ count: count() })
      .from(userNotificationsTable)
      .where(and(
        eq(userNotificationsTable.firmId, firmId),
        eq(userNotificationsTable.userId, userId),
        inArray(userNotificationsTable.status, ACTIVE_STATUSES as unknown as string[]),
        eq(userNotificationsTable.isRead, false),
      ));
    res.json({ count: Number(countRow?.[0]?.count ?? 0) });
  } catch (e) {
    const diag = emitNotifQueryErrorLog(req, "/user-notifications/unread-count", e);
    res.status(diag.errorCode === "NOTIFICATION_SCHEMA_MISMATCH" ? 503 : 500).json({
      error: diag.errorCode,
      errorClass: "NOTIFICATION_SCHEMA_MISMATCH" === diag.errorCode ? "schema" : "query",
      sqlState: diag.sqlState ?? undefined,
      schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      message: "unread_count_unavailable",
    });
  }
});

router.get("/user-notifications/summary", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const firmId = req.firmId!;
    const userId = req.userId!;
    const baseWhere = and(eq(userNotificationsTable.firmId, firmId), eq(userNotificationsTable.userId, userId));
    const activeWhere = and(baseWhere, inArray(userNotificationsTable.status, ACTIVE_STATUSES as unknown as string[]));
    const total = await rdb(req).$count(userNotificationsTable, baseWhere);
    const unread = await rdb(req).$count(userNotificationsTable, and(baseWhere, eq(userNotificationsTable.status, "unread")));
    const activeDistinctCount = await rdb(req).$count(userNotificationsTable, activeWhere);
    const criticalRows = await rdb(req).selectDistinct({ id: userNotificationsTable.id }).from(userNotificationsTable).where(and(activeWhere, inArray(userNotificationsTable.severity, ["urgent", "critical"])));
    const escalatedRows = await rdb(req).selectDistinct({ id: userNotificationsTable.id }).from(userNotificationsTable).where(and(activeWhere, eq(userNotificationsTable.status, "escalated")));
    const overdueRows = await rdb(req).selectDistinct({ id: userNotificationsTable.id }).from(userNotificationsTable).where(and(activeWhere, sql`coalesce(${userNotificationsTable.acknowledgementDueAt}, ${userNotificationsTable.resolutionSlaDueAt}) < ${now}`));
    const urgent = criticalRows.length;
    const escalated = escalatedRows.length;
    const overdue = overdueRows.length;
    const criticalOverdue = criticalRows.filter(r => overdueRows.some(o => o.id === r.id)).length;
    const criticalEscalated = criticalRows.filter(r => escalatedRows.some(e => e.id === r.id)).length;
    const overdueEscalated = overdueRows.filter(r => escalatedRows.some(e => e.id === r.id)).length;
    const allThree = criticalRows.filter(r => escalatedRows.some(e => e.id === r.id) && overdueRows.some(o => o.id === r.id)).length;
    const monitorUniqueCount = await rdb(req).$count(
      userNotificationsTable,
      and(
        activeWhere,
        sql`(
          ${userNotificationsTable.severity} in ('urgent','critical')
          or ${userNotificationsTable.status} = 'escalated'
          or coalesce(${userNotificationsTable.acknowledgementDueAt}, ${userNotificationsTable.resolutionSlaDueAt}) < ${now}
        )`
      )
    );
    const byStatusRows = await rdb(req).select({ status: userNotificationsTable.status, count: count() }).from(userNotificationsTable).where(baseWhere).groupBy(userNotificationsTable.status);
    const bySeverityRows = await rdb(req).select({ severity: userNotificationsTable.severity, count: count() }).from(userNotificationsTable).where(activeWhere).groupBy(userNotificationsTable.severity);
    const byScopeRows = await rdb(req).select({ targetScope: userNotificationsTable.targetScope, count: count() }).from(userNotificationsTable).where(activeWhere).groupBy(userNotificationsTable.targetScope);
    res.json({
      total, unread, urgent, escalated, overdue, activeDistinctCount, monitorUniqueCount,
      overlap: { criticalOverdue, criticalEscalated, overdueEscalated, allThree },
      byStatus: Object.fromEntries(byStatusRows.map(r => [r.status ?? "unknown", Number(r.count)])),
      bySeverity: Object.fromEntries(bySeverityRows.map(r => [r.severity ?? "unknown", Number(r.count)])),
      byTargetScope: Object.fromEntries(byScopeRows.map(r => [r.targetScope ?? "user", Number(r.count)])),
    });
  } catch (e) {
    const diag = emitNotifQueryErrorLog(req, "/user-notifications/summary", e);
    res.status(diag.errorCode === "NOTIFICATION_SCHEMA_MISMATCH" ? 503 : 500).json({
      error: diag.errorCode,
      errorClass: diag.errorCode === "NOTIFICATION_SCHEMA_MISMATCH" ? "schema" : "query",
      sqlState: diag.sqlState ?? undefined,
      schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      message: "summary_unavailable",
    });
  }
});

router.get("/user-notifications", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const status = one(req.query.status);
    const severity = one(req.query.severity);
    const scope = one(req.query.target_scope);
    const sourceType = one(req.query.source_type);
    const onlyActive = asBoolean(one(req.query.only_active));
    const onlyEscalated = asBoolean(one(req.query.only_escalated));
    const onlyOverdue = asBoolean(one(req.query.only_overdue));
    const caseId = asInt(one(req.query.case_id));
    const offset = Math.max(0, asInt(one(req.query.offset)) ?? 0);
    const limitRaw = asInt(one(req.query.limit)) ?? 30;
    const limit = Math.min(200, Math.max(1, limitRaw));
    const now = new Date();
    const where = [eq(userNotificationsTable.firmId, firmId), eq(userNotificationsTable.userId, userId)];
    if (onlyEscalated) where.push(eq(userNotificationsTable.status, "escalated"));
    else if (status) where.push(eq(userNotificationsTable.status, status));
    else if (onlyActive) where.push(inArray(userNotificationsTable.status, ACTIVE_STATUSES as unknown as string[]));
    if (severity) where.push(eq(userNotificationsTable.severity, severity));
    if (scope) where.push(eq(userNotificationsTable.targetScope, scope));
    if (sourceType) where.push(eq(userNotificationsTable.sourceType, sourceType));
    if (caseId) where.push(eq(userNotificationsTable.caseId, caseId));
    if (onlyOverdue) where.push(and(sql`coalesce(${userNotificationsTable.acknowledgementDueAt}, ${userNotificationsTable.resolutionSlaDueAt}) IS NOT NULL`, sql`coalesce(${userNotificationsTable.acknowledgementDueAt}, ${userNotificationsTable.resolutionSlaDueAt}) < ${now}`));
    const [countRow] = await rdb(req).select({ count: count() }).from(userNotificationsTable).where(and(...where));
    const items = await rdb(req)
      .select({
        id: userNotificationsTable.id,
        status: userNotificationsTable.status,
        severity: userNotificationsTable.severity,
        targetScope: userNotificationsTable.targetScope,
        dismissible: userNotificationsTable.dismissible,
        sourceType: userNotificationsTable.sourceType,
        sourceId: userNotificationsTable.sourceId,
        caseId: userNotificationsTable.caseId,
        notificationType: userNotificationsTable.notificationType,
        title: userNotificationsTable.title,
        message: userNotificationsTable.message,
        meta: userNotificationsTable.meta,
        isRead: userNotificationsTable.isRead,
        readAt: userNotificationsTable.readAt,
        acknowledgedAt: userNotificationsTable.acknowledgedAt,
        escalatedAt: userNotificationsTable.escalatedAt,
        resolvedAt: userNotificationsTable.resolvedAt,
        autoResolvedAt: userNotificationsTable.autoResolvedAt,
        acknowledgementDueAt: userNotificationsTable.acknowledgementDueAt,
        resolutionSlaDueAt: userNotificationsTable.resolutionSlaDueAt,
        resolutionMode: userNotificationsTable.resolutionMode,
        ruleCode: userNotificationsTable.ruleCode,
        correlationId: userNotificationsTable.correlationId,
        entityType: userNotificationsTable.entityType,
        entityId: userNotificationsTable.entityId,
        deliveryCount: userNotificationsTable.deliveryCount,
        lastNotifiedAt: userNotificationsTable.lastNotifiedAt,
        nextNotifyAt: userNotificationsTable.nextNotifyAt,
        eventResolvedAt: userNotificationsTable.eventResolvedAt,
        eventAutoResolvedAt: userNotificationsTable.eventAutoResolvedAt,
        eventEscalatedAt: userNotificationsTable.eventEscalatedAt,
        createdAt: userNotificationsTable.createdAt,
      })
      .from(userNotificationsTable)
      .where(and(...where))
      .orderBy(sql`CASE ${userNotificationsTable.status} WHEN 'escalated' THEN 0 WHEN 'unread' THEN 1 WHEN 'acknowledged' THEN 2 WHEN 'read' THEN 3 ELSE 4 END ASC`, desc(userNotificationsTable.severity), desc(userNotificationsTable.createdAt))
      .limit(limit).offset(offset);
    const enriched = items.map(r => {
      const due = r.acknowledgementDueAt ?? r.resolutionSlaDueAt;
      const isOverdue = !!due && due < now;
      return { ...r, isOverdue, severityRank: SEVERITY_ORDER[r.severity ?? "normal"] ?? 0 };
    });
    res.json({ total: Number(countRow?.count ?? 0), offset, limit, items: enriched });
  } catch (e) {
    res.status(500).json({ error: "list_unavailable", detail: (e as Error).message });
  }
});

router.get("/user-notifications/escalation-feed", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const roleName = await getRoleName(req);
    const isPartner = roleName.toLowerCase() === "partner" || roleName === "Founder";
    const hasCaseMonitor = await hasPerm(req, "case_monitor", "view");
    if (!isPartner && !hasCaseMonitor) {
      res.status(403).json({ error: "partner_monitor_forbidden", message: "Only Partners or case_monitor:view holders may access the firm-wide escalation feed." });
      return;
    }
    const now = new Date();
    const onlyEscalated = asBoolean(one(req.query.only_escalated)) ?? true;
    const limit = Math.min(100, Math.max(1, asInt(one(req.query.limit)) ?? 50));
    const where: ReturnType<typeof eq>[] = [eq(userNotificationsTable.firmId, firmId), inArray(userNotificationsTable.targetScope, ["all_partners", "selected_partner", "manager", "lawyer"] as unknown as string[])];
    if (onlyEscalated) where.push(eq(userNotificationsTable.status, "escalated"));
    const rows = await rdb(req)
      .select({
        id: userNotificationsTable.id, userId: userNotificationsTable.userId, status: userNotificationsTable.status, severity: userNotificationsTable.severity,
        targetScope: userNotificationsTable.targetScope, sourceType: userNotificationsTable.sourceType, sourceId: userNotificationsTable.sourceId, caseId: userNotificationsTable.caseId,
        notificationType: userNotificationsTable.notificationType, title: userNotificationsTable.title, message: userNotificationsTable.message, escalatedAt: userNotificationsTable.escalatedAt,
        acknowledgementDueAt: userNotificationsTable.acknowledgementDueAt, resolutionSlaDueAt: userNotificationsTable.resolutionSlaDueAt, createdAt: userNotificationsTable.createdAt,
        userName: usersTable.name,
      })
      .from(userNotificationsTable)
      .leftJoin(usersTable, eq(usersTable.id, userNotificationsTable.userId))
      .where(and(...where))
      .orderBy(desc(userNotificationsTable.escalatedAt ?? userNotificationsTable.createdAt))
      .limit(limit);
    const items = rows.map(r => ({ ...r, isOverdue: (r.acknowledgementDueAt ?? r.resolutionSlaDueAt) ? ((r.acknowledgementDueAt ?? r.resolutionSlaDueAt)! < now) : false, severityRank: SEVERITY_ORDER[r.severity ?? "normal"] ?? 0 }));
    const critical = items.filter(i => i.severityRank >= 3).length;
    const overdue = items.filter(i => i.isOverdue).length;
    res.json({ total: items.length, critical, overdue, items });
  } catch (e) {
    res.status(500).json({ error: "feed_unavailable", detail: (e as Error).message });
  }
});

router.post("/user-notifications/mark-read", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const parsed = MarkReadSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body" }); return; }
    const now = new Date();
    const ids = parsed.data.ids;
    const where = [eq(userNotificationsTable.firmId, firmId), eq(userNotificationsTable.userId, userId), ne(userNotificationsTable.status, "resolved"), ne(userNotificationsTable.status, "auto_resolved"), ne(userNotificationsTable.status, "dismissed")];
    if (ids) where.push(inArray(userNotificationsTable.id, ids));
    const updated = await rdb(req)
      .update(userNotificationsTable)
      .set({ isRead: true, readAt: now, status: "read", statusSetAt: now, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") })
      .where(and(...where))
      .returning({ id: userNotificationsTable.id });
    for (const row of updated) void writeAuditLog({ entityId: Number(row.id), action: "mark_read", entityType: "user_notification", firmId, actorId: userId, detail: ids?.length ? `bulk ${ids.length}` : "mark_all_read", ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ updated: updated.length });
  } catch (e) {
    res.status(500).json({ error: "mark_read_failed", detail: (e as Error).message });
  }
});

router.post("/user-notifications/:id/acknowledge", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const id = asInt(req.params.id);
    if (!Number.isFinite(id!)) { res.status(400).json({ error: "invalid_id" }); return; }
    const parsed = MarkAcknowledgeSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const now = new Date();
    const [existing] = await rdb(req).select().from(userNotificationsTable).where(and(eq(userNotificationsTable.firmId, firmId), eq(userNotificationsTable.userId, userId), eq(userNotificationsTable.id, id!)));
    if (!existing) { res.status(404).json({ error: "not_found" }); return; }
    if (existing.status === "resolved" || existing.status === "auto_resolved" || existing.status === "dismissed") { res.status(409).json({ error: "terminal_status_cannot_ack" }); return; }
    await rdb(req).update(userNotificationsTable).set({ status: "acknowledged", acknowledgedAt: now, acknowledgedBy: userId, statusSetAt: now, isRead: true, readAt: existing.readAt ?? now, meta: { ...(existing.meta ?? {}), ackNote: parsed.data.note ?? null } as any }).where(eq(userNotificationsTable.id, id!));
    void writeAuditLog({ entityId: id!, action: "acknowledge", entityType: "user_notification", firmId, actorId: userId, detail: parsed.data.note ?? "acknowledged", ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, id, status: "acknowledged", acknowledgedAt: now.toISOString() });
  } catch (e) {
    res.status(500).json({ error: "ack_failed", detail: (e as Error).message });
  }
});

router.post("/user-notifications/:id/dismiss", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const id = asInt(req.params.id);
    if (!Number.isFinite(id!)) { res.status(400).json({ error: "invalid_id" }); return; }
    const parsed = DismissSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [existing] = await rdb(req).select().from(userNotificationsTable).where(and(eq(userNotificationsTable.firmId, firmId), eq(userNotificationsTable.userId, userId), eq(userNotificationsTable.id, id!)));
    if (!existing) { res.status(404).json({ error: "not_found" }); return; }
    if (existing.resolutionMode === "AUTO_ONLY") {
      if (existing.sourceType === "payment_voucher" && Number.isFinite(Number(existing.sourceId))) {
        const [pv] = await rdb(req)
          .select({ status: paymentVouchersTable.status })
          .from(paymentVouchersTable)
          .where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.id, Number(existing.sourceId))));
        if (!pv || (pv.status !== "paid_pending_collection" && pv.status !== "completed")) {
          res.status(409).json({ error: "AUTO_RESOLVE_ONLY", message: "This is a locked operational escalation. It can only be auto-resolved when the underlying Payment Voucher is paid or completed. Manual dismiss is not allowed." });
          return;
        }
      } else {
        res.status(409).json({ error: "AUTO_RESOLVE_ONLY", message: "This notification uses AUTO_ONLY resolution and cannot be dismissed manually." });
        return;
      }
    }
    if (existing.dismissible === false) { res.status(409).json({ error: "non_dismissible", message: "This notification cannot be dismissed manually." }); return; }
    if (existing.status === "resolved" || existing.status === "auto_resolved" || existing.status === "dismissed") { res.status(409).json({ error: "terminal_status" }); return; }
    const now = new Date();
    await rdb(req).update(userNotificationsTable).set({ status: "dismissed", resolvedAt: now, resolvedBy: userId, statusSetAt: now, resolvedReason: parsed.data.reason ?? null, meta: { ...(existing.meta ?? {}), dismissReason: parsed.data.reason ?? null } as any }).where(eq(userNotificationsTable.id, id!));
    void writeAuditLog({ entityId: id!, action: "dismiss", entityType: "user_notification", firmId, actorId: userId, detail: parsed.data.reason ?? "dismissed", ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, id, status: "dismissed", at: now.toISOString() });
  } catch (e) {
    res.status(500).json({ error: "dismiss_failed", detail: (e as Error).message });
  }
});

router.post("/user-notifications/:id/escalate", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const id = asInt(req.params.id);
    if (!Number.isFinite(id!)) { res.status(400).json({ error: "invalid_id" }); return; }
    const parsed = EscalateSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [existing] = await rdb(req).select().from(userNotificationsTable).where(and(eq(userNotificationsTable.firmId, firmId), eq(userNotificationsTable.userId, userId), eq(userNotificationsTable.id, id!)));
    if (!existing) { res.status(404).json({ error: "not_found" }); return; }
    if (existing.status === "resolved" || existing.status === "auto_resolved" || existing.status === "dismissed") { res.status(409).json({ error: "terminal_status" }); return; }
    let targetPartnerUserId: number | null = null;
    let allPartners = false;
    if (parsed.data.targetPartnerUserId) {
      const maybe = Number(parsed.data.targetPartnerUserId);
      if (!Number.isFinite(maybe)) { res.status(400).json({ error: "invalid_target_partner" }); return; }
      const [verify] = await rdb(req)
        .select({ id: usersTable.id })
        .from(usersTable)
        .innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .where(and(eq(usersTable.firmId, firmId), eq(usersTable.id, maybe), eq(usersTable.status, "active"), sql`lower(${rolesTable.name}) = 'partner'`));
      if (!verify) { res.status(400).json({ error: "target_not_active_partner" }); return; }
      targetPartnerUserId = maybe;
    } else {
      allPartners = true;
    }
    const now = new Date();
    await rdb(req).update(userNotificationsTable).set({
      status: "escalated", escalatedAt: now, statusSetAt: now, escalatedReason: parsed.data.note ?? null,
      meta: { ...(existing.meta ?? {}), escalatedBy: userId, allPartners, targetPartnerUserId } as any,
    }).where(eq(userNotificationsTable.id, id!));
    void writeAuditLog({ entityId: id!, action: "escalate", entityType: "user_notification", firmId, actorId: userId, detail: parsed.data.note ?? (allPartners ? "escalated to all partners" : `escalated to partner ${targetPartnerUserId}`), ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, id, status: "escalated", escalatedAt: now.toISOString(), allPartners, targetPartnerUserId });
  } catch (e) {
    res.status(500).json({ error: "escalate_failed", detail: (e as Error).message });
  }
});

router.post("/user-notifications/:id/resolve", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const id = asInt(req.params.id);
    if (!Number.isFinite(id!)) { res.status(400).json({ error: "invalid_id" }); return; }
    const parsed = z.object({ note: z.string().trim().min(3).max(1000) }).safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [existing] = await rdb(req).select().from(userNotificationsTable).where(and(eq(userNotificationsTable.firmId, firmId), eq(userNotificationsTable.id, id!)));
    if (!existing) { res.status(404).json({ error: "not_found" }); return; }
    if (existing.status === "resolved" || existing.status === "auto_resolved") { res.status(409).json({ error: "already_resolved" }); return; }
    if (existing.resolutionMode === "AUTO_ONLY") {
      if (existing.sourceType === "payment_voucher" && Number.isFinite(Number(existing.sourceId))) {
        const [pv] = await rdb(req)
          .select({ status: paymentVouchersTable.status })
          .from(paymentVouchersTable)
          .where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.id, Number(existing.sourceId))));
        if (!pv || (pv.status !== "paid_pending_collection" && pv.status !== "completed")) {
          res.status(409).json({ error: "AUTO_RESOLVE_ONLY", message: "This is a locked operational escalation. It can only be auto-resolved when the underlying Payment Voucher is paid or completed." });
          return;
        }
      }
    }
    const roleName = await getRoleName(req);
    const isPartner = roleName.toLowerCase() === "partner" || roleName === "Founder";
    const hasManageMonitor = await hasPerm(req, "case_monitor", "manage");
    if (existing.targetScope === "all_partners" || existing.targetScope === "selected_partner") {
      if (!isPartner && !hasManageMonitor) {
        res.status(403).json({ error: "partner_resolve_only", message: "Only Partners may resolve this escalation." });
        return;
      }
    } else {
      const hasResolvePerm = await hasPerm(req, "accounting", "read");
      if (!hasResolvePerm && !isPartner && !hasManageMonitor) {
        res.status(403).json({ error: "resolve_forbidden" });
        return;
      }
    }
    const now = new Date();
    await rdb(req).update(userNotificationsTable).set({ status: "resolved", resolvedAt: now, resolvedBy: userId, statusSetAt: now, resolvedReason: parsed.data.note, isRead: true, readAt: existing.readAt ?? now }).where(eq(userNotificationsTable.id, id!));
    void writeAuditLog({ entityId: id!, action: "resolve", entityType: "user_notification", firmId, actorId: userId, detail: parsed.data.note, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, id, status: "resolved", resolvedAt: now.toISOString() });
  } catch (e) {
    res.status(500).json({ error: "resolve_failed", detail: (e as Error).message });
  }
});

router.get("/user-notifications/partners", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const rows = await rdb(req)
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, roleId: usersTable.roleId, roleName: rolesTable.name })
      .from(usersTable)
      .innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(and(eq(usersTable.firmId, firmId), eq(usersTable.status, "active"), sql`lower(${rolesTable.name}) = 'partner'`))
      .orderBy(asc(usersTable.name));
    res.json({ partners: rows });
  } catch (e) {
    res.status(500).json({ error: "partners_unavailable", detail: (e as Error).message });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
