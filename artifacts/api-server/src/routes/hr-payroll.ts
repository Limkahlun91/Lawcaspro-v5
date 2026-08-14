import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { requireHRModuleEnabled } from "../modules/hr/permissions/hr-feature-gate.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes.js";
import { one } from "../lib/http.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";
import {
  listPayrollPeriods,
  runPayrollDraft,
  calculateEmployeePayroll,
  approvePayroll,
  finalisePayrollWithPosting,
  getEmployeePayslip,
} from "../modules/hr/payroll/payroll-core.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const runPayrollBodySchema = z.object({
  periodId: z.number().int().positive(),
});

const calculateBodySchema = z.object({
  periodId: z.number().int().positive(),
  employeeId: z.number().int().positive(),
});

router.get("/hr/payroll/periods", requireAuth, requireFirmUser, requireUserFeatureAccess("hr.payroll"), requireHRModuleEnabled, requirePermission("hr_payroll", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await listPayrollPeriods({ firmId: req.firmId!, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/payroll/run", requireAuth, requireFirmUser, requireUserFeatureAccess("hr.payroll"), requireHRModuleEnabled, requirePermission("hr_payroll", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = runPayrollBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await runPayrollDraft({
      firmId: req.firmId!,
      periodId: parsed.data.periodId,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.status(201).json({ ok: true, run: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/payroll/calculate", requireAuth, requireFirmUser, requireUserFeatureAccess("hr.payroll"), requireHRModuleEnabled, requirePermission("hr_payroll", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = calculateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      )));
      return;
    }
    const result = await calculateEmployeePayroll({
      firmId: req.firmId!,
      periodId: parsed.data.periodId,
      employeeId: parsed.data.employeeId,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    res.json({ ok: true, calculation: result });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/payroll/:runId/approve", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_payroll", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runIdStr = one(req.params.runId);
    const runId = runIdStr ? parseInt(runIdStr, 10) : NaN;
    if (!Number.isFinite(runId) || runId <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid run id is required")));
      return;
    }
    const result = await approvePayroll({ firmId: req.firmId!, runId, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({ ok: true, run: result.run, wasAlreadyApproved: result.wasAlreadyApproved });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.post("/hr/payroll/:runId/finalise", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_payroll", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runIdStr = one(req.params.runId);
    const runId = runIdStr ? parseInt(runIdStr, 10) : NaN;
    if (!Number.isFinite(runId) || runId <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid run id is required")));
      return;
    }
    const result = await finalisePayrollWithPosting({ firmId: req.firmId!, runId, actorUserId: req.userId! }, { tx: req.rlsDb });
    res.json({
      ok: true,
      run: result.run,
      wasAlreadyFinalised: result.wasAlreadyFinalised,
      accountingPostedNow: result.accountingPostedNow,
      accounting_posted: result.run.accountingPosted,
    });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

router.get("/hr/payroll/payslips/:payrollRunId/:employeeId", requireAuth, requireFirmUser, requireHRModuleEnabled, requirePermission("hr_payroll", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const runIdStr = one(req.params.payrollRunId);
    const payrollRunId = runIdStr ? parseInt(runIdStr, 10) : NaN;
    const empIdStr = one(req.params.employeeId);
    const employeeId = empIdStr ? parseInt(empIdStr, 10) : NaN;
    if (!Number.isFinite(payrollRunId) || payrollRunId <= 0 || !Number.isFinite(employeeId) || employeeId <= 0) {
      res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Valid payrollRunId and employeeId are required")));
      return;
    }
    const slip = await getEmployeePayslip({
      firmId: req.firmId!,
      payrollRunId,
      employeeId,
      actorUserId: req.userId!,
    }, { tx: req.rlsDb });
    if (!slip) {
      res.status(404).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Payslip not found")));
      return;
    }
    res.json({ ok: true, payslip: slip });
  } catch (err) {
    res.status(500).json(serializeHRError(err instanceof Error ? createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, err.message) : createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Unknown error")));
  }
});

export default expressRouter;
