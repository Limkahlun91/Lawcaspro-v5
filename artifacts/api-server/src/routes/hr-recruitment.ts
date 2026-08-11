import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { isHRGlobalEnvEnabled, requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { one } from "../lib/http.js";
import {
  listPositions,
  listCandidates,
  createCandidate,
  scheduleInterview,
  createOffer,
  hireCandidateAsEmployee,
} from "../modules/hr/recruitment/recruitment-core.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

if (!isHRGlobalEnvEnabled()) {
  router.get("*", (_req, res: Response) => {
    res.status(503).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_MODULE_DISABLED, "HRMS module is not enabled.")));
  });
  router.post("*", (_req, res: Response) => {
    res.status(503).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_MODULE_DISABLED, "HRMS module is not enabled.")));
  });
}

const createCandidateSchema = z.object({
  positionId: z.number().int().positive().nullable().optional(),
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().nullable().optional(),
});

const scheduleInterviewSchema = z.object({
  candidateId: z.number().int().positive(),
  scheduledAt: z.coerce.date(),
  interviewerUserId: z.number().int().positive().nullable().optional(),
  mode: z.enum(["in_person", "video", "phone"]),
});

const createOfferSchema = z.object({
  candidateId: z.number().int().positive(),
  positionId: z.number().int().positive().nullable().optional(),
  salary: z.number().finite(),
  joiningDate: z.coerce.date(),
});

router.get("/hr/recruitment/positions", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_recruitment", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await listPositions({ firmId: req.firmId!, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/recruitment/candidates", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_recruitment", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await listCandidates({ firmId: req.firmId!, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/recruitment/candidates", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_recruitment", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = createCandidateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await createCandidate({
      firmId: req.firmId!,
      positionId: parsed.data.positionId ?? null,
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, candidate: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/recruitment/interviews", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_recruitment", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = scheduleInterviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await scheduleInterview({
      firmId: req.firmId!,
      candidateId: parsed.data.candidateId,
      scheduledAt: parsed.data.scheduledAt,
      interviewerUserId: parsed.data.interviewerUserId ?? null,
      mode: parsed.data.mode,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, interview: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/recruitment/offers", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_recruitment", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = createOfferSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await createOffer({
      firmId: req.firmId!,
      candidateId: parsed.data.candidateId,
      positionId: parsed.data.positionId ?? null,
      salary: parsed.data.salary,
      joiningDate: parsed.data.joiningDate,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, offer: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/recruitment/offers/:offerId/hire", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_recruitment", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const offerIdStr = one(req.params.offerId);
    const offerId = offerIdStr ? parseInt(offerIdStr, 10) : NaN;
    if (!Number.isFinite(offerId) || offerId <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid offer id is required")));
      return;
    }
    const result = await hireCandidateAsEmployee({ firmId: req.firmId!, offerId, actorUserId: req.userId! }, { tx: req.rlsDb });
    if (result.wasAlreadyHired && result.dedupeSkipped) {
      res.status(409).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_IDEMPOTENCY_CONFLICT, "Candidate already hired; duplicate entry prevented")));
      return;
    }
    res.json({
      ok: true,
      candidate: result.candidate,
      employeeId: result.employeeId,
      wasAlreadyHired: result.wasAlreadyHired,
      dedupeSkipped: result.dedupeSkipped,
    });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

export default expressRouter;
