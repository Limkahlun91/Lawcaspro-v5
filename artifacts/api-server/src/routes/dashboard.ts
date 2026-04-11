import { Router, type IRouter } from "express";
import { eq, count, desc, sql } from "drizzle-orm";
import { db, casesTable, clientsTable, developersTable, projectsTable, caseAssignmentsTable, usersTable, caseKeyDatesTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth";
import { milestonePresenceWhereSql, type CaseMilestoneKey, type MilestonePresence } from "../lib/caseListLogic";

async function queryRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

const router: IRouter = Router();

router.get("/dashboard", requireAuth, requireFirmUser, requirePermission("dashboard", "read"), async (req: AuthRequest, res): Promise<void> => {
  const firmId = req.firmId!;

  const [totalCasesRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.firmId, firmId));
  const [completedCasesRes] = await db.select({ c: count() }).from(casesTable)
    .where(eq(casesTable.firmId, firmId));
  const [totalClientsRes] = await db.select({ c: count() }).from(clientsTable).where(eq(clientsTable.firmId, firmId));
  const [totalDevsRes] = await db.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, firmId));
  const [totalProjsRes] = await db.select({ c: count() }).from(projectsTable).where(eq(projectsTable.firmId, firmId));

  const allCases = await db.select().from(casesTable).where(eq(casesTable.firmId, firmId));
  const cashCases = allCases.filter(c => c.purchaseMode === "cash").length;
  const loanCases = allCases.filter(c => c.purchaseMode === "loan").length;
  const masterTitleCases = allCases.filter(c => c.titleType === "master").length;
  const individualTitleCases = allCases.filter(c => c.titleType === "individual").length;
  const strataTitleCases = allCases.filter(c => c.titleType === "strata").length;
  const completedCases = allCases.filter(c => c.status.toLowerCase().includes("complet") || c.status.toLowerCase().includes("registered") || c.status.toLowerCase().includes("stamp")).length;
  const activeCases = allCases.length - completedCases;

  const recentRows = await db.select().from(casesTable)
    .where(eq(casesTable.firmId, firmId))
    .orderBy(desc(casesTable.updatedAt))
    .limit(5);

  const recentCases = await Promise.all(
    recentRows.map(async (c) => {
      const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
      const [dev] = await db.select().from(developersTable).where(eq(developersTable.id, c.developerId));
      const [assignment] = await db
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
        createdAt: c.createdAt.toISOString(),
      };
    })
  );

  // Billing summary
  const billingRows = await queryRows(sql`
    SELECT
      SUM(amount * quantity) as total_billed,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as total_paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as total_outstanding
    FROM case_billing_entries WHERE firm_id = ${firmId}
  `);
  const billing = billingRows[0] ?? {};

  // Communications count this month
  const commRows = await queryRows(sql`
    SELECT COUNT(*) as total_this_month
    FROM case_communications
    WHERE firm_id = ${firmId}
    AND created_at >= date_trunc('month', NOW())
  `);
  const commsThisMonth = Number(commRows[0]?.total_this_month ?? 0);

  const milestoneCountSql = (milestone: CaseMilestoneKey, presence: MilestonePresence, loanOnly: boolean): ReturnType<typeof sql<number>> => {
    const p = milestonePresenceWhereSql(milestone, presence);
    if (loanOnly) return sql<number>`COUNT(*) FILTER (WHERE ${casesTable.purchaseMode} = 'loan' AND ${p})`;
    return sql<number>`COUNT(*) FILTER (WHERE ${p})`;
  };

  const [milestoneCounts] = await db
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
    .where(eq(casesTable.firmId, firmId));

  const milestoneCards = [
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
  ];

  res.json({
    totalCases: Number(totalCasesRes?.c ?? 0),
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
});

export default router;
