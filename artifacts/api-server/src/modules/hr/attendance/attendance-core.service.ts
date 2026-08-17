import { and, eq, count, sql, isNotNull, gte, lte } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  hrEmployeesTable,
  hrAttendanceRecordsTable,
  hrAttendanceCorrectionsTable,
} from "@workspace/db";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

const normalizeDateStr = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

const toAttendance = (row: any): AttendanceRecord => {
  const hasPending = row?._pendingCorrectionCount != null && Number(row._pendingCorrectionCount) > 0;
  let status: AttendanceRecord["status"];
  if (hasPending) status = "correction_pending";
  else if (row?.workStatus === "correction_approved") status = "correction_approved";
  else if (row?.clockOutAt != null) status = "clocked_out";
  else if (row?.clockInAt != null) status = "clocked_in";
  else status = "clocked_in";
  const lat = row?.clockInLocationLat != null ? Number(row.clockInLocationLat) : null;
  const lng = row?.clockInLocationLng != null ? Number(row.clockInLocationLng) : null;
  return {
    id: Number(row.id),
    employeeId: Number(row.employeeId),
    clockInAt: row.clockInAt ? new Date(row.clockInAt) : null,
    clockOutAt: row.clockOutAt ? new Date(row.clockOutAt) : null,
    location: lat != null && lng != null ? { lat, lng } : null,
    status,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
};

const toCorrection = (row: any): CorrectionRequest => ({
  id: Number(row.id),
  attendanceId: Number(row.attendanceId),
  employeeId: Number(row.employeeId),
  requestedClockIn: row.requestedClockIn ? new Date(row.requestedClockIn) : null,
  requestedClockOut: row.requestedClockOut ? new Date(row.requestedClockOut) : null,
  reason: row.reason ?? null,
  status: (row.status as any) ?? "pending",
  createdAt: new Date(row.createdAt),
  updatedAt: new Date(row.updatedAt),
});

export async function clockIn(
  input: { firmId: number; employeeId: number; actorUserId: number; location?: { lat: number; lng: number } | null },
  opts: { tx?: unknown } = {},
): Promise<{ record: AttendanceRecord; wasAlreadyClockedIn: boolean }> {
  const firmId = input.firmId;
  const actorUserId = input.actorUserId;
  const now = new Date();
  const attendanceDate = normalizeDateStr(now);
  const conn = pickDbConn(opts.tx);

  const mutate = async (): Promise<{ record: AttendanceRecord; wasAlreadyClockedIn: boolean }> => {
    await assertEmployeeBelongs(conn, firmId, input.employeeId);

    const [existing] = await conn
      .select()
      .from(hrAttendanceRecordsTable as any)
      .where(and(
        eq((hrAttendanceRecordsTable as any).firmId, firmId),
        eq((hrAttendanceRecordsTable as any).employeeId, input.employeeId),
        eq((hrAttendanceRecordsTable as any).attendanceDate, attendanceDate),
      ))
      .execute();

    if (existing && existing.clockInAt != null) {
      return { record: toAttendance(existing), wasAlreadyClockedIn: true };
    }

    const payload: any = {
      firmId,
      employeeId: input.employeeId,
      attendanceDate,
      clockInAt: now,
      clockInSource: "portal",
      workStatus: "normal",
      source: "portal",
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    };
    if (input.location) {
      payload.clockInLocationLat = input.location.lat;
      payload.clockInLocationLng = input.location.lng;
    }
    let rows: any[];
    if (existing) {
      payload.updatedAt = now;
      rows = await (conn as any)
        .update(hrAttendanceRecordsTable)
        .set(payload)
        .where(eq((hrAttendanceRecordsTable as any).id, existing.id))
        .returning()
        .execute();
    } else {
      rows = await (conn as any)
        .insert(hrAttendanceRecordsTable)
        .values(payload)
        .returning()
        .execute();
    }
    return { record: toAttendance(rows[0]), wasAlreadyClockedIn: false };
  };

  return mutate();
}

export async function clockOut(
  input: { firmId: number; employeeId: number; actorUserId: number; location?: { lat: number; lng: number } | null },
  opts: { tx?: unknown } = {},
): Promise<{ record: AttendanceRecord; wasAlreadyClockedOut: boolean }> {
  const firmId = input.firmId;
  const actorUserId = input.actorUserId;
  const now = new Date();
  const attendanceDate = normalizeDateStr(now);
  const conn = pickDbConn(opts.tx);

  const mutate = async (): Promise<{ record: AttendanceRecord; wasAlreadyClockedOut: boolean }> => {
    await assertEmployeeBelongs(conn, firmId, input.employeeId);

    const [existing] = await conn
      .select()
      .from(hrAttendanceRecordsTable as any)
      .where(and(
        eq((hrAttendanceRecordsTable as any).firmId, firmId),
        eq((hrAttendanceRecordsTable as any).employeeId, input.employeeId),
        eq((hrAttendanceRecordsTable as any).attendanceDate, attendanceDate),
      ))
      .execute();

    if (existing && existing.clockOutAt != null) {
      return { record: toAttendance(existing), wasAlreadyClockedOut: true };
    }
    if (!existing) {
      throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Attendance clock-in not found for today");
    }

    const payload: any = {
      clockOutAt: now,
      clockOutSource: "portal",
      updatedAt: now,
      updatedByUserId: actorUserId,
    };
    if (input.location) {
      payload.clockOutLocationLat = input.location.lat;
      payload.clockOutLocationLng = input.location.lng;
    }
    const rows = await (conn as any)
      .update(hrAttendanceRecordsTable)
      .set(payload)
      .where(eq((hrAttendanceRecordsTable as any).id, existing.id))
      .returning()
      .execute();

    return { record: toAttendance(rows[0]), wasAlreadyClockedOut: false };
  };

  return mutate();
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
  const firmId = input.firmId;
  const now = new Date();
  const conn = pickDbConn(opts.tx);
  const mutate = async (): Promise<CorrectionRequest> => {
    await assertEmployeeBelongs(conn, firmId, input.employeeId);

    const [attendance] = await conn
      .select()
      .from(hrAttendanceRecordsTable as any)
      .where(and(
        eq((hrAttendanceRecordsTable as any).firmId, firmId),
        eq((hrAttendanceRecordsTable as any).id, input.attendanceId),
        eq((hrAttendanceRecordsTable as any).employeeId, input.employeeId),
      ))
      .execute();
    if (!attendance) {
      throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Attendance record not found for correction");
    }

    const rows = await (conn as any)
      .insert(hrAttendanceCorrectionsTable)
      .values({
        firmId,
        attendanceId: input.attendanceId,
        employeeId: input.employeeId,
        requestedClockIn: input.requestedClockIn,
        requestedClockOut: input.requestedClockOut,
        reason: input.reason,
        status: "pending",
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .execute();
    return toCorrection(rows[0]);
  };
  return mutate();
}

export async function approveCorrection(
  input: { firmId: number; correctionId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ correction: CorrectionRequest; wasAlreadyApproved: boolean }> {
  const now = new Date();
  const conn = pickDbConn(opts.tx);
  const mutate = async (): Promise<{ correction: CorrectionRequest; wasAlreadyApproved: boolean }> => {
    const [existing] = await conn
      .select()
      .from(hrAttendanceCorrectionsTable as any)
      .where(and(
        eq((hrAttendanceCorrectionsTable as any).firmId, input.firmId),
        eq((hrAttendanceCorrectionsTable as any).id, input.correctionId),
      ))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Correction not found");
    const wasAlreadyApproved = existing.status === "approved";
    let correctionRow: any = existing;
    if (!wasAlreadyApproved) {
      const [updCorr] = await (conn as any)
        .update(hrAttendanceCorrectionsTable)
        .set({
          status: "approved",
          reviewedByUserId: input.actorUserId,
          reviewedAt: now,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrAttendanceCorrectionsTable as any).id, input.correctionId))
        .returning()
        .execute();
      correctionRow = updCorr;
      const patch: any = { updatedAt: now, updatedByUserId: input.actorUserId, workStatus: "correction_approved" };
      if (existing.requestedClockIn != null) patch.clockInAt = existing.requestedClockIn;
      if (existing.requestedClockOut != null) patch.clockOutAt = existing.requestedClockOut;
      await (conn as any)
        .update(hrAttendanceRecordsTable)
        .set(patch)
        .where(eq((hrAttendanceRecordsTable as any).id, existing.attendanceId))
        .execute();
    }
    return { correction: toCorrection(correctionRow), wasAlreadyApproved };
  };
  return mutate();
}

void sql;
void isNotNull;
void gte;
void lte;
