import { and, count, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { caseAssignmentsTable, caseWorkflowStepsTable, casesTable, type RlsDb, db } from "@workspace/db";
import { type CaseMilestoneKey } from "../lib/caseListLogic";

type DbConn = typeof db | RlsDb;

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function tableExists(r: DbConn, reg: string): Promise<boolean> {
  const rows = await queryRows(r, sql`SELECT to_regclass(${reg}) AS reg`);
  return Boolean(rows[0]?.reg);
}

function toNumber0(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

function getPgCode(err: unknown): string | null {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : null;
}

function isCompatError(err: unknown): boolean {
  const code = getPgCode(err);
  return code === "42P01" || code === "42703" || code === "42501";
}

type Opts = { assignedToUserId?: number };

export async function computeMilestonesSummary(
  r: DbConn,
  firmId: number,
  opts?: Opts,
): Promise<{ milestoneSections: unknown[]; milestoneCards: unknown[] }> {
  const hasWorkflowSteps = await tableExists(r, "public.case_workflow_steps");
  if (!hasWorkflowSteps) return { milestoneSections: [], milestoneCards: [] };

  try {
    const assignedToUserId = opts?.assignedToUserId;
    const assignedFilter = assignedToUserId ? { assignedToUserId: String(assignedToUserId) } : {};
    const assignedCasesJoin = assignedToUserId
      ? and(
          eq(caseAssignmentsTable.caseId, casesTable.id),
          eq(caseAssignmentsTable.userId, assignedToUserId),
          isNull(caseAssignmentsTable.unassignedAt),
        )
      : undefined;

    const baseActiveWhere = and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt));
    const loanMasterWhere = and(eq(casesTable.purchaseMode, "loan"), eq(casesTable.titleType, "master"));
    const loanTitleWhere = and(
      eq(casesTable.purchaseMode, "loan"),
      or(eq(casesTable.titleType, "individual"), eq(casesTable.titleType, "strata")),
    );

    const countCases = async (where: SQL) => {
      const base = assignedCasesJoin
        ? r.select({ c: count() }).from(casesTable).innerJoin(caseAssignmentsTable, assignedCasesJoin)
        : r.select({ c: count() }).from(casesTable);
      const [row] = await base.where(where);
      return toNumber0(row?.c);
    };

    const spaTotal = await countCases(baseActiveWhere);
    const loanMasterTotal = await countCases(and(baseActiveWhere, loanMasterWhere));
    const loanTitleTotal = await countCases(and(baseActiveWhere, loanTitleWhere));

    const spaMilestones: Array<{ key: CaseMilestoneKey; label: string }> = [
      { key: "spa_stamped", label: "SPA Stamped" },
      { key: "lof_stamped", label: "Letter of Offer Stamped" },
    ];
    const loanMasterMilestones: Array<{ key: CaseMilestoneKey; label: string }> = [
      { key: "loan_docs_pending", label: "Loan Docs Pending" },
      { key: "loan_docs_signed", label: "Loan Docs Signed" },
      { key: "acting_letter_issued", label: "Acting Letter Issued" },
      { key: "advised", label: "Advised" },
      { key: "loan_sent_bank_exec", label: "Loan Sent Bank Exec" },
      { key: "loan_bank_executed", label: "Loan Bank Executed" },
      { key: "blu_received", label: "BLU Received" },
      { key: "noa_served", label: "NOA Served" },
      { key: "pa_registered", label: "PA Registered" },
      { key: "letter_disclaimer", label: "Letter Disclaimer" },
    ];
    const loanTitleMilestones: Array<{ key: CaseMilestoneKey; label: string }> = [
      { key: "loan_docs_pending", label: "Loan Docs Pending" },
      { key: "loan_docs_signed", label: "Loan Docs Signed" },
      { key: "acting_letter_issued", label: "Acting Letter Issued" },
      { key: "advised", label: "Advised" },
      { key: "loan_sent_bank_exec", label: "Loan Sent Bank Exec" },
      { key: "loan_bank_executed", label: "Loan Bank Executed" },
      { key: "blu_received", label: "BLU Received" },
      { key: "mot_received", label: "MOT Received" },
      { key: "mot_submitted_stamping", label: "MOT Submitted Stamping" },
      { key: "mot_stamp", label: "MOT Stamped" },
    ];

    const countCompletedByStepKey = async (stepKeys: CaseMilestoneKey[], extraCaseWhere?: SQL): Promise<Record<string, number>> => {
      if (stepKeys.length === 0) return {};
      const baseWhere = and(
        eq(casesTable.firmId, firmId),
        isNull(casesTable.deletedAt),
        eq(caseWorkflowStepsTable.status, "completed"),
        inArray(caseWorkflowStepsTable.stepKey, stepKeys as unknown as string[]),
        ...(extraCaseWhere ? [extraCaseWhere] : []),
      );
      const q = assignedCasesJoin
        ? r
            .select({
              stepKey: caseWorkflowStepsTable.stepKey,
              c: sql<number>`COUNT(DISTINCT ${caseWorkflowStepsTable.caseId})`,
            })
            .from(caseWorkflowStepsTable)
            .innerJoin(casesTable, eq(caseWorkflowStepsTable.caseId, casesTable.id))
            .innerJoin(caseAssignmentsTable, assignedCasesJoin)
            .where(baseWhere)
            .groupBy(caseWorkflowStepsTable.stepKey)
        : r
            .select({
              stepKey: caseWorkflowStepsTable.stepKey,
              c: sql<number>`COUNT(DISTINCT ${caseWorkflowStepsTable.caseId})`,
            })
            .from(caseWorkflowStepsTable)
            .innerJoin(casesTable, eq(caseWorkflowStepsTable.caseId, casesTable.id))
            .where(baseWhere)
            .groupBy(caseWorkflowStepsTable.stepKey);
      const rows = await q;
      const out: Record<string, number> = {};
      for (const row of rows as any[]) out[String(row.stepKey)] = toNumber0(row.c);
      return out;
    };

    const [spaDone, loanMasterDone, loanTitleDone] = await Promise.all([
      countCompletedByStepKey(spaMilestones.map((m) => m.key)),
      countCompletedByStepKey(loanMasterMilestones.map((m) => m.key), loanMasterWhere),
      countCompletedByStepKey(loanTitleMilestones.map((m) => m.key), loanTitleWhere),
    ]);

    const toCard = (segKey: string, total: number, m: { key: CaseMilestoneKey; label: string }, doneMap: Record<string, number>, extraFilter?: Record<string, string>) => {
      const done = doneMap[String(m.key)] ?? 0;
      const pending = Math.max(0, total - done);
      return {
        key: `${segKey}_${String(m.key)}`,
        label: m.label,
        count: pending,
        pendingCount: pending,
        doneCount: done,
        filter: {
          milestone: m.key,
          milestonePresence: "pending",
          ...assignedFilter,
          ...(extraFilter ?? {}),
        },
      };
    };

    const spaCards = spaMilestones.map((m) => toCard("spa", spaTotal, m, spaDone));
    const loanMasterCards = loanMasterMilestones.map((m) => toCard("loan_master", loanMasterTotal, m, loanMasterDone, { purchaseMode: "loan", titleType: "master" }));
    const loanTitleCards = loanTitleMilestones.map((m) => toCard("loan_title", loanTitleTotal, m, loanTitleDone, { purchaseMode: "loan", titleType: "individual,strata" }));

    const milestoneSections = [
      {
        key: "spa",
        label: "SPA Total",
        total: spaTotal,
        cards: [{ key: "spa_total", label: "Total", count: spaTotal, filter: { ...assignedFilter } }, ...spaCards],
      },
      {
        key: "loan_master",
        label: "Loan (Master) Total",
        total: loanMasterTotal,
        cards: [{ key: "loan_master_total", label: "Total", count: loanMasterTotal, filter: { ...assignedFilter, purchaseMode: "loan", titleType: "master" } }, ...loanMasterCards],
      },
      {
        key: "loan_title",
        label: "Loan (Title) Total",
        total: loanTitleTotal,
        cards: [{ key: "loan_title_total", label: "Total", count: loanTitleTotal, filter: { ...assignedFilter, purchaseMode: "loan", titleType: "individual,strata" } }, ...loanTitleCards],
      },
    ];

    return { milestoneSections, milestoneCards: [...spaCards, ...loanMasterCards, ...loanTitleCards] };
  } catch (err) {
    if (isCompatError(err)) return { milestoneSections: [], milestoneCards: [] };
    throw err;
  }
}

