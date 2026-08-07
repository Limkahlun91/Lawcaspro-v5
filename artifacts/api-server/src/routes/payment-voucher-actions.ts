import express, { type Response, type Router as ExpressRouter } from "express";
import { and, count, desc, eq, inArray, lte, or } from "drizzle-orm";
import { casesTable, casePurchasersTable, clientsTable, db, paymentVoucherActionsTable, paymentVouchersTable, permissionsTable, projectsTable, sql, userNotificationsTable } from "@workspace/db";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { extractDbErrorInfo } from "../lib/db-error.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const rdb = (req: AuthRequest) => req.rlsDb ?? db;
const one = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;

function escapedLike(s: string): string {
  return s.replace(/[%_]/g, (c) => "\\" + c);
}

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

router.get("/payment-voucher-actions/cases/reference-search", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const q = one((req.query as any).q)?.trim();
  if (!q || q.length < 2) {
    res.json([]);
    return;
  }
  const firmId = req.firmId!;
  const r = rdb(req);
  try {
    const withScopedTimeouts = async <T,>(fn: (conn: any) => Promise<T>): Promise<T> => {
      if (req.rlsDb) {
        await (r as any).execute(sql`SET LOCAL lock_timeout = '300ms'`);
        await (r as any).execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        return await fn(r as any);
      }
      return await (r as any).transaction(async (tx: any) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        return await fn(tx);
      });
    };

    const result = await withScopedTimeouts(async (tx: any) => {
      return await tx.execute(sql`
        SELECT
          c.id AS case_id,
          c.reference_no AS reference_no,
          c.project_id AS project_id,
          p.name AS project_name,
          ARRAY_AGG(DISTINCT(clients.name) || (CASE WHEN cp.role = 'main' THEN '*' ELSE '' END) ORDER BY (clients.name) || (CASE WHEN cp.role = 'main' THEN '*' ELSE '' END)) FILTER (WHERE clients.name IS NOT NULL) AS purchaser_names,
          MAX(clients.name) FILTER (WHERE cp.role = 'main') AS main_purchaser_name
        FROM cases c
        LEFT JOIN projects p ON p.id = c.project_id AND p.firm_id = c.firm_id
        LEFT JOIN case_purchasers cp ON cp.case_id = c.id
        LEFT JOIN clients ON clients.id = cp.client_id AND clients.firm_id = c.firm_id AND clients.deleted_at IS NULL
        WHERE c.firm_id = ${firmId}
          AND c.deleted_at IS NULL
          AND (
            LOWER(c.reference_no) LIKE LOWER('%' || ${escapedLike(q)} || '%')
            OR LOWER(clients.name) LIKE LOWER('%' || ${escapedLike(q)} || '%')
            OR LOWER(p.name) LIKE LOWER('%' || ${escapedLike(q)} || '%')
          )
        GROUP BY c.id, c.reference_no, c.project_id, p.name
        ORDER BY c.reference_no IS NULL, c.reference_no ASC NULLS LAST, c.id DESC
        LIMIT 20;
      `);
    });

    const rows = Array.isArray(result) ? result : result?.rows ?? [];
    res.json(rows.map((r: any) => ({
      case_id: Number(r.case_id),
      reference_no: String(r.reference_no ?? ""),
      project_id: r.project_id ? Number(r.project_id) : null,
      project_name: String(r.project_name ?? ""),
      purchaser_names: Array.isArray(r.purchaser_names) ? (r.purchaser_names as string[]).map(n => String(n).replace(/\*$/, "").trim()) : [],
      main_purchaser_name: String(r.main_purchaser_name ?? ""),
      title: [String(r.reference_no || ""), String(r.main_purchaser_name || "")].filter(Boolean).join(" — "),
    })));
  } catch (err) {
    const info = extractDbErrorInfo(err);
    const sqlState = info.sqlstate ?? info.sqlState ?? null;
    const durationMs = Date.now() - startedAt;
    logger.error(
      { err, sqlState, durationMs, firmId, q },
      "case_search.reference_search_failed",
    );
    res.status(503).json({
      code: "CASE_SEARCH_UNAVAILABLE",
      error: "Case search temporarily unavailable",
      meta: { sqlState, durationMs },
    });
    return;
  }
});

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

router.get("/payment-voucher-actions/my-work/overview", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
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
  const filter = (() => {
    const v = one((req.query as any).filter);
    return v === "active" || v === "overdue" ? v : "all";
  })();
  const limitRaw = one((req.query as any).limit);
  const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? Math.min(50, limitParsed) : 20;

  const r = rdb(req);
  const now = new Date();
  const firmId = req.firmId!;

  const baseConds = and(
    eq(paymentVoucherActionsTable.firmId, firmId),
    eq(paymentVoucherActionsTable.assignedUserId, userId),
  );

  const activeConds = and(baseConds, inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"]));
  const overdueConds = and(
    activeConds,
    or(lte(paymentVoucherActionsTable.acknowledgeDueAt, now), lte(paymentVoucherActionsTable.completionDueAt, now)),
  );

  let stage: "timeouts" | "counts" | "list" | "unknown" = "unknown";
  try {
    const withScopedTimeouts = async <T,>(fn: (conn: any) => Promise<T>): Promise<T> => {
      if (req.rlsDb) {
        stage = "timeouts";
        await (r as any).execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await (r as any).execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return await fn(r as any);
      }
      return await (r as any).transaction(async (tx: any) => {
        stage = "timeouts";
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return await fn(tx);
      });
    };

    const result = await withScopedTimeouts(async (tx: any) => {
      stage = "counts";
      const countsRows = await tx.execute(sql`
          SELECT
            COUNT(*)::bigint AS all,
            COUNT(*) FILTER (WHERE status IN ('assigned','acknowledged'))::bigint AS active,
            COUNT(*) FILTER (
              WHERE status IN ('assigned','acknowledged')
                AND (
                  (acknowledge_due_at IS NOT NULL AND acknowledge_due_at <= NOW())
                  OR (completion_due_at IS NOT NULL AND completion_due_at <= NOW())
                )
            )::bigint AS overdue
          FROM payment_voucher_actions
          WHERE firm_id = ${firmId}
            AND assigned_user_id = ${userId}
        `);
      const countsRowsArray = Array.isArray(countsRows)
          ? countsRows
          : (countsRows && typeof countsRows === "object" && "rows" in countsRows)
              ? (countsRows as { rows?: unknown }).rows
              : null;
      const countsRow = Array.isArray(countsRowsArray) ? (countsRowsArray[0] as Record<string, unknown> | undefined) : undefined;
      const counts = {
          all: Number(countsRow?.all ?? 0),
          active: Number(countsRow?.active ?? 0),
          overdue: Number(countsRow?.overdue ?? 0),
        };

      stage = "list";
      const listWhere = filter === "active" ? activeConds : filter === "overdue" ? overdueConds : baseConds;
      const items = await tx
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
        .where(listWhere)
        .orderBy(desc(paymentVoucherActionsTable.createdAt))
        .limit(limit);

      return { counts, items };
    });

    res.json({ ...result, meta: { durationMs: Date.now() - startedAt } });
  } catch (err) {
    const info = extractDbErrorInfo(err);
    const sqlState = info.sqlstate ?? info.sqlState ?? null;
    const safeCategory =
      sqlState === "42P01"
        ? "MISSING_TABLE"
        : sqlState === "42703"
          ? "MISSING_COLUMN"
          : sqlState === "42501"
            ? "INSUFFICIENT_PRIVILEGE"
            : sqlState === "57014" || sqlState === "57P01" || sqlState === "57P02"
              ? "QUERY_TIMEOUT"
              : sqlState === "55P03"
                ? "LOCK_TIMEOUT"
                : "UNKNOWN";
    logger.error(
      { err, sqlState, safeCategory, db: { table: info.table, column: info.column, constraint: info.constraint }, durationMs: Date.now() - startedAt, firmId, userId },
      "payment_voucher_actions.overview_failed",
    );
    const meta = { sqlState, safeCategory, stage, db: { table: info.table, column: info.column, constraint: info.constraint }, durationMs: Date.now() - startedAt };
    if (sqlState === "42P01" || sqlState === "42703") {
      res.status(503).json({
        error: "Database migration missing for Payment Voucher actions fields. Apply migration 0122_accounting_settings_and_payment_voucher_sla.sql",
        code: "MIGRATION_MISSING",
        meta,
      });
      return;
    }
    if (sqlState === "42501") {
      res.status(503).json({
        error: "Payment voucher actions unavailable",
        code: "PV_ACTIONS_INSUFFICIENT_PRIVILEGE",
        meta,
      });
      return;
    }
    if (sqlState === "57014" || sqlState === "57P01" || sqlState === "57P02" || sqlState === "55P03") {
      res.status(503).json({
        error: "Payment voucher actions temporarily unavailable",
        code: "PV_ACTIONS_TIMEOUT",
        meta,
      });
      return;
    }
    res.status(503).json({
      error: "Payment voucher actions unavailable",
      code: "PV_ACTIONS_UNAVAILABLE",
      meta,
    });
    return;
  }
});


router.get("/payment-vouchers/dashboard", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
  if (!await roleHasPermission(req, "accounting", "read")) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  const r = rdb(req);
  const firmId = req.firmId!;
  try {
    const withScopedTimeouts = async <T,>(fn: (conn: any) => Promise<T>): Promise<T> => {
      if (req.rlsDb) {
        await (r as any).execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await (r as any).execute(sql`SET LOCAL statement_timeout = '4500ms'`);
        return await fn(r as any);
      }
      return await (r as any).transaction(async (tx: any) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '4500ms'`);
        return await fn(tx);
      });
    };

    const dashboard = await withScopedTimeouts(async (tx: any) => {
      const result = await tx.execute(sql`
        WITH counts AS (
          SELECT
            COUNT(*)::bigint AS total_pv,
            COUNT(*) FILTER (WHERE status = 'pending_account' AND received_at IS NULL)::bigint AS awaiting_receipt,
            COUNT(*) FILTER (WHERE status = 'pending_account' AND received_at IS NOT NULL)::bigint AS received_and_processing,
            COUNT(*) FILTER (WHERE approval_status = 'pending_approval')::bigint AS waiting_approval,
            COUNT(*) FILTER (WHERE status = 'pending_account' AND payment_due_at <= NOW() + INTERVAL '2 hours')::bigint AS due_soon,
            COUNT(*) FILTER (WHERE status = 'pending_account' AND payment_due_at <= NOW())::bigint AS overdue,
            COUNT(*) FILTER (WHERE status = 'paid_pending_collection' AND date(paid_at) = current_date)::bigint AS paid_today,
            COUNT(*) FILTER (WHERE status = 'completed' AND date_trunc('month', updated_at) = date_trunc('month', NOW()))::bigint AS completed_month
          FROM payment_vouchers
          WHERE firm_id = ${firmId}
        ),
        action_counts AS (
          SELECT
            COUNT(*)::bigint AS clerk_pending,
            COUNT(*) FILTER (
              WHERE status IN ('assigned', 'acknowledged')
                AND (
                  (acknowledge_due_at IS NOT NULL AND acknowledge_due_at <= NOW())
                  OR (completion_due_at IS NOT NULL AND completion_due_at <= NOW())
                )
            )::bigint AS clerk_overdue
          FROM payment_voucher_actions
          WHERE firm_id = ${firmId}
            AND status IN ('assigned', 'acknowledged')
        ),
        status_grouped AS (
          SELECT COALESCE(json_agg(json_build_object('status', status, 'count', cnt)), '[]'::json) AS arr
          FROM (
            SELECT status, COUNT(*)::bigint AS cnt
            FROM payment_vouchers
            WHERE firm_id = ${firmId}
            GROUP BY status
            ORDER BY status
          ) s
        )
        SELECT
          c.awaiting_receipt,
          c.received_and_processing,
          c.waiting_approval,
          c.due_soon,
          c.overdue,
          c.paid_today,
          a.clerk_pending,
          a.clerk_overdue,
          c.completed_month,
          sg.arr AS status_grouped
        FROM counts c
        CROSS JOIN action_counts a
        CROSS JOIN status_grouped sg
      `);
      const rows = Array.isArray(result) ? result : result?.rows ?? [];
      const row = rows[0] ?? {};
      return {
        awaitingReceipt: Number(row.awaiting_receipt ?? 0),
        receivedAndProcessing: Number(row.received_and_processing ?? 0),
        waitingApproval: Number(row.waiting_approval ?? 0),
        dueSoon: Number(row.due_soon ?? 0),
        overdue: Number(row.overdue ?? 0),
        paidToday: Number(row.paid_today ?? 0),
        clerkPending: Number(row.clerk_pending ?? 0),
        clerkOverdue: Number(row.clerk_overdue ?? 0),
        completedMonth: Number(row.completed_month ?? 0),
        statusGrouped: Array.isArray(row.status_grouped) ? row.status_grouped : [],
      };
    });

    const durationMs = Date.now() - startedAt;
    if (durationMs >= 2000) {
      logger.warn({ durationMs, firmId: req.firmId, userId: req.userId }, "payment_voucher.dashboard_slow");
    }
    res.json({ ...dashboard, meta: { durationMs } });
  } catch (err) {
    const info = extractDbErrorInfo(err);
    const sqlState = info.sqlstate ?? info.sqlState ?? null;
    const durationMs = Date.now() - startedAt;
    logger.error(
      { err, sqlState, durationMs, firmId },
      "payment_voucher.dashboard_failed",
    );
    if (sqlState === "42P01" || sqlState === "42703") {
      res.status(503).json({
        code: "DASHBOARD_MIGRATION_MISSING",
        error: "Database migration missing for Payment Voucher dashboard fields. Apply migration 0122_accounting_settings_and_payment_voucher_sla.sql",
        meta: { sqlState, durationMs },
      });
      return;
    }
    if (sqlState === "42501") {
      res.status(503).json({
        code: "DASHBOARD_PERMISSION_ERROR",
        error: "Payment voucher dashboard unavailable due to permissions",
        meta: { sqlState, durationMs },
      });
      return;
    }
    if (sqlState === "57014" || sqlState === "57P01" || sqlState === "57P02") {
      res.status(503).json({
        code: "DASHBOARD_QUERY_TIMEOUT",
        error: "Payment voucher dashboard query timed out",
        meta: { sqlState, durationMs },
      });
      return;
    }
    if (sqlState === "55P03") {
      res.status(503).json({
        code: "DASHBOARD_LOCK_TIMEOUT",
        error: "Payment voucher dashboard lock timeout",
        meta: { sqlState, durationMs },
      });
      return;
    }
    res.status(503).json({
      code: "DASHBOARD_UNAVAILABLE",
      error: "Payment voucher dashboard temporarily unavailable",
      meta: { sqlState, durationMs },
    });
    return;
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
  const [updated] = await r.update(paymentVoucherActionsTable).set({
    status: "acknowledged",
    acknowledgedBy: req.userId!,
    acknowledgedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(paymentVoucherActionsTable.id, id), eq(paymentVoucherActionsTable.firmId, req.firmId!), eq(paymentVoucherActionsTable.status, "assigned"))).returning();
  if (!updated) {
    res.status(409).json({ error: "Action already acknowledged", code: "INVALID_STATUS" });
    return;
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "payment_voucher.action_acknowledged", entityType: "payment_voucher_action", entityId: id, detail: `paymentVoucherId=${action.paymentVoucherId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
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
    return { updatedAction, updatedVoucher };
  });
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "payment_voucher.action_completed", entityType: "payment_voucher_action", entityId: id, detail: `paymentVoucherId=${action.paymentVoucherId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(result);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
