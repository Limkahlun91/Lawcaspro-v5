import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and, isNull } from "drizzle-orm";
import { caseAssignmentsTable, hrEmployeesTable, usersTable } from "@workspace/db";
import { finaliseEmployeeOffboarding, buildOffboardingChecklist } from "../modules/hr/offboarding-finalisation.js";

const pg = new PGlite();
const r = drizzle(pg);
const FIRM = 1;
const EMP_ID = 555;
const LINKED_USER = 999;

describe("Offboarding → case reassignment (PART 2N)", () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (id serial);
      CREATE TABLE IF NOT EXISTS hr_employees (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        linked_user_id integer,
        employee_no text,
        legal_full_name text,
        employment_status text NOT NULL DEFAULT 'active',
        termination_date date,
        last_working_date date,
        terminated_at timestamptz,
        last_status_change_at timestamptz,
        created_by_user_id integer,
        updated_by_user_id integer,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_firm_user_test ON hr_employees(firm_id, linked_user_id) WHERE linked_user_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS users (
        id serial PRIMARY KEY, firm_id integer, status text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS payment_vouchers (
        id serial PRIMARY KEY, firm_id integer, responsible_lawyer_id integer, approving_partner_id integer, status text, fund_status text
      );
      CREATE TABLE IF NOT EXISTS case_assignments (
        id serial PRIMARY KEY,
        firm_id integer, user_id integer, case_id integer,
        role_in_case text,
        assignment_role text,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        unassigned_at timestamptz,
        unassigned_by_user_id integer,
        removal_reason text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });
  beforeEach(async () => {
    await pg.exec(`DELETE FROM case_assignments WHERE firm_id = ${FIRM}`);
    await pg.exec(`DELETE FROM hr_employees WHERE firm_id = ${FIRM}`);
    await pg.exec(`DELETE FROM users WHERE firm_id = ${FIRM}`);
    await pg.exec(`DELETE FROM payment_vouchers WHERE firm_id = ${FIRM}`);
    await pg.exec(`
      INSERT INTO hr_employees (id, firm_id, employee_no, legal_full_name, employment_status, linked_user_id)
      VALUES (${EMP_ID}, ${FIRM}, 'E555', 'Inactive Staff', 'active', ${LINKED_USER})
      ON CONFLICT DO NOTHING
    `);
    await pg.exec(`INSERT INTO users (id, firm_id, status) VALUES (${LINKED_USER}, ${FIRM}, 'active') ON CONFLICT DO NOTHING`);
    for (const caseId of [101,102,103]) {
      await pg.exec(`
        INSERT INTO case_assignments (firm_id, user_id, case_id, assignment_role)
        VALUES (${FIRM}, ${LINKED_USER}, ${caseId}, 'responsible_lawyer')
      `);
    }
  });

  it("dry-run returns summary and does not mutate", async () => {
    const check = await buildOffboardingChecklist(FIRM, EMP_ID, r);
    expect(check?.activeCaseCount).toBe(3);
    expect(check?.employee.linkedUserId).toBe(LINKED_USER);
    const dry = await finaliseEmployeeOffboarding(r, {
      actorId: 1, firmId: FIRM, employeeId: EMP_ID, terminationDate: null, lastWorkingDate: null, dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.assignmentsUnassigned).toBe(0);
    const remainingRes: any = await pg.query(
      `SELECT COUNT(*)::int AS n FROM case_assignments WHERE firm_id = $1 AND user_id = $2 AND unassigned_at IS NULL`,
      [FIRM, LINKED_USER]
    );
    const remaining = Number((remainingRes.rows?.[0] ?? remainingRes[0]).n);
    expect(remaining).toBe(3);
  });

  it("finalise sets employment_status='terminated', user='inactive', removes ALL case assignments → remaining active = 0", async () => {
    const exec = await finaliseEmployeeOffboarding(r, {
      actorId: 44, firmId: FIRM, employeeId: EMP_ID,
      terminationDate: new Date("2025-12-31"), lastWorkingDate: new Date("2025-12-31"), dryRun: false,
    });
    expect(exec.employeeStatusUpdated).toBe(true);
    expect(exec.userStatusInactivated).toBe(true);
    expect(exec.assignmentsUnassigned).toBe(3);
    expect(exec.summary?.activeCaseCount).toBe(3);
    const stillActiveRes: any = await pg.query(
      `SELECT COUNT(*)::int AS n FROM case_assignments WHERE firm_id = $1 AND user_id = $2 AND unassigned_at IS NULL`,
      [FIRM, LINKED_USER]
    );
    const stillActive = Number((stillActiveRes.rows?.[0] ?? stillActiveRes[0]).n);
    expect(stillActive).toBe(0);
    const empRes: any = await pg.query(
      `SELECT employment_status AS "employmentStatus" FROM hr_employees WHERE id = $1 LIMIT 1`,
      [EMP_ID]
    );
    const emp = empRes.rows?.[0] ?? empRes[0];
    expect(emp.employmentStatus).toBe("terminated");
    const userRes: any = await pg.query(
      `SELECT status FROM users WHERE id = $1 LIMIT 1`,
      [LINKED_USER]
    );
    const u = userRes.rows?.[0] ?? userRes[0];
    expect(u.status).toBe("inactive");
    const revRes: any = await pg.query(
      `SELECT removal_reason AS "removalReason", unassigned_by_user_id AS "unassignedByUserId"
       FROM case_assignments WHERE firm_id = $1 AND user_id = $2 LIMIT 1`,
      [FIRM, LINKED_USER]
    );
    const revs = revRes.rows?.[0] ?? revRes[0];
    expect(revs.removalReason).toBe("offboarding_finalize");
    expect(Number(revs.unassignedByUserId)).toBe(44);
  });
});

void r;
void hrEmployeesTable;
void usersTable;
void caseAssignmentsTable;
void eq;
void and;
void isNull;
