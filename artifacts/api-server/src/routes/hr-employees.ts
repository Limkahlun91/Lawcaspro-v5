import express, { type NextFunction, type Request, type Response, type Router } from "express";
import {
  hrEmployeeStatusTransitionBodySchema,
  hrOptimisticLockHeaderSchema,
  type HrEmployeeStatusTransitionBody,
} from "@workspace/api-zod";
import type { AuthRequest } from "../lib/auth";
import { requireAuth, requireFirmUser, requirePermission } from "../lib/auth";
import { one } from "../lib/api-response";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../modules/shared/errors/hr-error-codes";
import { normalizeClientRequestId } from "../modules/shared/idempotency/hr-idempotency";
import {
  applyEmployeeStatusTransition,
  sendStatusTransitionErrorResponse,
} from "../modules/hr/services/hr-employee-status-transition-service";
import { toHrDomainDb } from "../modules/hr/permissions/hr-domain-db";

const router: Router = express.Router();

async function parseEmployeeIdParam(req: Request, res: Response, next: NextFunction) {
  const raw = one(req.params.id);
  if (!raw) {
    res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Employee id is required.")));
    return;
  }
  const num = parseInt(raw, 10);
  if (!Number.isFinite(num) || num <= 0) {
    res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Employee id must be a positive integer.")));
    return;
  }
  (req as AuthRequest & { hrEmployeeId?: number }).hrEmployeeId = num;
  next();
}

router.delete("*", (_req, res) => {
  res.status(405).json(serializeHRError(createHRError(
    HR_ERROR_CODES.HR_METHOD_NOT_ALLOWED,
    "Hard delete on HR employees is forbidden. Use status transitions instead (terminate, reactivate, etc.).",
  )));
});

router.patch(
  "/:id/transition",
  requireAuth,
  requireFirmUser,
  requirePermission("hr_employee", "status_change"),
  parseEmployeeIdParam,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthRequest;
    try {
      const id = (authReq as AuthRequest & { hrEmployeeId?: number }).hrEmployeeId;
      if (!id) {
        res.status(400).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "Invalid employee id.")));
        return;
      }
      if (!authReq.rlsDb) {
        res.status(403).json(serializeHRError(createHRError(
          HR_ERROR_CODES.HR_PERMISSION_DENIED,
          "Tenant-scoped DB context missing. requireFirmUser must run before HR operations.",
        )));
        return;
      }
      const versionHeader = hrOptimisticLockHeaderSchema.safeParse(authReq.headers);
      if (!versionHeader.success) {
        res.status(400).json(serializeHRError(createHRError(
          HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
          "X-HR-Record-Version header is required for employee status transitions.",
        )));
        return;
      }
      const bodyParsed = hrEmployeeStatusTransitionBodySchema.safeParse(authReq.body ?? {});
      if (!bodyParsed.success) {
        res.status(400).json(serializeHRError(createHRError(
          HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
          bodyParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        )));
        return;
      }
      const body: HrEmployeeStatusTransitionBody = bodyParsed.data;
      const clientRequestId = normalizeClientRequestId(body.clientRequestId ?? one(authReq.headers["x-client-request-id"] as string | string[] | undefined));

      const hrDb = toHrDomainDb(authReq.rlsDb, "hr-employees#transition");

      const result = await applyEmployeeStatusTransition({
        db: hrDb,
        firmId: authReq.firmId ?? 0,
        actorUserId: authReq.userId ?? 0,
        employeeId: id,
        expectedVersion: versionHeader.data["X-HR-Record-Version"],
        transitionName: body.transitionName,
        effectiveDate: body.effectiveDate ?? null,
        reason: body.reason ?? null,
        note: body.note ?? null,
        clientRequestId: clientRequestId ?? null,
        req: authReq,
      });
      if (!authReq.firmId || !authReq.userId) {
        sendStatusTransitionErrorResponse(createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "Firm user context missing."), res);
        return;
      }
      res.status(200).json({
        ok: true,
        employee_id: result.employeeId,
        previous_status: result.previousStatus,
        new_status: result.newStatus,
        transition_name: result.transitionName,
        new_version: result.newVersion,
        client_request_id: clientRequestId ?? undefined,
        idempotency_key: result.idempotencyKey,
      });
    } catch (err) {
      sendStatusTransitionErrorResponse(err, res);
    }
  },
);

export default router;
