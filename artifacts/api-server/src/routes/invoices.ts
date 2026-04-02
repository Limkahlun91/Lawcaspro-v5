import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  db, invoicesTable, invoiceItemsTable, quotationsTable, quotationItemsTable,
  casesTable, clientsTable, casePurchasersTable, ledgerEntriesTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

function firmGuard(req: AuthRequest, firmId: number): boolean {
  return req.firmId === firmId;
}

async function nextInvoiceNo(firmId: number): Promise<string> {
  const [row] = await db.select({ c: sql<number>`COUNT(*)` }).from(invoicesTable).where(eq(invoicesTable.firmId, firmId));
  const seq = (Number(row?.c ?? 0) + 1).toString().padStart(4, "0");
  const yr = new Date().getFullYear();
  return `INV-${yr}-${seq}`;
}

// List
router.get("/invoices", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { caseId, status } = req.query as Record<string, string>;
  let query = db.select().from(invoicesTable).where(eq(invoicesTable.firmId, req.firmId!)).$dynamic();
  if (caseId) query = query.where(and(eq(invoicesTable.firmId, req.firmId!), eq(invoicesTable.caseId, parseInt(caseId))));
  if (status) query = query.where(and(eq(invoicesTable.firmId, req.firmId!), eq(invoicesTable.status, status)));
  const rows = await query.orderBy(desc(invoicesTable.createdAt));
  res.json(rows);
});

// Detail
router.get("/invoices/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [inv] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
  if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
  const items = await db.select().from(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, id)).orderBy(invoiceItemsTable.sortOrder);
  res.json({ ...inv, items });
});

// Create from quotation
router.post("/invoices/from-quotation/:quotationId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const quotationId = parseInt(req.params.quotationId);
  const [q] = await db.select().from(quotationsTable).where(and(eq(quotationsTable.id, quotationId), eq(quotationsTable.firmId, req.firmId!)));
  if (!q) { res.status(404).json({ error: "Quotation not found" }); return; }
  const qItems = await db.select().from(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId)).orderBy(quotationItemsTable.sortOrder);

  const subtotal = qItems.reduce((s, i) => s + Number(i.amountExclTax), 0);
  const taxTotal = qItems.reduce((s, i) => s + Number(i.taxAmount), 0);
  const grandTotal = subtotal + taxTotal;
  const invoiceNo = await nextInvoiceNo(req.firmId!);
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [inv] = await db.insert(invoicesTable).values({
    firmId: req.firmId!, caseId: q.caseId ?? null, quotationId,
    invoiceNo, status: "draft",
    subtotal: subtotal.toFixed(2) as any, taxTotal: taxTotal.toFixed(2) as any,
    grandTotal: grandTotal.toFixed(2) as any, amountPaid: "0", amountDue: grandTotal.toFixed(2) as any,
    issuedDate: today as any, dueDate: dueDate as any,
    notes: req.body.notes || null, createdBy: req.userId!,
  }).returning();

  if (qItems.length) {
    await db.insert(invoiceItemsTable).values(qItems.map((qi, idx) => ({
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

  res.status(201).json(inv);
});

// Create manually
router.post("/invoices", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { caseId, quotationId, items, notes, issuedDate, dueDate } = req.body;
  const parsedItems = (items || []) as any[];
  const subtotal = parsedItems.reduce((s: number, i: any) => s + Number(i.amountExclTax || 0), 0);
  const taxTotal = parsedItems.reduce((s: number, i: any) => s + Number(i.taxAmount || 0), 0);
  const grandTotal = subtotal + taxTotal;
  const invoiceNo = await nextInvoiceNo(req.firmId!);
  const today = issuedDate || new Date().toISOString().slice(0, 10);
  const due = dueDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [inv] = await db.insert(invoicesTable).values({
    firmId: req.firmId!, caseId: caseId || null, quotationId: quotationId || null,
    invoiceNo, status: "draft",
    subtotal: subtotal.toFixed(2) as any, taxTotal: taxTotal.toFixed(2) as any,
    grandTotal: grandTotal.toFixed(2) as any, amountPaid: "0", amountDue: grandTotal.toFixed(2) as any,
    issuedDate: today as any, dueDate: due as any,
    notes: notes || null, createdBy: req.userId!,
  }).returning();

  if (parsedItems.length) {
    await db.insert(invoiceItemsTable).values(parsedItems.map((i: any, idx: number) => ({
      invoiceId: inv.id, description: i.description, itemType: i.itemType || "professional_fee",
      amountExclTax: (Number(i.amountExclTax) || 0).toFixed(2) as any,
      taxRate: (Number(i.taxRate) || 0).toFixed(2) as any,
      taxAmount: (Number(i.taxAmount) || 0).toFixed(2) as any,
      amountInclTax: (Number(i.amountInclTax) || 0).toFixed(2) as any,
      sortOrder: idx,
    })));
  }
  res.status(201).json(inv);
});

// Issue invoice (draft → issued)
router.post("/invoices/:id/issue", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [inv] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
  if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (inv.status !== "draft") { res.status(400).json({ error: "Only draft invoices can be issued" }); return; }
  const [updated] = await db.update(invoicesTable).set({ status: "issued", updatedAt: new Date() })
    .where(eq(invoicesTable.id, id)).returning();
  res.json(updated);
});

// Void invoice
router.post("/invoices/:id/void", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [inv] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
  if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (inv.status === "paid") { res.status(400).json({ error: "Cannot void a paid invoice. Issue a credit note." }); return; }
  const [updated] = await db.update(invoicesTable).set({ status: "void", updatedAt: new Date() }).where(eq(invoicesTable.id, id)).returning();
  res.json(updated);
});

export default router;
