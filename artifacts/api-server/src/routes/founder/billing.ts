import express, { type Router as ExpressRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, firmInvoicesTable, firmsTable, subscriptionPlansTable } from "@workspace/db";
import { z } from "zod/v4";
import { ApiError, parseIntParam, sendError, sendOk, type ResLike } from "../../lib/api-response.js";
import { requireAuth, requireFounder, requireFounderPermission, type AuthRequest, writeAuditLog } from "../../lib/auth.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const currentBillingMonth = (): string => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
};

const parseMoney = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v.toFixed(2);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toFixed(2);
  }
  throw new ApiError({ status: 400, code: "INVALID_AMOUNT", message: "Invalid amount", retryable: false });
};

const resultRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as any).rows;
    if (Array.isArray(rows)) return rows;
  }
  return [];
};

router.get("/founder/billing/overview", requireAuth, requireFounder, requireFounderPermission("founder.dashboard.read"), async (_req: AuthRequest, res: ResLike) => {
  try {
    const month = currentBillingMonth();
    const q = await db.execute(sql`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE billing_month = ${month} AND status = 'paid'), 0) AS paid_total,
        COALESCE(SUM(amount) FILTER (WHERE billing_month = ${month} AND status IN ('unpaid','overdue')), 0) AS unpaid_total,
        COALESCE(COUNT(DISTINCT firm_id) FILTER (WHERE billing_month = ${month} AND status = 'overdue'), 0) AS overdue_firms
      FROM firm_invoices
    `);
    const row = resultRows(q)[0] as any;
    const paidTotal = Number((row as any)?.paid_total ?? 0);
    const unpaidTotal = Number((row as any)?.unpaid_total ?? 0);
    const overdueFirms = Number((row as any)?.overdue_firms ?? 0);
    sendOk(res, { billing_month: month, paid_total: paidTotal, unpaid_total: unpaidTotal, overdue_firms: overdueFirms });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/founder/billing/ledger", requireAuth, requireFounder, requireFounderPermission("founder.dashboard.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const month = currentBillingMonth();
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO firm_invoices (firm_id, billing_month, amount, status, created_at, updated_at)
        SELECT
          f.id,
          ${month},
          COALESCE(f.custom_price_monthly, p.price_monthly, 0),
          'unpaid',
          now(),
          now()
        FROM firms f
        LEFT JOIN subscription_plans p ON p.id = f.subscription_plan_id
        LEFT JOIN firm_invoices i ON i.firm_id = f.id AND i.billing_month = ${month}
        WHERE i.id IS NULL
      `);
    });

    const q = await db.execute(sql`
      SELECT
        f.id AS firm_id,
        f.name AS firm_name,
        COALESCE(p.name, 'starter') AS plan_name,
        f.is_custom_plan AS is_custom_plan,
        f.custom_price_monthly AS custom_price_monthly,
        i.id AS invoice_id,
        i.billing_month AS billing_month,
        i.amount AS amount,
        i.status AS status,
        i.paid_at AS paid_at,
        i.payment_method AS payment_method
      FROM firms f
      LEFT JOIN subscription_plans p ON p.id = f.subscription_plan_id
      JOIN firm_invoices i ON i.firm_id = f.id AND i.billing_month = ${month}
      ORDER BY f.name ASC
    `);
    sendOk(res, { billing_month: month, items: resultRows(q) });
  } catch (err) {
    sendError(res, err);
  }
});

router.patch("/founder/billing/invoices/:invoiceId/mark-paid", requireAuth, requireFounder, requireFounderPermission("founder.ops.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const invoiceId = parseIntParam("invoiceId", (req.params as any)?.invoiceId, { required: true, min: 1 })!;
    const bodySchema = z.object({ paymentMethod: z.string().trim().min(1).optional() });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const method = parsed.data.paymentMethod ?? "Manual";
    const [row] = await db
      .update(firmInvoicesTable)
      .set({ status: "paid", paidAt: new Date(), paymentMethod: method })
      .where(eq(firmInvoicesTable.id, invoiceId))
      .returning();
    if (!row) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Invoice not found", retryable: false });
    await writeAuditLog({ firmId: row.firmId, actorId: req.userId, actorType: req.userType, action: "founder.billing.invoice.mark_paid", entityType: "firm_invoice", entityId: row.id, detail: `billingMonth=${row.billingMonth} method=${method}`, ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    sendOk(res, { item: row });
  } catch (err) {
    sendError(res, err);
  }
});

router.patch("/founder/firms/:firmId/custom-price", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const bodySchema = z.object({ customPriceMonthly: z.any().optional(), isCustomPlan: z.boolean().optional() });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const customPriceMonthly = parsed.data.customPriceMonthly === undefined ? undefined : parseMoney(parsed.data.customPriceMonthly);
    const updates: Partial<(typeof firmsTable)["$inferInsert"]> = {};
    if (customPriceMonthly !== undefined) updates.customPriceMonthly = customPriceMonthly;
    if (parsed.data.isCustomPlan !== undefined) updates.isCustomPlan = parsed.data.isCustomPlan;
    const [firm] = await db.update(firmsTable).set(updates).where(eq(firmsTable.id, firmId)).returning();
    if (!firm) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Firm not found", retryable: false });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.billing.firm.custom_price.update", entityType: "firm", entityId: firmId, detail: `customPriceMonthly=${customPriceMonthly ?? "null"} isCustomPlan=${updates.isCustomPlan ?? firm.isCustomPlan}`, ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    const [plan] = await db.select({ name: subscriptionPlansTable.name }).from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, firm.subscriptionPlanId)).limit(1);
    sendOk(res, { item: { ...firm, subscriptionPlan: plan?.name ?? "starter" } });
  } catch (err) {
    sendError(res, err);
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
