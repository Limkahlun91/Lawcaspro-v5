import express, { type Response, type Router as ExpressRouter } from "express";
import { and, count, desc, eq, inArray, lte, or } from "drizzle-orm";
import { casesTable, db, paymentVoucherActionsTable, paymentVouchersTable, permissionsTable, sql, userNotificationsTable } from "@workspace/db";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, requireRlsDb, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const rdb = (req: AuthRequest) => requireRlsDb(req);
const one = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;

async function roleHasPermission(req: AuthRequest, module: string, action: string): Promise<boolean> {
  if (!req.roleId) return false;
  const rows = await rdb(req)
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, req.roleId),
      eq(permissionsTable.module, module),
      eq(permissionsTable.action, action),
      eq(permissionsTable.allowed, true),
    ))
    .limit(1);
  return Boolean(rows[0]);
}

router.get("/payment-voucher-actions/cases/:caseId/summary", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number.parseInt(one(req.params.caseId) ?? "", 10);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const now = new Date();
  const [activeRow] = await rdb(req)
    .select({ count: count() })
    .from(paymentVoucherActionsTable)
    .where(and(
      eq(paymentVoucherActionsTable.firmId, req.firmId!),
      eq(paymentVoucherActionsTable.caseId, caseId),
      inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"]),
    ));
  const [overdueRow] = await rdb(req)
    .select({ count: count() })
    .from(paymentVoucherActionsTable)
    .where(and(
      eq(paymentVoucherActionsTable.firmId, req.firmId!),
      eq(paymentVoucherActionsTable.caseId, caseId),
      inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"]),
      or(
        lte(paymentVoucherActionsTable.acknowledgeDueAt, now),
        lte(paymentVoucherActionsTable.completionDueAt, now),
      ),
    ));
  res.json({
    activeCount: Number(activeRow?.count ?? 0),
    overdueCount: Number(overdueRow?.count ?? 0),
  });
});

router.get("/payment-voucher-actions/my-work", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const requestedUserId = one((req.query as any).userId);
  const userId = requestedUserId ? Number.parseInt(requestedUserId, 10) : req.userId!;
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }
  if (userId !== req.userId && !await roleHasPermission(req, "accounting", "read")) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  const status = one((req.query as any).status);
  const conds = [eq(paymentVoucherActionsTable.firmId, req.firmId!), eq(paymentVoucherActionsTable.assignedUserId, userId)];
  if (status) conds.push(eq(paymentVoucherActionsTable.status, status));
  const rows = await rdb(req)
    .select({
      id: paymentVoucherActionsTable.id,
      paymentVoucherId: paymentVoucherActionsTable.paymentVoucherId,
      caseId: paymentVoucherActionsTable.caseId,
      actionType: paymentVoucherActionsTable.actionType,
      customAction: paymentVoucherActionsTable.customAction,
      status: paymentVoucherActionsTable.status,
      priority: paymentVoucherActionsTable.priority,
      assignedAt: paymentVoucherActionsTable.assignedAt,
      acknowledgeDueAt: paymentVoucherActionsTable.acknowledgeDueAt,
      acknowledgedAt: paymentVoucherActionsTable.acknowledgedAt,
      completionDueAt: paymentVoucherActionsTable.completionDueAt,
      completedAt: paymentVoucherActionsTable.completedAt,
      voucherNo: paymentVouchersTable.voucherNo,
      payeeName: paymentVouchersTable.payeeName,
      nextActionRemarks: paymentVouchersTable.nextActionRemarks,
      referenceNo: casesTable.referenceNo,
    })
    .from(paymentVoucherActionsTable)
    .innerJoin(paymentVouchersTable, and(
      eq(paymentVouchersTable.id, paymentVoucherActionsTable.paymentVoucherId),
      eq(paymentVouchersTable.firmId, paymentVoucherActionsTable.firmId),
    ))
    .leftJoin(casesTable, and(eq(casesTable.id, paymentVoucherActionsTable.caseId), eq(casesTable.firmId, paymentVoucherActionsTable.firmId)))
    .where(and(...conds))
    .orderBy(desc(paymentVoucherActionsTable.createdAt));
  res.json(rows);
});

router.get("/payment-vouchers/dashboard", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
  if (!await roleHasPermission(req, "accounting", "read")) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  const r = rdb(req);
  const now = new Date();
  const firmId = req.firmId!;
  try {
    const [
      awaitingReceipt,
      receivedAndProcessing,
      waitingApproval,
      dueSoon,
      overdue,
      paidToday,
      clerkPending,
      clerkOverdue,
      completedMonth,
    ] = await Promise.all([
      r.select({ c: count() }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.status, "pending_account"), sql`${paymentVouchersTable.receivedAt} IS NULL` as any)),
      r.select({ c: count() }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.status, "pending_account"), sql`${paymentVouchersTable.receivedAt} IS NOT NULL` as any)),
      r.select({ c: count() }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.approvalStatus, "pending_approval"))),
      r.select({ c: count() }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.status, "pending_account"), lte(paymentVouchersTable.paymentDueAt, new Date(now.getTime() + 2 * 60 * 60 * 1000)))),
      r.select({ c: count() }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.status, "pending_account"), lte(paymentVouchersTable.paymentDueAt, now))),
      r.select({ c: count() }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.status, "paid_pending_collection"), sql`date(${paymentVouchersTable.paidAt}) = current_date` as any)),
      r.select({ c: count() }).from(paymentVoucherActionsTable).where(and(eq(paymentVoucherActionsTable.firmId, firmId), inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"]))),
      r.select({ c: count() }).from(paymentVoucherActionsTable).where(and(eq(paymentVoucherActionsTable.firmId, firmId), inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"]), or(lte(paymentVoucherActionsTable.acknowledgeDueAt, now), lte(paymentVoucherActionsTable.completionDueAt, now)))),
      r.select({ c: count() }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.status, "completed"), sql`date_trunc('month', ${paymentVouchersTable.updatedAt}) = date_trunc('month', now())` as any)),
    ]);
    res.json({
      awaitingReceipt: Number(awaitingReceipt[0]?.c ?? 0),
      receivedAndProcessing: Number(receivedAndProcessing[0]?.c ?? 0),
      waitingApproval: Number(waitingApproval[0]?.c ?? 0),
      dueSoon: Number(dueSoon[0]?.c ?? 0),
      overdue: Number(overdue[0]?.c ?? 0),
      paidToday: Number(paidToday[0]?.c ?? 0),
      clerkPending: Number(clerkPending[0]?.c ?? 0),
      clerkOverdue: Number(clerkOverdue[0]?.c ?? 0),
      completedMonth: Number(completedMonth[0]?.c ?? 0),
    });
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 2000) {
      logger.warn({ durationMs, firmId: req.firmId, userId: req.userId }, "payment_voucher.dashboard_slow");
    }
  } catch (err) {
    const code = err && typeof err === "object" && "code" in (err as any) ? String((err as any).code) : null;
    if (code === "42703" || code === "42P01") {
      res.status(500).json({ error: "Database migration missing for Payment Voucher dashboard fields. Apply migration 0122_accounting_settings_and_payment_voucher_sla.sql", code: "MIGRATION_MISSING" });
      return;
    }
    throw err;
  }
});

router.post("/payment-voucher-actions/:id/acknowledge", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number.parseInt(one(req.params.id) ?? "", 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid action id" });
    return;
  }
  const r = rdb(req);
  const [action] = await r.select().from(paymentVoucherActionsTable).where(and(eq(paymentVoucherActionsTable.id, id), eq(paymentVoucherActionsTable.firmId, req.firmId!))).limit(1);
  if (!action) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  if (action.assignedUserId !== req.userId && !await roleHasPermission(req, "accounting", "review")) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  if (action.status !== "assigned") {
    res.status(409).json({ error: "Action already acknowledged or completed", code: "INVALID_STATUS" });
    return;
  }
  const updated = await r.transaction(async (tx) => {
    const [updated] = await tx.update(paymentVoucherActionsTable).set({
      status: "acknowledged",
      acknowledgedBy: req.userId!,
      acknowledgedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(paymentVoucherActionsTable.id, id), eq(paymentVoucherActionsTable.firmId, req.firmId!), eq(paymentVoucherActionsTable.status, "assigned"))).returning();
    if (!updated) return null;
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "payment_voucher.action_acknowledged", entityType: "payment_voucher_action", entityId: id, detail: `paymentVoucherId=${action.paymentVoucherId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return updated;
  });
  if (!updated) { res.status(409).json({ error: "Action already acknowledged", code: "INVALID_STATUS" }); return; }
  res.json(updated);
});

router.post("/payment-voucher-actions/:id/complete", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number.parseInt(one(req.params.id) ?? "", 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid action id" });
    return;
  }
  const BodySchema = z.object({
    actionTaken: z.string().trim().min(1).max(200),
    completionNotes: z.string().trim().max(2000).optional(),
    completionAttachmentPath: z.string().trim().max(1000).optional(),
    updatedMilestone: z.string().trim().max(255).optional(),
  });
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const r = rdb(req);
  const [action] = await r.select().from(paymentVoucherActionsTable).where(and(eq(paymentVoucherActionsTable.id, id), eq(paymentVoucherActionsTable.firmId, req.firmId!))).limit(1);
  if (!action) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  if (action.assignedUserId !== req.userId && !await roleHasPermission(req, "accounting", "review")) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  if (action.status === "completed" || action.status === "cancelled") {
    res.status(409).json({ error: "Action already completed", code: "INVALID_STATUS" });
    return;
  }
  if (action.status !== "acknowledged") {
    res.status(409).json({ error: "Action must be acknowledged before completion", code: "ACKNOWLEDGEMENT_REQUIRED" });
    return;
  }
  const result = await r.transaction(async (tx) => {
    const [updatedAction] = await tx.update(paymentVoucherActionsTable).set({
      status: "completed",
      completedBy: req.userId!,
      completedAt: new Date(),
      completionNotes: parsed.data.completionNotes ? `${parsed.data.actionTaken}\n${parsed.data.completionNotes}` : parsed.data.actionTaken,
      completionAttachmentPath: parsed.data.completionAttachmentPath ?? null,
      updatedMilestone: parsed.data.updatedMilestone ?? null,
      updatedAt: new Date(),
    }).where(and(eq(paymentVoucherActionsTable.id, id), eq(paymentVoucherActionsTable.firmId, req.firmId!))).returning();
    const [updatedVoucher] = await tx.update(paymentVouchersTable).set({
      status: "completed",
      updatedAt: new Date(),
    }).where(and(eq(paymentVouchersTable.id, action.paymentVoucherId), eq(paymentVouchersTable.firmId, req.firmId!), eq(paymentVouchersTable.status, "paid_pending_collection"))).returning();
    if (action.assignedUserId) {
      await tx.update(userNotificationsTable).set({ isRead: true, readAt: new Date() }).where(and(
        eq(userNotificationsTable.firmId, req.firmId!),
        eq(userNotificationsTable.userId, action.assignedUserId),
        eq(userNotificationsTable.sourceType, "payment_voucher_action"),
        eq(userNotificationsTable.sourceId, id),
      ));
    }
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "payment_voucher.action_completed", entityType: "payment_voucher_action", entityId: id, detail: `paymentVoucherId=${action.paymentVoucherId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return { updatedAction, updatedVoucher };
  });
  res.json(result);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
