import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";
import { one } from "../lib/http.js";
import {
  createLeaveRequest,
  listMyLeaves,
  approveLeaveIdempotent,
  rejectLeaveRequest,
  cancelLeaveIdempotent,
} from "../modules/hr/leave/leave-core.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const createLeaveBodySchema = z.object({
  employeeId: z.number().int().positive(),
  leaveType: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  reason: z.string().nullable().optional(),
});

router.post("/hr/leave", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.leave"), requirePermission("hr_leave", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = createLeaveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await createLeaveRequest({
      firmId: req.firmId!,
      employeeId: parsed.data.employeeId,
      leaveType: parsed.data.leaveType,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      reason: parsed.data.reason ?? null,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, leave: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/leave/me",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requireUserFeatureAccess("hr.leave"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const rows = await listMyLeaves({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/leave/me",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requireUserFeatureAccess("hr.leave"),
  requirePermission("hr_self_service", "create"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const selfCreateSchema = createLeaveBodySchema.omit({ employeeId: true });
    const parsed = selfCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await createLeaveRequest({
      firmId: req.firmId!,
      employeeId: req.userId!,
      leaveType: parsed.data.leaveType,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      reason: parsed.data.reason ?? null,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, leave: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/leave/:id/approve", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.leave"), requirePermission("hr_leave", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid leave id is required")));
      return;
    }
    const result = await approveLeaveIdempotent({ firmId: req.firmId!, leaveId: id, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({
      ok: true,
      leave: result.leave,
      wasAlreadyApproved: result.wasAlreadyApproved,
      balanceDeductedNow: result.balanceDeductedNow,
    });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/leave/:id/reject", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.leave"), requirePermission("hr_leave", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid leave id is required")));
      return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    const result = await rejectLeaveRequest({ firmId: req.firmId!, leaveId: id, actorUserId: req.userId!, reason }, { tx: req.rlsDb });
    res.json({
      ok: true,
      leave: result.leave,
      wasAlreadyRejected: result.wasAlreadyRejected,
      balanceRestored: result.balanceRestored,
    });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/leave/:id/cancel", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.leave"), requirePermission("hr_leave", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid leave id is required")));
      return;
    }
    const result = await cancelLeaveIdempotent({ firmId: req.firmId!, leaveId: id, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({
      ok: true,
      leave: result.leave,
      wasAlreadyCancelled: result.wasAlreadyCancelled,
      balanceRestored: result.balanceRestored,
      leave_audit_idempotency_key: result.idempotencyKey,
    });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

export default expressRouter;
