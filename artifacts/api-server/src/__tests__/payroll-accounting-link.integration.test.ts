import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and, count } from "drizzle-orm";
import { caseLedgersTable } from "@workspace/db";
import {
  insertPayrollAccountingFinalisation,
  buildPayrollAccountingEventKey,
  type PayrollAccountingLine,
} from "../modules/hr/payroll-accounting-link.js";

const pg = new PGlite();
const r = drizzle(pg);
const FIRM = 1;

describe("Payroll Finalise → Accounting entries (PART 2L)", () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (id serial);
      CREATE TABLE IF NOT EXISTS case_ledgers (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        transaction_date date,
        entry_category text,
        entry_type text,
        description text,
        amount numeric(18,2),
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        source_type text,
        source_id text,
        source_reference text,
        event_key text,
        created_by integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, event_key)
      )
    `);
  });
  beforeEach(async () => {
    await r.delete(caseLedgersTable).where(eq(caseLedgersTable.firmId, FIRM)).execute();
  });

  function baseLines(): PayrollAccountingLine[] {
    return [
      { kind: "salary_expense", description: "Salary expense (March 2025", amountCents: 100_000_00, debitCents: 100_000_00, creditCents: 0 },
      { kind: "employer_epf", description: "Employer EPF", amountCents: 12_000_00, debitCents: 12_000_00, creditCents: 0 },
      { kind: "employer_socso", description: "Employer SOCSO", amountCents: 3_00, debitCents: 3_00, creditCents: 0 },
      { kind: "employer_eis", description: "Employer EIS", amountCents: 2_00, debitCents: 2_00, creditCents: 0 },
      { kind: "tax_pcb_payable", description: "PCB/TAX PAYABLE", amountCents: 8_000_00, debitCents: 0, creditCents: 8_000_00 },
      { kind: "net_salary_payable", description: "Net salary payable", amountCents: 80_000_00, debitCents: 0, creditCents: 80_000_00 },
      { kind: "reimbursable_claims_payable", description: "Approved claims payable", amountCents: 5_000_00, debitCents: 0, creditCents: 5_000_00 },
    ];
  }

  it("Finalise once → exactly 7 ledger rows; retry → alreadyFinalised=true (no duplicates)", async () => {
    const res1 = await insertPayrollAccountingFinalisation(r, {
      firmId: FIRM, payrollRunId: 42, payrollReference: "PY-2025-03", runPeriod: "2025-03", entryDate: new Date(),
      lines: baseLines(), actorId: 31,
    });
    expect(res1.alreadyFinalised).toBe(false);
    expect(res1.inserted).toBe(7);
    const res2 = await insertPayrollAccountingFinalisation(r, {
      firmId: FIRM, payrollRunId: 42, payrollReference: "PY-2025-03", runPeriod: "2025-03", entryDate: new Date(),
      lines: baseLines(), actorId: 31,
    });
    expect(res2.alreadyFinalised).toBe(true);
    expect(res2.inserted).toBe(0);
    const [{ n }]: any[] = await r.select({ n: count() }).from(caseLedgersTable).where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceType, "payroll_finalise")));
    expect(n).toBe(7);
  });

  it("salary_expense event key is deterministic and used as probe", () => {
    const k1 = buildPayrollAccountingEventKey({ runId: 42, kind: "salary_expense" });
    const kRev = buildPayrollAccountingEventKey({ runId: 42, kind: "salary_expense", reversal: 1 });
    expect(k1).toBe("PY:42:salary_expense");
    expect(kRev).toBe("PY:42:salary_expense:REVERSAL:1");
  });
});
