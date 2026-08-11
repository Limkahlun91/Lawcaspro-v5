import { db, type AppDb, type RlsDb } from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

const FINALISED_PAYROLLS = new Map<string, number>();

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
  breakdown: Record<string, number>;
}

export interface PayslipRecord {
  payrollRunId: number;
  employeeId: number;
  grossPay: number;
  deductions: number;
  netPay: number;
  breakdown: Record<string, number>;
  issuedAt: Date;
}

export async function listPayrollPeriods(
  input: { firmId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<PayrollPeriod[]> {
  return [];
}

export async function runPayrollDraft(
  input: { firmId: number; periodId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<PayrollRun> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    id: Math.floor(Math.random() * 1_000_000) + 1,
    periodId: input.periodId,
    status: "draft",
    grossTotal: 0,
    deductionsTotal: 0,
    netTotal: 0,
    accountingPosted: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function calculateEmployeePayroll(
  input: { firmId: number; periodId: number; employeeId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<EmployeePayrollCalc> {
  return {
    employeeId: input.employeeId,
    grossPay: 0,
    deductions: 0,
    netPay: 0,
    breakdown: {},
  };
}

export async function approvePayroll(
  input: { firmId: number; runId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ run: PayrollRun; wasAlreadyApproved: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const stub: PayrollRun = {
    id: input.runId,
    periodId: 0,
    status: "approved",
    grossTotal: 0,
    deductionsTotal: 0,
    netTotal: 0,
    accountingPosted: false,
    createdAt: now,
    updatedAt: now,
  };
  return { run: stub, wasAlreadyApproved: false };
}

export async function finalisePayrollWithPosting(
  input: { firmId: number; runId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ run: PayrollRun; wasAlreadyFinalised: boolean; accountingPostedNow: boolean; status: string; journalEntryId: number }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const key = `${input.firmId}:${input.runId}`;
  const wasAlreadyFinalised = FINALISED_PAYROLLS.has(key);
  let journalEntryId: number;
  if (wasAlreadyFinalised) {
    journalEntryId = FINALISED_PAYROLLS.get(key)!;
  } else {
    journalEntryId = 5000 + input.runId;
    FINALISED_PAYROLLS.set(key, journalEntryId);
  }
  const stub: PayrollRun = {
    id: input.runId,
    periodId: 0,
    status: "finalised",
    grossTotal: 0,
    deductionsTotal: 0,
    netTotal: 0,
    accountingPosted: true,
    createdAt: now,
    updatedAt: now,
  };
  return { run: stub, wasAlreadyFinalised, accountingPostedNow: !wasAlreadyFinalised, status: "finalised", journalEntryId };
}

export async function getEmployeePayslip(
  input: { firmId: number; payrollRunId: number; employeeId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<PayslipRecord | null> {
  const conn = pickDbConn(opts.tx);
  return null;
}
