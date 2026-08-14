import express, { type Response, type Router as ExpressRouter } from "express";
import { eq, and, desc, count } from "drizzle-orm";
import {
  db, invoicesTable, invoiceItemsTable, quotationsTable, quotationItemsTable,
  casesTable, clientsTable, casePurchasersTable, ledgerEntriesTable, caseLedgersTable,
  sql,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePartnerOrAccountForInvoices, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { sensitiveRateLimiter } from "../lib/rate-limit.js";
import { one, queryOne } from "../lib/http.js";
import { syncCaseFinancialTotals } from "../lib/caseFinancialSync.js";
import { nextInvoiceNo } from "../modules/accounting/firm-sequence-numbers.js";
import { withDbStatementTimeout, type StatementTimeoutCategory } from "../modules/db/statement-timeout.js";
import { extractDbErrorInfo } from "../lib/db-error.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

function firmGuard(req: AuthRequest, firmId: number): boolean {
  return req.firmId === firmId;
}

export function parsePageLimit(
  req: { query?: Record<string, any> },
  defaults: { defaultLimit: number; maxLimit: number } = { defaultLimit: 30, maxLimit: 200 },
): { page: number; limit: number; offset: number } {
  const pageRaw = queryOne(req.query, "page");
  const limitRaw = queryOne(req.query, "limit");
  let page = Number.parseInt(pageRaw ?? "1", 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let limit = Number.parseInt(limitRaw ?? String(defaults.defaultLimit), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaults.defaultLimit;
  if (limit > defaults.maxLimit) limit = defaults.maxLimit;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

type InvoiceErrorClass =
  | "INVOICE_QUERY_FAILED"
  | "INVOICE_SCHEMA_MISMATCH"
  | "INVOICE_PERMISSION"
  | "INVOICE_MUTATION_FAILED"
  | "INVOICE_TIMEOUT";

function emitInvoiceErrorLog(
  req: AuthRequest,
  route: string,
  err: unknown,
  defaultClass: InvoiceErrorClass = "INVOICE_QUERY_FAILED",
): { errorCode: InvoiceErrorClass; sqlState: string | null | undefined; schemaObject: { table?: string | null; column?: string | null; constraint?: string | null } } {
  const info = extractDbErrorInfo(err);
  const sqlState = info.sqlstate ?? info.sqlState ?? null;
  const schemaObject = { table: info.table ?? null, column: info.column ?? null, constraint: info.constraint ?? null };
  let resolvedClass: InvoiceErrorClass = defaultClass;
  if (err instanceof Error && (err as any).code === "STATEMENT_TIMEOUT") {
    resolvedClass = "INVOICE_TIMEOUT";
  } else if (sqlState === "42P01" || sqlState === "42703" || sqlState === "42804" || schemaObject.table || schemaObject.column) {
    resolvedClass = "INVOICE_SCHEMA_MISMATCH";
  } else if (sqlState === "42501") {
    resolvedClass = "INVOICE_PERMISSION";
  }
  const payload: Record<string, unknown> = {
    event: "invoices_query_failed",
    route,
    firmId: req.firmId ?? null,
    userId: req.userId ?? null,
    requestId: (req as any).id ?? (req as any).requestId ?? null,
    sqlState,
    errorCode: resolvedClass,
    schemaObject,
  };
  try {
    const logFn: any = (req as any).log ?? console;
    if (logFn && typeof logFn.error === "function") {
      logFn.error({ err, ...payload }, "invoices_query_failed");
    } else {
      console.error("[invoices_query_failed]", JSON.stringify(payload));
    }
  } catch {
    console.error("[invoices_query_failed]", JSON.stringify(payload));
  }
  return { errorCode: resolvedClass, sqlState, schemaObject };
}

router.get("/invoices", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = rdb(req);
    const conn = req.rlsClient;
    const { page, limit, offset } = parsePageLimit(req, { defaultLimit: 30, maxLimit: 200 });
    const caseIdStr = queryOne(req.query, "caseId");
    const status = queryOne(req.query, "status");
    const caseId = caseIdStr ? Number.parseInt(caseIdStr, 10) : undefined;
    if (caseIdStr && Number.isNaN(caseId)) {
      res.status(400).json({ error: "Invalid caseId" });
      return;
    }
    const baseWhere = [eq(invoicesTable.firmId, req.firmId!)];
    if (caseId) baseWhere.push(eq(invoicesTable.caseId, caseId));
    if (status) baseWhere.push(eq(invoicesTable.status, status));
    const cond = and(...baseWhere);
    const category: StatementTimeoutCategory = "search";

    const totalPromise = conn
      ? withDbStatementTimeout(conn, category, () =>
          (r as any).select({ value: count() }).from(invoicesTable).where(cond),
          category,
        )
      : (r as any).select({ value: count() }).from(invoicesTable).where(cond);

    const listPromise = conn
      ? withDbStatementTimeout(conn, category, () =>
          r.select().from(invoicesTable).where(cond).orderBy(desc(invoicesTable.createdAt)).limit(limit).offset(offset),
          category,
        )
      : r.select().from(invoicesTable).where(cond).orderBy(desc(invoicesTable.createdAt)).limit(limit).offset(offset);

    const [[{ value: totalRaw }], rows] = await Promise.all([totalPromise, listPromise]);
    const totalCount = typeof totalRaw === "number" ? totalRaw : Number(totalRaw ?? 0);
    res.setHeader("X-Total-Count", String(totalCount));
    res.setHeader("X-Page", String(page));
    res.setHeader("X-Limit", String(limit));
    res.json(rows.map((inv) => (String((inv as any).status ?? "") === "void" ? { ...inv, amountDue: "0.00" } : inv)));
  } catch (err) {
    const diag = emitInvoiceErrorLog(req, "/invoices", err, "INVOICE_QUERY_FAILED");
    if (diag.errorCode === "INVOICE_TIMEOUT") {
      res.status(504).json({ error: diag.errorCode, sqlState: diag.sqlState ?? undefined });
      return;
    }
    const httpStatus = diag.errorCode === "INVOICE_SCHEMA_MISMATCH" ? 503 : 500;
    res.status(httpStatus).json({
      error: diag.errorCode,
      sqlState: diag.sqlState ?? undefined,
      schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      message: "Failed to load invoices",
    });
  }
});

// Detail
router.get("/invoices/:id", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = rdb(req);
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
    const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
    if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
    const items = await r.select().from(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, id)).orderBy(invoiceItemsTable.sortOrder);
    const billTo = await (async () => {
      if (inv.quotationId) {
        const [q] = await r.select().from(quotationsTable)
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
      if (inv.caseId) {
        const purchasers = await r.select({
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
      return { billToName: null, billToAddress: null, clientDetails: [] as Array<{ name: string; tin?: string }> };
    })();
    res.json({ ...inv, items, ...billTo });
  } catch (err) {
    const diag = emitInvoiceErrorLog(req, "/invoices/:id", err, "INVOICE_QUERY_FAILED");
    const httpStatus = diag.errorCode === "INVOICE_SCHEMA_MISMATCH" ? 503 : 500;
    res.status(httpStatus).json({
      error: diag.errorCode,
      sqlState: diag.sqlState ?? undefined,
      schemaObject: diag.schemaObject.table || diag.schemaObject.column || diag.schemaObject.constraint ? diag.schemaObject : undefined,
      message: "Failed to load invoice",
    });
  }
});

// Create from quotation
router.post("/invoices/from-quotation/:quotationId", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePartnerOrAccountForInvoices, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const quotationIdStr = one(req.params.quotationId);
  const quotationId = quotationIdStr ? parseInt(quotationIdStr) : NaN;
  if (isNaN(quotationId)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }
  const [q] = await r.select().from(quotationsTable).where(and(eq(quotationsTable.id, quotationId), eq(quotationsTable.firmId, req.firmId!)));
  if (!q) { res.status(404).json({ error: "Quotation not found" }); return; }
  const [existingInv] = await r
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.firmId, req.firmId!), eq(invoicesTable.quotationId, quotationId)))
    .limit(1);
  if (existingInv) { res.status(409).json({ error: "Quotation already invoiced" }); return; }
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
      itemCategory: qi.itemCategory === "disbursement" ? "disbursement" : "fee",
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
router.post("/invoices", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePartnerOrAccountForInvoices, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const { caseId, quotationId, items, notes, issuedDate, dueDate } = req.body;
  const rawItems = Array.isArray(items) ? items : [];
  const parsedItems = rawItems
    .map((i) => {
      const obj = (i && typeof i === "object") ? (i as Record<string, unknown>) : {};
      const description = typeof obj.description === "string" ? obj.description : "";
      const itemType = typeof obj.itemType === "string" ? obj.itemType : "professional_fee";
      const itemCategory = obj.itemCategory === "disbursement" ? "disbursement" : "fee";
      const amountExclTax = Number(obj.amountExclTax ?? 0);
      const taxRate = Number(obj.taxRate ?? 0);
      const taxAmount = Number(obj.taxAmount ?? 0);
      const amountInclTax = Number(obj.amountInclTax ?? (amountExclTax + taxAmount));
      return { description, itemType, itemCategory, amountExclTax, taxRate, taxAmount, amountInclTax };
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
      itemCategory: i.itemCategory,
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
router.post("/invoices/:id/issue", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePartnerOrAccountForInvoices, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
  const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
  if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (inv.status !== "draft") { res.status(400).json({ error: "Only draft invoices can be issued" }); return; }

  const updated = await (r as any).transaction(async (tx: DbConn) => {
    const [row] = await tx.update(invoicesTable).set({ status: "issued", updatedAt: new Date() })
      .where(eq(invoicesTable.id, id)).returning();

    const caseId = row?.caseId ? Number(row.caseId) : null;
    if (caseId) {
      const [exists] = await tx.select({ id: caseLedgersTable.id }).from(caseLedgersTable).where(and(
        eq(caseLedgersTable.firmId, req.firmId!),
        eq(caseLedgersTable.caseId, caseId),
        eq(caseLedgersTable.sourceType, "invoice"),
        eq(caseLedgersTable.sourceId, id),
      )).limit(1);
      if (!exists) {
        await tx.insert(caseLedgersTable).values({
          firmId: req.firmId!,
          caseId,
          transactionDate: String(row.issuedDate ?? new Date().toISOString().slice(0, 10)),
          entryCategory: "office",
          entryType: "invoice_billed",
          description: `Invoice ${row.invoiceNo}`,
          amount: Number(row.grandTotal ?? 0).toFixed(2),
          sourceType: "invoice",
          sourceId: id,
        } satisfies typeof caseLedgersTable.$inferInsert);
      }
      await syncCaseFinancialTotals(tx, { firmId: req.firmId!, caseId });
    }

    return row;
  });

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.invoice.issue", entityType: "invoice", entityId: id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(updated);
});

// Void invoice
router.post("/invoices/:id/void", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), requireReAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
  const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
  if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (inv.status === "paid") { res.status(400).json({ error: "Cannot void a paid invoice. Issue a credit note." }); return; }
  const [updated] = await r.update(invoicesTable).set({ status: "void", amountDue: "0.00", updatedAt: new Date() }).where(eq(invoicesTable.id, id)).returning();
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.invoice.void", entityType: "invoice", entityId: id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(updated);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
