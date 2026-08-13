import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { one } from "../lib/http.js";
import {
  createClaim,
  submitClaim,
  approveClaimWithPayable,
  rejectClaim,
  listMyClaims,
  listAdminClaims,
} from "../modules/hr/claims/claims-core.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const createClaimBodySchema = z.object({
  claimType: z.string().min(1),
  description: z.string().nullable().optional(),
  amount: z.number().finite(),
  receipts: z.array(z.any()).nullable().optional(),
  incurrenceDate: z.coerce.date(),
  employeeId: z.number().int().positive(),
});

router.post("/hr/claims", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_claims", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = createClaimBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await createClaim({
      firmId: req.firmId!,
      employeeId: parsed.data.employeeId,
      claimType: parsed.data.claimType,
      description: parsed.data.description ?? null,
      amount: parsed.data.amount,
      receipts: parsed.data.receipts ?? null,
      incurrenceDate: parsed.data.incurrenceDate,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, claim: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/claims/:id/submit", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_claims", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid claim id is required")));
      return;
    }
    const result = await submitClaim({ firmId: req.firmId!, claimId: id, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, claim: result.claim, wasAlreadySubmitted: result.wasAlreadySubmitted });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/claims/:id/approve", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_claims", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid claim id is required")));
      return;
    }
    const result = await approveClaimWithPayable({ firmId: req.firmId!, claimId: id, actorUserId: req.userId! }, { tx: req.rlsDb });
    if (result.payableCreatedNow && result.claim.accountingCreated === false) {
      res.status(409).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_CLAIM_ALREADY_SENT_TO_ACCOUNTING, "Accounting payable creation mismatch")));
      return;
    }
    res.json({
      ok: true,
      claim: result.claim,
      wasAlreadyApproved: result.wasAlreadyApproved,
      payableCreatedNow: result.payableCreatedNow,
      payableId: result.payableId,
      accounting_created: result.claim.accountingCreated,
    });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/claims/:id/reject", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_claims", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid claim id is required")));
      return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    const result = await rejectClaim({ firmId: req.firmId!, claimId: id, actorUserId: req.userId!, reason }, { tx: req.rlsDb });
    res.json({ ok: true, claim: result.claim, wasAlreadyRejected: result.wasAlreadyRejected });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/claims/me", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_claims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const rows = await listMyClaims({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/claims/admin", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_claims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await listAdminClaims({ firmId: req.firmId!, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

export default expressRouter;
