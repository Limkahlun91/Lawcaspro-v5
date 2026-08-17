import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, date, boolean, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const hrPayrollRunsTable = pgTable(
  "hr_payroll_runs",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    periodName: text("period_name").notNull(),
    periodStartDate: date("period_start_date").notNull(),
    periodEndDate: date("period_end_date").notNull(),
    status: text("status").notNull().default("draft"),
    payrollType: text("payroll_type").notNull().default("monthly"),
    idempotencyKey: text("idempotency_key"),
    totalEmployees: integer("total_employees").notNull().default(0),
    grossTotal: numeric("gross_total", { precision: 19, scale: 4 }).notNull().default("0"),
    deductionsTotal: numeric("deductions_total", { precision: 19, scale: 4 }).notNull().default("0"),
    netTotal: numeric("net_total", { precision: 19, scale: 4 }).notNull().default("0"),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: integer("approved_by_user_id"),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    finalisedByUserId: integer("finalised_by_user_id"),
    accountingPosted: boolean("accounting_posted").notNull().default(false),
    accountingJournalEntryId: integer("accounting_journal_entry_id"),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmPeriodUq: uniqueIndex("uq_hr_payroll_runs_firm_period").on(t.firmId, t.periodName, t.payrollType),
    firmIdx: index("idx_hr_payroll_runs_firm").on(t.firmId),
    firmStatusIdx: index("idx_hr_payroll_runs_status").on(t.firmId, t.status),
    firmPeriodDatesIdx: index("idx_hr_payroll_runs_period_dates").on(t.firmId, t.periodStartDate, t.periodEndDate),
    idempotencyUq: uniqueIndex("uq_hr_payroll_runs_idem").on(t.firmId, t.idempotencyKey),
    firmCreatedIdx: index("idx_hr_payroll_runs_created").on(t.firmId, t.createdAt),
  }),
);

export const insertHrPayrollRunSchema = createInsertSchema(hrPayrollRunsTable);
export const selectHrPayrollRunSchema = createSelectSchema(hrPayrollRunsTable);
export type HrPayrollRun = z.infer<typeof selectHrPayrollRunSchema>;
export type InsertHrPayrollRun = z.infer<typeof insertHrPayrollRunSchema>;

export const hrPayrollEmployeeResultsTable = pgTable(
  "hr_payroll_employee_results",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    payrollRunId: integer("payroll_run_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    grossPay: numeric("gross_pay", { precision: 19, scale: 4 }).notNull().default("0"),
    deductions: numeric("deductions", { precision: 19, scale: 4 }).notNull().default("0"),
    netPay: numeric("net_pay", { precision: 19, scale: 4 }).notNull().default("0"),
    breakdownJson: jsonb("breakdown_json"),
    status: text("status").notNull().default("draft"),
    calculationNote: text("calculation_note"),
    payslipIssuedAt: timestamp("payslip_issued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    runEmployeeUq: uniqueIndex("uq_hr_payroll_emp_results_run_emp").on(t.payrollRunId, t.employeeId),
    firmIdx: index("idx_hr_payroll_emp_results_firm").on(t.firmId),
    runIdx: index("idx_hr_payroll_emp_results_run").on(t.payrollRunId),
    firmEmployeeIdx: index("idx_hr_payroll_emp_results_emp").on(t.firmId, t.employeeId),
    firmStatusIdx: index("idx_hr_payroll_emp_results_status").on(t.firmId, t.status),
  }),
);

export const insertHrPayrollEmployeeResultSchema = createInsertSchema(hrPayrollEmployeeResultsTable);
export const selectHrPayrollEmployeeResultSchema = createSelectSchema(hrPayrollEmployeeResultsTable);
export type HrPayrollEmployeeResult = z.infer<typeof selectHrPayrollEmployeeResultSchema>;
export type InsertHrPayrollEmployeeResult = z.infer<typeof insertHrPayrollEmployeeResultSchema>;
