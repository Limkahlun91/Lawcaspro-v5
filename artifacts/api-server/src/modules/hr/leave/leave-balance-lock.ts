import { db, hrEmployeeLeaveBalancesTable, sql } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";
import { writeScrubbed } from "../events/business-event-writer.js";

export interface LeaveBalanceConsumeInput {
  firmId: number;
  employeeId: number;
  leaveTypeId: string;
  consumeDays: string;
  approvalRefId: number | string;
  actorUserId?: number;
}

function hashtext(s: string): bigint {
  let h = 2166136261n;
  const fnvPrime = 16777619n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(32, h * fnvPrime);
  }
  return BigInt.asIntN(64, h);
}

export function leaveBalanceAdvisoryLockKey(
  firmId: number | string,
  employeeId: number | string,
  leaveTypeId: string,
): bigint {
  const s = `leave_balance_lock_${firmId}_${employeeId}_${leaveTypeId}`;
  return hashtext(s);
}

export async function withPgAdvisoryLock<T>(
  lockKey: bigint,
  work: () => Promise<T>,
): Promise<T> {
  const lockAcquired = await db.execute(sql`SELECT pg_try_advisory_lock(${sql`${lockKey}`}::bigint) AS ok`);
  const rowOk = Array.isArray(lockAcquired) ? (lockAcquired as any)[0]?.ok : (lockAcquired as any)?.rows?.[0]?.ok;
  const hasLock = Boolean(rowOk);
  if (!hasLock) {
    throw createHRError(
      HR_ERROR_CODES.HR_LEAVE_INSUFFICIENT_BALANCE,
      "Concurrent leave balance operation in progress; try again in a moment.",
    );
  }
  try {
    return await work();
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${sql`${lockKey}`}::bigint)`);
    } catch (e) {
      logger.warn({ lockKey: lockKey.toString(), err: e }, "pg_advisory_unlock failed (leaked until session end)");
    }
  }
}

interface FakeBalanceRow {
  entitledDays: Decimal;
  carriedForwardDays: Decimal;
  adjustedDays: Decimal;
  takenDays: Decimal;
  pendingApprovalDays: Decimal;
  version: number;
}

export function effectiveBalanceDays(row: FakeBalanceRow): Decimal {
  return row.entitledDays
    .plus(row.carriedForwardDays)
    .plus(row.adjustedDays)
    .minus(row.takenDays)
    .minus(row.pendingApprovalDays);
}

export async function consumeLeaveBalanceWithLock(input: LeaveBalanceConsumeInput): Promise<{
  consumed: boolean;
  balanceAfter: string;
}> {
  const lockKey = leaveBalanceAdvisoryLockKey(input.firmId, input.employeeId, input.leaveTypeId);
  return withPgAdvisoryLock(lockKey, async () => {
    const balanceRows = await db
      .select()
      .from(hrEmployeeLeaveBalancesTable)
      .where(
        and(
          eq(hrEmployeeLeaveBalancesTable.firmId, input.firmId),
          eq(hrEmployeeLeaveBalancesTable.employeeId, input.employeeId),
          eq(hrEmployeeLeaveBalancesTable.leaveTypeCode, input.leaveTypeId),
        ),
      )
      .limit(1);
    const row = balanceRows[0];
    if (!row) {
      throw createHRError(HR_ERROR_CODES.HR_LEAVE_INSUFFICIENT_BALANCE, `Leave balance for type ${input.leaveTypeId} not found`, {
        details: input,
      });
    }
    const working: FakeBalanceRow = {
      entitledDays: new Decimal(String(row.entitledDays ?? 0)),
      carriedForwardDays: new Decimal(String(row.carriedForwardDays ?? 0)),
      adjustedDays: new Decimal(String(row.adjustedDays ?? 0)),
      takenDays: new Decimal(String(row.takenDays ?? 0)),
      pendingApprovalDays: new Decimal(String(row.pendingApprovalDays ?? 0)),
      version: Number(row.version ?? 0),
    };
    const available = effectiveBalanceDays(working);
    const consume = new Decimal(input.consumeDays);
    if (consume.lt(0)) {
      throw createHRError(HR_ERROR_CODES.HR_LEAVE_INSUFFICIENT_BALANCE, "consumeDays must be >= 0");
    }
    if (available.lt(consume)) {
      return { consumed: false, balanceAfter: available.toFixed(2) };
    }
    working.takenDays = working.takenDays.plus(consume);
    const after = effectiveBalanceDays(working);
    await db
      .update(hrEmployeeLeaveBalancesTable)
      .set({
        takenDays: working.takenDays.toFixed(2) as any,
        version: (working.version + 1) as any,
      })
      .where(eq(hrEmployeeLeaveBalancesTable.id, row.id));
    await writeScrubbed({
      firmId: input.firmId,
      eventType: "LEAVE_BALANCE_CONSUMED",
      aggregateType: "LEAVE_BALANCE",
      aggregateId: `${row.id}`,
      payload: { leaveTypeCode: input.leaveTypeId, consumedDays: input.consumeDays, approvalRef: String(input.approvalRefId) },
      actorUserId: input.actorUserId,
    }).catch(() => { /* outbox write not allowed to fail consume; event retry via idempotency */ });
    return { consumed: true, balanceAfter: after.toFixed(2) };
  });
}

export const hrLeaveBalanceService = {
  consumeLeaveBalanceWithLock,
  leaveBalanceAdvisoryLockKey,
  effectiveBalanceDays,
};

export default hrLeaveBalanceService;
