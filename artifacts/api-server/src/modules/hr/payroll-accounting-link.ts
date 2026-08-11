import { eq, and, or } from "drizzle-orm";
import { caseLedgersTable } from "@workspace/db";

export type PayrollLedgerLineKind =
  | "salary_expense"
  | "employer_epf"
  | "employer_socso"
  | "employer_eis"
  | "tax_pcb_payable"
  | "net_salary_payable"
  | "reimbursable_claims_payable";

export function buildPayrollAccountingEventKey(args: {
  runId: number | string;
  kind: PayrollLedgerLineKind;
  reversal?: 1;
}): string {
  const base = `PY:${args.runId}:${args.kind}`;
  return args.reversal ? `${base}:REVERSAL:${args.reversal}` : base;
}

export type PayrollAccountingLine = {
  kind: PayrollLedgerLineKind;
  description: string;
  amountCents: number;
  debitCents: number;
  creditCents: number;
};

type DbConnLike = {
  select: (cols: any) => any;
  insert: (t: any) => any;
};

function pickConn(tx: unknown): DbConnLike {
  return tx as DbConnLike;
}

async function lazyAudit(args: {
  firmId: number;
  actorId: number;
  actorType?: "firm_user" | "system" | "founder";
  action: string;
  entityType?: string;
  entityId?: number;
  detail?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  try {
    const mod = await import("../../lib/auth.js");
    if (mod && typeof mod.writeAuditLog === "function") {
      await mod.writeAuditLog(args);
      return;
    }
  } catch {
    // test context
  }
}

export async function insertPayrollAccountingFinalisation(
  tx: unknown,
  args: {
    firmId: number;
    payrollRunId: number;
    payrollReference: string | null;
    runPeriod: string;
    entryDate: Date;
    lines: PayrollAccountingLine[];
    actorId: number;
    ip?: string;
    ua?: string;
  },
): Promise<{ alreadyFinalised: boolean; inserted: number; existingRows: number }> {
  const d = pickConn(tx);
  const probeKey = buildPayrollAccountingEventKey({ runId: args.payrollRunId, kind: "salary_expense" });
  const sourceIdCol: any = caseLedgersTable.sourceId;
  const probe = d
    .select({ id: caseLedgersTable.id })
    .from(caseLedgersTable)
    .where(and(
      eq(caseLedgersTable.firmId, args.firmId),
      or(
        eq(caseLedgersTable.eventKey, probeKey),
        and(eq(caseLedgersTable.sourceType, "payroll_finalise"), eq(sourceIdCol, args.payrollRunId as any)),
      ),
    ))
    .limit(1);
  const probeRows = await (typeof probe.execute === "function" ? probe.execute() : probe);
  if (probeRows && probeRows[0]?.id) {
    return { alreadyFinalised: true, inserted: 0, existingRows: 1 };
  }
  let inserted = 0;
  const runPeriodStr = args.runPeriod || "current";
  for (const line of args.lines) {
    const eventKey = buildPayrollAccountingEventKey({ runId: args.payrollRunId, kind: line.kind });
    const amount = (line.amountCents / 100).toFixed(2);
    const row: any = {
      firmId: args.firmId,
      caseId: undefined,
      entryDate: args.entryDate,
      entryType: `payroll_${line.kind}`,
      description: `[Payroll ${runPeriodStr}] ${line.description}`,
      amount,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      sourceType: "payroll_finalise",
      sourceId: args.payrollRunId as any,
      sourceReference: args.payrollReference ?? null,
      eventKey,
      createdBy: args.actorId,
    };
    const ins = d.insert(caseLedgersTable).values(row);
    await (typeof ins.execute === "function" ? ins.execute() : ins);
    inserted++;
  }
  await lazyAudit({
    firmId: args.firmId,
    actorId: args.actorId,
    actorType: "firm_user",
    action: "hr.payroll.finalise_accounting_link",
    entityType: "payroll_run",
    entityId: args.payrollRunId,
    detail: JSON.stringify({
      runId: args.payrollRunId,
      runPeriod: args.runPeriod,
      lines: args.lines.map((l) => ({ kind: l.kind, amountCents: l.amountCents, dr: l.debitCents, cr: l.creditCents })),
      inserted,
    }),
    ipAddress: args.ip,
    userAgent: args.ua,
  });
  return { alreadyFinalised: false, inserted, existingRows: 0 };
}
