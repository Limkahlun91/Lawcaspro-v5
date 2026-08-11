import express, { type Response, type Router as ExpressRouter } from "express";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { one } from "../lib/http.js";
import { assertFirmFeatureEnabled } from "../modules/platform/firm-feature-service.js";
import {
  createDocumentExtractionJob,
  getExtractionJob,
  confirmExtractedCandidate,
  rejectExtractedCandidate,
} from "../lib/documentExtraction.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const FEATURE_KEY = "documents.ai_read";
const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

router.post("/document-intelligence/extractions", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const body = req.body as { caseId?: unknown; documentId?: unknown; fileReference?: unknown; extractionHints?: unknown };
    const caseId = typeof body.caseId === "number" ? body.caseId : typeof body.caseId === "string" ? parseInt(body.caseId, 10) : NaN;
    const documentId = typeof body.documentId === "number" ? body.documentId : typeof body.documentId === "string" ? parseInt(body.documentId, 10) : NaN;
    const fileReference = typeof body.fileReference === "string" ? body.fileReference.trim() : "";
    const hints = body.extractionHints && typeof body.extractionHints === "object" ? (body.extractionHints as Record<string, unknown>) : {};

    if ((!Number.isFinite(caseId) || caseId <= 0) && (!Number.isFinite(documentId) || documentId <= 0) && !fileReference) {
      res.status(400).json({ code: "DOCUMENT_INTEL_SOURCE_REQUIRED", error: "Either caseId, documentId or fileReference is required to start extraction" });
      return;
    }

    const job = await createDocumentExtractionJob(req.rlsDb!, {
      firmId: req.firmId!,
      actorUserId: req.userId!,
      caseId: Number.isFinite(caseId) ? caseId : null,
      documentId: Number.isFinite(documentId) ? documentId : null,
      fileReference: fileReference || null,
      extractionHints: hints,
    });
    res.status(202).json(job);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "document_intelligence.create_extraction_failed");
    res.status(500).json({ code: "DOCUMENT_INTEL_JOB_CREATE_FAILED", error: err?.message ?? "Failed to create extraction job" });
  }
});

router.get("/document-intelligence/extractions/:jobId", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const raw = one(req.params?.jobId);
    const jobId = typeof raw === "string" ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(jobId) || jobId <= 0) {
      res.status(400).json({ code: "DOCUMENT_INTEL_JOB_ID_INVALID", error: "Valid numeric jobId is required" });
      return;
    }
    const job = await getExtractionJob(req.rlsDb!, { firmId: req.firmId!, jobId });
    if (!job) {
      res.status(404).json({ code: "DOCUMENT_INTEL_JOB_NOT_FOUND", error: "Extraction job not found" });
      return;
    }
    res.json(job);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "document_intelligence.get_extraction_failed");
    res.status(500).json({ code: "DOCUMENT_INTEL_JOB_READ_FAILED", error: err?.message ?? "Failed to read extraction job" });
  }
});

router.post("/document-intelligence/candidates/:candidateId/confirm", requireAuth, requireFirmUser, requirePermission("documents", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const raw = one(req.params?.candidateId);
    const candidateId = typeof raw === "string" ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(candidateId) || candidateId <= 0) {
      res.status(400).json({ code: "DOCUMENT_INTEL_CANDIDATE_ID_INVALID", error: "Valid numeric candidateId is required" });
      return;
    }
    const body = req.body as { confirmedValue?: unknown } ?? {};
    const confirmedValue = body.confirmedValue;
    if (confirmedValue === undefined || confirmedValue === null) {
      res.status(400).json({ code: "DOCUMENT_INTEL_CONFIRMED_VALUE_REQUIRED", error: "confirmedValue must be provided by user action" });
      return;
    }
    const result = await confirmExtractedCandidate(
      {
        firmId: req.firmId!,
        candidateId,
        actorUserId: req.userId!,
        confirmedValue,
      },
      { tx: req.rlsDb },
    );
    res.json(result);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "document_intelligence.confirm_candidate_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "DOCUMENT_INTEL_CONFIRM_FAILED", error: err?.message ?? "Candidate confirm failed" });
  }
});

router.post("/document-intelligence/candidates/:candidateId/reject", requireAuth, requireFirmUser, requirePermission("documents", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const raw = one(req.params?.candidateId);
    const candidateId = typeof raw === "string" ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(candidateId) || candidateId <= 0) {
      res.status(400).json({ code: "DOCUMENT_INTEL_CANDIDATE_ID_INVALID", error: "Valid numeric candidateId is required" });
      return;
    }
    const body = req.body as { rejectionReason?: unknown } ?? {};
    const rejectionReason = typeof body.rejectionReason === "string" ? body.rejectionReason.trim() || null : null;
    const result = await rejectExtractedCandidate(
      {
        firmId: req.firmId!,
        candidateId,
        actorUserId: req.userId!,
        rejectionReason,
      },
      { tx: req.rlsDb },
    );
    res.json(result);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "document_intelligence.reject_candidate_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "DOCUMENT_INTEL_REJECT_FAILED", error: err?.message ?? "Candidate reject failed" });
  }
});

export default expressRouter;
