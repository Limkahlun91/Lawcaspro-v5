import { Router, type IRouter } from "express";
import { eq, count, desc, sql } from "drizzle-orm";
import { db, casesTable, clientsTable, developersTable, projectsTable, caseAssignmentsTable, usersTable, caseKeyDatesTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth";
import { milestonePresenceWhereSql, type CaseMilestoneKey, type MilestonePresence } from "../lib/caseListLogic";
import { logger } from "../lib/logger";

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

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

const router: IRouter = Router();

router.get("/dashboard", requireAuth, requireFirmUser, requirePermission("dashboard", "read"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const r = rdb(req);
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

  const billing = hasBillingEntries ? (await queryRows(r, sql`
      SELECT
        SUM(amount * quantity) as total_billed,
        SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as total_paid,
        SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as total_outstanding
      FROM case_billing_entries WHERE firm_id = ${firmId}
    `))[0] ?? {} : {};

  const commsThisMonth = hasCommunications
    ? Number((await queryRows(r, sql`
        SELECT COUNT(*) as total_this_month
        FROM case_communications
        WHERE firm_id = ${firmId}
        AND created_at >= date_trunc('month', NOW())
      `))[0]?.total_this_month ?? 0)
    : 0;

  const milestoneCountSql = (milestone: CaseMilestoneKey, presence: MilestonePresence, loanOnly: boolean): ReturnType<typeof sql<number>> => {
    const p = milestonePresenceWhereSql(milestone, presence);
    if (loanOnly) return sql<number>`COUNT(*) FILTER (WHERE ${casesTable.purchaseMode} = 'loan' AND ${p})`;
    return sql<number>`COUNT(*) FILTER (WHERE ${p})`;
  };

  const milestoneCounts = hasKeyDates
    ? (await r
      .select({
        spaStamped: milestoneCountSql("spa_stamped_date", "filled", false),
        loanDocsSigned: milestoneCountSql("loan_docs_signed_date", "filled", true),
        actingLetterIssued: milestoneCountSql("acting_letter_issued_date", "filled", true),
        loanSentBankExecution: milestoneCountSql("loan_sent_bank_execution_date", "filled", true),
        loanBankExecuted: milestoneCountSql("loan_bank_executed_date", "filled", true),
        bluReceived: milestoneCountSql("bank_lu_received_date", "filled", true),
        noaServed: milestoneCountSql("noa_served_on", "filled", false),
        completion: milestoneCountSql("completion_date", "filled", false),

        spaDateMissing: milestoneCountSql("spa_date", "missing", false),
        lofDateMissing: milestoneCountSql("letter_of_offer_date", "missing", false),
        loanDocsSignedMissing: milestoneCountSql("loan_docs_signed_date", "missing", true),
        completionDateMissing: milestoneCountSql("completion_date", "missing", false),
      })
      .from(casesTable)
      .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
      .where(eq(casesTable.firmId, firmId)))[0]
    : undefined;

  const milestoneCards = hasKeyDates ? [
    { key: "spa_stamped", label: "SPA Stamped", count: Number(milestoneCounts?.spaStamped ?? 0), filter: { milestone: "spa_stamped_date", milestonePresence: "filled" } },
    { key: "loan_docs_signed", label: "Loan Docs Signed", count: Number(milestoneCounts?.loanDocsSigned ?? 0), filter: { milestone: "loan_docs_signed_date", milestonePresence: "filled", purchaseMode: "loan" } },
    { key: "acting_letter_issued", label: "Acting Letter Issued", count: Number(milestoneCounts?.actingLetterIssued ?? 0), filter: { milestone: "acting_letter_issued_date", milestonePresence: "filled", purchaseMode: "loan" } },
    { key: "loan_sent_bank_execution", label: "Loan Sent Bank Execution", count: Number(milestoneCounts?.loanSentBankExecution ?? 0), filter: { milestone: "loan_sent_bank_execution_date", milestonePresence: "filled", purchaseMode: "loan" } },
    { key: "loan_bank_executed", label: "Loan Bank Executed", count: Number(milestoneCounts?.loanBankExecuted ?? 0), filter: { milestone: "loan_bank_executed_date", milestonePresence: "filled", purchaseMode: "loan" } },
    { key: "blu_received", label: "BLU Received", count: Number(milestoneCounts?.bluReceived ?? 0), filter: { milestone: "bank_lu_received_date", milestonePresence: "filled", purchaseMode: "loan" } },
    { key: "noa_served", label: "NOA Served", count: Number(milestoneCounts?.noaServed ?? 0), filter: { milestone: "noa_served_on", milestonePresence: "filled" } },
    { key: "completion", label: "Completion", count: Number(milestoneCounts?.completion ?? 0), filter: { milestone: "completion_date", milestonePresence: "filled" } },

    { key: "spa_date_missing", label: "SPA Date Missing", count: Number(milestoneCounts?.spaDateMissing ?? 0), filter: { milestone: "spa_date", milestonePresence: "missing" } },
    { key: "lof_date_missing", label: "LOF Date Missing", count: Number(milestoneCounts?.lofDateMissing ?? 0), filter: { milestone: "letter_of_offer_date", milestonePresence: "missing" } },
    { key: "loan_docs_signed_missing", label: "Loan Docs Signed Missing", count: Number(milestoneCounts?.loanDocsSignedMissing ?? 0), filter: { milestone: "loan_docs_signed_date", milestonePresence: "missing", purchaseMode: "loan" } },
    { key: "completion_date_missing", label: "Completion Date Missing", count: Number(milestoneCounts?.completionDateMissing ?? 0), filter: { milestone: "completion_date", milestonePresence: "missing" } },
  ] : [];

    res.json({
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
        totalBilled: Number(billing.total_billed ?? 0),
        totalPaid: Number(billing.total_paid ?? 0),
        totalOutstanding: Number(billing.total_outstanding ?? 0),
      },
      commsThisMonth,
      milestoneCards,
    });
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[dashboard]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
