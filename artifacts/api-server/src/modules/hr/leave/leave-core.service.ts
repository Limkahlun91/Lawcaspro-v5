import { and, eq, count, sql, or, gte, lte, isNotNull } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  hrEmployeesTable,
  hrLeaveRequestsTable,
  hrEmployeeLeaveBalancesTable,
} from "@workspace/db";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";

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
  const conn = pickDbConn(opts.tx);
  const mutate = async (): Promise<LeaveRequestRecord> => {
    await assertEmployeeBelongs(conn, firmId, employeeId);
    const [existing] = await conn
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, firmId),
        eq((hrLeaveRequestsTable as any).idempotencyKey, idempotencyKey),
      ))
      .execute();
    if (existing) return toLeaveRecord(existing);

    const [inserted] = await (conn as any)
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
    return toLeaveRecord(inserted);
  };
  return mutate();
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
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, input.firmId),
        eq((hrLeaveRequestsTable as any).id, input.leaveId),
      ))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Leave not found");
    const wasAlreadyApproved = existing.status === "approved";
    let row: any = existing;
    let balanceDeductedNow = false;
    if (!wasAlreadyApproved) {
      const [upd] = await (conn as any)
        .update(hrLeaveRequestsTable)
        .set({
          status: "approved",
          reviewedByUserId: input.actorUserId,
          reviewedAt: now,
          balanceDeducted: true,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrLeaveRequestsTable as any).id, input.leaveId))
        .returning()
        .execute();
      row = upd;
      balanceDeductedNow = true;
    }
    const leaveYear = new Date(row.startDate).getFullYear();
    let newBalanceDays = 0;
    try {
      const [balRow] = await conn
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
    } catch {
      newBalanceDays = 0;
    }
    return { leave: toLeaveRecord(row), wasAlreadyApproved, balanceDeductedNow, newBalanceDays, approved: true, idempotencyKey };
  };
  return mutate();
}

export async function rejectLeaveRequest(
  input: { firmId: number; leaveId: number; actorUserId: number; reason?: string | null },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyRejected: boolean; balanceRestored: boolean }> {
  const now = new Date();
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, input.firmId),
        eq((hrLeaveRequestsTable as any).id, input.leaveId),
      ))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Leave not found");
    const wasAlreadyRejected = existing.status === "rejected";
    let row: any = existing;
    const balanceRestored = Boolean(existing.balanceDeducted) && !wasAlreadyRejected;
    if (!wasAlreadyRejected) {
      const [upd] = await (conn as any)
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
  return mutate();
}

export async function cancelLeaveIdempotent(
  input: { firmId: number; leaveId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyCancelled: boolean; balanceRestored: boolean; idempotencyKey: string }> {
  const now = new Date();
  const idempotencyKey = `leave-cancel:${input.firmId}:${input.leaveId}`;
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, input.firmId),
        eq((hrLeaveRequestsTable as any).id, input.leaveId),
      ))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Leave not found");
    const wasAlreadyCancelled = existing.status === "cancelled";
    let row: any = existing;
    const balanceRestored = Boolean(existing.balanceDeducted) && !wasAlreadyCancelled;
    if (!wasAlreadyCancelled) {
      const [upd] = await (conn as any)
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
  return mutate();
}

void or;
void sql;
void isNotNull;
void gte;
void lte;
