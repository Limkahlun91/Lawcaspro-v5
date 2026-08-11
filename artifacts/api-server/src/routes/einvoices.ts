import express, { type Response, type Router as ExpressRouter } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  invoicesTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { one } from "../lib/http.js";
import { ApiError } from "../lib/api-response.js";
import {
  prepareInvoiceForEInvoice,
  submitInvoiceEInvoice,
  retryInvoiceEInvoice,
  getInvoiceEInvoiceStatus,
  submitConsolidatedEInvoices,
} from "../services/einvoice/einvoice-service.js";
import { isSandboxEnabled } from "../services/einvoice/sandbox-adapter.js";
import { submitEinvoice } from "../modules/accounting/einvoice-adapter-boundary.service.js";

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

const boundarySubmitBodySchema = z.object({
  idempotencyKey: z.string().min(8),
});

router.post("/einvoices/:invoiceId/submit", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const invoiceIdStr = one(req.params.invoiceId);
    const invoiceId = invoiceIdStr ? parseInt(invoiceIdStr, 10) : NaN;
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      res.status(400).json({ error: "Invalid invoice id", code: "EINVOICE_INVALID_ID" });
      return;
    }
    const parsed = boundarySubmitBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const missing = !req.body || typeof (req.body as any)?.idempotencyKey !== "string" || !(req.body as any).idempotencyKey.trim();
      if (missing) {
        res.status(400).json({ error: "idempotencyKey is required", code: "EINVOICE_IDEMPOTENCY_KEY_REQUIRED" });
        return;
      }
      res.status(400).json({ error: "Validation failed", issues: parsed.error.issues, code: "EINVOICE_IDEMPOTENCY_KEY_REQUIRED" });
      return;
    }
    const idemKey = parsed.data.idempotencyKey.trim();
    const r = rdb(req);
    const [inv] = await r.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.firmId, req.firmId!)));
    if (!inv) {
      res.status(404).json({ error: "Invoice not found", code: "INVOICE_NOT_FOUND" });
      return;
    }
    let boundaryResult: any;
    try {
      boundaryResult = await submitEinvoice({
        firmId: req.firmId!,
        invoiceId,
        idempotencyKey: idemKey,
        actorUserId: req.userId!,
        actorRole: req.roleName ?? req.userType ?? null,
        ipAddress: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
      }, { tx: r });
    } catch (err: any) {
      if (err instanceof ApiError) {
        if (err.code === "EINVOICE_IDEMPOTENCY_KEY_REQUIRED") {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        if (err.code === "EINVOICE_INTEGRATION_LOOKUP_FAILED") {
          res.status(503).json({ error: err.message, code: err.code });
          return;
        }
        if (err.code === "EINVOICE_INTEGRATION_NOT_CONFIGURED") {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        res.status(err.status ?? 500).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
    if (boundaryResult.boundaryPassed === false && boundaryResult.boundaryErrorCode) {
      const ec = String(boundaryResult.boundaryErrorCode);
      if (ec === "EINVOICE_INTEGRATION_LOOKUP_FAILED") {
        res.status(503).json({ error: boundaryResult.boundaryErrorMessage ?? "Integration lookup failed", code: ec });
        return;
      }
      if (ec === "EINVOICE_INTEGRATION_NOT_CONFIGURED") {
        res.status(400).json({ error: boundaryResult.boundaryErrorMessage ?? "Integration not configured", code: ec });
        return;
      }
      if (ec === "EINVOICE_IDEMPOTENCY_KEY_REQUIRED") {
        res.status(400).json({ error: boundaryResult.boundaryErrorMessage ?? "Idempotency key required", code: ec });
        return;
      }
    }
    if (boundaryResult.canProceedToProvider === true || boundaryResult.providerSubmitQueued === true) {
      try {
        await r
          .update(invoicesTable)
          .set({
            einvoiceStatus: "Submitted",
            updatedAt: new Date(),
          } as any)
          .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.firmId, req.firmId!)));
      } catch (updateErr: any) {
        req.log?.warn({ err: updateErr, invoiceId, firmId: req.firmId }, "einvoice.mark_submitted_status_failed");
      }
    }
    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "accounting.einvoice.boundary_submit",
      entityType: "invoice",
      entityId: invoiceId,
      detail: `boundaryPassed=${boundaryResult.boundaryPassed} idem=${idemKey} providerQueued=${boundaryResult.providerSubmitQueued ?? false} code=${boundaryResult.boundaryErrorCode ?? "null"}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    }, { db: req.rlsDb }).catch(() => undefined);
    res.json({
      ok: true,
      auditId: boundaryResult.auditId,
      boundaryPassed: boundaryResult.boundaryPassed,
      boundaryErrorCode: boundaryResult.boundaryErrorCode,
      boundaryErrorMessage: boundaryResult.boundaryErrorMessage,
      canProceedToProvider: boundaryResult.canProceedToProvider,
      providerSubmitQueued: boundaryResult.providerSubmitQueued,
      integrationId: boundaryResult.integrationId,
      integrationStatus: boundaryResult.integrationStatus,
      queueToken: boundaryResult.queueToken,
      einvoiceStatus: boundaryResult.canProceedToProvider || boundaryResult.providerSubmitQueued ? "Submitted" : (boundaryResult.einvoiceStatusSnapshot ?? inv.einvoiceStatus ?? null),
      idempotencyKey: idemKey,
    });
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "einvoice.boundary_submit_failed");
    const msg = err?.message ?? String(err);
    if (msg.includes("EINVOICE_IDEMPOTENCY_KEY_REQUIRED") || String((err as any)?.code) === "EINVOICE_IDEMPOTENCY_KEY_REQUIRED") {
      res.status(400).json({ error: "idempotencyKey is required", code: "EINVOICE_IDEMPOTENCY_KEY_REQUIRED" });
      return;
    }
    if (msg.includes("EINVOICE_INTEGRATION_LOOKUP_FAILED") || String((err as any)?.code) === "EINVOICE_INTEGRATION_LOOKUP_FAILED") {
      res.status(503).json({ error: "Unable to verify e-Invoice integration", code: "EINVOICE_INTEGRATION_LOOKUP_FAILED" });
      return;
    }
    if (msg.includes("EINVOICE_INTEGRATION_NOT_CONFIGURED") || String((err as any)?.code) === "EINVOICE_INTEGRATION_NOT_CONFIGURED") {
      res.status(400).json({ error: "Integration Not Configured", code: "EINVOICE_INTEGRATION_NOT_CONFIGURED" });
      return;
    }
    res.status(500).json({ error: "Failed e-invoice submit", detail: msg });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
