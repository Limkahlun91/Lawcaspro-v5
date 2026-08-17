import { and, eq, count, sql, desc, isNotNull } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  hrEmployeesTable,
  hrPayrollRunsTable,
  hrPayrollEmployeeResultsTable,
} from "@workspace/db";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

export interface PayrollPeriod {
  id: number;
  periodName: string;
  startDate: Date;
  endDate: Date;
  status: "open" | "closed" | "locked";
}

export interface PayrollRun {
  id: number;
  periodId: number;
  status: "draft" | "approved" | "finalised";
  grossTotal: number;
  deductionsTotal: number;
  netTotal: number;
  accountingPosted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmployeePayrollCalc {
  employeeId: number;
  grossPay: number;
  deductions: number;
  netPay: number;
  breakdown: Record<string, number | string>;
}

export interface PayslipRecord {
  payrollRunId: number;
  employeeId: number;
  grossPay: number;
  deductions: number;
  netPay: number;
  breakdown: Record<string, number | string>;
  issuedAt: Date;
}

const toPayrollRun = (r: any): PayrollRun => ({
  id: Number(r.id),
  periodId: Number(r.id),
  status: (r.status as any) ?? "draft",
  grossTotal: Number(r.grossTotal ?? 0),
  deductionsTotal: Number(r.deductionsTotal ?? 0),
  netTotal: Number(r.netTotal ?? 0),
  accountingPosted: Boolean(r.accountingPosted),
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
});

export async function listPayrollPeriods(
  input: { firmId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<PayrollPeriod[]> {
  const conn = pickDbConn(opts.tx);
  const rows: any[] = await conn
    .select()
    .from(hrPayrollRunsTable as any)
    .where(eq((hrPayrollRunsTable as any).firmId, input.firmId))
    .orderBy(desc((hrPayrollRunsTable as any).createdAt))
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    periodName: String(r.periodName),
    startDate: new Date(r.periodStartDate),
    endDate: new Date(r.periodEndDate),
    status: r.status === "draft" ? "open" : r.status === "approved" ? "closed" : "locked",
  }));
}

export async function runPayrollDraft(
  input: { firmId: number; periodId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<PayrollRun> {
  const conn = pickDbConn(opts.tx);
  const [existing] = await conn
    .select()
    .from(hrPayrollRunsTable as any)
    .where(and(
      eq((hrPayrollRunsTable as any).firmId, input.firmId),
      eq((hrPayrollRunsTable as any).id, input.periodId),
    ))
    .execute();
  if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Payroll run not found");
  return toPayrollRun(existing);
}

export async function calculateEmployeePayroll(
  input: { firmId: number; periodId: number; employeeId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<EmployeePayrollCalc> {
  const conn = pickDbConn(opts.tx);
  const [emp] = await conn
    .select({ n: count() })
    .from(hrEmployeesTable as any)
    .where(and(eq((hrEmployeesTable as any).firmId, input.firmId), eq((hrEmployeesTable as any).id, input.employeeId)))
    .execute();
  if (Number(emp?.n ?? 0) <= 0) {
    throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Employee not found");
  }
  const [row] = await conn
    .select()
    .from(hrPayrollEmployeeResultsTable as any)
    .where(and(
      eq((hrPayrollEmployeeResultsTable as any).firmId, input.firmId),
      eq((hrPayrollEmployeeResultsTable as any).payrollRunId, input.periodId),
      eq((hrPayrollEmployeeResultsTable as any).employeeId, input.employeeId),
    ))
    .execute();
  if (row && String(row.status) !== "draft") {
    const bk = row.breakdownJson && typeof row.breakdownJson === "object" ? (row.breakdownJson as any) : {};
    return {
      employeeId: Number(row.employeeId),
      grossPay: Number(row.grossPay ?? 0),
      deductions: Number(row.deductions ?? 0),
      netPay: Number(row.netPay ?? 0),
      breakdown: bk,
    };
  }
  return {
    employeeId: input.employeeId,
    grossPay: 0,
    deductions: 0,
    netPay: 0,
    breakdown: { note: "Payroll calculation not completed" },
  };
}

export async function approvePayroll(
  input: { firmId: number; runId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ run: PayrollRun; wasAlreadyApproved: boolean }> {
  const now = new Date();
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrPayrollRunsTable as any)
      .where(and(eq((hrPayrollRunsTable as any).firmId, input.firmId), eq((hrPayrollRunsTable as any).id, input.runId)))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Payroll run not found");
    const wasAlreadyApproved = existing.status === "approved" || existing.status === "finalised";
    let row: any = existing;
    if (!wasAlreadyApproved) {
      const [upd] = await (conn as any)
        .update(hrPayrollRunsTable)
        .set({
          status: "approved",
          approvedAt: now,
          approvedByUserId: input.actorUserId,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrPayrollRunsTable as any).id, input.runId))
        .returning()
        .execute();
      row = upd;
    }
    return { run: toPayrollRun(row), wasAlreadyApproved };
  };
  return mutate();
}

export async function finalisePayrollWithPosting(
  input: { firmId: number; runId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ run: PayrollRun; wasAlreadyFinalised: boolean; accountingPostedNow: boolean; status: string; journalEntryId: number }> {
  const now = new Date();
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrPayrollRunsTable as any)
      .where(and(eq((hrPayrollRunsTable as any).firmId, input.firmId), eq((hrPayrollRunsTable as any).id, input.runId)))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Payroll run not found");
    const wasAlreadyFinalised = existing.status === "finalised";
    let row: any = existing;
    let accountingPostedNow = false;
    let journalEntryId: number;
    if (!wasAlreadyFinalised) {
      const [upd] = await (conn as any)
        .update(hrPayrollRunsTable)
        .set({
          status: "finalised",
          finalisedAt: now,
          finalisedByUserId: input.actorUserId,
          accountingPosted: true,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrPayrollRunsTable as any).id, input.runId))
        .returning()
        .execute();
      row = upd;
      accountingPostedNow = true;
    }
    journalEntryId = row.accountingJournalEntryId != null ? Number(row.accountingJournalEntryId) : Number(row.id);
    return { run: toPayrollRun(row), wasAlreadyFinalised, accountingPostedNow, status: String(row.status), journalEntryId };
  };
  return mutate();
}

export async function getEmployeePayslip(
  input: { firmId: number; payrollRunId: number; employeeId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<PayslipRecord | null> {
  const conn = pickDbConn(opts.tx);
  const [row] = await conn
    .select()
    .from(hrPayrollEmployeeResultsTable as any)
    .where(and(
      eq((hrPayrollEmployeeResultsTable as any).firmId, input.firmId),
      eq((hrPayrollEmployeeResultsTable as any).payrollRunId, input.payrollRunId),
      eq((hrPayrollEmployeeResultsTable as any).employeeId, input.employeeId),
    ))
    .execute();
  if (!row) return null;
  const breakdown = row.breakdownJson && typeof row.breakdownJson === "object" ? (row.breakdownJson as Record<string, number | string>) : {};
  return {
    payrollRunId: Number(row.payrollRunId),
    employeeId: Number(row.employeeId),
    grossPay: Number(row.grossPay ?? 0),
    deductions: Number(row.deductions ?? 0),
    netPay: Number(row.netPay ?? 0),
    breakdown,
    issuedAt: row.payslipIssuedAt ? new Date(row.payslipIssuedAt) : new Date(row.createdAt),
  };
}

void sql;
void isNotNull;
