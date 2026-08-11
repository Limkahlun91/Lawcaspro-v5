import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";
import {
  hrEmployeeLeaveBalancesTable,
} from "@workspace/db";
import { deductLeaveBalanceExactlyOnce, restoreLeaveBalanceOnCancel, buildLeaveBalanceEventKey } from "../modules/hr/leave-workflow.js";

const pg = new PGlite();
const r = drizzle(pg);
const FIRM = 1;
const EMP = 101;
const YEAR = new Date().getFullYear();

describe("Leave Workflow — approve deduct/cancel restore (PART 2I)", () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (id serial PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS hr_employee_leave_balances (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        employee_id integer NOT NULL,
        leave_type_code text NOT NULL,
        leave_year integer NOT NULL,
        entitled_days numeric(10,2) NOT NULL DEFAULT 0,
        carried_forward_days numeric(10,2) NOT NULL DEFAULT 0,
        adjusted_days numeric(10,2) NOT NULL DEFAULT 0,
        taken_days numeric(10,2) NOT NULL DEFAULT 0,
        pending_approval_days numeric(10,2) NOT NULL DEFAULT 0,
        balance_carried_forward_override numeric(10,2),
        expiry_date date,
        last_calculation_ref text,
        note text,
        created_by_user_id integer,
        updated_by_user_id integer,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, employee_id, leave_type_code, leave_year)
      )
    `);
  });
  beforeEach(async () => {
    await r.delete(hrEmployeeLeaveBalancesTable).where(and(eq(hrEmployeeLeaveBalancesTable.firmId, FIRM), eq(hrEmployeeLeaveBalancesTable.employeeId, EMP)));
  });

  it("Leave approve once → taken_days incremented exactly once; second call → alreadyApplied", async () => {
    const approveKey = buildLeaveBalanceEventKey({ kind: "leave_approved", applicationId: 5001 });
    const one = await deductLeaveBalanceExactlyOnce(r, { firmId: FIRM, employeeId: EMP, leaveTypeCode: "ANNUAL", year: YEAR, daysToDeduct: 2, eventKey: approveKey, applicationId: 5001, actorId: 88 });
    expect(one.alreadyApplied).toBe(false);
    expect(one.takenUpdated).toBe(true);
    const two = await deductLeaveBalanceExactlyOnce(r, { firmId: FIRM, employeeId: EMP, leaveTypeCode: "ANNUAL", year: YEAR, daysToDeduct: 2, eventKey: approveKey, applicationId: 5001, actorId: 88 });
    expect(two.alreadyApplied).toBe(true);
    expect(two.takenUpdated).toBe(false);
    const rowRes: any = await pg.query(
      `SELECT taken_days AS "takenDays" FROM hr_employee_leave_balances
       WHERE firm_id = $1 AND employee_id = $2 AND leave_type_code = $3 AND leave_year = $4 LIMIT 1`,
      [FIRM, EMP, "ANNUAL", YEAR]
    );
    const rows = rowRes.rows ?? rowRes;
    expect(Number(rows[0].takenDays)).toBe(2);
  });

  it("Cancel approved leave → restore exactly once; second call → alreadyRestored; original row not deleted", async () => {
    const approveKey = buildLeaveBalanceEventKey({ kind: "leave_approved", applicationId: 6001 });
    await deductLeaveBalanceExactlyOnce(r, { firmId: FIRM, employeeId: EMP, leaveTypeCode: "MEDICAL", year: YEAR, daysToDeduct: 3, eventKey: approveKey, applicationId: 6001, actorId: 77 });
    const cancelEvent = buildLeaveBalanceEventKey({ kind: "leave_cancel", applicationId: 6001, reversal: 1 });
    const one = await restoreLeaveBalanceOnCancel(r, { firmId: FIRM, employeeId: EMP, leaveTypeCode: "MEDICAL", year: YEAR, daysToRestore: 3, eventKey: cancelEvent, originalApproveEventKey: approveKey, applicationId: 6001, actorId: 77 });
    expect(one.alreadyRestored).toBe(false);
    expect(one.takenUpdated).toBe(true);
    const two = await restoreLeaveBalanceOnCancel(r, { firmId: FIRM, employeeId: EMP, leaveTypeCode: "MEDICAL", year: YEAR, daysToRestore: 3, eventKey: cancelEvent, originalApproveEventKey: approveKey, applicationId: 6001, actorId: 77 });
    expect(two.alreadyRestored).toBe(true);
    expect(two.takenUpdated).toBe(false);
    const rowsRes: any = await pg.query(
      `SELECT taken_days AS "takenDays", last_calculation_ref AS "lastCalculationRef"
       FROM hr_employee_leave_balances
       WHERE firm_id = $1 AND employee_id = $2 AND leave_type_code = $3`,
      [FIRM, EMP, "MEDICAL"]
    );
    const rows = rowsRes.rows ?? rowsRes;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].takenDays)).toBe(0);
    expect(rows[0].lastCalculationRef).toContain(approveKey);
    expect(rows[0].lastCalculationRef).toContain(cancelEvent);
  });

  it("Two separate applications deduct independently without cross-contaminate taken_days", async () => {
    const k1 = buildLeaveBalanceEventKey({ kind: "leave_approved", applicationId: 7001 });
    const k2 = buildLeaveBalanceEventKey({ kind: "leave_approved", applicationId: 7002 });
    await deductLeaveBalanceExactlyOnce(r, { firmId: FIRM, employeeId: EMP, leaveTypeCode: "ANNUAL", year: YEAR, daysToDeduct: 1, eventKey: k1, applicationId: 7001, actorId: 88 });
    await deductLeaveBalanceExactlyOnce(r, { firmId: FIRM, employeeId: EMP, leaveTypeCode: "ANNUAL", year: YEAR, daysToDeduct: 1.5, eventKey: k2, applicationId: 7002, actorId: 88 });
    const rowRes: any = await pg.query(
      `SELECT taken_days AS "takenDays" FROM hr_employee_leave_balances
       WHERE firm_id = $1 AND employee_id = $2 AND leave_type_code = $3 AND leave_year = $4 LIMIT 1`,
      [FIRM, EMP, "ANNUAL", YEAR]
    );
    const rows = rowRes.rows ?? rowRes;
    expect(Number(rows[0].takenDays)).toBe(2.5);
  });
});
