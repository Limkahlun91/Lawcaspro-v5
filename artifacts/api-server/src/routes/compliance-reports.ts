import { Router, type IRouter } from "express";
import { eq, and, desc, sql, gte, lte, lt, isNull } from "drizzle-orm";
import { db, invoicesTable, invoiceItemsTable, receiptsTable, ledgerEntriesTable, casesTable, casePurchasersTable, clientsTable, usersTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

// ── Bills Delivered Book ──────────────────────────────────────────────────────
// Malaysian Solicitors' Accounts Rules: firms must maintain a bills-delivered book
router.get("/reports/bills-delivered-book", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { from, to } = req.query as Record<string, string>;
  let dateCond = eq(invoicesTable.firmId, req.firmId!);
  if (from) dateCond = and(dateCond, sql`issued_date >= ${from}`) as any;
  if (to)   dateCond = and(dateCond, sql`issued_date <= ${to}`) as any;

  const invoices = await db.select({
    id: invoicesTable.id,
    invoiceNo: invoicesTable.invoiceNo,
    caseId: invoicesTable.caseId,
    quotationId: invoicesTable.quotationId,
    status: invoicesTable.status,
    issuedDate: invoicesTable.issuedDate,
    dueDate: invoicesTable.dueDate,
    subtotal: invoicesTable.subtotal,
    taxTotal: invoicesTable.taxTotal,
    grandTotal: invoicesTable.grandTotal,
    amountPaid: invoicesTable.amountPaid,
    amountDue: invoicesTable.amountDue,
  }).from(invoicesTable).where(dateCond).orderBy(desc(invoicesTable.issuedDate));

  const enriched = await Promise.all(invoices.map(async (inv) => {
    let caseRef = null;
    let clientName = null;
    if (inv.caseId) {
      const [c] = await db.select({ caseRef: casesTable.referenceNo, clientName: clientsTable.name })
        .from(casesTable)
        .leftJoin(casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
        .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
        .where(eq(casesTable.id, inv.caseId));
      caseRef = c?.caseRef ?? null;
      clientName = c?.clientName ?? null;
    }
    return { ...inv, caseRef, clientName };
  }));

  const totals = {
    count: enriched.length,
    totalBilled: enriched.reduce((s, i) => s + Number(i.grandTotal), 0).toFixed(2),
    totalPaid: enriched.reduce((s, i) => s + Number(i.amountPaid), 0).toFixed(2),
    totalOutstanding: enriched.reduce((s, i) => s + Number(i.amountDue), 0).toFixed(2),
  };

  res.json({ invoices: enriched, totals });
});

// ── Trust Account Statement (per case or firm-wide) ───────────────────────────
router.get("/reports/trust-account-statement", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { caseId } = req.query as Record<string, string>;
  let cond = and(eq(ledgerEntriesTable.firmId, req.firmId!), eq(ledgerEntriesTable.accountType, "trust"));
  if (caseId) cond = and(cond, eq(ledgerEntriesTable.caseId, parseInt(caseId))) as any;
  const entries = await db.select().from(ledgerEntriesTable).where(cond).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt);
  const balance = entries.reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
  res.json({ entries, balance: balance.toFixed(2) });
});

// ── Client Account Statement ──────────────────────────────────────────────────
router.get("/reports/client-account-statement", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { caseId } = req.query as Record<string, string>;
  let cond = and(eq(ledgerEntriesTable.firmId, req.firmId!), eq(ledgerEntriesTable.accountType, "client"));
  if (caseId) cond = and(cond, eq(ledgerEntriesTable.caseId, parseInt(caseId))) as any;
  const entries = await db.select().from(ledgerEntriesTable).where(cond).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt);
  const balance = entries.reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
  res.json({ entries, balance: balance.toFixed(2) });
});

// ── Matter Aging Report ───────────────────────────────────────────────────────
router.get("/reports/matter-aging", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const today = new Date().toISOString().slice(0, 10);
  const invoices = await db.select({
    id: invoicesTable.id,
    invoiceNo: invoicesTable.invoiceNo,
    caseId: invoicesTable.caseId,
    issuedDate: invoicesTable.issuedDate,
    dueDate: invoicesTable.dueDate,
    amountDue: invoicesTable.amountDue,
    grandTotal: invoicesTable.grandTotal,
    status: invoicesTable.status,
  }).from(invoicesTable).where(
    and(eq(invoicesTable.firmId, req.firmId!), sql`status IN ('issued','partially_paid') AND amount_due > 0`)
  ).orderBy(invoicesTable.dueDate);

  const buckets: Record<string, any[]> = { current: [], days1_30: [], days31_60: [], days61_90: [], over90: [] };
  for (const inv of invoices) {
    const due = inv.dueDate as string | null;
    if (!due || due >= today) { buckets.current.push(inv); continue; }
    const days = Math.floor((new Date(today).getTime() - new Date(due).getTime()) / 86400000);
    if (days <= 30) buckets.days1_30.push(inv);
    else if (days <= 60) buckets.days31_60.push(inv);
    else if (days <= 90) buckets.days61_90.push(inv);
    else buckets.over90.push(inv);
  }

  const bucketTotals = Object.entries(buckets).map(([key, items]) => ({
    bucket: key,
    count: items.length,
    total: items.reduce((s, i) => s + Number(i.amountDue), 0).toFixed(2),
    items,
  }));

  res.json({ buckets: bucketTotals, grandTotal: invoices.reduce((s, i) => s + Number(i.amountDue), 0).toFixed(2) });
});

// ── Time Summary Report ────────────────────────────────────────────────────────
router.get("/reports/time-summary", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { from, to } = req.query as Record<string, string>;
  const { timeEntriesTable } = await import("@workspace/db");
  let cond = eq(timeEntriesTable.firmId, req.firmId!);
  if (from) cond = and(cond, sql`entry_date >= ${from}`) as any;
  if (to)   cond = and(cond, sql`entry_date <= ${to}`) as any;

  const [summary] = await db.select({
    totalHours: sql<string>`COALESCE(SUM(hours), 0)`,
    totalAmount: sql<string>`COALESCE(SUM(hours * rate_per_hour), 0)`,
    billableHours: sql<string>`COALESCE(SUM(CASE WHEN is_billable THEN hours ELSE 0 END), 0)`,
    unbilledAmount: sql<string>`COALESCE(SUM(CASE WHEN is_billable AND NOT is_billed THEN hours * rate_per_hour ELSE 0 END), 0)`,
  }).from(timeEntriesTable).where(cond);

  const byUser = await db.select({
    userId: timeEntriesTable.userId,
    hours: sql<string>`COALESCE(SUM(hours), 0)`,
    amount: sql<string>`COALESCE(SUM(hours * rate_per_hour), 0)`,
  }).from(timeEntriesTable).where(cond).groupBy(timeEntriesTable.userId);

  res.json({ summary, byUser });
});

export default router;
