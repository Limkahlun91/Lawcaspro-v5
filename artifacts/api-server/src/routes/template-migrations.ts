import express, { type Response, type Router as ExpressRouter } from "express";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { one } from "../lib/http.js";
import { ApiError } from "../lib/api-response.js";
import {
  compareTemplatesMigration,
  getTemplateMigrationRun,
  patchTemplateProposal,
  testGenerateTemplateMigration,
  publishTemplateMigrationRun,
} from "../modules/templates/template-migration-service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const parseIntParam = (raw: unknown, field: string): number => {
  const v = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(v) || v <= 0) {
    throw new ApiError({ status: 400, code: `BAD_PARAM_${field.toUpperCase()}`, message: `Valid numeric ${field} required`, retryable: false });
  }
  return v;
};

router.post("/template-migrations/compare", requireAuth, requireFirmUser, requirePermission("templates", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body as { templateScope?: unknown; sourceTag?: unknown; targetTag?: unknown; options?: unknown } ?? {};
    const templateScope = typeof body.templateScope === "string" ? body.templateScope.trim() : "firm";
    const sourceTag = typeof body.sourceTag === "string" ? body.sourceTag.trim() || null : null;
    const targetTag = typeof body.targetTag === "string" ? body.targetTag.trim() || null : null;
    const result = await compareTemplatesMigration(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        oldTemplateId: typeof body.sourceTag === "number" ? body.sourceTag : (typeof sourceTag === "string" && /^\d+$/.test(sourceTag) ? parseInt(sourceTag, 10) : 0),
        newTemplateId: typeof body.targetTag === "number" ? body.targetTag : (typeof targetTag === "string" && /^\d+$/.test(targetTag) ? parseInt(targetTag, 10) : 0),
      },
      { tx: req.rlsDb },
    );
    res.status(202).json(result);
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "template_migrations.compare_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "TEMPLATE_MIGRATION_COMPARE_FAILED", error: err?.message ?? "Template migration compare failed" });
  }
});

router.get("/template-migrations/:runId", requireAuth, requireFirmUser, requirePermission("templates", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runId = parseIntParam(one(req.params?.runId), "runId");
    const result = await getTemplateMigrationRun({ firmId: req.firmId!, runId }, { tx: req.rlsDb });
    if (!result) {
      res.status(404).json({ code: "TEMPLATE_MIGRATION_RUN_NOT_FOUND", error: "Template migration run not found" });
      return;
    }
    res.json(result);
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "template_migrations.get_run_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "TEMPLATE_MIGRATION_GET_FAILED", error: err?.message ?? "Template migration get failed" });
  }
});

router.patch("/template-migrations/proposals/:id", requireAuth, requireFirmUser, requirePermission("templates", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const proposalId = parseIntParam(one(req.params?.id), "proposalId");
    const body = req.body as { reviewStatus?: unknown; reviewerNote?: unknown; resolvedValue?: unknown; runId?: unknown } ?? {};
    const reviewStatus = typeof body.reviewStatus === "string" ? body.reviewStatus.trim() : "";
    if (!["accepted", "rejected"].includes(reviewStatus)) {
      res.status(400).json({ code: "TEMPLATE_MIGRATION_BAD_REVIEW_STATUS", error: "reviewStatus must be one of accepted | rejected" });
      return;
    }
    const reviewDecision = reviewStatus as "accepted" | "rejected";
    const reviewerNote = typeof body.reviewerNote === "string" ? body.reviewerNote.trim() || null : null;
    const overrideFieldKeyNew = "resolvedValue" in body ? (body.resolvedValue as any) : undefined;
    const runId = typeof body.runId === "number" ? body.runId : typeof body.runId === "string" ? parseInt(body.runId, 10) : 0;
    const result = await patchTemplateProposal(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        proposalId,
        runId,
        reviewDecision,
        overrideFieldKeyNew,
        reviewNotes: reviewerNote,
      },
      { tx: req.rlsDb },
    );
    res.json(result);
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "template_migrations.patch_proposal_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "TEMPLATE_MIGRATION_PROPOSAL_PATCH_FAILED", error: err?.message ?? "Proposal patch failed" });
  }
});

router.post("/template-migrations/:runId/test-generate", requireAuth, requireFirmUser, requirePermission("templates", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runId = parseIntParam(one(req.params?.runId), "runId");
    const body = req.body as { proposalIds?: unknown; sampleCaseId?: unknown } ?? {};
    const proposalIds = Array.isArray(body.proposalIds) ? (body.proposalIds as unknown[]).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0) : null;
    const sampleCaseId = typeof body.sampleCaseId === "number" || typeof body.sampleCaseId === "string" ? parseInt(String(body.sampleCaseId), 10) : NaN;
    const result = await testGenerateTemplateMigration(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        runId,
      },
      { tx: req.rlsDb },
    );
    res.json(result);
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "template_migrations.test_generate_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "TEMPLATE_MIGRATION_TEST_GENERATE_FAILED", error: err?.message ?? "Test generate failed" });
  }
});

router.post("/template-migrations/:runId/publish", requireAuth, requireFirmUser, requirePermission("templates", "publish"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runId = parseIntParam(one(req.params?.runId), "runId");
    const body = req.body as { confirmationSlug?: unknown } ?? {};
    const result = await publishTemplateMigrationRun(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        runId,
        confirmationSlug: typeof body.confirmationSlug === "string" ? body.confirmationSlug : null,
      },
      { tx: req.rlsDb },
    );
    res.json(result);
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "template_migrations.publish_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "TEMPLATE_MIGRATION_PUBLISH_FAILED", error: err?.message ?? "Publish failed (review required proposals + success test generate + actor permission)" });
  }
});

export default expressRouter;
