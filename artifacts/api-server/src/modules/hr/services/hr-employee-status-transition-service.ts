import { type Response } from "express";
import { and, eq, type SQL } from "drizzle-orm";
import { hrEmployeesTable } from "@workspace/db";
import type { HrDomainDb } from "../permissions/hr-domain-db";
import { assertHrDomainDb } from "../permissions/hr-domain-db";
import {
  createHRError,
  HR_ERROR_CODES,
  serializeHRError,
} from "../../shared/errors/hr-error-codes";
import {
  checkOptimisticLock,
  nextVersion,
} from "../permissions/hr-authorization";
import { EMPLOYEE_STATUS_TRANSITIONS } from "../validators/employee-status-transitions";
import { formatHRIdempotencyKey } from "../../shared/idempotency/hr-idempotency";
import type { HrEmployeeStatusTransitionName } from "@workspace/api-zod";
import { writeAuditLog } from "../../../lib/auth";
import type { AuthRequest } from "../../../lib/auth";

export interface EmployeeStatusTransitionContext {
  db: HrDomainDb;
  firmId: number;
  actorUserId: number;
  employeeId: number;
  expectedVersion: number;
  transitionName: HrEmployeeStatusTransitionName;
  effectiveDate?: Date | null;
  reason?: string | null;
  note?: string | null;
  clientRequestId?: string | null;
  req?: Pick<AuthRequest, "ip" | "headers"> | null;
}

export interface EmployeeStatusTransitionResult {
  ok: true;
  employeeId: number;
  previousStatus: string;
  newStatus: string;
  transitionName: HrEmployeeStatusTransitionName;
  newVersion: number;
  idempotencyKey: string;
  auditWritten: boolean;
}

const TRANSITION_TO_REQUIRED_DATE: Partial<Record<HrEmployeeStatusTransitionName, string>> = {
  start_notice: "noticeStartDate",
  terminate_without_notice: "terminationDate",
  complete_inactive_handover: "lastWorkingDate",
  complete_handover_terminate: "terminationDate",
  terminate_from_inactive: "terminationDate",
  start_probation: "joinDate",
  activate: "joinDate",
  confirm: "confirmationDate",
};

function buildDateFieldUpdate(
  transitionName: HrEmployeeStatusTransitionName,
  effectiveDate?: Date | null,
): Partial<Record<string, Date | null>> {
  const field = TRANSITION_TO_REQUIRED_DATE[transitionName];
  if (!field) return {};
  if (!effectiveDate) {
    throw createHRError(
      HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
      `Transition ${transitionName} requires effectiveDate (${field}).`,
    );
  }
  return { [field]: effectiveDate };
}

export async function applyEmployeeStatusTransition(
  ctx: EmployeeStatusTransitionContext,
): Promise<EmployeeStatusTransitionResult> {
  const {
    actorUserId,
    employeeId,
    expectedVersion,
    transitionName,
    effectiveDate,
    reason,
    note,
    clientRequestId,
    req,
  } = ctx;
  const firmId = ctx.firmId;
  const targetDb = assertHrDomainDb(ctx.db, "applyEmployeeStatusTransition");

  const rows = await targetDb
    .select()
    .from(hrEmployeesTable)
    .where(
      and(
        eq(hrEmployeesTable.firmId, firmId),
        eq(hrEmployeesTable.id, employeeId),
      ),
    )
    .limit(1)
    .execute();

  const employee = rows[0];
  if (!employee) {
    throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `Employee ${employeeId} not found in firm ${firmId}.`);
  }

  checkOptimisticLock(employee, expectedVersion, "employee");

  const transition = EMPLOYEE_STATUS_TRANSITIONS.find(
    (t) => t.actionName === transitionName && t.from === employee.employmentStatus,
  );
  if (!transition) {
    throw createHRError(
      HR_ERROR_CODES.HR_INVALID_STATUS_TRANSITION,
      `Cannot apply transition "${transitionName}" from status "${employee.employmentStatus}".`,
    );
  }

  const previousStatus = employee.employmentStatus;
  const newStatus = transition.to;
  const newVersionNum = nextVersion(expectedVersion);
  const idempotencyKey = formatHRIdempotencyKey({
    sourceModule: "HR",
    sourceType: "EMPLOYEE",
    sourceId: employee.id,
    actionType: `TRANSITION:${transitionName}`,
    version: newVersionNum,
  });

  const dateUpdates = buildDateFieldUpdate(transitionName, effectiveDate ?? null);
  const now = new Date();

  const setClauses: Partial<Record<string, unknown>> = {
    employmentStatus: newStatus,
    version: newVersionNum,
    lastStatusChangeAt: now,
    updatedByUserId: actorUserId,
    updatedAt: now,
    ...dateUpdates,
  };

  if (newStatus === "terminated") {
    setClauses.terminatedAt = now;
    if (!dateUpdates.terminationDate) setClauses.terminationDate = now;
  }
  if (newStatus === "notice_period" && !dateUpdates.noticeStartDate) {
    setClauses.noticeStartDate = effectiveDate ?? now;
  }

  let affected = 0;
  try {
    const res = await targetDb
      .update(hrEmployeesTable)
      .set(setClauses as Record<string, unknown>)
      .where(
        and(
          eq(hrEmployeesTable.firmId, firmId),
          eq(hrEmployeesTable.id, employeeId),
          eq(hrEmployeesTable.version, expectedVersion) as unknown as SQL<unknown>,
        ),
      )
      .execute() as unknown as { rowCount?: number; affectedRows?: number };
    affected = (res.rowCount ?? res.affectedRows ?? 0) as number;
  } catch (err) {
    throw createHRError(
      HR_ERROR_CODES.HR_RECORD_CONFLICT,
      "Employee record could not be updated. Possible concurrent modification.",
    );
  }

  if (affected <= 0) {
    throw createHRError(
      HR_ERROR_CODES.HR_RECORD_VERSION_MISMATCH,
      "This record was updated by another user. Refresh and review the latest information.",
    );
  }

  let auditWritten = false;
  try {
    await writeAuditLog(
      {
        firmId,
        actorId: actorUserId,
        action: `hr.employee.${transitionName}`,
        entityType: "hr_employee",
        entityId: employeeId,
        detail: note ?? undefined,
        ipAddress: req?.ip ?? undefined,
        userAgent: typeof req?.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
        before: { employmentStatus: previousStatus, version: expectedVersion },
        after: { employmentStatus: newStatus, version: newVersionNum },
        reason: reason ?? undefined,
        requestId: clientRequestId ?? undefined,
      },
      { strict: false },
    );
    auditWritten = true;
  } catch {
    auditWritten = false;
  }

  return {
    ok: true,
    employeeId,
    previousStatus,
    newStatus,
    transitionName,
    newVersion: newVersionNum,
    idempotencyKey,
    auditWritten,
  };
}

export function sendStatusTransitionErrorResponse(err: unknown, res: Response) {
  const code = (err as { code?: string })?.code as string | undefined;
  if (code && (Object.values(HR_ERROR_CODES) as readonly string[]).includes(code)) {
    const httpStatus =
      code === HR_ERROR_CODES.HR_PERMISSION_DENIED ? 403 :
      code === HR_ERROR_CODES.HR_CROSS_FIRM_ACCESS_DENIED ? 403 :
      code === HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND ? 404 :
      code === HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING ? 400 :
      code === HR_ERROR_CODES.HR_INVALID_STATUS_TRANSITION ? 422 :
      code === HR_ERROR_CODES.HR_MODULE_DISABLED ? 503 :
      409;
    res.status(httpStatus).json(serializeHRError(err as Error));
    return;
  }
  res.status(500).json(serializeHRError(err as Error));
}
