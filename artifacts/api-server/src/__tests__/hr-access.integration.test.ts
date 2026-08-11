import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and, count } from "drizzle-orm";
import { hrEmployeesTable } from "@workspace/db";
import { assertHrAccess, assertAccountingAccess } from "../modules/shared/access-gates.js";

const pg = new PGlite();
const r = drizzle(pg);

const FIRM = 1;
const MANAGER_ROLE = 11;
const HR_ADMIN_ROLE = 12;
const HR_MANAGER_ROLE = 13;
const STAFF_ROLE = 14;
const ACCOUNT_ADMIN_ROLE = 21;
const ACCOUNT_MANAGER_ROLE = 22;
const PARTNER_ROLE = 2;

describe("HR + Accounting Access Matrix (PART 2A + 2E)", () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS roles (id serial PRIMARY KEY, firm_id integer, name text);
      CREATE TABLE IF NOT EXISTS permissions (id serial PRIMARY KEY, firm_id integer, role_id integer, module text, action text, allowed boolean);
      CREATE TABLE IF NOT EXISTS hr_employees (id serial PRIMARY KEY, firm_id integer, linked_user_id integer, employee_no text, legal_full_name text, employment_status text);
    `);
    const roles = [
      { id: PARTNER_ROLE, name: "Partner" },
      { id: HR_ADMIN_ROLE, name: "HR Admin" },
      { id: HR_MANAGER_ROLE, name: "HR Manager" },
      { id: MANAGER_ROLE, name: "Manager" },
      { id: STAFF_ROLE, name: "Staff" },
      { id: ACCOUNT_ADMIN_ROLE, name: "Account Admin" },
      { id: ACCOUNT_MANAGER_ROLE, name: "Account Manager" },
    ];
    for (const ro of roles) {
      await pg.exec(`INSERT INTO roles (id, firm_id, name) VALUES (${ro.id}, ${FIRM}, '${ro.name}') ON CONFLICT DO NOTHING`);
    }
    await pg.exec(`
      INSERT INTO permissions (firm_id, role_id, module, action, allowed) VALUES
      (${FIRM}, ${ACCOUNT_ADMIN_ROLE}, 'accounting','read', true),
      (${FIRM}, ${ACCOUNT_ADMIN_ROLE}, 'accounting','write', true),
      (${FIRM}, ${ACCOUNT_ADMIN_ROLE}, 'accounting','approve', true),
      (${FIRM}, ${ACCOUNT_MANAGER_ROLE}, 'accounting','read', true),
      (${FIRM}, ${ACCOUNT_MANAGER_ROLE}, 'accounting','write', true),
      (${FIRM}, ${PARTNER_ROLE}, 'dashboard','read', true),
      (${FIRM}, ${PARTNER_ROLE}, 'accounting','read', true),
      (${FIRM}, ${PARTNER_ROLE}, 'cases','assign_any', true),
      (${FIRM}, ${HR_ADMIN_ROLE}, 'hr','manage', true),
      (${FIRM}, ${HR_ADMIN_ROLE}, 'hr','approve', true),
      (${FIRM}, ${HR_MANAGER_ROLE}, 'hr','write', true),
      (${FIRM}, ${HR_MANAGER_ROLE}, 'hr','read', true),
      (${FIRM}, ${MANAGER_ROLE}, 'dashboard','read', true)
      ON CONFLICT DO NOTHING
    `);
  });

  it("2A: Partner / Account Admin / Account Manager → accounting module access=module", async () => {
    for (const roleId of [PARTNER_ROLE, ACCOUNT_ADMIN_ROLE, ACCOUNT_MANAGER_ROLE]) {
      const result = await assertAccountingAccess({
        firmId: FIRM, roleId, userId: 9000 + roleId, purpose: "module_accounting",
      }, r);
      expect(result.scope).toBe("module");
    }
  });

  it("2A: Plain Staff → module_accounting → denied, but own_case purpose with assigned → purpose_own_case", async () => {
    const denied = await assertAccountingAccess({
      firmId: FIRM, roleId: STAFF_ROLE, userId: 30000, purpose: "module_accounting",
    }, r);
    expect(denied.scope).toBe("denied");
    const ownCase = await assertAccountingAccess({
      firmId: FIRM, roleId: STAFF_ROLE, userId: 30001, purpose: "own_case_financial_status", ownCaseAssigned: true,
    }, r);
    expect(ownCase.scope).toBe("purpose_own_case");
  });

  it("2E: Staff self-service purpose allowed, module_hr denied", async () => {
    const denied = await assertHrAccess({
      firmId: FIRM, roleId: STAFF_ROLE, userId: 40001, purpose: "module_hr", targetEmployeeId: 100, viewerEmployeeId: 99,
    }, r);
    expect(denied.scope).toBe("denied");
    const self = await assertHrAccess({
      firmId: FIRM, roleId: STAFF_ROLE, userId: 40002, purpose: "self_service",
    }, r);
    expect(self.scope).toBe("self_service");
  });

  it("2E: HR Admin / HR Manager / Partner → hr full_admin", async () => {
    for (const roleId of [HR_ADMIN_ROLE, HR_MANAGER_ROLE, PARTNER_ROLE]) {
      const res = await assertHrAccess({ firmId: FIRM, roleId, userId: 8100 + roleId, purpose: "module_hr" }, r);
      expect(res.scope).toBe("full_admin");
    }
  });

  it("2E: Manager own_team_reports with managerOf returns manager_scope; otherwise denied", async () => {
    const good = await assertHrAccess({
      firmId: FIRM, roleId: MANAGER_ROLE, userId: 911, purpose: "own_team_reports", targetEmployeeId: 11, viewerEmployeeId: 999,
      managerOf: async (id) => id === 11,
    }, r);
    expect(good.scope).toBe("manager_scope");
    const bad = await assertHrAccess({
      firmId: FIRM, roleId: MANAGER_ROLE, userId: 912, purpose: "own_team_reports", targetEmployeeId: 999, viewerEmployeeId: 999,
      managerOf: async (id) => id === 11,
    }, r);
    expect(bad.scope).toBe("denied");
  });

  it("2F: hr_employees linked_user_id nullable unique semantic (schema test)", async () => {
    await pg.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_test_hr_emp_firm_user ON hr_employees (firm_id, linked_user_id) WHERE linked_user_id IS NOT NULL`);
    const [{ n }]: any[] = await r.select({ n: count() }).from(hrEmployeesTable);
    void n;
    await pg.exec(`
      INSERT INTO hr_employees (firm_id, employee_no, legal_full_name, employment_status, linked_user_id)
      VALUES (${FIRM}, 'E001', 'Alice', 'active', 1001)
    `);
    const rowsRes: any = await pg.query(
      `SELECT linked_user_id AS "linkedUserId" FROM hr_employees WHERE firm_id = $1 AND linked_user_id = $2`,
      [FIRM, 1001]
    );
    const rows = rowsRes.rows ?? rowsRes;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].linkedUserId)).toBe(1001);
  });
});
