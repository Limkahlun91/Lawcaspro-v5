import { db, type AppDb, type RlsDb } from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

export interface AttendanceRecord {
  id: number;
  employeeId: number;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  location: { lat: number; lng: number } | null;
  status: "clocked_in" | "clocked_out" | "correction_pending" | "correction_approved";
  createdAt: Date;
  updatedAt: Date;
}

export interface CorrectionRequest {
  id: number;
  attendanceId: number;
  employeeId: number;
  requestedClockIn: Date | null;
  requestedClockOut: Date | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
  updatedAt: Date;
}

export async function clockIn(
  input: { firmId: number; employeeId: number; actorUserId: number; location?: { lat: number; lng: number } | null },
  opts: { tx?: unknown } = {},
): Promise<{ record: AttendanceRecord; wasAlreadyClockedIn: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    record: {
      id: Math.floor(Math.random() * 1_000_000) + 1,
      employeeId: input.employeeId,
      clockInAt: now,
      clockOutAt: null,
      location: input.location ?? null,
      status: "clocked_in",
      createdAt: now,
      updatedAt: now,
    },
    wasAlreadyClockedIn: false,
  };
}

export async function clockOut(
  input: { firmId: number; employeeId: number; actorUserId: number; location?: { lat: number; lng: number } | null },
  opts: { tx?: unknown } = {},
): Promise<{ record: AttendanceRecord; wasAlreadyClockedOut: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    record: {
      id: Math.floor(Math.random() * 1_000_000) + 1,
      employeeId: input.employeeId,
      clockInAt: now,
      clockOutAt: now,
      location: input.location ?? null,
      status: "clocked_out",
      createdAt: now,
      updatedAt: now,
    },
    wasAlreadyClockedOut: false,
  };
}

export async function requestCorrection(
  input: {
    firmId: number;
    employeeId: number;
    attendanceId: number;
    requestedClockIn: Date | null;
    requestedClockOut: Date | null;
    reason: string | null;
    actorUserId: number;
  },
  opts: { tx?: unknown } = {},
): Promise<CorrectionRequest> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    id: Math.floor(Math.random() * 1_000_000) + 1,
    attendanceId: input.attendanceId,
    employeeId: input.employeeId,
    requestedClockIn: input.requestedClockIn,
    requestedClockOut: input.requestedClockOut,
    reason: input.reason,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export async function approveCorrection(
  input: { firmId: number; correctionId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ correction: CorrectionRequest; wasAlreadyApproved: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    correction: {
      id: input.correctionId,
      attendanceId: 0,
      employeeId: 0,
      requestedClockIn: now,
      requestedClockOut: now,
      reason: null,
      status: "approved",
      createdAt: now,
      updatedAt: now,
    },
    wasAlreadyApproved: false,
  };
}
