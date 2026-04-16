import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  db, invoicesTable, invoiceItemsTable, quotationsTable, quotationItemsTable,
  casesTable, clientsTable, casePurchasersTable, ledgerEntriesTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

function firmGuard(req: AuthRequest, firmId: number): boolean {
  return req.firmId === firmId;
}

async function nextInvoiceNo(r: DbConn, firmId: number): Promise<string> {
  const [row] = await r.select({ c: sql<number>`COUNT(*)` }).from(invoicesTable).where(eq(invoicesTable.firmId, firmId));
  const seq = (Number(row?.c ?? 0) + 1).toString().padStart(4, "0");
  const yr = new Date().getFullYear();
  return `INV-${yr}-${seq}`;
}

// List
router.get("/invoices", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const r = rdb(req);
    const caseId = one((req.query as any).caseId);
    const status = one((req.query as any).status);
    let query = r.select().from(invoicesTable).where(eq(invoicesTable.firmId, req.firmId!)).$dynamic();
    if (caseId) query = query.where(and(eq(invoicesTable.firmId, req.firmId!), eq(invoicesTable.caseId, parseInt(caseId))));
    if (status) query = query.where(and(eq(invoicesTable.firmId, req.firmId!), eq(invoicesTable.status, status)));
    const rows = await query.orderBy(desc(invoicesTable.createdAt));
    res.json(rows);
  } catch (err) {
    (req as any).log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "invoices.list_failed");
    res.status(500).json({ error: "Failed to load invoices" });
  }
});

// Detail
router.get("/invoices/:id", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const r = rdb(req);
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
    const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
    if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
    const items = await r.select().from(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, id)).orderBy(invoiceItemsTable.sortOrder);
    res.json({ ...inv, items });
  } catch (err) {
    (req as any).log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "invoices.detail_failed");
    res.status(500).json({ error: "Failed to load invoice" });
  }
});

// Create from quotation
router.post("/invoices/from-quotation/:quotationId", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const quotationIdStr = one(req.params.quotationId);
  const quotationId = quotationIdStr ? parseInt(quotationIdStr) : NaN;
  if (isNaN(quotationId)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }
  const [q] = await r.select().from(quotationsTable).where(and(eq(quotationsTable.id, quotationId), eq(quotationsTable.firmId, req.firmId!)));
  if (!q) { res.status(404).json({ error: "Quotation not found" }); return; }
  const qItems = await r.select().from(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId)).orderBy(quotationItemsTable.sortOrder);

  const subtotal = qItems.reduce((s, i) => s + Number(i.amountExclTax), 0);
  const taxTotal = qItems.reduce((s, i) => s + Number(i.taxAmount), 0);
  const grandTotal = subtotal + taxTotal;
  const invoiceNo = await nextInvoiceNo(r, req.firmId!);
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [inv] = await r.insert(invoicesTable).values({
    firmId: req.firmId!, caseId: q.caseId ?? null, quotationId,
    invoiceNo, status: "draft",
    subtotal: subtotal.toFixed(2) as any, taxTotal: taxTotal.toFixed(2) as any,
    grandTotal: grandTotal.toFixed(2) as any, amountPaid: "0", amountDue: grandTotal.toFixed(2) as any,
    issuedDate: today as any, dueDate: dueDate as any,
    notes: req.body.notes || null, createdBy: req.userId!,
  }).returning();

  if (qItems.length) {
    await r.insert(invoiceItemsTable).values(qItems.map((qi, idx) => ({
      invoiceId: inv.id,
      description: qi.description,
      itemType: qi.itemType || "disbursement",
      amountExclTax: qi.amountExclTax as any,
      taxRate: qi.taxRate as any,
      taxAmount: qi.taxAmount as any,
      amountInclTax: qi.amountInclTax as any,
      sortOrder: idx,
    })));
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.invoice.create", entityType: "invoice", entityId: inv.id, detail: `from=quotation quotationId=${quotationId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(inv);
});

// Create manually
router.post("/invoices", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const { caseId, quotationId, items, notes, issuedDate, dueDate } = req.body;
  const parsedItems = (items || []) as any[];
  const subtotal = parsedItems.reduce((s: number, i: any) => s + Number(i.amountExclTax || 0), 0);
  const taxTotal = parsedItems.reduce((s: number, i: any) => s + Number(i.taxAmount || 0), 0);
  const grandTotal = subtotal + taxTotal;
  const invoiceNo = await nextInvoiceNo(r, req.firmId!);
  const today = issuedDate || new Date().toISOString().slice(0, 10);
  const due = dueDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [inv] = await r.insert(invoicesTable).values({
    firmId: req.firmId!, caseId: caseId || null, quotationId: quotationId || null,
    invoiceNo, status: "draft",
    subtotal: subtotal.toFixed(2) as any, taxTotal: taxTotal.toFixed(2) as any,
    grandTotal: grandTotal.toFixed(2) as any, amountPaid: "0", amountDue: grandTotal.toFixed(2) as any,
    issuedDate: today as any, dueDate: due as any,
    notes: notes || null, createdBy: req.userId!,
  }).returning();

  if (parsedItems.length) {
    await r.insert(invoiceItemsTable).values(parsedItems.map((i: any, idx: number) => ({
      invoiceId: inv.id, description: i.description, itemType: i.itemType || "professional_fee",
      amountExclTax: (Number(i.amountExclTax) || 0).toFixed(2) as any,
      taxRate: (Number(i.taxRate) || 0).toFixed(2) as any,
      taxAmount: (Number(i.taxAmount) || 0).toFixed(2) as any,
      amountInclTax: (Number(i.amountInclTax) || 0).toFixed(2) as any,
      sortOrder: idx,
    })));
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.invoice.create", entityType: "invoice", entityId: inv.id, detail: "from=manual", ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(inv);
});

// Issue invoice (draft → issued)
router.post("/invoices/:id/issue", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
  const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
  if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (inv.status !== "draft") { res.status(400).json({ error: "Only draft invoices can be issued" }); return; }
  const [updated] = await r.update(invoicesTable).set({ status: "issued", updatedAt: new Date() })
    .where(eq(invoicesTable.id, id)).returning();
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.invoice.issue", entityType: "invoice", entityId: id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(updated);
});

// Void invoice
router.post("/invoices/:id/void", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), requireReAuth, async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
  const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
  if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (inv.status === "paid") { res.status(400).json({ error: "Cannot void a paid invoice. Issue a credit note." }); return; }
  const [updated] = await r.update(invoicesTable).set({ status: "void", updatedAt: new Date() }).where(eq(invoicesTable.id, id)).returning();
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.invoice.void", entityType: "invoice", entityId: id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(updated);
});

export default router;
