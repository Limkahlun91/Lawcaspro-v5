import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, ledgerEntriesTable, paymentVoucherItemsTable, paymentVouchersTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

const STATUS_FLOW: Record<string, string[]> = {
  draft: ["prepared"],
  prepared: ["lawyer_approved", "draft"],
  lawyer_approved: ["partner_approved", "prepared"],
  partner_approved: ["submitted", "lawyer_approved"],
  submitted: ["paid", "returned"],
  returned: ["prepared"],
  paid: ["locked"],
};

async function nextVoucherNo(firmId: number): Promise<string> {
  const [row] = await db.select({ c: sql<number>`COUNT(*)` }).from(paymentVouchersTable).where(eq(paymentVouchersTable.firmId, firmId));
  const seq = (Number(row?.c ?? 0) + 1).toString().padStart(4, "0");
  const yr = new Date().getFullYear();
  return `PV-${yr}-${seq}`;
}

// List
router.get("/payment-vouchers", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const status = one((req.query as any).status);
  let cond = eq(paymentVouchersTable.firmId, req.firmId!);
  if (caseId) cond = and(cond, eq(paymentVouchersTable.caseId, parseInt(caseId))) as any;
  if (status) cond = and(cond, eq(paymentVouchersTable.status, status)) as any;
  const rows = await db.select().from(paymentVouchersTable).where(cond).orderBy(desc(paymentVouchersTable.createdAt));
  res.json(rows);
});

// Detail
router.get("/payment-vouchers/:id", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const [pv] = await db.select().from(paymentVouchersTable).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Payment voucher not found" }); return; }
  const items = await db.select().from(paymentVoucherItemsTable).where(eq(paymentVoucherItemsTable.voucherId, id)).orderBy(paymentVoucherItemsTable.sortOrder);
  res.json({ ...pv, items });
});

// Create
router.post("/payment-vouchers", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res): Promise<void> => {
  const { caseId, payeeName, payeeBank, payeeAccountNo, paymentMethod, bankAccountId,
    accountType, amount, purpose, notes, items } = req.body;
  if (!payeeName || !amount || !purpose) { res.status(400).json({ error: "payeeName, amount, purpose required" }); return; }

  const voucherNo = await nextVoucherNo(req.firmId!);
  const [pv] = await db.insert(paymentVouchersTable).values({
    firmId: req.firmId!, caseId: caseId || null, voucherNo,
    status: "draft", payeeName, payeeBank: payeeBank || null, payeeAccountNo: payeeAccountNo || null,
    paymentMethod: paymentMethod || "bank_transfer", bankAccountId: bankAccountId || null,
    accountType: accountType || "office", amount: Number(amount).toFixed(2) as any,
    purpose, notes: notes || null, createdBy: req.userId!,
  }).returning();

  const itemList = items as { description: string; itemType?: string; amount: number }[] || [];
  if (itemList.length) {
    await db.insert(paymentVoucherItemsTable).values(itemList.map((i, idx) => ({
      voucherId: pv.id, description: i.description, itemType: i.itemType || "disbursement",
      amount: Number(i.amount).toFixed(2) as any, sortOrder: idx,
    })));
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.payment_voucher.create", entityType: "payment_voucher", entityId: pv.id, detail: `voucherNo=${pv.voucherNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(pv);
});

// Status transition
router.post("/payment-vouchers/:id/transition", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), requireReAuth, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const { toStatus, notes } = req.body as { toStatus: string; notes?: string };
  const [pv] = await db.select().from(paymentVouchersTable).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Voucher not found" }); return; }
  if (pv.isReversed) { res.status(400).json({ error: "Reversed voucher cannot be transitioned" }); return; }

  const allowed = STATUS_FLOW[pv.status] || [];
  if (!allowed.includes(toStatus)) { res.status(400).json({ error: `Cannot move from ${pv.status} to ${toStatus}` }); return; }

  const now = new Date();
  const updateFields: Record<string, any> = { status: toStatus, updatedAt: now };
  if (toStatus === "prepared") { updateFields.preparedBy = req.userId!; updateFields.preparedAt = now; }
  if (toStatus === "lawyer_approved") { updateFields.lawyerApprovedBy = req.userId!; updateFields.lawyerApprovedAt = now; }
  if (toStatus === "partner_approved") { updateFields.partnerApprovedBy = req.userId!; updateFields.partnerApprovedAt = now; }
  if (toStatus === "paid") {
    updateFields.paidAt = now; updateFields.paidBy = req.userId!;
    // Post ledger entry (debit from account)
    await db.insert(ledgerEntriesTable).values({
      firmId: req.firmId!, caseId: pv.caseId, entryDate: now.toISOString().slice(0, 10) as any,
      entryType: "payment_voucher", accountType: pv.accountType,
      debit: Number(pv.amount).toFixed(2) as any, credit: "0" as any, balanceAfter: "0" as any,
      description: `Payment Voucher ${pv.voucherNo} — ${pv.payeeName}`,
      referenceNo: pv.voucherNo, sourceType: "payment_voucher", sourceId: id, createdBy: req.userId!,
    });
  }

  const [updated] = await db.update(paymentVouchersTable).set(updateFields).where(eq(paymentVouchersTable.id, id)).returning();
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.payment_voucher.transition", entityType: "payment_voucher", entityId: id, detail: `from=${pv.status} to=${toStatus}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(updated);
});

// Ledger: view by case and account type
router.get("/ledger", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const accountType = one((req.query as any).accountType);
  let cond = eq(ledgerEntriesTable.firmId, req.firmId!);
  if (caseId) cond = and(cond, eq(ledgerEntriesTable.caseId, parseInt(caseId))) as any;
  if (accountType) cond = and(cond, eq(ledgerEntriesTable.accountType, accountType)) as any;
  const rows = await db.select().from(ledgerEntriesTable).where(cond).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt);
  res.json(rows);
});

// Ledger summary (balance per account type per case)
router.get("/ledger/summary", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  let cond = eq(ledgerEntriesTable.firmId, req.firmId!);
  if (caseId) cond = and(cond, eq(ledgerEntriesTable.caseId, parseInt(caseId))) as any;
  const rows = await db.select({
    accountType: ledgerEntriesTable.accountType,
    totalDebit: sql<string>`COALESCE(SUM(debit), 0)`,
    totalCredit: sql<string>`COALESCE(SUM(credit), 0)`,
    balance: sql<string>`COALESCE(SUM(credit - debit), 0)`,
  }).from(ledgerEntriesTable).where(cond).groupBy(ledgerEntriesTable.accountType);
  res.json(rows);
});

export default router;
