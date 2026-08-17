import { and, eq, count, sql, or, gte, lte, isNotNull } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  hrEmployeesTable,
  hrLeaveRequestsTable,
  hrEmployeeLeaveBalancesTable,
  hrLeaveTypesTable,
} from "@workspace/db";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import {
  deductLeaveBalanceExactlyOnce,
  restoreLeaveBalanceOnCancel,
  reservePendingApprovalDays,
  releasePendingReservation,
  buildLeaveBalanceEventKey,
  isDeductibleLeaveTypeCode,
} from "../leave-workflow.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

const diffDays = (start: Date, end: Date): number => {
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)) + 1);
};

async function assertEmployeeBelongs(
  conn: DbConnLike,
  firmId: number,
  employeeId: number,
): Promise<void> {
  const [existing] = await conn
    .select({ n: count() })
    .from(hrEmployeesTable as any)
    .where(and(eq((hrEmployeesTable as any).firmId, firmId), eq((hrEmployeesTable as any).id, employeeId)))
    .execute();
  if (Number(existing?.n ?? 0) <= 0) {
    throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `Employee ${employeeId} not found in firm ${firmId}`);
  }
}

export interface CreateLeaveInput {
  firmId: number;
  employeeId: number;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  reason: string | null;
  actorUserId: number;
}

export interface LeaveRequestRecord {
  id: number;
  employeeId: number;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  balanceDeducted: boolean;
  leaveAuditIdempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const toLeaveRecord = (r: any): LeaveRequestRecord => ({
  id: Number(r.id),
  employeeId: Number(r.employeeId),
  leaveType: r.leaveTypeCode as string,
  startDate: new Date(r.startDate),
  endDate: new Date(r.endDate),
  reason: r.reason ?? null,
  status: r.status as any,
  balanceDeducted: Boolean(r.balanceDeducted),
  leaveAuditIdempotencyKey: r.idempotencyKey ?? null,
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
});

export async function createLeaveRequest(
  input: CreateLeaveInput,
  opts: { tx?: unknown } = {},
): Promise<LeaveRequestRecord> {
  const { firmId, employeeId, leaveType, startDate, endDate, reason, actorUserId } = input;
  if (endDate < startDate) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "end date cannot be before start date");
  }
  const days = diffDays(startDate, endDate);
  const now = new Date();
  const idempotencyKey = `leave-create:${firmId}:${employeeId}:${leaveType}:${startDate.toISOString().slice(0, 10)}:${endDate.toISOString().slice(0, 10)}`;
  const outerConn = pickDbConn(opts.tx);
  const deductible = isDeductibleLeaveTypeCode(leaveType);
  const year = new Date(startDate).getFullYear();
  const mutateInTx = async (tx: any): Promise<LeaveRequestRecord> => {
    await assertEmployeeBelongs(tx, firmId, employeeId);
    let typeRows: Array<{ code: string; defaultEntitled: unknown }> | null = null;
    const [existing] = await tx
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, firmId),
        eq((hrLeaveRequestsTable as any).idempotencyKey, idempotencyKey),
      ))
      .execute();
    if (existing) return toLeaveRecord(existing);

    if (deductible) {
      typeRows = await tx
        .select({
          code: hrLeaveTypesTable.leaveTypeCode,
          defaultEntitled: hrLeaveTypesTable.defaultEntitledDays,
        })
        .from(hrLeaveTypesTable)
        .where(and(
          eq(hrLeaveTypesTable.firmId, firmId),
          eq(hrLeaveTypesTable.leaveTypeCode, leaveType.toUpperCase()),
        ))
        .limit(1);
      if (typeRows.length === 0) {
        throw createHRError(
          HR_ERROR_CODES.HR_LEAVE_BALANCE_NOT_CONFIGURED,
          `Leave type ${leaveType} is not configured for firm ${firmId}`,
        );
      }
    }

    const [inserted] = await (tx as any)
      .insert(hrLeaveRequestsTable)
      .values({
        firmId,
        employeeId,
        leaveTypeCode: leaveType,
        startDate,
        endDate,
        days,
        reason,
        status: "pending",
        idempotencyKey,
        submittedAt: now,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      })
      .returning()
      .execute();
    const leaveRec = toLeaveRecord(inserted);

    if (deductible) {
      const createdEventKey = buildLeaveBalanceEventKey({ kind: "leave_created", applicationId: leaveRec.id });
      const reserveResult = await reservePendingApprovalDays(tx, {
        firmId,
        employeeId,
        leaveTypeCode: leaveType,
        year,
        daysToReserve: days,
        eventKey: createdEventKey,
        applicationId: leaveRec.id,
        actorId: actorUserId,
      });
      if (!reserveResult.balanceConfigured && Number(typeRows?.[0]?.defaultEntitled ?? 0) <= 0) {
        throw createHRError(
          HR_ERROR_CODES.HR_LEAVE_BALANCE_NOT_CONFIGURED,
          `No leave balance configured for employee ${employeeId}, type ${leaveType}, year ${year}`,
        );
      }
    }
    return leaveRec;
  };
  if (opts.tx) return mutateInTx(outerConn);
  return db.transaction((tx: any) => mutateInTx(tx));
}

export async function listMyLeaves(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<LeaveRequestRecord[]> {
  const conn = pickDbConn(opts.tx);
  const rows: any[] = await conn
    .select()
    .from(hrLeaveRequestsTable as any)
    .where(and(
      eq((hrLeaveRequestsTable as any).firmId, input.firmId),
      eq((hrLeaveRequestsTable as any).employeeId, input.employeeId),
    ))
    .orderBy((hrLeaveRequestsTable as any).createdAt)
    .execute();
  return rows.map(toLeaveRecord);
}

export async function approveLeaveIdempotent(
  input: { firmId: number; leaveId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyApproved: boolean; balanceDeductedNow: boolean; newBalanceDays: number; approved: boolean; idempotencyKey: string }> {
  const now = new Date();
  const idempotencyKey = `leave-approve:${input.firmId}:${input.leaveId}`;
  const outerConn = pickDbConn(opts.tx);
  const mutateInTx = async (tx: any) => {
    const [existing] = await tx
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, input.firmId),
        eq((hrLeaveRequestsTable as any).id, input.leaveId),
      ))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Leave not found");
    await assertEmployeeBelongs(tx, input.firmId, Number(existing.employeeId));
    const wasAlreadyApproved = existing.status === "approved";
    const deductible = isDeductibleLeaveTypeCode(String(existing.leaveTypeCode));
    const leaveYear = new Date(existing.startDate).getFullYear();
    const days = Number(existing.days ?? 0);
    let row: any = existing;
    let balanceDeductedNow = false;

    if (wasAlreadyApproved) {
      balanceDeductedNow = false;
    } else {
      if (deductible) {
        const approvedEventKey = buildLeaveBalanceEventKey({ kind: "leave_approved", applicationId: input.leaveId });
        const deductResult = await deductLeaveBalanceExactlyOnce(tx, {
          firmId: input.firmId,
          employeeId: Number(existing.employeeId),
          leaveTypeCode: String(existing.leaveTypeCode),
          year: leaveYear,
          daysToDeduct: days,
          eventKey: approvedEventKey,
          applicationId: input.leaveId,
          actorId: input.actorUserId,
        });
        if (!deductResult.balanceConfigured) {
          throw createHRError(
            HR_ERROR_CODES.HR_LEAVE_BALANCE_NOT_CONFIGURED,
            `No leave balance configured for employee ${existing.employeeId}, type ${existing.leaveTypeCode}, year ${leaveYear}`,
          );
        }
        if (!deductResult.alreadyApplied && deductResult.takenUpdated) {
          balanceDeductedNow = true;
        }
      }
      const balanceDeductedFinal = deductible && balanceDeductedNow;
      const [upd] = await (tx as any)
        .update(hrLeaveRequestsTable)
        .set({
          status: "approved",
          reviewedByUserId: input.actorUserId,
          reviewedAt: now,
          balanceDeducted: balanceDeductedFinal,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrLeaveRequestsTable as any).id, input.leaveId))
        .returning()
        .execute();
      row = upd;
    }

    let newBalanceDays = 0;
    const [balRow] = await tx
      .select()
      .from(hrEmployeeLeaveBalancesTable as any)
      .where(and(
        eq((hrEmployeeLeaveBalancesTable as any).firmId, input.firmId),
        eq((hrEmployeeLeaveBalancesTable as any).employeeId, Number(row.employeeId)),
        eq((hrEmployeeLeaveBalancesTable as any).leaveTypeCode, String(row.leaveTypeCode)),
        eq((hrEmployeeLeaveBalancesTable as any).leaveYear, leaveYear),
      ))
      .execute();
    if (balRow) {
      newBalanceDays = Number(balRow.entitledDays ?? 0) + Number(balRow.carriedForwardDays ?? 0) + Number(balRow.adjustedDays ?? 0) - Number(balRow.takenDays ?? 0) - Number(balRow.pendingApprovalDays ?? 0);
      newBalanceDays = Math.max(0, newBalanceDays);
    }
    return { leave: toLeaveRecord(row), wasAlreadyApproved, balanceDeductedNow, newBalanceDays, approved: true, idempotencyKey };
  };
  if (opts.tx) return mutateInTx(outerConn);
  return db.transaction((tx: any) => mutateInTx(tx));
}

export async function rejectLeaveRequest(
  input: { firmId: number; leaveId: number; actorUserId: number; reason?: string | null },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyRejected: boolean; balanceRestored: boolean }> {
  const now = new Date();
  const outerConn = pickDbConn(opts.tx);
  const mutateInTx = async (tx: any) => {
    const [existing] = await tx
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, input.firmId),
        eq((hrLeaveRequestsTable as any).id, input.leaveId),
      ))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Leave not found");
    const wasAlreadyRejected = existing.status === "rejected";
    const deductible = isDeductibleLeaveTypeCode(String(existing.leaveTypeCode));
    let row: any = existing;
    let balanceRestored = false;
    if (!wasAlreadyRejected) {
      if (deductible) {
        const createdEventKey = buildLeaveBalanceEventKey({ kind: "leave_created", applicationId: input.leaveId });
        const rejectEventKey = buildLeaveBalanceEventKey({ kind: "leave_rejected", applicationId: input.leaveId, reservedEventKey: createdEventKey });
        const year = new Date(existing.startDate).getFullYear();
        const releaseResult = await releasePendingReservation(tx, {
          firmId: input.firmId,
          employeeId: Number(existing.employeeId),
          leaveTypeCode: String(existing.leaveTypeCode),
          year,
          daysToRelease: Number(existing.days ?? 0),
          eventKey: rejectEventKey,
          reservedEventKey: createdEventKey,
          applicationId: input.leaveId,
          actorId: input.actorUserId,
        });
        balanceRestored = releaseResult.releasedNow;
      }
      const [upd] = await (tx as any)
        .update(hrLeaveRequestsTable)
        .set({
          status: "rejected",
          reviewedByUserId: input.actorUserId,
          reviewedAt: now,
          rejectionReason: input.reason ?? null,
          balanceDeducted: false,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrLeaveRequestsTable as any).id, input.leaveId))
        .returning()
        .execute();
      row = upd;
    }
    return { leave: toLeaveRecord(row), wasAlreadyRejected, balanceRestored };
  };
  if (opts.tx) return mutateInTx(outerConn);
  return db.transaction((tx: any) => mutateInTx(tx));
}

export async function cancelLeaveIdempotent(
  input: { firmId: number; leaveId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyCancelled: boolean; balanceRestored: boolean; idempotencyKey: string }> {
  const now = new Date();
  const idempotencyKey = `leave-cancel:${input.firmId}:${input.leaveId}`;
  const outerConn = pickDbConn(opts.tx);
  const mutateInTx = async (tx: any) => {
    const [existing] = await tx
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, input.firmId),
        eq((hrLeaveRequestsTable as any).id, input.leaveId),
      ))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Leave not found");
    const wasAlreadyCancelled = existing.status === "cancelled";
    const deductible = isDeductibleLeaveTypeCode(String(existing.leaveTypeCode));
    let row: any = existing;
    let balanceRestored = false;
    if (!wasAlreadyCancelled) {
      if (deductible && Boolean(existing.balanceDeducted)) {
        const originalApproveEventKey = buildLeaveBalanceEventKey({ kind: "leave_approved", applicationId: input.leaveId });
        const cancelEventKey = buildLeaveBalanceEventKey({ kind: "leave_cancel", applicationId: input.leaveId, reversal: 1 });
        const year = new Date(existing.startDate).getFullYear();
        const cancelResult = await restoreLeaveBalanceOnCancel(tx, {
          firmId: input.firmId,
          employeeId: Number(existing.employeeId),
          leaveTypeCode: String(existing.leaveTypeCode),
          year,
          daysToRestore: Number(existing.days ?? 0),
          eventKey: cancelEventKey,
          originalApproveEventKey,
          applicationId: input.leaveId,
          actorId: input.actorUserId,
        });
        balanceRestored = cancelResult.takenUpdated && !cancelResult.alreadyRestored;
      }
      const [upd] = await (tx as any)
        .update(hrLeaveRequestsTable)
        .set({
          status: "cancelled",
          balanceDeducted: false,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrLeaveRequestsTable as any).id, input.leaveId))
        .returning()
        .execute();
      row = upd;
    }
    return { leave: toLeaveRecord(row), wasAlreadyCancelled, balanceRestored, idempotencyKey };
  };
  if (opts.tx) return mutateInTx(outerConn);
  return db.transaction((tx: any) => mutateInTx(tx));
}

void or;
void sql;
void isNotNull;
void gte;
void lte;
