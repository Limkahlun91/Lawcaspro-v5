import { count, desc, eq } from "drizzle-orm";
import {
  caseAssignmentsTable,
  caseKeyDatesTable,
  casesTable,
  clientsTable,
  developersTable,
  projectsTable,
  sql,
  usersTable,
  type RlsDb,
  db,
} from "@workspace/db";
import { milestonePresenceWhereSql, type CaseMilestoneKey, type MilestonePresence } from "../lib/caseListLogic";

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
      completed: sql<number>`COUNT(*) FILTER (WHERE LOWER(${casesTable.status}) LIKE '%complet%' OR LOWER(${casesTable.status}) LIKE '%registered%' OR LOWER(${casesTable.status}) LIKE '%stamp%')`,
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
  const completedCases = Number(caseStats?.completed ?? 0);
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

  const milestoneCountSql = (milestone: CaseMilestoneKey, presence: MilestonePresence, extraWhere?: ReturnType<typeof sql>): ReturnType<typeof sql<number>> => {
    const p = milestonePresenceWhereSql(milestone, presence);
    if (extraWhere) return sql<number>`COUNT(*) FILTER (WHERE ${extraWhere} AND ${p})`;
    return sql<number>`COUNT(*) FILTER (WHERE ${p})`;
  };

  const loanMasterWhere = sql`${casesTable.purchaseMode} = 'loan' AND ${casesTable.titleType} = 'master'`;
  const loanTitleWhere = sql`${casesTable.purchaseMode} = 'loan' AND (${casesTable.titleType} = 'individual' OR ${casesTable.titleType} = 'strata')`;

  const segmentTotals = hasKeyDates
    ? (await r
        .select({
          spaTotal: count(),
          loanMasterTotal: sql<number>`COUNT(*) FILTER (WHERE ${loanMasterWhere})`,
          loanTitleTotal: sql<number>`COUNT(*) FILTER (WHERE ${loanTitleWhere})`,
        })
        .from(casesTable)
        .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
        .where(eq(casesTable.firmId, firmId)))[0]
    : undefined;

  const spaTotal = Number(segmentTotals?.spaTotal ?? 0);
  const loanMasterTotal = Number(segmentTotals?.loanMasterTotal ?? 0);
  const loanTitleTotal = Number(segmentTotals?.loanTitleTotal ?? 0);

  const isEncumberedSql = sql`${casesTable.isEncumbered} = true`;
  const encumbranceMissingSql = (milestone: CaseMilestoneKey, extraWhere: ReturnType<typeof sql>) =>
    sql<number>`COUNT(*) FILTER (WHERE ${extraWhere} AND ${isEncumberedSql} AND ${milestonePresenceWhereSql(milestone, "missing")})`;

  const spaMilestones: Array<{ key: CaseMilestoneKey; label: string }> = [
    { key: "spa_date", label: "SPA Date" },
    { key: "spa_stamped_date", label: "SPA Stamped Date" },
  ];

  const loanMasterMilestones: Array<{ key: CaseMilestoneKey; label: string }> = [
    { key: "letter_of_offer_date", label: "LO Date" },
    { key: "letter_of_offer_stamped_date", label: "LO Stamped" },
    { key: "acting_letter_issued_date", label: "Acting Letter" },
    { key: "loan_sent_bank_execution_date", label: "Bank Execution" },
    { key: "loan_bank_executed_date", label: "Loan Doc" },
    { key: "loan_agreement_stamped_date", label: "Loan Doc Stamped" },
    { key: "letter_disclaimer_dated", label: "Letter Disclaimer" },
    { key: "register_poa_on", label: "Register PA" },
    { key: "noa_served_on", label: "NOA Serve" },
    { key: "advice_to_bank_date", label: "Advice" },
    { key: "bank_1st_release_on", label: "Bank Released" },
    { key: "completion_date", label: "Completion" },
  ];

  const loanTitleMilestones: Array<{ key: CaseMilestoneKey; label: string; encumbranceOnlyWhenMissing?: boolean }> = [
    { key: "letter_of_offer_date", label: "LO Date" },
    { key: "letter_of_offer_stamped_date", label: "LO Stamped" },
    { key: "acting_letter_issued_date", label: "Acting Letter" },
    { key: "loan_sent_bank_execution_date", label: "Bank Execution" },
    { key: "loan_bank_executed_date", label: "Loan Doc" },
    { key: "loan_agreement_stamped_date", label: "Loan Doc Stamped" },
    { key: "letter_disclaimer_dated", label: "Letter Disclaimer" },
    { key: "caveat_lodged_date", label: "Caveat Lodged", encumbranceOnlyWhenMissing: true },
    { key: "first_advice_date", label: "1st Advice", encumbranceOnlyWhenMissing: true },
    { key: "dev_informed_redemption_date", label: "Dev Informed Redemption", encumbranceOnlyWhenMissing: true },
    { key: "request_discharge_date", label: "Request Discharge", encumbranceOnlyWhenMissing: true },
    { key: "discharge_date", label: "Discharge", encumbranceOnlyWhenMissing: true },
    { key: "mot_registered_date", label: "MOT" },
    { key: "charge_date", label: "Charge" },
    { key: "presentation_date", label: "Presentation" },
    { key: "second_advice_date", label: "2nd Advice" },
    { key: "bank_1st_release_on", label: "Bank Released" },
    { key: "completion_date", label: "Completion" },
  ];

  const filledCounts = hasKeyDates
    ? (await r
        .select(Object.fromEntries([
          ...spaMilestones.map((m) => [`spa_${m.key}`, milestoneCountSql(m.key, "filled")]),
          ...loanMasterMilestones.map((m) => [`loan_master_${m.key}`, milestoneCountSql(m.key, "filled", loanMasterWhere)]),
          ...loanTitleMilestones.filter((m) => !m.encumbranceOnlyWhenMissing).map((m) => [`loan_title_${m.key}`, milestoneCountSql(m.key, "filled", loanTitleWhere)]),
          ...loanTitleMilestones.filter((m) => m.encumbranceOnlyWhenMissing).map((m) => [`loan_title_enc_${m.key}`, encumbranceMissingSql(m.key, loanTitleWhere)]),
        ]))
        .from(casesTable)
        .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
        .where(eq(casesTable.firmId, firmId)))[0] as Record<string, unknown>
    : {};

  const toPendingCard = (segKey: string, total: number, m: { key: CaseMilestoneKey; label: string }, filledKey: string, extraFilter: Record<string, string> | undefined) => {
    const filled = Number((filledCounts as any)?.[filledKey] ?? 0);
    const pending = Math.max(0, total - filled);
    return {
      key: `${segKey}_${String(m.key)}`,
      label: `${m.label} Pending`,
      count: pending,
      filter: {
        milestone: m.key,
        milestonePresence: "missing",
        ...(extraFilter ?? {}),
      },
    };
  };

  const toEncumbrancePendingCard = (segKey: string, m: { key: CaseMilestoneKey; label: string }, missingKey: string, extraFilter: Record<string, string>) => {
    const pending = Number((filledCounts as any)?.[missingKey] ?? 0);
    return {
      key: `${segKey}_${String(m.key)}`,
      label: `${m.label} Pending`,
      count: pending,
      filter: {
        milestone: m.key,
        milestonePresence: "missing",
        ...extraFilter,
      },
    };
  };

  const spaCards = spaMilestones.map((m) => toPendingCard("spa", spaTotal, m, `spa_${m.key}`, undefined));
  const loanMasterCards = loanMasterMilestones.map((m) => toPendingCard("loan_master", loanMasterTotal, m, `loan_master_${m.key}`, { purchaseMode: "loan", titleType: "master" }));
  const loanTitleCards = loanTitleMilestones.map((m) => {
    const baseFilter = { purchaseMode: "loan", titleType: "individual,strata" };
    if (m.encumbranceOnlyWhenMissing) {
      return toEncumbrancePendingCard("loan_title", m, `loan_title_enc_${m.key}`, baseFilter);
    }
    return toPendingCard("loan_title", loanTitleTotal, m, `loan_title_${m.key}`, baseFilter);
  });

  const milestoneSections = hasKeyDates ? [
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

  const milestoneCards = hasKeyDates
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
