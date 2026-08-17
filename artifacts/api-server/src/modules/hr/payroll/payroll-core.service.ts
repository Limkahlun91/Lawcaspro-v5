import { and, eq, count, sql, desc, isNotNull } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  hrEmployeesTable,
  hrPayrollRunsTable,
  hrPayrollEmployeeResultsTable,
  ledgerEntriesTable,
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

const HR_PAYROLL_EVENT_KEY = (firmId: number, runId: number): string =>
  `HR_PAYROLL_FINALISED:${firmId}:${runId}`;

const formatEntryDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const isSchemaMissing = (err: unknown): boolean => {
  const code = err != null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return code === "42P01" || code === "42703";
};

async function tryPostPayrollJournalInTx(
  tx: any,
  args: {
    firmId: number;
    runId: number;
    grossTotal: number;
    deductionsTotal: number;
    netTotal: number;
    periodName: string | null;
    periodEndDate: Date | null;
    actorUserId: number;
  },
): Promise<{ journalEntryId: number | null; postedNow: boolean }> {
  const eventKey = HR_PAYROLL_EVENT_KEY(args.firmId, args.runId);
  const existing = await tx
    .select({ id: ledgerEntriesTable.id })
    .from(ledgerEntriesTable)
    .where(and(
      eq(ledgerEntriesTable.firmId, args.firmId),
      eq(ledgerEntriesTable.sourceType, "hr_payroll"),
      eq(ledgerEntriesTable.sourceId, args.runId),
      eq(ledgerEntriesTable.entryType, "payroll_disbursement_wages"),
    ))
    .limit(1);
  if (existing?.[0]) {
    return { journalEntryId: Number(existing[0].id), postedNow: false };
  }
  const entryDate = formatEntryDate(args.periodEndDate ? new Date(args.periodEndDate) : new Date());
  const gross = Math.max(0, Number(args.grossTotal) || 0);
  const deductions = Math.max(0, Number(args.deductionsTotal) || 0);
  const net = Math.max(0, Number(args.netTotal) || 0);
  const referenceNo = args.periodName?.trim() || `PAYROLL-RUN-${args.runId}`;

  try {
    const wagesRows = await tx
      .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
      .from(ledgerEntriesTable)
      .where(and(
        eq(ledgerEntriesTable.firmId, args.firmId),
        eq(ledgerEntriesTable.accountType, "office"),
        sql`case_id IS NULL`,
      ));
    const prevWages = Number(wagesRows?.[0]?.bal ?? 0);
    const [wagesIns] = await tx
      .insert(ledgerEntriesTable)
      .values({
        firmId: args.firmId,
        caseId: null,
        entryDate,
        entryType: "payroll_disbursement_wages",
        accountType: "office",
        debit: gross.toFixed(2),
        credit: "0.00",
        balanceAfter: (prevWages - gross).toFixed(2),
        description: `Payroll wages expense for ${referenceNo} (run #${args.runId})`,
        referenceNo,
        sourceType: "hr_payroll",
        sourceId: args.runId,
        createdBy: args.actorUserId,
      })
      .returning({ id: ledgerEntriesTable.id });
    const journalEntryId = wagesIns?.id != null ? Number(wagesIns.id) : 0;
    if (journalEntryId <= 0) {
      return { journalEntryId: null, postedNow: false };
    }
    const dedRows = await tx
      .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
      .from(ledgerEntriesTable)
      .where(and(
        eq(ledgerEntriesTable.firmId, args.firmId),
        eq(ledgerEntriesTable.accountType, "balance_sheet"),
        sql`case_id IS NULL`,
      ));
    const prevDed = Number(dedRows?.[0]?.bal ?? 0);
    await tx.insert(ledgerEntriesTable).values({
      firmId: args.firmId,
      caseId: null,
      entryDate,
      entryType: "payroll_deductions_withheld",
      accountType: "balance_sheet",
      debit: "0.00",
      credit: deductions.toFixed(2),
      balanceAfter: (prevDed + deductions).toFixed(2),
      description: `Payroll statutory/voluntary deductions for ${referenceNo}`,
      referenceNo,
      sourceType: "hr_payroll",
      sourceId: args.runId,
      createdBy: args.actorUserId,
    });
    const netRows = await tx
      .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
      .from(ledgerEntriesTable)
      .where(and(
        eq(ledgerEntriesTable.firmId, args.firmId),
        eq(ledgerEntriesTable.accountType, "balance_sheet"),
        sql`case_id IS NULL`,
      ));
    const prevNet = Number(netRows?.[0]?.bal ?? 0);
    await tx.insert(ledgerEntriesTable).values({
      firmId: args.firmId,
      caseId: null,
      entryDate,
      entryType: "payroll_net_payable",
      accountType: "balance_sheet",
      debit: "0.00",
      credit: net.toFixed(2),
      balanceAfter: (prevNet + net).toFixed(2),
      description: `Payroll net salaries payable for ${referenceNo}`,
      referenceNo,
      sourceType: "hr_payroll",
      sourceId: args.runId,
      createdBy: args.actorUserId,
    });
    void eventKey;
    return { journalEntryId, postedNow: true };
  } catch (err: unknown) {
    if (isSchemaMissing(err)) {
      return { journalEntryId: null, postedNow: false };
    }
    return { journalEntryId: null, postedNow: false };
  }
}

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
): Promise<{ run: PayrollRun; wasAlreadyFinalised: boolean; accountingPostedNow: boolean; status: string; journalEntryId: number | null }> {
  const now = new Date();
  const outerConn = pickDbConn(opts.tx);
  const runInTx = async (tx: any) => {
    const [existing] = await tx
      .select()
      .from(hrPayrollRunsTable as any)
      .where(and(eq((hrPayrollRunsTable as any).firmId, input.firmId), eq((hrPayrollRunsTable as any).id, input.runId)))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Payroll run not found");
    const wasAlreadyFinalised = existing.status === "finalised";
    let row: any = existing;
    let accountingPostedNow = false;
    let journalEntryId: number | null = null;

    if (wasAlreadyFinalised) {
      journalEntryId = existing.accountingJournalEntryId != null ? Number(existing.accountingJournalEntryId) : null;
      if (!journalEntryId || !existing.accountingPosted) {
        const posting = await tryPostPayrollJournalInTx(tx, {
          firmId: input.firmId,
          runId: input.runId,
          grossTotal: Number(existing.grossTotal ?? 0),
          deductionsTotal: Number(existing.deductionsTotal ?? 0),
          netTotal: Number(existing.netTotal ?? 0),
          periodName: existing.periodName ?? null,
          periodEndDate: existing.periodEndDate ? new Date(existing.periodEndDate) : null,
          actorUserId: input.actorUserId,
        });
        if (posting.journalEntryId != null) {
          accountingPostedNow = posting.postedNow;
          const [backfill] = await (tx as any)
            .update(hrPayrollRunsTable)
            .set({
              accountingPosted: true,
              accountingJournalEntryId: posting.journalEntryId,
              updatedAt: now,
              updatedByUserId: input.actorUserId,
            })
            .where(eq((hrPayrollRunsTable as any).id, input.runId))
            .returning()
            .execute();
          row = backfill ?? row;
          journalEntryId = posting.journalEntryId;
        }
      }
    } else {
      const posting = await tryPostPayrollJournalInTx(tx, {
        firmId: input.firmId,
        runId: input.runId,
        grossTotal: Number(existing.grossTotal ?? 0),
        deductionsTotal: Number(existing.deductionsTotal ?? 0),
        netTotal: Number(existing.netTotal ?? 0),
        periodName: existing.periodName ?? null,
        periodEndDate: existing.periodEndDate ? new Date(existing.periodEndDate) : null,
        actorUserId: input.actorUserId,
      });
      const accountingPosted = posting.journalEntryId != null;
      if (accountingPosted) {
        accountingPostedNow = posting.postedNow;
        journalEntryId = posting.journalEntryId;
      }
      const [upd] = await (tx as any)
        .update(hrPayrollRunsTable)
        .set({
          status: "finalised",
          finalisedAt: now,
          finalisedByUserId: input.actorUserId,
          accountingPosted,
          accountingJournalEntryId: journalEntryId,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrPayrollRunsTable as any).id, input.runId))
        .returning()
        .execute();
      row = upd;
    }

    return {
      run: toPayrollRun(row),
      wasAlreadyFinalised,
      accountingPostedNow,
      status: String(row.status),
      journalEntryId,
    };
  };
  if (opts.tx) return runInTx(outerConn);
  return db.transaction((tx: any) => runInTx(tx));
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
