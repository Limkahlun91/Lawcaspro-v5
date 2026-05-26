import { and, count, desc, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import {
  caseAssignmentsTable,
  caseKeyDatesTable,
  casesTable,
  caseWorkflowStepsTable,
  clientsTable,
  developersTable,
  projectsTable,
  sql,
  usersTable,
  type RlsDb,
  db,
} from "@workspace/db";
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

type DashboardStatsOpts = { assignedToUserId?: number };

function toNumber0(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function computeDashboardStats(
  r: DbConn,
  firmId: number,
  opts?: DashboardStatsOpts,
): Promise<Record<string, unknown>> {
  const hasKeyDates = await tableExists(r, "public.case_key_dates");
  const hasWorkflowSteps = await tableExists(r, "public.case_workflow_steps");
  const hasBillingEntries = await tableExists(r, "public.case_billing_entries");
  const hasCommunications = await tableExists(r, "public.case_communications");
  const hasCaseLedgers = await tableExists(r, "public.case_ledgers");

  const assignedToUserId = opts?.assignedToUserId;
  const assignedFilter = assignedToUserId ? { assignedToUserId: String(assignedToUserId) } : {};
  const assignedCasesJoin = assignedToUserId
    ? and(
        eq(caseAssignmentsTable.caseId, casesTable.id),
        eq(caseAssignmentsTable.userId, assignedToUserId),
        isNull(caseAssignmentsTable.unassignedAt),
      )
    : undefined;

  const countCases = async (where?: SQL) => {
    const base = assignedCasesJoin
      ? r.select({ c: count() }).from(casesTable).innerJoin(caseAssignmentsTable, assignedCasesJoin)
      : r.select({ c: count() }).from(casesTable);
    const [row] = where ? await base.where(where) : await base;
    return toNumber0(row?.c);
  };

  const totalCases = await countCases(and(eq(casesTable.firmId, firmId)));
  const cashCases = await countCases(and(eq(casesTable.firmId, firmId), eq(casesTable.purchaseMode, "cash")));
  const loanCases = await countCases(and(eq(casesTable.firmId, firmId), eq(casesTable.purchaseMode, "loan")));
  const masterTitleCases = await countCases(and(eq(casesTable.firmId, firmId), eq(casesTable.titleType, "master")));
  const individualTitleCases = await countCases(and(eq(casesTable.firmId, firmId), eq(casesTable.titleType, "individual")));
  const strataTitleCases = await countCases(and(eq(casesTable.firmId, firmId), eq(casesTable.titleType, "strata")));

  const completedCases = hasKeyDates
    ? (await (async () => {
        const base = assignedCasesJoin
          ? r.select({ c: count() }).from(casesTable)
              .innerJoin(caseAssignmentsTable, assignedCasesJoin)
              .leftJoin(caseKeyDatesTable, and(
                eq(caseKeyDatesTable.caseId, casesTable.id),
                eq(caseKeyDatesTable.firmId, casesTable.firmId),
              ))
          : r.select({ c: count() }).from(casesTable)
              .leftJoin(caseKeyDatesTable, and(
                eq(caseKeyDatesTable.caseId, casesTable.id),
                eq(caseKeyDatesTable.firmId, casesTable.firmId),
              ));
        const [row] = await base.where(and(
          eq(casesTable.firmId, firmId),
          isNotNull(caseKeyDatesTable.completionDate),
        ));
        return toNumber0(row?.c);
      })())
    : 0;
  const activeCases = Math.max(0, totalCases - completedCases);

  const recentRawRows = assignedCasesJoin
    ? await r
        .select({
          id: casesTable.id,
          referenceNo: casesTable.referenceNo,
          projectId: casesTable.projectId,
          developerId: casesTable.developerId,
          purchaseMode: casesTable.purchaseMode,
          titleType: casesTable.titleType,
          status: casesTable.status,
          createdAt: casesTable.createdAt,
          updatedAt: casesTable.updatedAt,
        })
        .from(casesTable)
        .innerJoin(caseAssignmentsTable, assignedCasesJoin)
        .where(eq(casesTable.firmId, firmId))
        .orderBy(desc(casesTable.updatedAt))
        .limit(20)
    : await r
        .select({
          id: casesTable.id,
          referenceNo: casesTable.referenceNo,
          projectId: casesTable.projectId,
          developerId: casesTable.developerId,
          purchaseMode: casesTable.purchaseMode,
          titleType: casesTable.titleType,
          status: casesTable.status,
          createdAt: casesTable.createdAt,
          updatedAt: casesTable.updatedAt,
        })
        .from(casesTable)
        .where(eq(casesTable.firmId, firmId))
        .orderBy(desc(casesTable.updatedAt))
        .limit(5);

  const seenRecent = new Set<number>();
  const recentRows = recentRawRows.filter((row) => {
    if (seenRecent.has(row.id)) return false;
    seenRecent.add(row.id);
    return true;
  }).slice(0, 5);

  const recentCases = await Promise.all(
    recentRows.map(async (c) => {
      const [proj] = await r.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, c.projectId));
      const [dev] = await r.select({ name: developersTable.name }).from(developersTable).where(eq(developersTable.id, c.developerId));
      const [assignment] = await r
        .select({ userName: usersTable.name })
        .from(caseAssignmentsTable)
        .leftJoin(usersTable, eq(caseAssignmentsTable.userId, usersTable.id))
        .where(eq(caseAssignmentsTable.caseId, c.id))
        .limit(1);
      return {
        id: c.id,
        referenceNo: c.referenceNo,
        projectName: proj?.name ?? "Unknown",
        developerName: dev?.name ?? "Unknown",
        purchaseMode: c.purchaseMode,
        titleType: c.titleType,
        status: c.status,
        assignedLawyerName: assignment?.userName ?? null,
        createdAt: (c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt)).toISOString(),
      };
    })
  );

  const [totalClientsRes] = await r.select({ c: count() }).from(clientsTable).where(eq(clientsTable.firmId, firmId));
  const [totalDevsRes] = await r.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, firmId));
  const [totalProjsRes] = await r.select({ c: count() }).from(projectsTable).where(eq(projectsTable.firmId, firmId));

  const billing = hasBillingEntries
    ? (await queryRows(r, sql`
        SELECT
          SUM(amount * quantity) as total_billed,
          SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as total_paid,
          SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as total_outstanding
        FROM case_billing_entries WHERE firm_id = ${firmId}
      `))[0] ?? {}
    : {};

  const outstandingAdvances = hasCaseLedgers
    ? (await (async () => {
        const [totals] = await queryRows(r, sql`
          SELECT
            COUNT(*) as case_count,
            COALESCE(SUM(outstanding_amount), 0) as total_amount
          FROM (
            SELECT
              cl.case_id,
              (
                COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
              ) as outstanding_amount
            FROM case_ledgers cl
            WHERE cl.firm_id = ${firmId}
            GROUP BY cl.case_id
            HAVING (
              COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
            ) > 0
          ) t
        `);
        const rows = await queryRows(r, sql`
          SELECT
            cl.case_id as case_id,
            c.reference_no as reference_no,
            COALESCE((
              SELECT string_agg(DISTINCT cc.name, ', ')
              FROM case_purchasers cp
              JOIN clients cc ON cc.id = cp.client_id
              WHERE cp.case_id = c.id
            ), '') as client_names,
            (
              COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
            ) as outstanding_amount
          FROM case_ledgers cl
          JOIN cases c ON c.id = cl.case_id AND c.firm_id = cl.firm_id
          WHERE cl.firm_id = ${firmId}
          GROUP BY cl.case_id, c.reference_no
          HAVING (
            COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
          ) > 0
          ORDER BY outstanding_amount DESC
          LIMIT 10
        `);
        const topCases = rows.map((rr) => ({
          caseId: toNumber0(rr.case_id),
          referenceNo: String(rr.reference_no ?? ""),
          clientNames: String(rr.client_names ?? "") || null,
          amount: toNumber0((rr as any).outstanding_amount),
        })).filter((x) => x.caseId > 0 && x.amount > 0);
        const caseCount = toNumber0((totals as any)?.case_count);
        const totalAmount = toNumber0((totals as any)?.total_amount);
        return { caseCount, totalAmount, topCases };
      })())
    : { caseCount: 0, totalAmount: 0, topCases: [] as any[] };

  const commsThisMonth = hasCommunications
    ? Number((await queryRows(r, sql`
          SELECT COUNT(*) as total_this_month
          FROM case_communications
          WHERE firm_id = ${firmId}
          AND created_at >= date_trunc('month', NOW())
        `))[0]?.total_this_month ?? 0)
    : 0;

  const baseActiveWhere = and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt));
  const loanMasterWhere = and(eq(casesTable.purchaseMode, "loan"), eq(casesTable.titleType, "master"));
  const loanTitleWhere = and(
    eq(casesTable.purchaseMode, "loan"),
    or(eq(casesTable.titleType, "individual"), eq(casesTable.titleType, "strata")),
  );

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

  const stepCounts: Record<string, number> = {};
  if (hasWorkflowSteps) {
    const countCompletedCasesForStep = async (stepKey: CaseMilestoneKey, extraWhere?: SQL) => {
      const baseWhere = and(
        eq(casesTable.firmId, firmId),
        isNull(casesTable.deletedAt),
        eq(caseWorkflowStepsTable.stepKey, stepKey),
        eq(caseWorkflowStepsTable.status, "completed"),
        ...(extraWhere ? [extraWhere] : []),
      );
      const rows = assignedCasesJoin
        ? await r
            .select({ caseId: caseWorkflowStepsTable.caseId })
            .from(caseWorkflowStepsTable)
            .innerJoin(casesTable, eq(caseWorkflowStepsTable.caseId, casesTable.id))
            .innerJoin(caseAssignmentsTable, assignedCasesJoin)
            .where(baseWhere)
            .groupBy(caseWorkflowStepsTable.caseId)
        : await r
            .select({ caseId: caseWorkflowStepsTable.caseId })
            .from(caseWorkflowStepsTable)
            .innerJoin(casesTable, eq(caseWorkflowStepsTable.caseId, casesTable.id))
            .where(baseWhere)
            .groupBy(caseWorkflowStepsTable.caseId);
      return rows.length;
    };

    await Promise.all([
      ...spaMilestones.map(async (m) => {
        const done = await countCompletedCasesForStep(m.key);
        stepCounts[`spa_${m.key}_done`] = done;
        stepCounts[`spa_${m.key}_pending`] = Math.max(0, spaTotal - done);
      }),
      ...loanMasterMilestones.map(async (m) => {
        const done = await countCompletedCasesForStep(m.key, loanMasterWhere);
        stepCounts[`loan_master_${m.key}_done`] = done;
        stepCounts[`loan_master_${m.key}_pending`] = Math.max(0, loanMasterTotal - done);
      }),
      ...loanTitleMilestones.map(async (m) => {
        const done = await countCompletedCasesForStep(m.key, loanTitleWhere);
        stepCounts[`loan_title_${m.key}_done`] = done;
        stepCounts[`loan_title_${m.key}_pending`] = Math.max(0, loanTitleTotal - done);
      }),
    ]);
  }

  const toMilestoneCard = (segKey: string, total: number, m: { key: CaseMilestoneKey; label: string }, filledKey: string, extraFilter: Record<string, string> | undefined) => {
    const done = stepCounts[`${filledKey}_done`] ?? 0;
    const pending = stepCounts[`${filledKey}_pending`] ?? Math.max(0, total - done);
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

  const spaCards = spaMilestones.map((m) => toMilestoneCard("spa", spaTotal, m, `spa_${m.key}`, undefined));
  const loanMasterCards = loanMasterMilestones.map((m) => toMilestoneCard("loan_master", loanMasterTotal, m, `loan_master_${m.key}`, { purchaseMode: "loan", titleType: "master" }));
  const loanTitleCards = loanTitleMilestones.map((m) => toMilestoneCard("loan_title", loanTitleTotal, m, `loan_title_${m.key}`, { purchaseMode: "loan", titleType: "individual,strata" }));

  const milestoneSections = hasWorkflowSteps ? [
    {
      key: "spa",
      label: "SPA Total",
      total: spaTotal,
      cards: [
        { key: "spa_total", label: "Total", count: spaTotal, filter: { ...assignedFilter } },
        ...spaCards,
      ],
    },
    {
      key: "loan_master",
      label: "Loan (Master) Total",
      total: loanMasterTotal,
      cards: [
        { key: "loan_master_total", label: "Total", count: loanMasterTotal, filter: { ...assignedFilter, purchaseMode: "loan", titleType: "master" } },
        ...loanMasterCards,
      ],
    },
    {
      key: "loan_title",
      label: "Loan (Title) Total",
      total: loanTitleTotal,
      cards: [
        { key: "loan_title_total", label: "Total", count: loanTitleTotal, filter: { ...assignedFilter, purchaseMode: "loan", titleType: "individual,strata" } },
        ...loanTitleCards,
      ],
    },
  ] : [];

  const milestoneCards = hasWorkflowSteps
    ? [...spaCards, ...loanMasterCards, ...loanTitleCards]
    : [];

  return {
    totalCases,
    activeCases,
    completedCases,
    totalClients: toNumber0(totalClientsRes?.c),
    totalDevelopers: toNumber0(totalDevsRes?.c),
    totalProjects: toNumber0(totalProjsRes?.c),
    cashCases,
    loanCases,
    masterTitleCases,
    individualTitleCases,
    strataTitleCases,
    recentCases,
    billing: (() => {
      const row = billing as Record<string, unknown>;
      return {
        totalBilled: toNumber0(row.total_billed),
        totalPaid: toNumber0(row.total_paid),
        totalOutstanding: toNumber0(row.total_outstanding),
      };
    })(),
    outstandingAdvances,
    commsThisMonth,
    milestoneSections,
    milestoneCards,
  };
}
