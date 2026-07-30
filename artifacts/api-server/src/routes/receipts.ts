import express, { type Router as ExpressRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, firmBankAccountsTable, invoicesTable, ledgerEntriesTable, receiptAllocationsTable, receiptsTable, sql, quotationsTable, clientsTable, casePurchasersTable, caseLedgersTable, casesTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { sensitiveRateLimiter } from "../lib/rate-limit.js";
import { syncCaseFinancialTotals } from "../lib/caseFinancialSync.js";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function normalizeLedgerAccountType(v: unknown): "client" | "office" | "balance_sheet" {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "trust") return "client";
  if (s === "balance_sheet" || s === "fixed_deposit") return "balance_sheet";
  if (s === "office") return "office";
  return "client";
}

async function applyAdvanceRecovery(tx: typeof db, args: { firmId: number; caseId: number; receiptId: number; receiptNo: string; receivedDate: string; amount: number }) {
  const [row] = await tx
    .select({
      outstanding: sql<string>`
        COALESCE(SUM(CASE WHEN ${caseLedgersTable.entryType} = 'advance_paid' THEN ${caseLedgersTable.amount} ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ${caseLedgersTable.entryType} = 'advance_recovered' THEN ${caseLedgersTable.amount} ELSE 0 END), 0)
      `,
    })
    .from(caseLedgersTable)
    .where(and(eq(caseLedgersTable.firmId, args.firmId), eq(caseLedgersTable.caseId, args.caseId)))
    .limit(1);
  const outstanding = Number(row?.outstanding ?? 0);
  if (!Number.isFinite(outstanding) || outstanding <= 0) return;
  const applied = Math.min(outstanding, args.amount);
  if (!Number.isFinite(applied) || applied <= 0) return;

  const [exists] = await tx.select({ id: caseLedgersTable.id }).from(caseLedgersTable).where(and(
    eq(caseLedgersTable.firmId, args.firmId),
    eq(caseLedgersTable.caseId, args.caseId),
    eq(caseLedgersTable.sourceType, "receipt"),
    eq(caseLedgersTable.sourceId, args.receiptId),
    eq(caseLedgersTable.entryType, "advance_recovered"),
  )).limit(1);
  if (exists) return;
  await tx.insert(caseLedgersTable).values({
    firmId: args.firmId,
    caseId: args.caseId,
    transactionDate: args.receivedDate,
    entryCategory: "office",
    entryType: "advance_recovered",
    description: `Advance recovered via Receipt ${args.receiptNo}`,
    amount: applied.toFixed(2),
    sourceType: "receipt",
    sourceId: args.receiptId,
  } satisfies typeof caseLedgersTable.$inferInsert);
}

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

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
  if (inv.status === "void") {
    await db.update(invoicesTable).set({
      amountPaid: paid.toFixed(2),
      amountDue: "0.00",
      status: "void",
      updatedAt: new Date(),
    }).where(eq(invoicesTable.id, invoiceId));
    return;
  }
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
  const caseId = one((req.query as { caseId?: string | string[] }).caseId);
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
  const invoiceIdFromAlloc = allocs.find((a) => a.invoiceId)?.invoiceId ?? null;
  const invoiceId = rec.invoiceId ?? invoiceIdFromAlloc;

  const billTo = await (async () => {
    if (invoiceId) {
      const [inv] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.firmId, req.firmId!)));
      if (inv?.quotationId) {
        const [q] = await db.select().from(quotationsTable)
          .where(and(eq(quotationsTable.id, inv.quotationId), eq(quotationsTable.firmId, req.firmId!)));
        if (q) {
          const rawDetails = q.clientDetails as unknown;
          const clientDetails = Array.isArray(rawDetails)
            ? rawDetails
                .map((row) => (row && typeof row === "object") ? (row as Record<string, unknown>) : null)
                .filter((row): row is Record<string, unknown> => Boolean(row))
                .map((row) => ({
                  name: typeof row.name === "string" ? row.name : "",
                  tin: typeof row.tin === "string" ? row.tin : undefined,
                }))
                .filter((row) => Boolean(row.name))
            : [];
          return {
            billToName: q.clientName,
            billToAddress: q.clientAddress ?? null,
            clientDetails,
          };
        }
      }
      if (inv?.caseId) {
        const purchasers = await db.select({
          name: clientsTable.name,
          address: clientsTable.address,
        })
          .from(casePurchasersTable)
          .innerJoin(clientsTable, eq(casePurchasersTable.clientId, clientsTable.id))
          .where(and(eq(casePurchasersTable.caseId, inv.caseId), eq(clientsTable.firmId, req.firmId!)))
          .orderBy(casePurchasersTable.id);
        const names = purchasers.map((p) => p.name).filter(Boolean);
        const firstAddr = purchasers.find((p) => typeof p.address === "string" && p.address.trim())?.address ?? null;
        return {
          billToName: names.join(" & "),
          billToAddress: firstAddr,
          clientDetails: names.map((n) => ({ name: n })),
        };
      }
    }
    return { billToName: null, billToAddress: null, clientDetails: [] as Array<{ name: string; tin?: string }> };
  })();

  res.json({ ...rec, allocations: allocs, ...billTo });
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

  const paymentAccountType = normalizeLedgerAccountType(accountType);

  const created = await (db as any).transaction(async (tx: typeof db) => {
    const invoice = invoiceIdNum
      ? await (async () => {
          const [inv] = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceIdNum), eq(invoicesTable.firmId, req.firmId!)));
          return inv ?? null;
        })()
      : null;
    if (invoiceIdNum && !invoice) {
      return { kind: "invoice_not_found" as const };
    }

    const effectiveCaseId = (() => {
      const invCaseId = invoice?.caseId ? Number(invoice.caseId) : null;
      const provided = caseIdNum !== null ? Number(caseIdNum) : null;
      if (provided && invCaseId && provided !== invCaseId) return "mismatch" as const;
      return provided ?? invCaseId ?? null;
    })();
    if (effectiveCaseId === "mismatch") {
      return { kind: "case_invoice_mismatch" as const };
    }

    if (effectiveCaseId) {
      const [c] = await tx.select({ id: casesTable.id }).from(casesTable).where(and(eq(casesTable.id, effectiveCaseId), eq(casesTable.firmId, req.firmId!))).limit(1);
      if (!c) return { kind: "case_not_found" as const };
    }

    const receiptNo = await nextReceiptNo(req.firmId!);
    const [rec] = await tx.insert(receiptsTable).values({
      firmId: req.firmId!,
      caseId: effectiveCaseId,
      invoiceId: invoiceIdNum,
      receiptNo,
      paymentMethod: paymentMethod || "bank_transfer",
      bankAccountId: bankAccountIdNum,
      accountType: paymentAccountType,
      amount: amountStr,
      receivedDate: receivedDateStr,
      referenceNo: referenceNo || null,
      notes: notes || null,
      createdBy: req.userId!,
    }).returning();

    const allocList = (Array.isArray(allocations) ? allocations : []) as { invoiceId: number; amount: number }[];
    if (invoiceIdNum && !allocList.length) {
      allocList.push({ invoiceId: invoiceIdNum, amount: amountNum });
    }
    for (const alloc of allocList) {
      const allocAmountNum = Number(alloc.amount);
      if (!Number.isFinite(allocAmountNum) || allocAmountNum <= 0) continue;
      const allocInvoiceIdNum = alloc.invoiceId ? Number(alloc.invoiceId) : null;
      if (allocInvoiceIdNum) {
        const [inv] = await tx.select({ id: invoicesTable.id }).from(invoicesTable).where(and(eq(invoicesTable.id, allocInvoiceIdNum), eq(invoicesTable.firmId, req.firmId!))).limit(1);
        if (!inv) return { kind: "allocation_invoice_not_found" as const, invoiceId: allocInvoiceIdNum };
      }
      await tx.insert(receiptAllocationsTable).values({
        receiptId: rec.id,
        invoiceId: allocInvoiceIdNum,
        amount: allocAmountNum.toFixed(2),
      });
    }
    for (const alloc of allocList) {
      const allocInvoiceIdNum = alloc.invoiceId ? Number(alloc.invoiceId) : null;
      if (allocInvoiceIdNum) await updateInvoicePaymentStatus(allocInvoiceIdNum, req.firmId!);
    }

    await postLedger(req.firmId!, effectiveCaseId, {
      entryDate: receivedDateStr, entryType: "receipt", accountType: paymentAccountType,
      debit: 0, credit: amountNum,
      description: `Receipt ${receiptNo} — ${paymentMethod || "bank_transfer"}`,
      referenceNo: receiptNo, sourceType: "receipt", sourceId: rec.id, createdBy: req.userId!,
    });

    if (effectiveCaseId) {
      const [exists] = await tx.select({ id: caseLedgersTable.id }).from(caseLedgersTable).where(and(
        eq(caseLedgersTable.firmId, req.firmId!),
        eq(caseLedgersTable.caseId, effectiveCaseId),
        eq(caseLedgersTable.sourceType, "receipt"),
        eq(caseLedgersTable.sourceId, rec.id),
      )).limit(1);
      if (!exists) {
        await tx.insert(caseLedgersTable).values({
          firmId: req.firmId!,
          caseId: effectiveCaseId,
          transactionDate: receivedDateStr,
          entryCategory: paymentAccountType,
          entryType: "payment_received",
          description: `Receipt ${receiptNo}`,
          amount: amountStr,
          sourceType: "receipt",
          sourceId: rec.id,
        } satisfies typeof caseLedgersTable.$inferInsert);
      }
      await applyAdvanceRecovery(tx, {
        firmId: req.firmId!,
        caseId: effectiveCaseId,
        receiptId: rec.id,
        receiptNo,
        receivedDate: receivedDateStr,
        amount: amountNum,
      });
      await syncCaseFinancialTotals(tx, { firmId: req.firmId!, caseId: effectiveCaseId });
    }

    return { kind: "ok" as const, rec };
  });

  if (created.kind === "invoice_not_found") { res.status(400).json({ error: "Invalid invoiceId" }); return; }
  if (created.kind === "case_invoice_mismatch") { res.status(400).json({ error: "caseId does not match invoice caseId" }); return; }
  if (created.kind === "case_not_found") { res.status(400).json({ error: "Invalid caseId" }); return; }
  if (created.kind === "allocation_invoice_not_found") { res.status(400).json({ error: "Invalid allocation invoiceId" }); return; }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.receipt.create", entityType: "receipt", entityId: created.rec.id, detail: `receiptNo=${created.rec.receiptNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(created.rec);
});

// Reverse receipt
router.post("/receipts/:id/reverse", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), requireReAuth, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid receipt ID" }); return; }
  const [rec] = await db.select().from(receiptsTable).where(and(eq(receiptsTable.id, id), eq(receiptsTable.firmId, req.firmId!)));
  if (!rec) { res.status(404).json({ error: "Receipt not found" }); return; }
  if (rec.isReversed) { res.status(400).json({ error: "Already reversed" }); return; }

  const reversed = await (db as any).transaction(async (tx: typeof db) => {
    await tx.update(receiptsTable).set({ isReversed: true, reversedBy: req.userId!, reversedAt: new Date() }).where(eq(receiptsTable.id, id));
    const allocs = await tx.select().from(receiptAllocationsTable).where(eq(receiptAllocationsTable.receiptId, id));
    for (const a of allocs) { if (a.invoiceId) await updateInvoicePaymentStatus(a.invoiceId, req.firmId!); }

    await postLedger(req.firmId!, rec.caseId, {
      entryDate: new Date().toISOString().slice(0, 10), entryType: "reversal",
      accountType: rec.accountType, debit: Number(rec.amount), credit: 0,
      description: `Reversal of Receipt ${rec.receiptNo}`,
      referenceNo: rec.receiptNo, sourceType: "receipt", sourceId: id, createdBy: req.userId!,
    });

    const caseIdResolved = rec.caseId ? Number(rec.caseId) : null;
    if (caseIdResolved) {
      await tx.insert(caseLedgersTable).values({
        firmId: req.firmId!,
        caseId: caseIdResolved,
        transactionDate: new Date().toISOString().slice(0, 10),
        entryCategory: String(rec.accountType || "client"),
        entryType: "payment_received",
        description: `Reversal of Receipt ${rec.receiptNo}`,
        amount: (-Number(rec.amount)).toFixed(2),
        sourceType: "receipt_reversal",
        sourceId: id,
      } satisfies typeof caseLedgersTable.$inferInsert);
      const [recovery] = await tx
        .select({ amount: caseLedgersTable.amount })
        .from(caseLedgersTable)
        .where(and(
          eq(caseLedgersTable.firmId, req.firmId!),
          eq(caseLedgersTable.caseId, caseIdResolved),
          eq(caseLedgersTable.sourceType, "receipt"),
          eq(caseLedgersTable.sourceId, id),
          eq(caseLedgersTable.entryType, "advance_recovered"),
        ))
        .limit(1);
      if (recovery) {
        await tx.insert(caseLedgersTable).values({
          firmId: req.firmId!,
          caseId: caseIdResolved,
          transactionDate: new Date().toISOString().slice(0, 10),
          entryCategory: "office",
          entryType: "advance_recovered",
          description: `Reversal of advance recovery via Receipt ${rec.receiptNo}`,
          amount: (-Number(recovery.amount ?? 0)).toFixed(2),
          sourceType: "receipt_reversal",
          sourceId: id,
        } satisfies typeof caseLedgersTable.$inferInsert);
      }
      await syncCaseFinancialTotals(tx, { firmId: req.firmId!, caseId: caseIdResolved });
    }

    return { ok: true as const };
  });

  if (!reversed.ok) { res.status(500).json({ error: "Internal Server Error" }); return; }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.receipt.reverse", entityType: "receipt", entityId: id, detail: `receiptNo=${rec.receiptNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ success: true });
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
