import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { one } from "../lib/http.js";
import {
  startOffboarding,
  getChecklist,
  finaliseOffboarding,
  type OffboardingGuardCode,
} from "../modules/hr/offboarding/offboarding-core.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const startOffboardingSchema = z.object({
  employeeId: z.number().int().positive(),
  lastWorkingDay: z.coerce.date(),
  reason: z.string().nullable().optional(),
});

function mapGuardCodeToHttp(guard: OffboardingGuardCode): { httpStatus: number; code: string; message: string } {
  switch (guard) {
    case "OFFBOARDING_ACTIVE_CASES_PENDING":
      return { httpStatus: 409, code: guard, message: "Employee has active cases that must be reassigned first." };
    case "OFFBOARDING_APPROVALS_PENDING":
      return { httpStatus: 409, code: guard, message: "Employee has pending approvals that must be resolved." };
    case "OFFBOARDING_ASSETS_PENDING":
      return { httpStatus: 409, code: guard, message: "Employee has unreturned assets that must be returned first." };
    case "OFFBOARDING_CLAIMS_PENDING":
      return { httpStatus: 409, code: guard, message: "Employee has pending or unsettled claims that must be settled." };
    case "OFFBOARDING_PAYROLL_PENDING":
      return { httpStatus: 409, code: guard, message: "Employee has open payroll items that must be finalised." };
    default:
      return { httpStatus: 500, code: "OFFBOARDING_UNKNOWN_GUARD", message: "Unknown offboarding guard failed." };
  }
}

router.post("/hr/offboarding/start", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_offboarding", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = startOffboardingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await startOffboarding({
      firmId: req.firmId!,
      employeeId: parsed.data.employeeId,
      lastWorkingDay: parsed.data.lastWorkingDay,
      reason: parsed.data.reason ?? null,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, offboarding: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/offboarding/:id/checklist", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_offboarding", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid offboarding id is required")));
      return;
    }
    const rows = await getChecklist({ firmId: req.firmId!, offboardingId: id, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/offboarding/:id/finalise", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_offboarding", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid offboarding id is required")));
      return;
    }
    const result = await finaliseOffboarding({ firmId: req.firmId!, offboardingId: id, actorUserId: req.userId! }, { tx: req.rlsDb });
    if (!result.guardsPassed && result.failedGuardCode) {
      const mapping = mapGuardCodeToHttp(result.failedGuardCode);
      res.status(mapping.httpStatus).json({
        error: {
          code: mapping.code,
          message: mapping.message,
          details: {
            active_case_count: result.record.activeCaseCount,
            pending_approvals: result.record.pendingApprovals,
            assets_count: result.record.assetsCount,
            claims_count: result.record.claimsCount,
            payroll_open: result.record.payrollOpen,
          },
        },
      });
      return;
    }
    res.json({
      ok: true,
      record: result.record,
      wasAlreadyFinalised: result.wasAlreadyFinalised,
      guardsPassed: result.guardsPassed,
    });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

export default expressRouter;
