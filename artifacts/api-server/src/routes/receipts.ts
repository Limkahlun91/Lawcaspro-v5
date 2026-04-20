import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, firmBankAccountsTable, invoicesTable, ledgerEntriesTable, receiptAllocationsTable, receiptsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

async function nextReceiptNo(firmId: number): Promise<string> {
  const [row] = await db.select({ c: sql<number>`COUNT(*)` }).from(receiptsTable).where(eq(receiptsTable.firmId, firmId));
  const seq = (Number(row?.c ?? 0) + 1).toString().padStart(4, "0");
  const yr = new Date().getFullYear();
  return `REC-${yr}-${seq}`;
}

async function updateInvoicePaymentStatus(invoiceId: number, firmId: number) {
  const [inv] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.firmId, firmId)));
  if (!inv) return;
  const [allocSum] = await db.select({ total: sql<string>`COALESCE(SUM(amount), 0)` })
    .from(receiptAllocationsTable).where(eq(receiptAllocationsTable.invoiceId, invoiceId));
  const paid = Number(allocSum?.total ?? 0);
  const grandTotal = Number(inv.grandTotal);
  let status = inv.status;
  if (paid >= grandTotal) status = "paid";
  else if (paid > 0) status = "partially_paid";
  else if (inv.status === "paid" || inv.status === "partially_paid") status = "issued";
  await db.update(invoicesTable).set({
    amountPaid: paid.toFixed(2),
    amountDue: Math.max(0, grandTotal - paid).toFixed(2),
    status, updatedAt: new Date()
  }).where(eq(invoicesTable.id, invoiceId));
}

async function postLedger(firmId: number, caseId: number | null, opts: {
  entryDate: string; entryType: string; accountType: string;
  debit: number; credit: number; description: string;
  referenceNo?: string; sourceType: string; sourceId: number; createdBy: number;
}) {
  const [last] = await db.select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
    .from(ledgerEntriesTable)
    .where(and(eq(ledgerEntriesTable.firmId, firmId), eq(ledgerEntriesTable.accountType, opts.accountType),
      caseId ? eq(ledgerEntriesTable.caseId, caseId) : sql`case_id IS NULL`));
  const prevBal = Number(last?.bal ?? 0);
  const balanceAfter = prevBal + opts.credit - opts.debit;
  await db.insert(ledgerEntriesTable).values({
    firmId,
    caseId,
    entryDate: opts.entryDate,
    entryType: opts.entryType,
    accountType: opts.accountType,
    debit: opts.debit.toFixed(2),
    credit: opts.credit.toFixed(2),
    balanceAfter: balanceAfter.toFixed(2),
    description: opts.description,
    referenceNo: opts.referenceNo ?? null,
    sourceType: opts.sourceType, sourceId: opts.sourceId, createdBy: opts.createdBy,
  });
}

// List
router.get("/receipts", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const conds = [eq(receiptsTable.firmId, req.firmId!)];
  if (caseId) conds.push(eq(receiptsTable.caseId, parseInt(caseId, 10)));
  const rows = await db.select().from(receiptsTable).where(and(...conds)).orderBy(desc(receiptsTable.createdAt));
  res.json(rows);
});

// Detail
router.get("/receipts/:id", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid receipt ID" }); return; }
  const [rec] = await db.select().from(receiptsTable).where(and(eq(receiptsTable.id, id), eq(receiptsTable.firmId, req.firmId!)));
  if (!rec) { res.status(404).json({ error: "Receipt not found" }); return; }
  const allocs = await db.select().from(receiptAllocationsTable).where(eq(receiptAllocationsTable.receiptId, id));
  res.json({ ...rec, allocations: allocs });
});

// Create receipt
router.post("/receipts", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res): Promise<void> => {
  const { caseId, invoiceId, paymentMethod, bankAccountId, accountType, amount,
    receivedDate, referenceNo, notes, allocations } = req.body;
  if (!amount || !receivedDate) { res.status(400).json({ error: "amount and receivedDate required" }); return; }

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
  const amountStr = amountNum.toFixed(2);
  const receivedDateStr = typeof receivedDate === "string" ? receivedDate : String(receivedDate);

  const caseIdNum = caseId ? Number(caseId) : null;
  if (caseIdNum !== null && (!Number.isFinite(caseIdNum) || caseIdNum <= 0)) { res.status(400).json({ error: "Invalid caseId" }); return; }
  const invoiceIdNum = invoiceId ? Number(invoiceId) : null;
  if (invoiceIdNum !== null && (!Number.isFinite(invoiceIdNum) || invoiceIdNum <= 0)) { res.status(400).json({ error: "Invalid invoiceId" }); return; }
  const bankAccountIdNum = bankAccountId ? Number(bankAccountId) : null;
  if (bankAccountIdNum !== null && (!Number.isFinite(bankAccountIdNum) || bankAccountIdNum <= 0)) { res.status(400).json({ error: "Invalid bankAccountId" }); return; }

  const receiptNo = await nextReceiptNo(req.firmId!);
  const [rec] = await db.insert(receiptsTable).values({
    firmId: req.firmId!,
    caseId: caseIdNum,
    invoiceId: invoiceIdNum,
    receiptNo,
    paymentMethod: paymentMethod || "bank_transfer",
    bankAccountId: bankAccountIdNum,
    accountType: accountType || "client",
    amount: amountStr,
    receivedDate: receivedDateStr,
    referenceNo: referenceNo || null,
    notes: notes || null,
    createdBy: req.userId!,
  }).returning();

  // Auto-allocate to invoice if specified
  const allocList = (Array.isArray(allocations) ? allocations : []) as { invoiceId: number; amount: number }[];
  if (invoiceIdNum && !allocList.length) {
    allocList.push({ invoiceId: invoiceIdNum, amount: amountNum });
  }
  for (const alloc of allocList) {
    const allocAmountNum = Number(alloc.amount);
    if (!Number.isFinite(allocAmountNum) || allocAmountNum <= 0) continue;
    const allocInvoiceIdNum = alloc.invoiceId ? Number(alloc.invoiceId) : null;
    await db.insert(receiptAllocationsTable).values({
      receiptId: rec.id,
      invoiceId: allocInvoiceIdNum,
      amount: allocAmountNum.toFixed(2),
    });
    if (alloc.invoiceId) await updateInvoicePaymentStatus(alloc.invoiceId, req.firmId!);
  }

  // Post to ledger
  await postLedger(req.firmId!, caseIdNum, {
    entryDate: receivedDateStr, entryType: "receipt", accountType: accountType || "client",
    debit: 0, credit: amountNum,
    description: `Receipt ${receiptNo} — ${paymentMethod || "bank_transfer"}`,
    referenceNo: receiptNo, sourceType: "receipt", sourceId: rec.id, createdBy: req.userId!,
  });

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.receipt.create", entityType: "receipt", entityId: rec.id, detail: `receiptNo=${rec.receiptNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(rec);
});

// Reverse receipt
router.post("/receipts/:id/reverse", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), requireReAuth, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid receipt ID" }); return; }
  const [rec] = await db.select().from(receiptsTable).where(and(eq(receiptsTable.id, id), eq(receiptsTable.firmId, req.firmId!)));
  if (!rec) { res.status(404).json({ error: "Receipt not found" }); return; }
  if (rec.isReversed) { res.status(400).json({ error: "Already reversed" }); return; }

  await db.update(receiptsTable).set({ isReversed: true, reversedBy: req.userId!, reversedAt: new Date() }).where(eq(receiptsTable.id, id));
  const allocs = await db.select().from(receiptAllocationsTable).where(eq(receiptAllocationsTable.receiptId, id));
  for (const a of allocs) { if (a.invoiceId) await updateInvoicePaymentStatus(a.invoiceId, req.firmId!); }

  await postLedger(req.firmId!, rec.caseId, {
    entryDate: new Date().toISOString().slice(0, 10), entryType: "reversal",
    accountType: rec.accountType, debit: Number(rec.amount), credit: 0,
    description: `Reversal of Receipt ${rec.receiptNo}`,
    referenceNo: rec.receiptNo, sourceType: "receipt", sourceId: id, createdBy: req.userId!,
  });

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.receipt.reverse", entityType: "receipt", entityId: id, detail: `receiptNo=${rec.receiptNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ success: true });
});

export default router;
