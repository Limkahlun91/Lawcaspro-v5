import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db, invoicesTable, invoiceItemsTable, quotationsTable, quotationItemsTable,
  casesTable, clientsTable, casePurchasersTable, ledgerEntriesTable,
  sql,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";
import { one, queryOne } from "../lib/http";

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
    const caseIdStr = queryOne(req.query, "caseId");
    const status = queryOne(req.query, "status");
    const caseId = caseIdStr ? Number.parseInt(caseIdStr, 10) : undefined;
    if (caseIdStr && Number.isNaN(caseId)) {
      res.status(400).json({ error: "Invalid caseId" });
      return;
    }
    let query = r.select().from(invoicesTable).where(eq(invoicesTable.firmId, req.firmId!)).$dynamic();
    if (caseId) query = query.where(and(eq(invoicesTable.firmId, req.firmId!), eq(invoicesTable.caseId, caseId)));
    if (status) query = query.where(and(eq(invoicesTable.firmId, req.firmId!), eq(invoicesTable.status, status)));
    const rows = await query.orderBy(desc(invoicesTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "invoices.list_failed");
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
    req.log.error({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "invoices.detail_failed");
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
    subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2),
    grandTotal: grandTotal.toFixed(2), amountPaid: "0", amountDue: grandTotal.toFixed(2),
    issuedDate: today, dueDate,
    notes: req.body.notes || null, createdBy: req.userId!,
  }).returning();

  if (qItems.length) {
    await r.insert(invoiceItemsTable).values(qItems.map((qi, idx) => ({
      invoiceId: inv.id,
      description: qi.description,
      itemType: qi.itemType || "disbursement",
      amountExclTax: String(qi.amountExclTax),
      taxRate: String(qi.taxRate),
      taxAmount: String(qi.taxAmount),
      amountInclTax: String(qi.amountInclTax),
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
  const rawItems = Array.isArray(items) ? items : [];
  const parsedItems = rawItems
    .map((i) => {
      const obj = (i && typeof i === "object") ? (i as Record<string, unknown>) : {};
      const description = typeof obj.description === "string" ? obj.description : "";
      const itemType = typeof obj.itemType === "string" ? obj.itemType : "professional_fee";
      const amountExclTax = Number(obj.amountExclTax ?? 0);
      const taxRate = Number(obj.taxRate ?? 0);
      const taxAmount = Number(obj.taxAmount ?? 0);
      const amountInclTax = Number(obj.amountInclTax ?? (amountExclTax + taxAmount));
      return { description, itemType, amountExclTax, taxRate, taxAmount, amountInclTax };
    })
    .filter((i) => Boolean(i.description));

  const subtotal = parsedItems.reduce((s, i) => s + (Number.isFinite(i.amountExclTax) ? i.amountExclTax : 0), 0);
  const taxTotal = parsedItems.reduce((s, i) => s + (Number.isFinite(i.taxAmount) ? i.taxAmount : 0), 0);
  const grandTotal = subtotal + taxTotal;
  const invoiceNo = await nextInvoiceNo(r, req.firmId!);
  const today = issuedDate || new Date().toISOString().slice(0, 10);
  const due = dueDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [inv] = await r.insert(invoicesTable).values({
    firmId: req.firmId!, caseId: caseId || null, quotationId: quotationId || null,
    invoiceNo, status: "draft",
    subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2),
    grandTotal: grandTotal.toFixed(2), amountPaid: "0", amountDue: grandTotal.toFixed(2),
    issuedDate: typeof today === "string" ? today : String(today), dueDate: typeof due === "string" ? due : String(due),
    notes: notes || null, createdBy: req.userId!,
  }).returning();

  if (parsedItems.length) {
    await r.insert(invoiceItemsTable).values(parsedItems.map((i, idx) => ({
      invoiceId: inv.id,
      description: i.description,
      itemType: i.itemType || "professional_fee",
      amountExclTax: (Number.isFinite(i.amountExclTax) ? i.amountExclTax : 0).toFixed(2),
      taxRate: (Number.isFinite(i.taxRate) ? i.taxRate : 0).toFixed(2),
      taxAmount: (Number.isFinite(i.taxAmount) ? i.taxAmount : 0).toFixed(2),
      amountInclTax: (Number.isFinite(i.amountInclTax) ? i.amountInclTax : 0).toFixed(2),
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
