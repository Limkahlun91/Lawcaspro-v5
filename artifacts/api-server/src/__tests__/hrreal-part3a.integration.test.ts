import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  eq,
  count,
  or,
  desc,
  gte,
  lte,
} from "drizzle-orm";
import {
  hrEmployeesTable,
  hrAttendanceRecordsTable,
  hrLeaveRequestsTable,
  hrClaimsTable,
  hrPayrollRunsTable,
  hrEmployeeLeaveBalancesTable,
  type AppDb,
} from "@workspace/db";
import { clockIn } from "../modules/hr/attendance/attendance-core.service.js";
import {
  createLeaveRequest,
  approveLeaveIdempotent,
} from "../modules/hr/leave/leave-core.service.js";
import {
  createClaim,
  submitClaim,
  approveClaimWithPayable,
} from "../modules/hr/claims/claims-core.service.js";
import {
  runPayrollDraft,
  approvePayroll,
} from "../modules/hr/payroll/payroll-core.service.js";

const FIRM_A = 1;
const FIRM_B = 2;
const USER_ACTOR = 99;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../supabase/migrations");

function preprocessMigrationSql(raw: string): string {
  let sql = raw;
  sql = sql.replace(/^\s*CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+[a-zA-Z0-9_]+\s*;\s*$/gim, "-- stripped CREATE EXTENSION\n");
  sql = sql.replace(/^\s*CREATE\s+EXTENSION\s+[a-zA-Z0-9_]+\s*;\s*$/gim, "-- stripped CREATE EXTENSION\n");
  sql = sql.replace(/^\s*COMMENT\s+ON\s+EXTENSION\s+.*?;\s*$/gim, "-- stripped COMMENT ON EXTENSION\n");
  const supabaseRoles = ["anon", "authenticated", "service_role", "dashboard_user", "pg_read_all_data", "pg_write_all_data", "pg_monitor"];
  const rolesRe = new RegExp(`^\\s*(GRANT\\s+.*?|REVOKE\\s+.*?|ALTER\\s+DEFAULT\\s+PRIVILEGES\\s+.*?)\\s+(TO|FROM)\\s+.*?(${supabaseRoles.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*;\\s*$`, "gims");
  sql = sql.replace(rolesRe, "-- stripped supabase role grant/revoke\n");
  sql = sql.replace(/^\s*DO\s*\$\$.*?\$\$\s*;?\s*$/gims, "-- stripped DO block\n");
  sql = sql.replace(/^\s*SELECT\s+audit\.pgaudit\s*\(.*?\)\s*;?\s*$/gims, "-- stripped pgaudit\n");
  return sql;
}

async function newPgliteWithHrSchema() {
  const pg = new PGlite();
  const migrationPath = path.join(MIGRATIONS_DIR, "p8_hr_workflow_schema_parity.sql");
  if (fs.existsSync(migrationPath)) {
    const raw = fs.readFileSync(migrationPath, "utf8");
    const processed = preprocessMigrationSql(raw);
    await pg.exec(processed);
  } else {
    throw new Error(`Migration file not found at ${migrationPath} — PGlite cannot initialise HR schemas.`);
  }
  const db = drizzle(pg) as unknown as AppDb;
  return { pg, db };
}

type HrModuleStatus = "ready" | "not_configured";

function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function buildDashboardSummary(
  db: AppDb,
  firmId: number,
): Promise<{
  totalEmployees: number;
  activeToday: number | null;
  onLeaveToday: number | null;
  pendingLeave: number | null;
  pendingClaims: number | null;
  payrollStatusLabel: string | null;
  metricStatus: {
    attendance: HrModuleStatus;
    leave: HrModuleStatus;
    claims: HrModuleStatus;
    payroll: HrModuleStatus;
  };
}> {
  const today = todayStr();
  const metricStatus = {
    attendance: "not_configured" as HrModuleStatus,
    leave: "not_configured" as HrModuleStatus,
    claims: "not_configured" as HrModuleStatus,
    payroll: "not_configured" as HrModuleStatus,
  };

  const [empRow] = await db
    .select({ n: count() })
    .from(hrEmployeesTable as any)
    .where(and(
      eq((hrEmployeesTable as any).firmId, firmId),
      eq((hrEmployeesTable as any).employmentStatus, "active"),
    ))
    .execute();
  const totalEmployees = Number(empRow?.n ?? 0);

  let activeToday: number | null = null;
  try {
    const [r] = await db
      .select({ n: count() })
      .from(hrAttendanceRecordsTable as any)
      .where(and(
        eq((hrAttendanceRecordsTable as any).firmId, firmId),
        eq((hrAttendanceRecordsTable as any).attendanceDate, today),
      ))
      .execute();
    activeToday = Number(r?.n ?? 0);
    metricStatus.attendance = "ready";
  } catch {
    activeToday = null;
    metricStatus.attendance = "not_configured";
  }

  let onLeaveToday: number | null = null;
  let pendingLeave: number | null = null;
  try {
    const [lvRow] = await db
      .select({ n: count() })
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, firmId),
        eq((hrLeaveRequestsTable as any).status, "approved"),
        lte((hrLeaveRequestsTable as any).startDate, today),
        gte((hrLeaveRequestsTable as any).endDate, today),
      ))
      .execute();
    onLeaveToday = Number(lvRow?.n ?? 0);
    const [pLvRow] = await db
      .select({ n: count() })
      .from(hrLeaveRequestsTable as any)
      .where(and(
        eq((hrLeaveRequestsTable as any).firmId, firmId),
        eq((hrLeaveRequestsTable as any).status, "pending"),
      ))
      .execute();
    pendingLeave = Number(pLvRow?.n ?? 0);
    metricStatus.leave = "ready";
  } catch {
    onLeaveToday = null;
    pendingLeave = null;
    metricStatus.leave = "not_configured";
  }

  let pendingClaims: number | null = null;
  try {
    const [pClRow] = await db
      .select({ n: count() })
      .from(hrClaimsTable as any)
      .where(and(
        eq((hrClaimsTable as any).firmId, firmId),
        or(
          eq((hrClaimsTable as any).status, "pending"),
          eq((hrClaimsTable as any).status, "submitted"),
        ),
      ))
      .execute();
    pendingClaims = Number(pClRow?.n ?? 0);
    metricStatus.claims = "ready";
  } catch {
    pendingClaims = null;
    metricStatus.claims = "not_configured";
  }

  let payrollStatusLabel: string | null = null;
  try {
    const [pr] = await db
      .select()
      .from(hrPayrollRunsTable as any)
      .where(eq((hrPayrollRunsTable as any).firmId, firmId))
      .orderBy(desc((hrPayrollRunsTable as any).createdAt))
      .limit(1)
      .execute();
    if (pr) {
      payrollStatusLabel =
        pr.status === "finalised" ? "Completed" :
        pr.status === "approved" ? "Processing" :
        pr.status === "processing" ? "Processing" :
        pr.status === "draft" ? "Draft" : "Not Started";
    } else {
      payrollStatusLabel = "Not Started";
    }
    metricStatus.payroll = "ready";
  } catch {
    payrollStatusLabel = null;
    metricStatus.payroll = "not_configured";
  }

  return {
    totalEmployees,
    activeToday,
    onLeaveToday,
    pendingLeave,
    pendingClaims,
    payrollStatusLabel,
    metricStatus,
  };
}

let _empSeq = 1;
async function insertEmployee(
  db: AppDb,
  firmId: number,
  name: string,
  email: string,
): Promise<number> {
  const employeeNo = `EMP-HRREAL-${firmId}-${_empSeq++}`;
  const [row] = await (db as any)
    .insert(hrEmployeesTable)
    .values({
      firmId,
      employeeNo,
      legalFullName: name,
      commonEmail: email,
      employmentStatus: "active",
    })
    .returning()
    .execute();
  return Number(row.id);
}

describe("HRREAL integration tests (PGlite) — PART 3A HRMS real data closure", () => {
  let pg: PGlite;
  let db: AppDb;

  beforeAll(async () => {
    const ctx = await newPgliteWithHrSchema();
    pg = ctx.pg;
    db = ctx.db;
  });

  beforeEach(async () => {
    await (db as any).delete(hrAttendanceRecordsTable).execute();
    await (db as any).delete(hrLeaveRequestsTable).execute();
    await (db as any).delete(hrClaimsTable).execute();
    await (db as any).delete(hrPayrollRunsTable).execute();
    await (db as any).delete(hrEmployeeLeaveBalancesTable).execute();
    await (db as any).delete(hrEmployeesTable).execute();
  });

  it("HRREAL-1 employee persisted → totalEmployees increases from 0 → 1", async () => {
    const before = await buildDashboardSummary(db, FIRM_A);
    expect(before.totalEmployees).toBe(0);
    const id = await insertEmployee(db, FIRM_A, "HRREAL-1 Ali", "ali@hrreal1.test");
    expect(id).toBeGreaterThan(0);
    const after = await buildDashboardSummary(db, FIRM_A);
    expect(after.totalEmployees).toBe(1);
  });

  it("HRREAL-2 attendance persisted → Active Today changes 0 → 1 (real drizzle records)", async () => {
    const empId = await insertEmployee(db, FIRM_A, "HRREAL-2 Ah Meng", "meng@hrreal2.test");
    const dBefore = await buildDashboardSummary(db, FIRM_A);
    expect(dBefore.activeToday).toBe(0);
    expect(dBefore.metricStatus.attendance).toBe("ready");
    const ci = await clockIn(
      {
        firmId: FIRM_A,
        employeeId: empId,
        actorUserId: USER_ACTOR,
        location: { lat: 3.1, lng: 101.7 },
      },
      { tx: db },
    );
    expect(ci.wasAlreadyClockedIn).toBe(false);
    expect(ci.record.clockInAt).not.toBeNull();
    const dAfter = await buildDashboardSummary(db, FIRM_A);
    expect(dAfter.activeToday).toBe(1);
  });

  it("HRREAL-3 approved leave today → On Leave Today 0 → 1 with actual count", async () => {
    const empId = await insertEmployee(db, FIRM_A, "HRREAL-3 Siti", "siti@hrreal3.test");
    const today = new Date();
    const lv = await createLeaveRequest(
      {
        firmId: FIRM_A,
        employeeId: empId,
        leaveType: "annual",
        startDate: today,
        endDate: today,
        reason: "annual leave same day",
        actorUserId: USER_ACTOR,
      },
      { tx: db },
    );
    expect(lv.status).toBe("pending");
    const dPending = await buildDashboardSummary(db, FIRM_A);
    expect(dPending.onLeaveToday).toBe(0);
    expect(dPending.pendingLeave).toBe(1);
    const a = await approveLeaveIdempotent(
      { firmId: FIRM_A, leaveId: lv.id, actorUserId: USER_ACTOR },
      { tx: db },
    );
    expect(a.approved).toBe(true);
    expect(a.wasAlreadyApproved).toBe(false);
    const dAppr = await buildDashboardSummary(db, FIRM_A);
    expect(dAppr.onLeaveToday).toBe(1);
    expect(dAppr.pendingLeave).toBe(0);
  });

  it("HRREAL-4 pending leave → Pending Leave +1 (real count dashboard)", async () => {
    const empId = await insertEmployee(db, FIRM_A, "HRREAL-4 Keng", "keng@hrreal4.test");
    const base = await buildDashboardSummary(db, FIRM_A);
    expect(base.pendingLeave).toBe(0);
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86_400_000);
    await createLeaveRequest(
      {
        firmId: FIRM_A,
        employeeId: empId,
        leaveType: "annual",
        startDate: tomorrow,
        endDate: tomorrow,
        reason: "pending leave test",
        actorUserId: USER_ACTOR,
      },
      { tx: db },
    );
    const after = await buildDashboardSummary(db, FIRM_A);
    expect(after.pendingLeave).toBe(1);
  });

  it("HRREAL-5 approve leave → Pending Leave -1 (real count)", async () => {
    const empId = await insertEmployee(db, FIRM_A, "HRREAL-5 Raj", "raj@hrreal5.test");
    const tomorrow = new Date(Date.now() + 86_400_000);
    const lv = await createLeaveRequest(
      {
        firmId: FIRM_A,
        employeeId: empId,
        leaveType: "annual",
        startDate: tomorrow,
        endDate: tomorrow,
        reason: "approve test",
        actorUserId: USER_ACTOR,
      },
      { tx: db },
    );
    const beforeApprove = await buildDashboardSummary(db, FIRM_A);
    expect(beforeApprove.pendingLeave).toBe(1);
    await approveLeaveIdempotent(
      { firmId: FIRM_A, leaveId: lv.id, actorUserId: USER_ACTOR },
      { tx: db },
    );
    const afterApprove = await buildDashboardSummary(db, FIRM_A);
    expect(afterApprove.pendingLeave).toBe(0);
  });

  it("HRREAL-6 pending claim → Pending Claims +1 (real count dashboard from hr_claims persisted)", async () => {
    const empId = await insertEmployee(db, FIRM_A, "HRREAL-6 Lin", "lin@hrreal6.test");
    const base = await buildDashboardSummary(db, FIRM_A);
    expect(base.pendingClaims).toBe(0);
    const c = await createClaim(
      {
        firmId: FIRM_A,
        employeeId: empId,
        claimType: "travel",
        description: "Petrol claim",
        amount: 150.5,
        receipts: ["receipt-6.png"],
        incurrenceDate: new Date(),
        actorUserId: USER_ACTOR,
      },
      { tx: db },
    );
    expect(c.amount).toBe(150.5);
    await submitClaim(
      { firmId: FIRM_A, claimId: c.id, actorUserId: USER_ACTOR },
      { tx: db },
    );
    const after = await buildDashboardSummary(db, FIRM_A);
    expect(after.pendingClaims).toBe(1);
  });

  it("HRREAL-7 approve claim → Pending Claims -1 (real count)", async () => {
    const empId = await insertEmployee(db, FIRM_A, "HRREAL-7 Mei", "mei@hrreal7.test");
    const c = await createClaim(
      {
        firmId: FIRM_A,
        employeeId: empId,
        claimType: "meal",
        description: "client lunch",
        amount: 88.0,
        receipts: null,
        incurrenceDate: new Date(),
        actorUserId: USER_ACTOR,
      },
      { tx: db },
    );
    const sub = await submitClaim(
      { firmId: FIRM_A, claimId: c.id, actorUserId: USER_ACTOR },
      { tx: db },
    );
    expect(sub.wasAlreadySubmitted).toBe(false);
    const beforeApprove = await buildDashboardSummary(db, FIRM_A);
    expect(beforeApprove.pendingClaims).toBe(1);
    const apr = await approveClaimWithPayable(
      { firmId: FIRM_A, claimId: c.id, actorUserId: USER_ACTOR },
      { tx: db },
    );
    expect(apr.wasAlreadyApproved).toBe(false);
    expect(apr.claimStatus).toBe("approved");
    const afterApprove = await buildDashboardSummary(db, FIRM_A);
    expect(afterApprove.pendingClaims).toBe(0);
  });

  it("HRREAL-8 payroll draft persisted → Payroll Status Draft from real hr_payroll_runs", async () => {
    const empId = await insertEmployee(db, FIRM_A, "HRREAL-8 Payroll user", "pay@hrreal8.test");
    const start = new Date();
    const end = new Date(Date.now() + 29 * 86_400_000);
    const [inserted] = await (db as any)
      .insert(hrPayrollRunsTable)
      .values({
        firmId: FIRM_A,
        periodName: "2025-03 Monthly",
        periodStartDate: start,
        periodEndDate: end,
        status: "draft",
        payrollType: "monthly",
        totalEmployees: 1,
        createdByUserId: USER_ACTOR,
      })
      .returning()
      .execute();
    const run = await runPayrollDraft(
      { firmId: FIRM_A, periodId: Number(inserted.id), actorUserId: USER_ACTOR },
      { tx: db },
    );
    expect(run.status).toBe("draft");
    const dash = await buildDashboardSummary(db, FIRM_A);
    expect(dash.payrollStatusLabel).toBe("Draft");
    expect(dash.metricStatus.payroll).toBe("ready");
    const approved = await approvePayroll(
      { firmId: FIRM_A, runId: Number(inserted.id), actorUserId: USER_ACTOR },
      { tx: db },
    );
    expect(approved.wasAlreadyApproved).toBe(false);
    const dash2 = await buildDashboardSummary(db, FIRM_A);
    expect(dash2.payrollStatusLabel).toBe("Processing");
    void empId;
  });

  it("HRREAL-9 no attendance config / empty rows → NOT_CONFIGURED still ready, schema present zero rows returns 0 not null (backends distinguishes missing tables vs empty: here schema present so ready=0)", async () => {
    const emptyFirm = 3000;
    const dash = await buildDashboardSummary(db, emptyFirm);
    expect(dash.metricStatus.attendance).toBe("ready");
    expect(dash.activeToday).toBe(0);
    expect(dash.metricStatus.leave).toBe("ready");
    expect(dash.onLeaveToday).toBe(0);
    expect(dash.metricStatus.claims).toBe("ready");
    expect(dash.pendingClaims).toBe(0);
    expect(dash.metricStatus.payroll).toBe("ready");
    expect(dash.payrollStatusLabel).toBe("Not Started");
  });

  it("HRREAL-10 cross-firm employee denied by firm_id boundary (assertEmployeeBelongs)", async () => {
    const empFirmB = await insertEmployee(db, FIRM_B, "HRREAL-10 F2-Only", "cross@firm-b.test");
    let threw = false;
    try {
      await clockIn(
        {
          firmId: FIRM_A,
          employeeId: empFirmB,
          actorUserId: USER_ACTOR,
          location: null,
        },
        { tx: db },
      );
    } catch (e: any) {
      threw = true;
      expect(e?.code ?? e?.message).toBeTruthy();
    }
    expect(threw).toBe(true);
  });
});
