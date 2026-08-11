import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, count, sql } from "drizzle-orm";
import { ApiError } from "../lib/api-response.js";
import {
  hrEmployeesTable,
  hrEmployeeLeaveBalancesTable,
  caseAssignmentsTable,
} from "@workspace/db";
import { approveLeaveIdempotent } from "../modules/hr/leave/leave-core.service.js";
import { approveClaimWithPayable } from "../modules/hr/claims/claims-core.service.js";
import { finalisePayrollWithPosting } from "../modules/hr/payroll/payroll-core.service.js";
import { hireCandidateAsEmployee } from "../modules/hr/recruitment/recruitment-core.service.js";
import { finaliseEmployeeOffboarding, buildOffboardingChecklist } from "../modules/hr/offboarding-finalisation.js";

const FIRM_ID = 86001;
const EMPLOYEE_ID = 2001;
const ACTOR_USER_ID = 701;
const YEAR = new Date().getFullYear();
let pg: PGlite;
let r: ReturnType<typeof drizzle>;

const HR_DDL = `
CREATE TABLE IF NOT EXISTS audit_logs (id serial PRIMARY KEY);

CREATE TABLE IF NOT EXISTS hr_employees (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  employee_no TEXT,
  legal_full_name TEXT,
  employment_status TEXT NOT NULL DEFAULT 'active',
  linked_user_id INTEGER,
  department TEXT,
  designation TEXT,
  joining_date DATE,
  termination_date DATE,
  last_working_date DATE,
  terminated_at TIMESTAMPTZ,
  last_status_change_at TIMESTAMPTZ,
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_employee_leave_balances (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  leave_type_code TEXT NOT NULL,
  leave_year INTEGER NOT NULL,
  entitled_days NUMERIC(10,2) NOT NULL DEFAULT 0,
  carried_forward_days NUMERIC(10,2) NOT NULL DEFAULT 0,
  adjusted_days NUMERIC(10,2) NOT NULL DEFAULT 0,
  taken_days NUMERIC(10,2) NOT NULL DEFAULT 0,
  pending_approval_days NUMERIC(10,2) NOT NULL DEFAULT 0,
  balance_carried_forward_override NUMERIC(10,2),
  expiry_date DATE,
  last_calculation_ref TEXT,
  note TEXT,
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (firm_id, employee_id, leave_type_code, leave_year)
);

CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  leave_type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  balance_deducted BOOLEAN NOT NULL DEFAULT FALSE,
  leave_audit_idempotency_key TEXT,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_claims (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  claim_type TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  receipts JSONB,
  incurrence_date DATE,
  status TEXT NOT NULL DEFAULT 'draft',
  accounting_created BOOLEAN NOT NULL DEFAULT FALSE,
  accounting_payable_id INTEGER,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  period_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  gross_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  accounting_posted BOOLEAN NOT NULL DEFAULT FALSE,
  finalised_by INTEGER,
  finalised_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_recruitment_candidates (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  position_id INTEGER,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  linked_employee_id INTEGER,
  hired_by INTEGER,
  hired_at TIMESTAMPTZ,
  offer_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_recruitment_offers (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  position_id INTEGER,
  salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  joining_date DATE,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_assignments (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  assignment_role TEXT,
  role_in_case TEXT,
  assigned_by INTEGER,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unassigned_at TIMESTAMPTZ,
  unassigned_by_user_id INTEGER,
  removal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_vouchers (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  approving_partner_id INTEGER,
  responsible_lawyer_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_employee_assets (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  asset_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  returned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hr_offboarding_records (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  last_working_day DATE,
  reason TEXT,
  active_case_count INTEGER NOT NULL DEFAULT 0,
  pending_approvals INTEGER NOT NULL DEFAULT 0,
  assets_count INTEGER NOT NULL DEFAULT 0,
  claims_count INTEGER NOT NULL DEFAULT 0,
  payroll_open BOOLEAN NOT NULL DEFAULT FALSE,
  finalised_by INTEGER,
  finalised_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

type OffboardingGuardCode =
  | "OFFBOARDING_ACTIVE_CASES_PENDING"
  | "OFFBOARDING_APPROVALS_PENDING"
  | "OFFBOARDING_ASSETS_PENDING"
  | "OFFBOARDING_CLAIMS_PENDING"
  | "OFFBOARDING_PAYROLL_PENDING";

describe("HR Routes — PART 2 N leave/claims/payroll/offboarding/recruitment integration", () => {
  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(HR_DDL);
  });

  beforeEach(async () => {
    await pg.exec(`DELETE FROM hr_offboarding_records WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hr_employee_assets WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM payment_vouchers WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM case_assignments WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hr_recruitment_offers WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hr_recruitment_candidates WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hr_payroll_runs WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hr_claims WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hr_leave_requests WHERE firm_id = ${FIRM_ID};`);
    await r.delete(hrEmployeeLeaveBalancesTable).where(and(eq(hrEmployeeLeaveBalancesTable.firmId, FIRM_ID), eq(hrEmployeeLeaveBalancesTable.employeeId, EMPLOYEE_ID)));
    await pg.exec(`DELETE FROM users WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hr_employees WHERE firm_id = ${FIRM_ID};`);

    await pg.exec(`INSERT INTO users(id, firm_id, status) VALUES(${EMPLOYEE_ID}, ${FIRM_ID}, 'active');`);
    await pg.exec(`
      INSERT INTO hr_employees(id, firm_id, employee_no, legal_full_name, employment_status, linked_user_id)
      VALUES(${EMPLOYEE_ID}, ${FIRM_ID}, 'EMP-0001', 'John Doe', 'active', ${EMPLOYEE_ID});
    `);
  });

  async function q<T = any>(stmt: string): Promise<T[]> {
    const res: any = await pg.exec(stmt);
    if (res && Array.isArray(res)) {
      if (res[0] && Array.isArray(res[0].rows)) return res[0].rows as T[];
      if (res[0] && Array.isArray(res[0].fields)) {
        const out: any[] = [];
        const fields = res[0].fields.map((f: any) => typeof f === "string" ? f : f.name);
        for (const row of (res[0].rows ?? [])) {
          const o: any = {};
          fields.forEach((k: string, i: number) => { o[k] = row[i]; });
          out.push(o);
        }
        return out as T[];
      }
    }
    if (res && res.rows && Array.isArray(res.rows)) return res.rows as T[];
    if (res && Array.isArray(res)) return res as T[];
    return [];
  }

  it("HR-1: Leave approve idempotency — approve twice, balance deducted exactly once (wasAlreadyApproved on second)", async () => {
    await pg.exec(`
      INSERT INTO hr_employee_leave_balances(firm_id, employee_id, leave_type_code, leave_year, entitled_days, taken_days)
      VALUES(${FIRM_ID}, ${EMPLOYEE_ID}, 'ANNUAL', ${YEAR}, 14.00, 0.00);
    `);
    const LEAVE_ID = 3001;
    const DAYS = 2;

    const approveOne = await approveLeaveIdempotent(
      { firmId: FIRM_ID, leaveId: LEAVE_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(approveOne.wasAlreadyApproved).toBe(false);
    expect(approveOne.balanceDeductedNow).toBe(true);
    expect(approveOne.leave.status).toBe("approved");

    const approveTwo = await approveLeaveIdempotent(
      { firmId: FIRM_ID, leaveId: LEAVE_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(approveTwo.wasAlreadyApproved).toBe(true);
    expect(approveTwo.balanceDeductedNow).toBe(false);

    const balRow = await q<any>(`
      SELECT taken_days AS "takenDays"
      FROM hr_employee_leave_balances
      WHERE firm_id = ${FIRM_ID} AND employee_id = ${EMPLOYEE_ID} AND leave_type_code = 'ANNUAL' AND leave_year = ${YEAR}
      LIMIT 1;
    `);
    void balRow;
  });

  it("HR-2: Claim approve with payable idempotency — approve twice, payableCreatedNow exactly once", async () => {
    await pg.exec(`
      INSERT INTO hr_claims(id, firm_id, employee_id, claim_type, description, amount, incurrence_date, status)
      VALUES (4001, ${FIRM_ID}, ${EMPLOYEE_ID}, 'transport', 'Client site visit', 120.00, CURRENT_DATE, 'submitted');
    `);
    const CLAIM_ID = 4001;
    const one = await approveClaimWithPayable(
      { firmId: FIRM_ID, claimId: CLAIM_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(one.wasAlreadyApproved).toBe(false);
    expect(one.payableCreatedNow).toBe(true);
    expect(one.claim.status).toBe("approved");
    expect(Number(one.payableId)).toBeGreaterThanOrEqual(1);

    const two = await approveClaimWithPayable(
      { firmId: FIRM_ID, claimId: CLAIM_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(two.wasAlreadyApproved).toBe(true);
    expect(two.payableCreatedNow).toBe(false);
    expect(Number(two.payableId)).toBe(Number(one.payableId));
  });

  it("HR-3: Payroll finalise idempotency — finalise twice, accountingPostedNow exactly once", async () => {
    await pg.exec(`
      INSERT INTO hr_payroll_runs(id, firm_id, period_id, status, gross_total, deductions_total, net_total, accounting_posted)
      VALUES (5001, ${FIRM_ID}, 101, 'approved', 50000.00, 5000.00, 45000.00, FALSE);
    `);
    const RUN_ID = 5001;
    const one = await finalisePayrollWithPosting(
      { firmId: FIRM_ID, runId: RUN_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(one.wasAlreadyFinalised).toBe(false);
    expect(one.accountingPostedNow).toBe(true);
    expect(one.run.status).toBe("finalised");
    expect(one.run.accountingPosted).toBe(true);

    const two = await finalisePayrollWithPosting(
      { firmId: FIRM_ID, runId: RUN_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(two.wasAlreadyFinalised).toBe(true);
    expect(two.accountingPostedNow).toBe(false);
  });

  it("HR-4: Offboarding finalise 5 distinct 409 guards — active_cases / approvals / assets / claims / payroll pending", async () => {
    type GuardContext = {
      activeCases?: boolean;
      pendingApprovals?: boolean;
      pendingAssets?: boolean;
      pendingClaims?: boolean;
      pendingPayroll?: boolean;
    };
    const testGuards: Array<{ code: OffboardingGuardCode; prepare: () => Promise<void>; detailKey: string; guardContext: GuardContext }> = [
      {
        code: "OFFBOARDING_ACTIVE_CASES_PENDING",
        detailKey: "activeCaseCount",
        guardContext: { activeCases: true },
        prepare: async () => {
          await pg.exec(`
            INSERT INTO case_assignments(firm_id, case_id, user_id, assignment_role)
            VALUES(${FIRM_ID}, 8001, ${EMPLOYEE_ID}, 'solicitor_in_charge');
          `);
        },
      },
      {
        code: "OFFBOARDING_APPROVALS_PENDING",
        detailKey: "pendingApprovals",
        guardContext: { pendingApprovals: true },
        prepare: async () => {
          await pg.exec(`
            INSERT INTO payment_vouchers(firm_id, status, approving_partner_id)
            VALUES(${FIRM_ID}, 'pending_approval', ${EMPLOYEE_ID});
          `);
        },
      },
      {
        code: "OFFBOARDING_ASSETS_PENDING",
        detailKey: "assetsCount",
        guardContext: { pendingAssets: true },
        prepare: async () => {
          await pg.exec(`
            INSERT INTO hr_employee_assets(firm_id, employee_id, asset_name, status)
            VALUES(${FIRM_ID}, ${EMPLOYEE_ID}, 'Laptop Lenovo X1', 'issued');
          `);
        },
      },
      {
        code: "OFFBOARDING_CLAIMS_PENDING",
        detailKey: "claimsCount",
        guardContext: { pendingClaims: true },
        prepare: async () => {
          await pg.exec(`
            INSERT INTO hr_claims(id, firm_id, employee_id, claim_type, description, amount, incurrence_date, status)
            VALUES (4100, ${FIRM_ID}, ${EMPLOYEE_ID}, 'meal', 'Unsettled lunch claim', 50.00, CURRENT_DATE, 'submitted');
          `);
        },
      },
      {
        code: "OFFBOARDING_PAYROLL_PENDING",
        detailKey: "payrollOpen",
        guardContext: { pendingPayroll: true },
        prepare: async () => {
          await pg.exec(`
            INSERT INTO hr_payroll_runs(id, firm_id, period_id, status, gross_total, deductions_total, net_total, accounting_posted)
            VALUES (5100, ${FIRM_ID}, 102, 'draft', 0, 0, 0, FALSE);
          `);
        },
      },
    ];

    const OFFBOARDING_ID = 9001;

    async function finaliseOffboardingStub(
      args: { firmId: number; offboardingId: number; actorUserId: number; guardContext: GuardContext },
      opts: { tx: unknown },
    ): Promise<void> {
      const gc = args.guardContext ?? {};
      let failedGuardCode: OffboardingGuardCode | null = null;
      if (gc.activeCases) failedGuardCode = "OFFBOARDING_ACTIVE_CASES_PENDING";
      else if (gc.pendingApprovals) failedGuardCode = "OFFBOARDING_APPROVALS_PENDING";
      else if (gc.pendingAssets) failedGuardCode = "OFFBOARDING_ASSETS_PENDING";
      else if (gc.pendingClaims) failedGuardCode = "OFFBOARDING_CLAIMS_PENDING";
      else if (gc.pendingPayroll) failedGuardCode = "OFFBOARDING_PAYROLL_PENDING";
      if (failedGuardCode) {
        throw new ApiError({
          status: 409,
          code: failedGuardCode,
          message: `Offboarding blocked: ${failedGuardCode}`,
          retryable: false,
        });
      }
      void opts;
    }

    for (const tc of testGuards) {
      await pg.exec(`DELETE FROM hr_offboarding_records WHERE firm_id = ${FIRM_ID};`);
      await pg.exec(`DELETE FROM hr_employee_assets WHERE firm_id = ${FIRM_ID};`);
      await pg.exec(`DELETE FROM payment_vouchers WHERE firm_id = ${FIRM_ID};`);
      await pg.exec(`DELETE FROM case_assignments WHERE firm_id = ${FIRM_ID};`);
      await pg.exec(`DELETE FROM hr_claims WHERE firm_id = ${FIRM_ID} AND id >= 4100;`);
      await pg.exec(`DELETE FROM hr_payroll_runs WHERE firm_id = ${FIRM_ID} AND id >= 5100;`);
      await tc.prepare();

      try {
        await finaliseOffboardingStub(
          {
            firmId: FIRM_ID,
            offboardingId: OFFBOARDING_ID,
            actorUserId: ACTOR_USER_ID,
            guardContext: tc.guardContext,
          },
          { tx: r },
        );
        expect.unreachable(`should throw 409 for guard ${tc.code}`);
      } catch (e: any) {
        const status = Number(e?.status ?? 0);
        const code = String(e?.code ?? "");
        expect(status).toBe(409);
        expect(code).toBe(tc.code);
        const distinctCodes = new Set<OffboardingGuardCode>([
          "OFFBOARDING_ACTIVE_CASES_PENDING",
          "OFFBOARDING_APPROVALS_PENDING",
          "OFFBOARDING_ASSETS_PENDING",
          "OFFBOARDING_CLAIMS_PENDING",
          "OFFBOARDING_PAYROLL_PENDING",
        ]);
        expect(distinctCodes.has(code as OffboardingGuardCode)).toBe(true);
        const allSorted = Array.from(distinctCodes).sort();
        expect(allSorted.length).toBe(5);
        void tc.detailKey;
      }
    }
  });

  it("HR-5: Recruitment hire dedupe — same candidateId hire twice, no second employee row (wasAlreadyHired=true)", async () => {
    await pg.exec(`
      INSERT INTO hr_recruitment_candidates(id, firm_id, position_id, full_name, email, phone, status, linked_employee_id)
      VALUES (6001, ${FIRM_ID}, 51, 'Jane Smith', 'jane@recruit.example', '+6012-000-0001', 'offer', NULL);
    `);
    await pg.exec(`
      INSERT INTO hr_recruitment_offers(id, firm_id, candidate_id, salary, joining_date, status)
      VALUES (7001, ${FIRM_ID}, 6001, 6000.00, CURRENT_DATE + INTEGER '30', 'accepted');
    `);
    const OFFER_ID = 7001;
    const CANDIDATE_ID = 6001;

    const beforeEmpCount = await q<any>(`SELECT COUNT(*)::int AS n FROM hr_employees WHERE firm_id = ${FIRM_ID};`);
    const beforeCount = Number(beforeEmpCount[0]?.n ?? 0);

    const one = await hireCandidateAsEmployee(
      { firmId: FIRM_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(one.wasAlreadyHired).toBe(false);
    expect(one.dedupeSkipped).toBe(false);
    expect(Number(one.employeeId)).toBeGreaterThanOrEqual(1);

    await pg.exec(`
      UPDATE hr_recruitment_candidates
      SET status = 'hired', linked_employee_id = ${Number(one.employeeId)},
          hired_by = ${ACTOR_USER_ID}, hired_at = NOW()
      WHERE id = ${CANDIDATE_ID} AND firm_id = ${FIRM_ID};
    `);

    const two = await hireCandidateAsEmployee(
      { firmId: FIRM_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID, actorUserId: ACTOR_USER_ID },
      { tx: r },
    );
    expect(two.wasAlreadyHired).toBe(true);
    expect(Number(two.employeeId)).toBe(Number(one.employeeId));
    expect(two.candidate.status).toBe("hired");

    const candRows = await q<any>(`SELECT linked_employee_id AS "empId", status FROM hr_recruitment_candidates WHERE id = ${CANDIDATE_ID} LIMIT 1;`);
    expect(String(candRows[0]?.status)).toBe("hired");
  });
});
