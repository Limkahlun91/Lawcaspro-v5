import express, { type Response, type Router as ExpressRouter } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  invoicesTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { one } from "../lib/http.js";
import {
  prepareInvoiceForEInvoice,
  submitInvoiceEInvoice,
  retryInvoiceEInvoice,
  getInvoiceEInvoiceStatus,
  submitConsolidatedEInvoices,
} from "../services/einvoice/einvoice-service.js";
import { isSandboxEnabled } from "../services/einvoice/sandbox-adapter.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

const consolidatedSubmitSchema = z.object({
  invoiceIds: z.array(z.number().int().positive()),
});

router.post("/invoices/:id/einvoice/prepare", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }

    const r = rdb(req);
    const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
    if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }

    const result = await prepareInvoiceForEInvoice(r as any, { firmId: req.firmId!, invoiceId: id });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.einvoice.prepare", entityType: "invoice", entityId: id, detail: `classification=${result.classification ?? "null"} eligible=${result.eligible}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.json(result);
  } catch (err: any) {
    req.log.error({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "einvoice.prepare_failed");
    const msg = err?.message ?? String(err);
    if (msg.startsWith("INVOICE_NOT_FOUND")) res.status(404).json({ error: "Invoice not found" });
    else res.status(500).json({ error: "Failed to prepare e-invoice", detail: msg });
  }
});

router.post("/invoices/:id/einvoice/submit", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!isSandboxEnabled()) {
      res.status(503).json({ error: "EINVOICE_SANDBOX_DISABLED", message: "e-Invoice submission requires EINVOICE_SANDBOX=1 in server environment. Production submit is NOT allowed." });
      return;
    }
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }

    const r = rdb(req);
    const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
    if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }

    const result = await submitInvoiceEInvoice(r as any, { firmId: req.firmId!, invoiceId: id, actorId: req.userId!, actorType: req.userType!, ipAddress: req.ip, userAgent: req.headers["user-agent"] as string });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.einvoice.submit", entityType: "invoice", entityId: id, detail: `status=${result.status} new=${result.isNewSubmission} submissionId=${result.submissionId}${result.skippedDueToDuplicateSourceLink ? " skipped=DOUBLE_INVOICE_GUARD" : ""}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.json(result);
  } catch (err: any) {
    req.log.error({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "einvoice.submit_failed");
    const msg = err?.message ?? String(err);
    if (msg === "EINVOICE_SANDBOX_DISABLED") res.status(503).json({ error: "EINVOICE_SANDBOX_DISABLED", message: "e-Invoice submission requires EINVOICE_SANDBOX=1. Production submit is NOT allowed." });
    else if (msg.startsWith("INVOICE_NOT_FOUND")) res.status(404).json({ error: "Invoice not found" });
    else if (msg.startsWith("NOT_ELIGIBLE")) res.status(400).json({ error: "Invoice not eligible", detail: msg.slice("NOT_ELIGIBLE: ".length) });
    else res.status(500).json({ error: "Failed to submit e-invoice", detail: msg });
  }
});

router.post("/invoices/:id/einvoice/retry", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!isSandboxEnabled()) {
      res.status(503).json({ error: "EINVOICE_SANDBOX_DISABLED", message: "e-Invoice retry requires EINVOICE_SANDBOX=1" });
      return;
    }
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }

    const r = rdb(req);
    const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.firmId, req.firmId!)));
    if (!inv) { res.status(404).json({ error: "Invoice not found" }); return; }

    const result = await retryInvoiceEInvoice(r as any, { firmId: req.firmId!, invoiceId: id });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.einvoice.retry", entityType: "invoice", entityId: id, detail: `status=${result.status} retryCount=${inv.einvoiceRetryCount ?? 0 + 1}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.json(result);
  } catch (err: any) {
    req.log.error({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "einvoice.retry_failed");
    const msg = err?.message ?? String(err);
    if (msg === "EINVOICE_SANDBOX_DISABLED") res.status(503).json({ error: "EINVOICE_SANDBOX_DISABLED" });
    else if (msg.startsWith("INVOICE_NOT_FOUND")) res.status(404).json({ error: "Invoice not found" });
    else if (msg.startsWith("RETRY_NOT_ALLOWED")) res.status(400).json({ error: "Retry not allowed", detail: msg });
    else res.status(500).json({ error: "Failed to retry e-invoice", detail: msg });
  }
});

router.get("/invoices/:id/einvoice", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid invoice ID" }); return; }

    const r = rdb(req);
    const result = await getInvoiceEInvoiceStatus(r as any, { firmId: req.firmId!, invoiceId: id });
    res.json(result);
  } catch (err: any) {
    req.log.error({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "einvoice.get_status_failed");
    const msg = err?.message ?? String(err);
    if (msg.startsWith("INVOICE_NOT_FOUND")) res.status(404).json({ error: "Invoice not found" });
    else res.status(500).json({ error: "Failed to load e-invoice status", detail: msg });
  }
});

router.post("/einvoices/consolidated/submit", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!isSandboxEnabled()) {
      res.status(503).json({ error: "EINVOICE_SANDBOX_DISABLED", message: "Consolidated e-Invoice submit requires EINVOICE_SANDBOX=1" });
      return;
    }
    const parsed = consolidatedSubmitSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const r = rdb(req);
    const result = await submitConsolidatedEInvoices(r as any, {
      firmId: req.firmId!,
      invoiceIds: parsed.data.invoiceIds,
      actorId: req.userId!,
      actorType: req.userType!,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] as string,
    });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.einvoice.consolidated_submit", entityType: "invoice", entityId: 0, detail: `count=${parsed.data.invoiceIds.length} success=${result.successCount} fail=${result.failCount}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.json(result);
  } catch (err: any) {
    req.log.error({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "einvoice.consolidated_submit_failed");
    const msg = err?.message ?? String(err);
    if (msg === "EINVOICE_SANDBOX_DISABLED") res.status(503).json({ error: "EINVOICE_SANDBOX_DISABLED" });
    else res.status(500).json({ error: "Failed consolidated submit", detail: msg });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
