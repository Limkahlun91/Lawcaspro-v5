import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";
import { one } from "../lib/http.js";
import {
  clockIn,
  clockOut,
  requestCorrection,
  approveCorrection,
} from "../modules/hr/attendance/attendance-core.service.js";

type RouterInternalLike = {
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const clockBodySchema = z.object({
  employeeId: z.number().int().positive(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
});

const correctionRequestSchema = z.object({
  employeeId: z.number().int().positive(),
  attendanceId: z.number().int().positive(),
  requestedClockIn: z.coerce.date().nullable().optional(),
  requestedClockOut: z.coerce.date().nullable().optional(),
  reason: z.string().nullable().optional(),
});

router.post("/hr/attendance/clock-in", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.attendance"), requirePermission("hr_attendance", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = clockBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const locationIn: { lat: number; lng: number } | null =
      parsed.data.location && parsed.data.location.lat != null && parsed.data.location.lng != null
        ? ({ lat: parsed.data.location.lat as number, lng: parsed.data.location.lng as number } as { lat: number; lng: number })
        : null;
    const result = await clockIn({
      firmId: req.firmId!,
      employeeId: parsed.data.employeeId,
      actorUserId: req.userId!,
      location: locationIn,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, record: result.record, wasAlreadyClockedIn: result.wasAlreadyClockedIn });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/attendance/clock-out", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.attendance"), requirePermission("hr_attendance", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = clockBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const locationOut: { lat: number; lng: number } | null =
      parsed.data.location && parsed.data.location.lat != null && parsed.data.location.lng != null
        ? ({ lat: parsed.data.location.lat as number, lng: parsed.data.location.lng as number } as { lat: number; lng: number })
        : null;
    const result = await clockOut({
      firmId: req.firmId!,
      employeeId: parsed.data.employeeId,
      actorUserId: req.userId!,
      location: locationOut,
    }, { tx: req.rlsDb });
    res.json({ ok: true, record: result.record, wasAlreadyClockedOut: result.wasAlreadyClockedOut });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/attendance/correction-request", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.attendance"), requirePermission("hr_attendance", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = correctionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await requestCorrection({
      firmId: req.firmId!,
      employeeId: parsed.data.employeeId,
      attendanceId: parsed.data.attendanceId,
      requestedClockIn: parsed.data.requestedClockIn ?? null,
      requestedClockOut: parsed.data.requestedClockOut ?? null,
      reason: parsed.data.reason ?? null,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, correction: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/attendance/corrections/:id/approve", requireAuth, requireFirmUser, requireHRModuleEnabled, requireUserFeatureAccess("hr.attendance"), requirePermission("hr_attendance", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid correction id is required")));
      return;
    }
    const result = await approveCorrection({ firmId: req.firmId!, correctionId: id, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, correction: result.correction, wasAlreadyApproved: result.wasAlreadyApproved });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

export default expressRouter;
