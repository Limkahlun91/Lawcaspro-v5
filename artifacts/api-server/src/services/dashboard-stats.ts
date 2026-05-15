import { count, desc, eq } from "drizzle-orm";
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

export async function computeDashboardStats(r: DbConn, firmId: number): Promise<Record<string, unknown>> {
  const hasKeyDates = await tableExists(r, "public.case_key_dates");
  const hasWorkflowSteps = await tableExists(r, "public.case_workflow_steps");
  const hasBillingEntries = await tableExists(r, "public.case_billing_entries");
  const hasCommunications = await tableExists(r, "public.case_communications");

  const [caseStats] = await r
    .select({
      total: count(),
      cash: sql<number>`COUNT(*) FILTER (WHERE ${casesTable.purchaseMode} = 'cash')`,
      loan: sql<number>`COUNT(*) FILTER (WHERE ${casesTable.purchaseMode} = 'loan')`,
      masterTitle: sql<number>`COUNT(*) FILTER (WHERE ${casesTable.titleType} = 'master')`,
      individualTitle: sql<number>`COUNT(*) FILTER (WHERE ${casesTable.titleType} = 'individual')`,
      strataTitle: sql<number>`COUNT(*) FILTER (WHERE ${casesTable.titleType} = 'strata')`,
    })
    .from(casesTable)
    .where(eq(casesTable.firmId, firmId));

  const [totalClientsRes] = await r.select({ c: count() }).from(clientsTable).where(eq(clientsTable.firmId, firmId));
  const [totalDevsRes] = await r.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, firmId));
  const [totalProjsRes] = await r.select({ c: count() }).from(projectsTable).where(eq(projectsTable.firmId, firmId));

  const totalCases = Number(caseStats?.total ?? 0);
  const cashCases = Number(caseStats?.cash ?? 0);
  const loanCases = Number(caseStats?.loan ?? 0);
  const masterTitleCases = Number(caseStats?.masterTitle ?? 0);
  const individualTitleCases = Number(caseStats?.individualTitle ?? 0);
  const strataTitleCases = Number(caseStats?.strataTitle ?? 0);
  const completedCases = hasKeyDates
    ? Number(((
        await r
          .select({ c: sql<number>`COUNT(*) FILTER (WHERE ${caseKeyDatesTable.completionDate} IS NOT NULL)` })
          .from(casesTable)
          .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
          .where(eq(casesTable.firmId, firmId))
      )[0] as any)?.c ?? 0)
    : 0;
  const activeCases = totalCases - completedCases;

  const recentRows = await r
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

  const recentCases = await Promise.all(
    recentRows.map(async (c) => {
      const [proj] = await r.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
      const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, c.developerId));
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

  const billing = hasBillingEntries
    ? (await queryRows(r, sql`
        SELECT
          SUM(amount * quantity) as total_billed,
          SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as total_paid,
          SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as total_outstanding
        FROM case_billing_entries WHERE firm_id = ${firmId}
      `))[0] ?? {}
    : {};

  const commsThisMonth = hasCommunications
    ? Number((await queryRows(r, sql`
          SELECT COUNT(*) as total_this_month
          FROM case_communications
          WHERE firm_id = ${firmId}
          AND created_at >= date_trunc('month', NOW())
        `))[0]?.total_this_month ?? 0)
    : 0;

  const activeCaseWhere = sql`${casesTable.deletedAt} IS NULL`;

  const loanMasterWhere = sql`${casesTable.purchaseMode} = 'loan' AND ${casesTable.titleType} = 'master'`;
  const loanTitleWhere = sql`${casesTable.purchaseMode} = 'loan' AND (${casesTable.titleType} = 'individual' OR ${casesTable.titleType} = 'strata')`;

  const segmentTotals = (await r
    .select({
      spaTotal: sql<number>`COUNT(*) FILTER (WHERE ${activeCaseWhere})`,
      loanMasterTotal: sql<number>`COUNT(*) FILTER (WHERE ${activeCaseWhere} AND ${loanMasterWhere})`,
      loanTitleTotal: sql<number>`COUNT(*) FILTER (WHERE ${activeCaseWhere} AND ${loanTitleWhere})`,
    })
    .from(casesTable)
    .where(eq(casesTable.firmId, firmId)))[0];

  const spaTotal = Number(segmentTotals?.spaTotal ?? 0);
  const loanMasterTotal = Number(segmentTotals?.loanMasterTotal ?? 0);
  const loanTitleTotal = Number(segmentTotals?.loanTitleTotal ?? 0);
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

  const completedWhereSql = (stepKey: CaseMilestoneKey) => sql`EXISTS (
    SELECT 1
    FROM ${caseWorkflowStepsTable}
    WHERE ${caseWorkflowStepsTable.caseId} = ${casesTable.id}
      AND ${caseWorkflowStepsTable.stepKey} = ${stepKey}
      AND ${caseWorkflowStepsTable.status} = 'completed'
  )`;

  const doneCountSql = (stepKey: CaseMilestoneKey, extraWhere?: ReturnType<typeof sql>) => {
    if (extraWhere) return sql<number>`COUNT(*) FILTER (WHERE ${activeCaseWhere} AND ${extraWhere} AND ${completedWhereSql(stepKey)})`;
    return sql<number>`COUNT(*) FILTER (WHERE ${activeCaseWhere} AND ${completedWhereSql(stepKey)})`;
  };

  const pendingCountSql = (stepKey: CaseMilestoneKey, extraWhere?: ReturnType<typeof sql>) => {
    if (extraWhere) return sql<number>`COUNT(*) FILTER (WHERE ${activeCaseWhere} AND ${extraWhere} AND NOT (${completedWhereSql(stepKey)}))`;
    return sql<number>`COUNT(*) FILTER (WHERE ${activeCaseWhere} AND NOT (${completedWhereSql(stepKey)}))`;
  };

  const stepCounts = hasWorkflowSteps
    ? ((await r
        .select(Object.fromEntries([
          ...spaMilestones.flatMap((m) => [
            [`spa_${m.key}_done`, doneCountSql(m.key)],
            [`spa_${m.key}_pending`, pendingCountSql(m.key)],
          ]),
          ...loanMasterMilestones.flatMap((m) => [
            [`loan_master_${m.key}_done`, doneCountSql(m.key, loanMasterWhere)],
            [`loan_master_${m.key}_pending`, pendingCountSql(m.key, loanMasterWhere)],
          ]),
          ...loanTitleMilestones.flatMap((m) => [
            [`loan_title_${m.key}_done`, doneCountSql(m.key, loanTitleWhere)],
            [`loan_title_${m.key}_pending`, pendingCountSql(m.key, loanTitleWhere)],
          ]),
        ]))
        .from(casesTable)
        .where(eq(casesTable.firmId, firmId)))[0] as Record<string, unknown>)
    : {};

  const toMilestoneCard = (segKey: string, total: number, m: { key: CaseMilestoneKey; label: string }, filledKey: string, extraFilter: Record<string, string> | undefined) => {
    const done = Number((stepCounts as any)?.[`${filledKey}_done`] ?? 0);
    const pending = Number((stepCounts as any)?.[`${filledKey}_pending`] ?? Math.max(0, total - done));
    return {
      key: `${segKey}_${String(m.key)}`,
      label: m.label,
      count: pending,
      pendingCount: pending,
      doneCount: done,
      filter: {
        milestone: m.key,
        milestonePresence: "pending",
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
        { key: "spa_total", label: "Total", count: spaTotal, filter: {} },
        ...spaCards,
      ],
    },
    {
      key: "loan_master",
      label: "Loan (Master) Total",
      total: loanMasterTotal,
      cards: [
        { key: "loan_master_total", label: "Total", count: loanMasterTotal, filter: { purchaseMode: "loan", titleType: "master" } },
        ...loanMasterCards,
      ],
    },
    {
      key: "loan_title",
      label: "Loan (Title) Total",
      total: loanTitleTotal,
      cards: [
        { key: "loan_title_total", label: "Total", count: loanTitleTotal, filter: { purchaseMode: "loan", titleType: "individual,strata" } },
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
    totalClients: Number(totalClientsRes?.c ?? 0),
    totalDevelopers: Number(totalDevsRes?.c ?? 0),
    totalProjects: Number(totalProjsRes?.c ?? 0),
    cashCases,
    loanCases,
    masterTitleCases,
    individualTitleCases,
    strataTitleCases,
    recentCases,
    billing: {
      totalBilled: Number((billing as any).total_billed ?? 0),
      totalPaid: Number((billing as any).total_paid ?? 0),
      totalOutstanding: Number((billing as any).total_outstanding ?? 0),
    },
    commsThisMonth,
    milestoneSections,
    milestoneCards,
  };
}
