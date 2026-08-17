import express, { type Response, type Router as ExpressRouter } from "express";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";
import { one } from "../lib/http.js";
import {
  getProfile,
  getMyLeave,
  getMyClaims,
  getMyPayslips,
  getMyAttendance,
  getMyDocuments,
  getMyAssets,
} from "../modules/hr/self/self-service-core.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

router.get("/hr/self/profile",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const profile = await getProfile({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    if (!profile) {
      res.status(404).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Profile not found")));
      return;
    }
    res.json({ ok: true, profile });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/self/leave",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requireUserFeatureAccess("hr.leave"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const rows = await getMyLeave({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/self/claims",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requireUserFeatureAccess("hr.claims"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const rows = await getMyClaims({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/self/payslips",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requireUserFeatureAccess("hr.payroll"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const rows = await getMyPayslips({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/self/attendance",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requireUserFeatureAccess("hr.attendance"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const startStr = one((req.query as any).startDate);
    const endStr = one((req.query as any).endDate);
    const startDate = startStr ? new Date(startStr) : undefined;
    const endDate = endStr ? new Date(endStr) : undefined;
    const rows = await getMyAttendance({ firmId: req.firmId!, userId: req.userId!, employeeId, startDate, endDate }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/self/documents",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const rows = await getMyDocuments({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/self/assets",
  requireAuth, requireFirmUser,
  requireHRModuleEnabled,
  requireUserFeatureAccess("hr.self_service"),
  requirePermission("hr_self_service", "read"),
  async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.userId!;
    const rows = await getMyAssets({ firmId: req.firmId!, userId: req.userId!, employeeId }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

export default expressRouter;
