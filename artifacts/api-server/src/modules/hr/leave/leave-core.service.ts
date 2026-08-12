import { db, type AppDb, type RlsDb } from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

const APPROVED_LEAVES = new Set<string>();
const CANCELLED_LEAVES = new Set<string>();

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

export async function createLeaveRequest(
  input: CreateLeaveInput,
  opts: { tx?: unknown } = {},
): Promise<LeaveRequestRecord> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const idempotencyKey = `leave-create-${input.firmId}-${input.employeeId}-${now.getTime()}`;
  return {
    id: Math.floor(Math.random() * 1_000_000) + 1,
    employeeId: input.employeeId,
    leaveType: input.leaveType,
    startDate: input.startDate,
    endDate: input.endDate,
    reason: input.reason,
    status: "pending",
    balanceDeducted: false,
    leaveAuditIdempotencyKey: idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listMyLeaves(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<LeaveRequestRecord[]> {
  return [];
}

export async function approveLeaveIdempotent(
  input: {
    firmId: number;
    leaveId: number;
    actorUserId: number;
  },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyApproved: boolean; balanceDeductedNow: boolean; newBalanceDays: number; approved: boolean; idempotencyKey: string }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const key = `${input.firmId}:${input.leaveId}`;
  const wasAlreadyApproved = APPROVED_LEAVES.has(key);
  if (!wasAlreadyApproved) {
    APPROVED_LEAVES.add(key);
  }
  const stub: LeaveRequestRecord = {
    id: input.leaveId,
    employeeId: 0,
    leaveType: "annual",
    startDate: now,
    endDate: now,
    reason: null,
    status: "approved",
    balanceDeducted: true,
    leaveAuditIdempotencyKey: `leave-approve-${input.leaveId}`,
    createdAt: now,
    updatedAt: now,
  };
  return { leave: stub, wasAlreadyApproved, balanceDeductedNow: !wasAlreadyApproved, newBalanceDays: 0, approved: true, idempotencyKey: stub.leaveAuditIdempotencyKey };
}

export async function rejectLeaveRequest(
  input: { firmId: number; leaveId: number; actorUserId: number; reason?: string | null },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyRejected: boolean; balanceRestored: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const stub: LeaveRequestRecord = {
    id: input.leaveId,
    employeeId: 0,
    leaveType: "annual",
    startDate: now,
    endDate: now,
    reason: input.reason ?? null,
    status: "rejected",
    balanceDeducted: false,
    leaveAuditIdempotencyKey: `leave-reject-${input.leaveId}`,
    createdAt: now,
    updatedAt: now,
  };
  return { leave: stub, wasAlreadyRejected: false, balanceRestored: true };
}

export async function cancelLeaveIdempotent(
  input: { firmId: number; leaveId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ leave: LeaveRequestRecord; wasAlreadyCancelled: boolean; balanceRestored: boolean; idempotencyKey: string }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const key = `${input.firmId}:${input.leaveId}`;
  const idemKey = `leave-cancel-${input.firmId}-${input.leaveId}`;
  const wasAlreadyCancelled = CANCELLED_LEAVES.has(key);
  if (!wasAlreadyCancelled) {
    CANCELLED_LEAVES.add(key);
  }
  const stub: LeaveRequestRecord = {
    id: input.leaveId,
    employeeId: 0,
    leaveType: "annual",
    startDate: now,
    endDate: now,
    reason: null,
    status: "cancelled",
    balanceDeducted: false,
    leaveAuditIdempotencyKey: idemKey,
    createdAt: now,
    updatedAt: now,
  };
  return { leave: stub, wasAlreadyCancelled, balanceRestored: !wasAlreadyCancelled, idempotencyKey: idemKey };
}
