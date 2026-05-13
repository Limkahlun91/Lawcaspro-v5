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
  const loanIndStrataWhere = sql`${casesTable.purchaseMode} = 'loan' AND (${casesTable.titleType} = 'individual' OR ${casesTable.titleType} = 'strata')`;

  const milestoneDefsSpa: Array<{ key: CaseMilestoneKey; label: string }> = [
    { key: "spa_date", label: "SPA Date" },
    { key: "spa_stamped_date", label: "SPA Stamped" },
    { key: "letter_of_offer_date", label: "LO Date" },
  ];

  const milestoneDefsLoanCommon: Array<{ key: CaseMilestoneKey; label: string }> = [
    { key: "loan_docs_pending_date", label: "Loan Docs Pending" },
    { key: "loan_docs_signed_date", label: "Loan Docs Signed" },
    { key: "acting_letter_issued_date", label: "Acting Letter Issued" },
    { key: "developer_confirmation_received_on", label: "Developer Confirmation Received" },
    { key: "loan_sent_bank_execution_date", label: "Loan Sent Bank Execution" },
    { key: "loan_bank_executed_date", label: "Loan Bank Executed" },
    { key: "bank_lu_received_date", label: "BLU Received" },
    { key: "advice_to_bank_date", label: "Advice to Bank" },
    { key: "bank_lu_forward_to_developer_on", label: "BLU Forwarded to Developer" },
    { key: "developer_lu_received_on", label: "Developer LU Received" },
    { key: "developer_lu_dated", label: "Developer LU Dated" },
  ];

  const milestoneDefsLoanMaster: Array<{ key: CaseMilestoneKey; label: string }> = [
    { key: "noa_served_on", label: "NOA Served" },
    { key: "register_poa_on", label: "POA Registered" },
    { key: "letter_disclaimer_dated", label: "Letter Disclaimer Dated" },
  ];

  const milestoneDefsLoanIndStrata: Array<{ key: CaseMilestoneKey; label: string }> = [
    { key: "mot_received_date", label: "MOT Received" },
    { key: "mot_signed_date", label: "MOT Signed" },
    { key: "mot_stamped_date", label: "MOT Stamped" },
    { key: "mot_registered_date", label: "MOT Registered" },
  ];

  const totalsBySegment = hasKeyDates
    ? (await r
        .select({
          totalSpa: count(),
          totalLoanMaster: sql<number>`COUNT(*) FILTER (WHERE ${loanMasterWhere})`,
          totalLoanIndStrata: sql<number>`COUNT(*) FILTER (WHERE ${loanIndStrataWhere})`,
        })
        .from(casesTable)
        .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
        .where(eq(casesTable.firmId, firmId)))[0]
    : undefined;

  const totalSpa = Number(totalsBySegment?.totalSpa ?? 0);
  const totalLoanMaster = Number(totalsBySegment?.totalLoanMaster ?? 0);
  const totalLoanIndStrata = Number(totalsBySegment?.totalLoanIndStrata ?? 0);

  const filledCounts = hasKeyDates
    ? (await r
        .select(Object.fromEntries([
          ...milestoneDefsSpa.map((m) => [`spa_${m.key}`, milestoneCountSql(m.key, "filled")]),
          ...milestoneDefsLoanCommon.map((m) => [`loan_master_common_${m.key}`, milestoneCountSql(m.key, "filled", loanMasterWhere)]),
          ...milestoneDefsLoanCommon.map((m) => [`loan_ind_common_${m.key}`, milestoneCountSql(m.key, "filled", loanIndStrataWhere)]),
          ...milestoneDefsLoanMaster.map((m) => [`loan_master_${m.key}`, milestoneCountSql(m.key, "filled", loanMasterWhere)]),
          ...milestoneDefsLoanIndStrata.map((m) => [`loan_ind_${m.key}`, milestoneCountSql(m.key, "filled", loanIndStrataWhere)]),
        ]))
        .from(casesTable)
        .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
        .where(eq(casesTable.firmId, firmId)))[0] as Record<string, unknown>
    : {};

  const toPendingCard = (segKey: string, total: number, m: { key: CaseMilestoneKey; label: string }, filledKey: string, extraFilter?: Record<string, string>) => {
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

  const spaCards = milestoneDefsSpa.map((m) => toPendingCard("spa", totalSpa, m, `spa_${m.key}`));
  const loanMasterCards = [
    ...milestoneDefsLoanCommon.map((m) => toPendingCard("loan_master", totalLoanMaster, m, `loan_master_common_${m.key}`, { purchaseMode: "loan", titleType: "master" })),
    ...milestoneDefsLoanMaster.map((m) => toPendingCard("loan_master", totalLoanMaster, m, `loan_master_${m.key}`, { purchaseMode: "loan", titleType: "master" })),
  ];
  const loanIndStrataCards = [
    ...milestoneDefsLoanCommon.map((m) => toPendingCard("loan_ind", totalLoanIndStrata, m, `loan_ind_common_${m.key}`, { purchaseMode: "loan", titleType: "individual,strata" })),
    ...milestoneDefsLoanIndStrata.map((m) => toPendingCard("loan_ind", totalLoanIndStrata, m, `loan_ind_${m.key}`, { purchaseMode: "loan", titleType: "individual,strata" })),
  ];

  const milestoneSections = hasKeyDates ? [
    { key: "spa", label: "Total SPA Cases", total: totalSpa, cards: spaCards },
    { key: "loan_master", label: "Total Loan Cases (Master Title)", total: totalLoanMaster, cards: loanMasterCards },
    { key: "loan_ind_strata", label: "Total Loan Cases (Individual/Strata)", total: totalLoanIndStrata, cards: loanIndStrataCards },
  ] : [];

  const milestoneCards = hasKeyDates
    ? [...spaCards, ...loanMasterCards, ...loanIndStrataCards]
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
