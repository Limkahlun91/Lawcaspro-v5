import { Router, type IRouter } from "express";
import { eq, and, desc, gte, lte, lt, isNull } from "drizzle-orm";
import { casesTable, casePurchasersTable, clientsTable, db, invoiceItemsTable, invoicesTable, ledgerEntriesTable, receiptsTable, sql, usersTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isYmd = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);
const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const needs = /[",\n\r]/.test(s);
  const escaped = s.replace(/"/g, "\"\"");
  return needs ? `"${escaped}"` : escaped;
};

// ── Bills Delivered Book ──────────────────────────────────────────────────────
// Malaysian Solicitors' Accounts Rules: firms must maintain a bills-delivered book
router.get("/reports/bills-delivered-book", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const from = one((req.query as any).from);
  const to = one((req.query as any).to);
  const format = one((req.query as any).format);
  if (from && !isYmd(from)) { res.status(400).json({ error: "Invalid from date (YYYY-MM-DD)" }); return; }
  if (to && !isYmd(to)) { res.status(400).json({ error: "Invalid to date (YYYY-MM-DD)" }); return; }
  if (from && to && from > to) { res.status(400).json({ error: "Invalid date range" }); return; }
  let dateCond = and(eq(invoicesTable.firmId, req.firmId!), isNull(invoicesTable.deletedAt));
  if (from) dateCond = and(dateCond, sql`issued_date >= ${from}`) as any;
  if (to)   dateCond = and(dateCond, sql`issued_date <= ${to}`) as any;

  const invoices = await r.select({
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
      const [c] = await r.select({ caseRef: casesTable.referenceNo, clientName: clientsTable.name })
        .from(casesTable)
        .leftJoin(casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
        .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
        .where(and(eq(casesTable.id, inv.caseId), eq(casesTable.firmId, req.firmId!)));
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

  if (format === "csv") {
    const lines: string[] = [];
    lines.push([
      "invoice_no", "issued_date", "due_date", "status",
      "case_ref", "client_name",
      "subtotal", "tax_total", "grand_total", "amount_paid", "amount_due",
    ].join(","));
    for (const inv of enriched) {
      lines.push([
        csvCell(inv.invoiceNo),
        csvCell(inv.issuedDate),
        csvCell(inv.dueDate),
        csvCell(inv.status),
        csvCell((inv as any).caseRef),
        csvCell((inv as any).clientName),
        csvCell(inv.subtotal),
        csvCell(inv.taxTotal),
        csvCell(inv.grandTotal),
        csvCell(inv.amountPaid),
        csvCell(inv.amountDue),
      ].join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bills-delivered-book${from ? `_${from}` : ""}${to ? `_${to}` : ""}.csv"`);
    res.send(lines.join("\n"));
    return;
  }

  res.json({ invoices: enriched, totals });
});

// ── Trust Account Statement (per case or firm-wide) ───────────────────────────
router.get("/reports/trust-account-statement", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const caseId = one((req.query as any).caseId);
  const format = one((req.query as any).format);
  let cond = and(eq(ledgerEntriesTable.firmId, req.firmId!), eq(ledgerEntriesTable.accountType, "trust"));
  if (caseId) {
    const cid = parseInt(caseId, 10);
    if (Number.isNaN(cid)) { res.status(400).json({ error: "Invalid case ID" }); return; }
    cond = and(cond, eq(ledgerEntriesTable.caseId, cid)) as any;
  }
  const entries = await r.select().from(ledgerEntriesTable).where(cond).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt);
  const balance = entries.reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
  if (format === "csv") {
    const lines: string[] = [];
    lines.push(["entry_date", "entry_type", "reference_no", "description", "debit", "credit", "balance_after"].join(","));
    for (const e of entries) {
      lines.push([
        csvCell(e.entryDate),
        csvCell(e.entryType),
        csvCell(e.referenceNo),
        csvCell(e.description),
        csvCell(e.debit),
        csvCell(e.credit),
        csvCell(e.balanceAfter),
      ].join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="trust-account-statement${caseId ? `_${caseId}` : ""}.csv"`);
    res.send(lines.join("\n"));
    return;
  }
  res.json({ entries, balance: balance.toFixed(2) });
});

// ── Client Account Statement ──────────────────────────────────────────────────
router.get("/reports/client-account-statement", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb ?? db;
  const caseId = one((req.query as any).caseId);
  let cond = and(eq(ledgerEntriesTable.firmId, req.firmId!), eq(ledgerEntriesTable.accountType, "client"));
  if (caseId) {
    const cid = parseInt(caseId, 10);
    if (Number.isNaN(cid)) { res.status(400).json({ error: "Invalid case ID" }); return; }
    cond = and(cond, eq(ledgerEntriesTable.caseId, cid)) as any;
  }
  const entries = await r.select().from(ledgerEntriesTable).where(cond).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt);
  const balance = entries.reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
  res.json({ entries, balance: balance.toFixed(2) });
});

// ── Matter Aging Report ───────────────────────────────────────────────────────
router.get("/reports/matter-aging", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const format = one((req.query as any).format);
  const today = new Date().toISOString().slice(0, 10);
  const invoices = await r.select({
    id: invoicesTable.id,
    invoiceNo: invoicesTable.invoiceNo,
    caseId: invoicesTable.caseId,
    issuedDate: invoicesTable.issuedDate,
    dueDate: invoicesTable.dueDate,
    amountDue: invoicesTable.amountDue,
    grandTotal: invoicesTable.grandTotal,
    status: invoicesTable.status,
  }).from(invoicesTable).where(
    and(eq(invoicesTable.firmId, req.firmId!), isNull(invoicesTable.deletedAt), sql`status IN ('issued','partially_paid') AND amount_due > 0`)
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

  if (format === "csv") {
    const lines: string[] = [];
    lines.push(["bucket", "invoice_no", "case_id", "issued_date", "due_date", "amount_due"].join(","));
    for (const b of bucketTotals) {
      for (const inv of b.items as any[]) {
        lines.push([
          csvCell(b.bucket),
          csvCell(inv.invoiceNo),
          csvCell(inv.caseId),
          csvCell(inv.issuedDate),
          csvCell(inv.dueDate),
          csvCell(inv.amountDue),
        ].join(","));
      }
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"matter-aging.csv\"");
    res.send(lines.join("\n"));
    return;
  }

  res.json({ buckets: bucketTotals, grandTotal: invoices.reduce((s, i) => s + Number(i.amountDue), 0).toFixed(2) });
});

// ── Time Summary Report ────────────────────────────────────────────────────────
router.get("/reports/time-summary", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb ?? db;
  const from = one((req.query as any).from);
  const to = one((req.query as any).to);
  if (from && !isYmd(from)) { res.status(400).json({ error: "Invalid from date (YYYY-MM-DD)" }); return; }
  if (to && !isYmd(to)) { res.status(400).json({ error: "Invalid to date (YYYY-MM-DD)" }); return; }
  if (from && to && from > to) { res.status(400).json({ error: "Invalid date range" }); return; }
  const { timeEntriesTable } = await import("@workspace/db");
  let cond = eq(timeEntriesTable.firmId, req.firmId!);
  if (from) cond = and(cond, sql`entry_date >= ${from}`) as any;
  if (to)   cond = and(cond, sql`entry_date <= ${to}`) as any;

  const [summary] = await r.select({
    totalHours: sql<string>`COALESCE(SUM(hours), 0)`,
    totalAmount: sql<string>`COALESCE(SUM(hours * rate_per_hour), 0)`,
    billableHours: sql<string>`COALESCE(SUM(CASE WHEN is_billable THEN hours ELSE 0 END), 0)`,
    unbilledAmount: sql<string>`COALESCE(SUM(CASE WHEN is_billable AND NOT is_billed THEN hours * rate_per_hour ELSE 0 END), 0)`,
  }).from(timeEntriesTable).where(cond);

  const byUser = await r.select({
    userId: timeEntriesTable.userId,
    hours: sql<string>`COALESCE(SUM(hours), 0)`,
    amount: sql<string>`COALESCE(SUM(hours * rate_per_hour), 0)`,
  }).from(timeEntriesTable).where(cond).groupBy(timeEntriesTable.userId);

  res.json({ summary, byUser });
});

export default router;
