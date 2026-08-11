import { eq, and, count } from "drizzle-orm";
import {
  hrEmployeeLeaveBalancesTable,
} from "@workspace/db";

export type LeaveTypeCode =
  | "ANNUAL" | "MEDICAL" | "HOSPITALISATION" | "UNPAID" | "EMERGENCY" | "COMPASSIONATE" | "OTHER";

export type HrLeaveEventId =
  | { kind: "leave_approved"; applicationId: number | string }
  | { kind: "leave_cancel"; applicationId: number | string; reversal: 1 };

export function buildLeaveBalanceEventKey(e: HrLeaveEventId): string {
  if (e.kind === "leave_approved") return `HR_LEAVE_APPROVED:${e.applicationId}`;
  return `HR_LEAVE_CANCEL:${e.applicationId}:REVERSAL:${e.reversal}`;
}

type DbConnLike = {
  select: (cols: any) => any;
  insert: (t: any) => any;
  update: (t: any) => any;
};

function pickConn(tx: unknown): DbConnLike {
  return tx as DbConnLike;
}

type NumLike = number | string;
function toNum(n: unknown, fallback = 0): number {
  if (n == null) return fallback;
  const x = Number(n);
  if (Number.isFinite(x)) return x;
  return fallback;
}

function appendRef(base: string | null | undefined, token: string): string {
  const b = base ? String(base) : "";
  if (b.includes(token)) return b;
  return b ? `${b},${token}` : token;
}

export async function deductLeaveBalanceExactlyOnce(
  tx: unknown,
  args: {
    firmId: number;
    employeeId: number;
    leaveTypeCode: string;
    year: number;
    daysToDeduct: number;
    eventKey: string;
    applicationId: number | string;
    actorId: number;
  },
): Promise<{ alreadyApplied: boolean; takenUpdated: boolean }> {
  const d = pickConn(tx);
  const where = and(
    eq(hrEmployeeLeaveBalancesTable.firmId, args.firmId),
    eq(hrEmployeeLeaveBalancesTable.employeeId, args.employeeId),
    eq(hrEmployeeLeaveBalancesTable.leaveTypeCode, args.leaveTypeCode),
    eq(hrEmployeeLeaveBalancesTable.leaveYear, args.year),
  );
  const q = d.select({
    id: hrEmployeeLeaveBalancesTable.id,
    entitledDays: hrEmployeeLeaveBalancesTable.entitledDays,
    carriedForwardDays: hrEmployeeLeaveBalancesTable.carriedForwardDays,
    adjustedDays: hrEmployeeLeaveBalancesTable.adjustedDays,
    takenDays: hrEmployeeLeaveBalancesTable.takenDays,
    pendingApprovalDays: hrEmployeeLeaveBalancesTable.pendingApprovalDays,
    lastCalculationRef: hrEmployeeLeaveBalancesTable.lastCalculationRef,
    version: hrEmployeeLeaveBalancesTable.version,
    createdByUserId: hrEmployeeLeaveBalancesTable.createdByUserId,
  }).from(hrEmployeeLeaveBalancesTable).where(where).limit(1);
  const rows = await (typeof q.execute === "function" ? q.execute() : q);
  let row = rows && rows[0];
  if (!row) {
    const ins = d.insert(hrEmployeeLeaveBalancesTable).values({
      firmId: args.firmId,
      employeeId: args.employeeId,
      leaveTypeCode: args.leaveTypeCode,
      leaveYear: args.year,
      entitledDays: "0",
      carriedForwardDays: "0",
      adjustedDays: "0",
      takenDays: "0",
      pendingApprovalDays: "0",
      lastCalculationRef: "",
      createdByUserId: args.actorId,
      updatedByUserId: args.actorId,
      version: 1,
    }).returning({ id: hrEmployeeLeaveBalancesTable.id });
    const inserted = await (typeof ins.execute === "function" ? ins.execute() : ins);
    const id = inserted && inserted[0] ? Number((inserted[0] as any).id) : 0;
    row = { id, entitledDays: 0, carriedForwardDays: 0, adjustedDays: 0, takenDays: 0, pendingApprovalDays: 0, lastCalculationRef: "", version: 1, createdByUserId: args.actorId };
  }
  if (row.lastCalculationRef && String(row.lastCalculationRef).includes(args.eventKey)) {
    return { alreadyApplied: true, takenUpdated: false };
  }
  const taken = toNum(row.takenDays, 0);
  const newTaken = taken + args.daysToDeduct;
  const pending = Math.max(0, toNum(row.pendingApprovalDays, 0) - args.daysToDeduct);
  const newRef = appendRef(row.lastCalculationRef as any, args.eventKey);
  const ver = toNum(row.version, 1) + 1;
  const upd = d.update(hrEmployeeLeaveBalancesTable).set({
    takenDays: newTaken as any,
    pendingApprovalDays: pending as any,
    lastCalculationRef: newRef,
    updatedByUserId: args.actorId,
    version: ver,
  }).where(eq(hrEmployeeLeaveBalancesTable.id, Number(row.id)));
  await (typeof upd.execute === "function" ? upd.execute() : upd);
  return { alreadyApplied: false, takenUpdated: true };
}

export async function restoreLeaveBalanceOnCancel(
  tx: unknown,
  args: {
    firmId: number;
    employeeId: number;
    leaveTypeCode: string;
    year: number;
    daysToRestore: number;
    eventKey: string;
    originalApproveEventKey: string;
    applicationId: number | string;
    actorId: number;
  },
): Promise<{ alreadyRestored: boolean; takenUpdated: boolean }> {
  const d = pickConn(tx);
  const where = and(
    eq(hrEmployeeLeaveBalancesTable.firmId, args.firmId),
    eq(hrEmployeeLeaveBalancesTable.employeeId, args.employeeId),
    eq(hrEmployeeLeaveBalancesTable.leaveTypeCode, args.leaveTypeCode),
    eq(hrEmployeeLeaveBalancesTable.leaveYear, args.year),
  );
  const q = d.select({
    id: hrEmployeeLeaveBalancesTable.id,
    takenDays: hrEmployeeLeaveBalancesTable.takenDays,
    lastCalculationRef: hrEmployeeLeaveBalancesTable.lastCalculationRef,
    version: hrEmployeeLeaveBalancesTable.version,
    createdByUserId: hrEmployeeLeaveBalancesTable.createdByUserId,
  }).from(hrEmployeeLeaveBalancesTable).where(where).limit(1);
  const rows = await (typeof q.execute === "function" ? q.execute() : q);
  const row = rows && rows[0];
  if (!row) {
    return { alreadyRestored: true, takenUpdated: false };
  }
  if (row.lastCalculationRef && String(row.lastCalculationRef).includes(args.eventKey)) {
    return { alreadyRestored: true, takenUpdated: false };
  }
  const taken = Math.max(0, toNum(row.takenDays, 0) - args.daysToRestore);
  let ref = appendRef(row.lastCalculationRef as any, args.eventKey);
  if (!ref.includes(args.originalApproveEventKey)) {
    ref = appendRef(ref, args.originalApproveEventKey);
  }
  const ver = toNum(row.version, 1) + 1;
  const upd = d.update(hrEmployeeLeaveBalancesTable).set({
    takenDays: taken as any,
    lastCalculationRef: ref,
    updatedByUserId: args.actorId,
    version: ver,
  }).where(eq(hrEmployeeLeaveBalancesTable.id, Number(row.id)));
  await (typeof upd.execute === "function" ? upd.execute() : upd);
  return { alreadyRestored: false, takenUpdated: true };
}
