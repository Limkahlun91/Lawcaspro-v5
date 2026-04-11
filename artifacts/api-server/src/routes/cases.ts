import { Router, type IRouter } from "express";
import { eq, ilike, count, desc, and, or, sql } from "drizzle-orm";
import {
  db, casesTable, casePurchasersTable, caseAssignmentsTable,
  caseWorkflowStepsTable, caseNotesTable,
  caseKeyDatesTable,
  projectsTable, developersTable, clientsTable, usersTable, auditLogsTable,
} from "@workspace/db";
import {
  CreateCaseBody, UpdateCaseBody, ListCasesQueryParams,
  GetCaseParams, UpdateCaseParams,
  GetCaseWorkflowParams, UpdateWorkflowStepParams, UpdateWorkflowStepBody,
  GetCaseNotesParams, CreateCaseNoteParams, CreateCaseNoteBody
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";
import { buildWorkflowSteps } from "../lib/workflow";
import { KEY_DATE_FIELD_TO_STEP_KEY, WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD, type KeyDateField } from "../lib/keyDatesWorkflow";
import { loanStatusSql, milestoneDateYmdSql, milestonePresenceWhereSql, spaStatusSql, type CaseMilestoneKey, type MilestonePresence } from "../lib/caseListLogic";

const router: IRouter = Router();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

type CaseKeyDatesInsert = typeof caseKeyDatesTable.$inferInsert;

function parseDateOnlyInput(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  return s;
}

function parseMoneyInput(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    return String(v);
  }
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return String(n);
}

function ymdToUtcDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

function dateToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shouldBackfillKeyDate(field: KeyDateField, kd: typeof caseKeyDatesTable.$inferSelect | null): boolean {
  if (!kd) return true;
  switch (field) {
    case "spa_signed_date": return !kd.spaSignedDate;
    case "spa_stamped_date": return !kd.spaStampedDate;
    case "letter_of_offer_stamped_date": return !kd.letterOfOfferStampedDate;
    case "loan_docs_signed_date": return !kd.loanDocsSignedDate;
    case "acting_letter_issued_date": return !kd.actingLetterIssuedDate;
    case "loan_sent_bank_execution_date": return !kd.loanSentBankExecutionDate;
    case "loan_bank_executed_date": return !kd.loanBankExecutedDate;
    case "bank_lu_received_date": return !kd.bankLuReceivedDate;
    case "noa_served_on": return !kd.noaServedOn;
  }
}

function keyDatePatchFromWorkflow(field: KeyDateField, ymd: string): Partial<CaseKeyDatesInsert> {
  switch (field) {
    case "spa_signed_date": return { spaSignedDate: ymd };
    case "spa_stamped_date": return { spaStampedDate: ymd };
    case "letter_of_offer_stamped_date": return { letterOfOfferStampedDate: ymd };
    case "loan_docs_signed_date": return { loanDocsSignedDate: ymd };
    case "acting_letter_issued_date": return { actingLetterIssuedDate: ymd };
    case "loan_sent_bank_execution_date": return { loanSentBankExecutionDate: ymd };
    case "loan_bank_executed_date": return { loanBankExecutedDate: ymd };
    case "bank_lu_received_date": return { bankLuReceivedDate: ymd };
    case "noa_served_on": return { noaServedOn: ymd };
  }
}

async function formatCaseDetail(r: DbConn, c: typeof casesTable.$inferSelect) {
  const [proj] = await r.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
  const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, c.developerId));

  const purchaserRows = await r.select().from(casePurchasersTable).where(eq(casePurchasersTable.caseId, c.id));
  const purchasers = await Promise.all(
    purchaserRows.map(async (p) => {
      const [client] = await r.select().from(clientsTable).where(eq(clientsTable.id, p.clientId));
      return {
        id: p.id,
        clientId: p.clientId,
        clientName: client?.name ?? "Unknown",
        icNo: client?.icNo ?? null,
        role: p.role,
        orderNo: p.orderNo,
      };
    })
  );

  const assignRows = await r.select().from(caseAssignmentsTable)
    .where(and(eq(caseAssignmentsTable.caseId, c.id), sql`unassigned_at IS NULL`));
  const assignments = await Promise.all(
    assignRows.map(async (a) => {
      const [user] = await r.select().from(usersTable).where(eq(usersTable.id, a.userId));
      return {
        id: a.id,
        userId: a.userId,
        userName: user?.name ?? "Unknown",
        roleInCase: a.roleInCase,
        assignedAt: a.assignedAt.toISOString(),
      };
    })
  );

  let spaDetails: any = null;
  let propertyDetails: any = null;
  let loanDetails: any = null;
  let companyDetails: any = null;
  try { if (c.spaDetails) spaDetails = JSON.parse(c.spaDetails); } catch {}
  try { if (c.propertyDetails) propertyDetails = JSON.parse(c.propertyDetails); } catch {}
  try { if (c.loanDetails) loanDetails = JSON.parse(c.loanDetails); } catch {}
  try { if (c.companyDetails) companyDetails = JSON.parse(c.companyDetails); } catch {}

  const [kd] = await r
    .select()
    .from(caseKeyDatesTable)
    .where(and(eq(caseKeyDatesTable.caseId, c.id), eq(caseKeyDatesTable.firmId, c.firmId)));

  return {
    id: c.id,
    firmId: c.firmId,
    referenceNo: c.referenceNo,
    projectId: c.projectId,
    projectName: proj?.name ?? "Unknown",
    developerId: c.developerId,
    developerName: dev?.name ?? "Unknown",
    purchaseMode: c.purchaseMode,
    titleType: c.titleType,
    spaPrice: c.spaPrice ? Number(c.spaPrice) : null,
    status: c.status,
    caseType: c.caseType,
    parcelNo: c.parcelNo,
    spaDetails,
    propertyDetails,
    loanDetails,
    companyDetails,
    keyDates: kd ? {
      spa_signed_date: kd.spaSignedDate ? String(kd.spaSignedDate) : null,
      spa_forward_to_developer_execution_on: kd.spaForwardToDeveloperExecutionOn ? String(kd.spaForwardToDeveloperExecutionOn) : null,
      spa_date: kd.spaDate ? String(kd.spaDate) : null,
      spa_stamped_date: kd.spaStampedDate ? String(kd.spaStampedDate) : null,
      stamped_spa_send_to_developer_on: kd.stampedSpaSendToDeveloperOn ? String(kd.stampedSpaSendToDeveloperOn) : null,
      stamped_spa_received_from_developer_on: kd.stampedSpaReceivedFromDeveloperOn ? String(kd.stampedSpaReceivedFromDeveloperOn) : null,
      letter_of_offer_date: kd.letterOfOfferDate ? String(kd.letterOfOfferDate) : null,
      letter_of_offer_stamped_date: kd.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
      loan_docs_pending_date: kd.loanDocsPendingDate ? String(kd.loanDocsPendingDate) : null,
      loan_docs_signed_date: kd.loanDocsSignedDate ? String(kd.loanDocsSignedDate) : null,
      acting_letter_issued_date: kd.actingLetterIssuedDate ? String(kd.actingLetterIssuedDate) : null,
      developer_confirmation_received_on: kd.developerConfirmationReceivedOn ? String(kd.developerConfirmationReceivedOn) : null,
      developer_confirmation_date: kd.developerConfirmationDate ? String(kd.developerConfirmationDate) : null,
      loan_sent_bank_execution_date: kd.loanSentBankExecutionDate ? String(kd.loanSentBankExecutionDate) : null,
      loan_bank_executed_date: kd.loanBankExecutedDate ? String(kd.loanBankExecutedDate) : null,
      bank_lu_received_date: kd.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
      bank_lu_forward_to_developer_on: kd.bankLuForwardToDeveloperOn ? String(kd.bankLuForwardToDeveloperOn) : null,
      developer_lu_received_on: kd.developerLuReceivedOn ? String(kd.developerLuReceivedOn) : null,
      developer_lu_dated: kd.developerLuDated ? String(kd.developerLuDated) : null,
      letter_disclaimer_received_on: kd.letterDisclaimerReceivedOn ? String(kd.letterDisclaimerReceivedOn) : null,
      letter_disclaimer_dated: kd.letterDisclaimerDated ? String(kd.letterDisclaimerDated) : null,
      letter_disclaimer_reference_nos: kd.letterDisclaimerReferenceNos ?? null,
      redemption_sum: kd.redemptionSum ? Number(kd.redemptionSum) : null,
      loan_agreement_dated: kd.loanAgreementDated ? String(kd.loanAgreementDated) : null,
      loan_agreement_submitted_stamping_date: kd.loanAgreementSubmittedStampingDate ? String(kd.loanAgreementSubmittedStampingDate) : null,
      loan_agreement_stamped_date: kd.loanAgreementStampedDate ? String(kd.loanAgreementStampedDate) : null,
      register_poa_on: kd.registerPoaOn ? String(kd.registerPoaOn) : null,
      registered_poa_registration_number: kd.registeredPoaRegistrationNumber ?? null,
      noa_served_on: kd.noaServedOn ? String(kd.noaServedOn) : null,
      advice_to_bank_date: kd.adviceToBankDate ? String(kd.adviceToBankDate) : null,
      bank_1st_release_on: kd.bank1stReleaseOn ? String(kd.bank1stReleaseOn) : null,
      first_release_amount_rm: kd.firstReleaseAmountRm ? Number(kd.firstReleaseAmountRm) : null,
      mot_received_date: kd.motReceivedDate ? String(kd.motReceivedDate) : null,
      mot_signed_date: kd.motSignedDate ? String(kd.motSignedDate) : null,
      mot_stamped_date: kd.motStampedDate ? String(kd.motStampedDate) : null,
      mot_registered_date: kd.motRegisteredDate ? String(kd.motRegisteredDate) : null,
      progressive_payment_date: kd.progressivePaymentDate ? String(kd.progressivePaymentDate) : null,
      full_settlement_date: kd.fullSettlementDate ? String(kd.fullSettlementDate) : null,
      completion_date: kd.completionDate ? String(kd.completionDate) : null,
    } : null,
    purchasers,
    assignments,
    createdBy: c.createdBy ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

async function formatCaseSummary(r: DbConn, c: typeof casesTable.$inferSelect) {
  const [proj] = await r.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
  const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, c.developerId));
  const [lawyerAssign] = await r.select().from(caseAssignmentsTable)
    .where(and(eq(caseAssignmentsTable.caseId, c.id), eq(caseAssignmentsTable.roleInCase, "lawyer"), sql`unassigned_at IS NULL`));
  let lawyerName: string | null = null;
  if (lawyerAssign) {
    const [lawyer] = await r.select().from(usersTable).where(eq(usersTable.id, lawyerAssign.userId));
    lawyerName = lawyer?.name ?? null;
  }
  return {
    id: c.id,
    referenceNo: c.referenceNo,
    projectName: proj?.name ?? "Unknown",
    developerName: dev?.name ?? "Unknown",
    purchaseMode: c.purchaseMode,
    titleType: c.titleType,
    spaPrice: c.spaPrice ? Number(c.spaPrice) : null,
    status: c.status,
    assignedLawyerName: lawyerName,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/cases/stats/by-status", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const rows = await db
    .select({ status: casesTable.status, count: count() })
    .from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .groupBy(casesTable.status);
  res.json(rows.map(r => ({ status: r.status, count: Number(r.count) })));
});

router.get("/cases/stats/by-type", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const rows = await db
    .select({ purchaseMode: casesTable.purchaseMode, count: count() })
    .from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .groupBy(casesTable.purchaseMode);
  res.json(rows.map(r => ({ purchaseMode: r.purchaseMode, count: Number(r.count) })));
});

router.get("/cases/recent", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const limitParam = req.query.limit ? Number(req.query.limit) : 5;
  const cases = await r.select().from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .orderBy(desc(casesTable.updatedAt))
    .limit(limitParam);
  const summaries = await Promise.all(cases.map((c) => formatCaseSummary(r, c)));
  res.json(summaries);
});

router.get("/cases/filter-options", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);

  const stepDefs = buildWorkflowSteps("loan", "individual");
  const spaStatuses = ["Pending", ...stepDefs.filter(s => s.pathType === "common").sort((a, b) => a.stepOrder - b.stepOrder).map(s => s.stepName)];
  const loanStatuses = ["Pending", ...stepDefs.filter(s => s.pathType === "loan").sort((a, b) => a.stepOrder - b.stepOrder).map(s => s.stepName)];

  const assignmentRows = await r
    .select({ userId: usersTable.id, userName: usersTable.name, roleInCase: caseAssignmentsTable.roleInCase })
    .from(caseAssignmentsTable)
    .innerJoin(usersTable, eq(caseAssignmentsTable.userId, usersTable.id))
    .where(and(eq(usersTable.firmId, req.firmId!), sql`unassigned_at IS NULL`));

  const lawyersMap = new Map<number, string>();
  const clerksMap = new Map<number, string>();
  for (const a of assignmentRows) {
    if (a.roleInCase === "lawyer") lawyersMap.set(a.userId, a.userName);
    if (a.roleInCase === "clerk") clerksMap.set(a.userId, a.userName);
  }
  const lawyers = Array.from(lawyersMap.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const clerks = Array.from(clerksMap.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    spaStatuses,
    loanStatuses,
    assignees: { lawyers, clerks },
    milestones: [
      { key: "spa_date", label: "SPA Date" },
      { key: "spa_stamped_date", label: "SPA Stamped" },
      { key: "letter_of_offer_date", label: "LOF Date" },
      { key: "loan_docs_signed_date", label: "Loan Docs Signed" },
      { key: "completion_date", label: "Completion Date" },
    ],
  });
});

router.get("/cases", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const params = ListCasesQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const status = params.success ? params.data.status : undefined;
  const projectId = params.success ? params.data.projectId : undefined;
  const developerId = params.success ? params.data.developerId : undefined;
  const purchaseMode = params.success ? params.data.purchaseMode : undefined;
  const titleType = params.success ? params.data.titleType : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  const one = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;
  const parseIntOrUndef = (v: string | string[] | undefined): number | undefined => {
    const s = one(v);
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n)) return undefined;
    return n;
  };

  const spaStatus = one(req.query.spaStatus as any);
  const loanStatus = one(req.query.loanStatus as any);
  const milestone = one(req.query.milestone as any) as CaseMilestoneKey | undefined;
  const milestonePresence = one(req.query.milestonePresence as any) as MilestonePresence | undefined;
  const assignedLawyerId = params.success ? params.data.assignedLawyerId : parseIntOrUndef(req.query.assignedLawyerId as any);
  const assignedClerkId = parseIntOrUndef(req.query.assignedClerkId as any);

  const loanOnlyMilestones: Set<CaseMilestoneKey> = new Set([
    "loan_docs_signed_date",
    "acting_letter_issued_date",
    "loan_sent_bank_execution_date",
    "loan_bank_executed_date",
    "bank_lu_received_date",
  ]);

  const conditions = [eq(casesTable.firmId, req.firmId!)];
  if (status) conditions.push(eq(casesTable.status, status));
  if (projectId) conditions.push(eq(casesTable.projectId, projectId));
  if (developerId) conditions.push(eq(casesTable.developerId, developerId));
  if (purchaseMode) conditions.push(eq(casesTable.purchaseMode, purchaseMode));
  if (titleType) conditions.push(eq(casesTable.titleType, titleType));
  if (assignedLawyerId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
        AND ${caseAssignmentsTable.userId} = ${assignedLawyerId}
        AND ${sql`unassigned_at IS NULL`}
    )`);
  }
  if (assignedClerkId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'clerk'
        AND ${caseAssignmentsTable.userId} = ${assignedClerkId}
        AND ${sql`unassigned_at IS NULL`}
    )`);
  }
  if (spaStatus) {
    conditions.push(sql`${spaStatusSql()} = ${spaStatus}`);
  }
  if (loanStatus) {
    conditions.push(sql`${loanStatusSql()} = ${loanStatus}`);
  }
  if (milestone && milestonePresence && (milestonePresence === "filled" || milestonePresence === "missing")) {
    if (loanOnlyMilestones.has(milestone)) {
      conditions.push(eq(casesTable.purchaseMode, "loan"));
    }
    conditions.push(milestonePresenceWhereSql(milestone, milestonePresence));
  }
  if (search && search.trim()) {
    const like = `%${search.trim()}%`;
    const searchOr = or(
      sql`${casesTable.referenceNo} ILIKE ${like}`,
      sql`${projectsTable.name} ILIKE ${like}`,
      sql`${developersTable.name} ILIKE ${like}`,
      sql`COALESCE(${casesTable.parcelNo}, '') ILIKE ${like}`,
      sql`EXISTS (
        SELECT 1
        FROM ${casePurchasersTable} cp
        JOIN ${clientsTable} cl ON cp.client_id = cl.id
        WHERE cp.case_id = ${casesTable.id}
          AND cl.firm_id = ${casesTable.firmId}
          AND cl.name ILIKE ${like}
      )`
    );
    if (searchOr) conditions.push(searchOr);
  }

  const purchaserNameSql = sql<string | null>`(
    SELECT cl.name
    FROM ${casePurchasersTable} cp
    JOIN ${clientsTable} cl ON cp.client_id = cl.id
    WHERE cp.case_id = ${casesTable.id}
      AND cl.firm_id = ${casesTable.firmId}
    ORDER BY cp.order_no ASC
    LIMIT 1
  )`;
  const purchaserCountSql = sql<number>`(
    SELECT COUNT(*)
    FROM ${casePurchasersTable} cp
    WHERE cp.case_id = ${casesTable.id}
  )`;

  const lawyerIdSql = sql<number | null>`(
    SELECT ${caseAssignmentsTable.userId}
    FROM ${caseAssignmentsTable}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
      AND ${sql`unassigned_at IS NULL`}
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const lawyerNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
      AND ${sql`unassigned_at IS NULL`}
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const clerkIdSql = sql<number | null>`(
    SELECT ${caseAssignmentsTable.userId}
    FROM ${caseAssignmentsTable}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'clerk'
      AND ${sql`unassigned_at IS NULL`}
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const clerkNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'clerk'
      AND ${sql`unassigned_at IS NULL`}
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;

  const rows = await r
    .select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      status: casesTable.status,
      projectName: projectsTable.name,
      developerName: developersTable.name,
      purchaseMode: casesTable.purchaseMode,
      titleType: casesTable.titleType,
      parcelNo: casesTable.parcelNo,
      createdAt: casesTable.createdAt,
      updatedAt: casesTable.updatedAt,
      clientName: purchaserNameSql,
      purchaserCount: purchaserCountSql,
      assignedLawyerId: lawyerIdSql,
      assignedLawyerName: lawyerNameSql,
      assignedClerkId: clerkIdSql,
      assignedClerkName: clerkNameSql,
      spaStatus: spaStatusSql(),
      loanStatus: loanStatusSql(),
      mSpaDate: milestoneDateYmdSql("spa_date"),
      mSpaStampedDate: milestoneDateYmdSql("spa_stamped_date"),
      mLetterOfOfferDate: milestoneDateYmdSql("letter_of_offer_date"),
      mLoanDocsSignedDate: milestoneDateYmdSql("loan_docs_signed_date"),
      mCompletionDate: milestoneDateYmdSql("completion_date"),
    })
    .from(casesTable)
    .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .leftJoin(developersTable, eq(developersTable.id, casesTable.developerId))
    .leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)))
    .where(and(...conditions))
    .orderBy(desc(casesTable.updatedAt))
    .limit(limit)
    .offset(offset);

  const [totalRes] = await r
    .select({ c: sql<number>`COUNT(DISTINCT ${casesTable.id})` })
    .from(casesTable)
    .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .leftJoin(developersTable, eq(developersTable.id, casesTable.developerId))
    .leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)))
    .where(and(...conditions));

  const data = rows.map((row) => {
    const purchaserCount = Number(row.purchaserCount ?? 0);
    const baseName = row.clientName ?? null;
    const clientDisplayName = baseName && purchaserCount > 1 ? `${baseName} +${purchaserCount - 1}` : baseName;
    return {
      id: row.id,
      referenceNo: row.referenceNo,
      clientName: clientDisplayName,
      projectName: row.projectName ?? "Unknown",
      developerName: row.developerName ?? "Unknown",
      property: row.parcelNo ?? null,
      purchaseMode: row.purchaseMode,
      titleType: row.titleType,
      status: row.status,
      assignedLawyerId: row.assignedLawyerId ?? null,
      assignedLawyerName: row.assignedLawyerName ?? null,
      assignedClerkId: row.assignedClerkId ?? null,
      assignedClerkName: row.assignedClerkName ?? null,
      spaStatus: row.spaStatus,
      loanStatus: row.loanStatus ?? null,
      milestones: {
        spa_date: row.mSpaDate ?? null,
        spa_stamped_date: row.mSpaStampedDate ?? null,
        letter_of_offer_date: row.mLetterOfOfferDate ?? null,
        loan_docs_signed_date: row.mLoanDocsSignedDate ?? null,
        completion_date: row.mCompletionDate ?? null,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  res.json({ data, total: Number(totalRes?.c ?? 0), page, limit });
});

router.post("/cases", requireAuth, requireFirmUser, requirePermission("cases", "create"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      (req as any).log?.error?.({ route: "POST /api/cases", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const parsed = CreateCaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", fields: parsed.error.flatten().fieldErrors });
      return;
    }

    const { projectId, developerId: clientDeveloperId, purchaseMode, titleType, spaPrice, assignedLawyerId, assignedClerkId, purchaserIds, purchasers } = parsed.data;

    // ── 1. Resolve developerId server-side from projectId ─────────────────────
    const [project] = await r.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.firmId !== req.firmId) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!project.developerId) {
      res.status(422).json({ error: "The selected project has no linked developer. Please edit the project first." });
      return;
    }
    // If caller sent developerId, validate it matches the project
    if (clientDeveloperId !== undefined && clientDeveloperId !== project.developerId) {
      res.status(409).json({
        error: "developerId does not match the project's developer",
        expected: project.developerId,
        received: clientDeveloperId,
      });
      return;
    }
    const developerId = project.developerId;

    // ── 2. Resolve purchaser client IDs with dedupe ───────────────────────────
    let resolvedPurchaserIds: number[] = purchaserIds ?? [];
    let purchasersCreated = 0;
    let purchasersReused = 0;

    if (resolvedPurchaserIds.length === 0 && purchasers && purchasers.length > 0) {
      for (const p of purchasers) {
        const trimmedName = p.name.trim();
        if (!trimmedName) continue;
        const trimmedIc = p.ic?.trim() || null;

        let existingClientId: number | null = null;

        if (trimmedIc) {
          // IC is present — look up by firmId + icNo (most reliable match)
          const [byIc] = await r
            .select()
            .from(clientsTable)
            .where(and(eq(clientsTable.firmId, req.firmId!), eq(clientsTable.icNo, trimmedIc)));
          if (byIc) {
            existingClientId = byIc.id;
          }
        }

        if (!existingClientId) {
          // No IC or no IC match — try exact case-insensitive name match
          const byName = await r
            .select()
            .from(clientsTable)
            .where(and(
              eq(clientsTable.firmId, req.firmId!),
              sql`LOWER(${clientsTable.name}) = LOWER(${trimmedName})`
            ));
          // Only reuse if exactly one match (ambiguous → create new)
          if (byName.length === 1) {
            existingClientId = byName[0].id;
          }
        }

        if (existingClientId) {
          resolvedPurchaserIds.push(existingClientId);
          purchasersReused++;
        } else {
          const insertBase = {
            firmId: req.firmId!,
            name: trimmedName,
            icNo: trimmedIc,
          };

          let client: typeof clientsTable.$inferSelect;
          [client] = await r
            .insert(clientsTable)
            .values(insertBase as any)
            .returning();

          try {
            await r
              .update(clientsTable)
              .set({ createdBy: req.userId } as any)
              .where(and(eq(clientsTable.id, client.id), eq(clientsTable.firmId, req.firmId!)));
          } catch {
          }
          resolvedPurchaserIds.push(client.id);
          purchasersCreated++;
        }
      }
    }

    if (resolvedPurchaserIds.length === 0) {
      res.status(400).json({ error: "At least one purchaser name is required" });
      return;
    }

    // ── 3. Build extra fields from body (not in Zod schema) ───────────────────
    const { caseType, parcelNo, spaDetails, propertyDetails, loanDetails, companyDetails } = req.body as {
      caseType?: string;
      parcelNo?: string;
      spaDetails?: object;
      propertyDetails?: object;
      loanDetails?: object;
      companyDetails?: object;
    };

    const requestedRef = typeof (req.body as any).referenceNo === "string"
      ? String((req.body as any).referenceNo).trim()
      : "";

    if (requestedRef.length > 80) {
      res.status(400).json({ error: "Invalid referenceNo" });
      return;
    }

    const refNo = requestedRef || `LCP-${req.firmId}-${Date.now()}`;

    const insertCaseBase = {
      firmId: req.firmId!,
      projectId,
      developerId,
      referenceNo: refNo,
      purchaseMode,
      titleType,
      spaPrice: spaPrice ? String(spaPrice) : null,
      status: "File Opened / SPA Pending Signing",
      caseType: caseType ?? null,
      parcelNo: parcelNo ?? null,
      spaDetails: spaDetails ? JSON.stringify(spaDetails) : null,
      propertyDetails: propertyDetails ? JSON.stringify(propertyDetails) : null,
      loanDetails: loanDetails ? JSON.stringify(loanDetails) : null,
      companyDetails: companyDetails ? JSON.stringify(companyDetails) : null,
    };

    let ctxFirmId: string | null = null;
    let ctxIsFounder: string | null = null;
    try {
      const result = await r.execute(sql`
        select
          current_setting('app.current_firm_id', true) as firm_id,
          current_setting('app.is_founder', true) as is_founder
      `);
      const rows = Array.isArray(result)
        ? result
        : ("rows" in (result as any) ? (result as any).rows : []);
      const row = rows?.[0] as any;
      ctxFirmId = typeof row?.firm_id === "string" ? row.firm_id : null;
      ctxIsFounder = typeof row?.is_founder === "string" ? row.is_founder : null;
    } catch {
    }
    (req as any).log?.info?.({
      route: "POST /api/cases",
      userId: req.userId,
      firmId: req.firmId,
      insertFirmId: insertCaseBase.firmId,
      ctxFirmId,
      ctxIsFounder,
    }, "create route tenant context");

    let newCase: typeof casesTable.$inferSelect;
    [newCase] = await r
      .insert(casesTable)
      .values(insertCaseBase as any)
      .returning();

    try {
      await r
        .update(casesTable)
        .set({ createdBy: req.userId } as any)
        .where(and(eq(casesTable.id, newCase.id), eq(casesTable.firmId, req.firmId!)));
    } catch {
    }

    for (let i = 0; i < resolvedPurchaserIds.length; i++) {
      await r.insert(casePurchasersTable).values({
        caseId: newCase.id,
        clientId: resolvedPurchaserIds[i],
        role: i === 0 ? "main" : "joint",
        orderNo: i + 1,
      });
    }

    await r.insert(caseAssignmentsTable).values({
      caseId: newCase.id,
      userId: assignedLawyerId,
      roleInCase: "lawyer",
      assignedBy: req.userId,
    });

    if (assignedClerkId) {
      await r.insert(caseAssignmentsTable).values({
        caseId: newCase.id,
        userId: assignedClerkId,
        roleInCase: "clerk",
        assignedBy: req.userId,
      });
    }

    const workflowSteps = buildWorkflowSteps(purchaseMode, titleType);
    if (workflowSteps.length > 0) {
      await r.insert(caseWorkflowStepsTable).values(
        workflowSteps.map((s) => ({
          caseId: newCase.id,
          stepKey: s.stepKey,
          stepName: s.stepName,
          stepOrder: s.stepOrder,
          pathType: s.pathType,
          status: "pending",
        }))
      );
    }

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: "firm_user",
      action: "cases.create",
      entityType: "case",
      entityId: newCase.id,
      detail: `referenceNo=${refNo} purchasersCreated=${purchasersCreated} purchasersReused=${purchasersReused}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const detail = await formatCaseDetail(r, newCase);
    res.status(201).json({ ...detail, purchasersCreated, purchasersReused });
    return;
  } catch (e) {
    const pg = (() => {
      let cur: any = e;
      for (let i = 0; i < 6 && cur; i++) {
        if (typeof cur?.code === "string" || typeof cur?.message === "string" || typeof cur?.detail === "string" || typeof cur?.constraint === "string") {
          const code = typeof cur.code === "string" ? cur.code : undefined;
          const message = typeof cur.message === "string" ? cur.message : undefined;
          const detail = typeof cur.detail === "string" ? cur.detail : undefined;
          const constraint = typeof cur.constraint === "string" ? cur.constraint : undefined;
          return { code, message, detail, constraint };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    (req as any).log?.error?.({ err: e, pg }, "cases.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/cases/:caseId", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = GetCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [c] = await r
    .select()
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  res.json(await formatCaseDetail(r, c));
});

router.get("/cases/:caseId/key-dates", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = GetCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const [kd] = await r
    .select()
    .from(caseKeyDatesTable)
    .where(and(eq(caseKeyDatesTable.caseId, params.data.caseId), eq(caseKeyDatesTable.firmId, req.firmId!)));
  const out: Record<string, unknown> = kd ? {
    spa_signed_date: kd.spaSignedDate ? String(kd.spaSignedDate) : null,
    spa_forward_to_developer_execution_on: kd.spaForwardToDeveloperExecutionOn ? String(kd.spaForwardToDeveloperExecutionOn) : null,
    spa_date: kd.spaDate ? String(kd.spaDate) : null,
    spa_stamped_date: kd.spaStampedDate ? String(kd.spaStampedDate) : null,
    stamped_spa_send_to_developer_on: kd.stampedSpaSendToDeveloperOn ? String(kd.stampedSpaSendToDeveloperOn) : null,
    stamped_spa_received_from_developer_on: kd.stampedSpaReceivedFromDeveloperOn ? String(kd.stampedSpaReceivedFromDeveloperOn) : null,
    letter_of_offer_date: kd.letterOfOfferDate ? String(kd.letterOfOfferDate) : null,
    letter_of_offer_stamped_date: kd.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
    loan_docs_pending_date: kd.loanDocsPendingDate ? String(kd.loanDocsPendingDate) : null,
    loan_docs_signed_date: kd.loanDocsSignedDate ? String(kd.loanDocsSignedDate) : null,
    acting_letter_issued_date: kd.actingLetterIssuedDate ? String(kd.actingLetterIssuedDate) : null,
    developer_confirmation_received_on: kd.developerConfirmationReceivedOn ? String(kd.developerConfirmationReceivedOn) : null,
    developer_confirmation_date: kd.developerConfirmationDate ? String(kd.developerConfirmationDate) : null,
    loan_sent_bank_execution_date: kd.loanSentBankExecutionDate ? String(kd.loanSentBankExecutionDate) : null,
    loan_bank_executed_date: kd.loanBankExecutedDate ? String(kd.loanBankExecutedDate) : null,
    bank_lu_received_date: kd.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
    bank_lu_forward_to_developer_on: kd.bankLuForwardToDeveloperOn ? String(kd.bankLuForwardToDeveloperOn) : null,
    developer_lu_received_on: kd.developerLuReceivedOn ? String(kd.developerLuReceivedOn) : null,
    developer_lu_dated: kd.developerLuDated ? String(kd.developerLuDated) : null,
    letter_disclaimer_received_on: kd.letterDisclaimerReceivedOn ? String(kd.letterDisclaimerReceivedOn) : null,
    letter_disclaimer_dated: kd.letterDisclaimerDated ? String(kd.letterDisclaimerDated) : null,
    letter_disclaimer_reference_nos: kd.letterDisclaimerReferenceNos ?? null,
    redemption_sum: kd.redemptionSum ? Number(kd.redemptionSum) : null,
    loan_agreement_dated: kd.loanAgreementDated ? String(kd.loanAgreementDated) : null,
    loan_agreement_submitted_stamping_date: kd.loanAgreementSubmittedStampingDate ? String(kd.loanAgreementSubmittedStampingDate) : null,
    loan_agreement_stamped_date: kd.loanAgreementStampedDate ? String(kd.loanAgreementStampedDate) : null,
    register_poa_on: kd.registerPoaOn ? String(kd.registerPoaOn) : null,
    registered_poa_registration_number: kd.registeredPoaRegistrationNumber ?? null,
    noa_served_on: kd.noaServedOn ? String(kd.noaServedOn) : null,
    advice_to_bank_date: kd.adviceToBankDate ? String(kd.adviceToBankDate) : null,
    bank_1st_release_on: kd.bank1stReleaseOn ? String(kd.bank1stReleaseOn) : null,
    first_release_amount_rm: kd.firstReleaseAmountRm ? Number(kd.firstReleaseAmountRm) : null,
    mot_received_date: kd.motReceivedDate ? String(kd.motReceivedDate) : null,
    mot_signed_date: kd.motSignedDate ? String(kd.motSignedDate) : null,
    mot_stamped_date: kd.motStampedDate ? String(kd.motStampedDate) : null,
    mot_registered_date: kd.motRegisteredDate ? String(kd.motRegisteredDate) : null,
    progressive_payment_date: kd.progressivePaymentDate ? String(kd.progressivePaymentDate) : null,
    full_settlement_date: kd.fullSettlementDate ? String(kd.fullSettlementDate) : null,
    completion_date: kd.completionDate ? String(kd.completionDate) : null,
  } : {};

  const workflowSteps = await r
    .select({ stepKey: caseWorkflowStepsTable.stepKey, status: caseWorkflowStepsTable.status, completedAt: caseWorkflowStepsTable.completedAt })
    .from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, params.data.caseId));
  const workflowCompletedAtByKey = new Map<string, Date>();
  for (const s of workflowSteps) {
    if (s.status === "completed" && s.completedAt) workflowCompletedAtByKey.set(s.stepKey, s.completedAt);
  }

  const keyDateFields = Object.keys(KEY_DATE_FIELD_TO_STEP_KEY) as KeyDateField[];
  for (const f of keyDateFields) {
    if (!Object.prototype.hasOwnProperty.call(out, f) || out[f] === null || out[f] === undefined || out[f] === "") {
      const stepKey = KEY_DATE_FIELD_TO_STEP_KEY[f];
      const d = workflowCompletedAtByKey.get(stepKey);
      if (d) out[f] = dateToYmd(d);
    }
  }

  res.json(out);
});

router.patch("/cases/:caseId/key-dates", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = UpdateCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;

  const dateFieldMap = {
    spa_signed_date: "spaSignedDate",
    spa_forward_to_developer_execution_on: "spaForwardToDeveloperExecutionOn",
    spa_date: "spaDate",
    spa_stamped_date: "spaStampedDate",
    stamped_spa_send_to_developer_on: "stampedSpaSendToDeveloperOn",
    stamped_spa_received_from_developer_on: "stampedSpaReceivedFromDeveloperOn",
    letter_of_offer_date: "letterOfOfferDate",
    letter_of_offer_stamped_date: "letterOfOfferStampedDate",
    loan_docs_pending_date: "loanDocsPendingDate",
    loan_docs_signed_date: "loanDocsSignedDate",
    acting_letter_issued_date: "actingLetterIssuedDate",
    developer_confirmation_received_on: "developerConfirmationReceivedOn",
    developer_confirmation_date: "developerConfirmationDate",
    loan_sent_bank_execution_date: "loanSentBankExecutionDate",
    loan_bank_executed_date: "loanBankExecutedDate",
    bank_lu_received_date: "bankLuReceivedDate",
    bank_lu_forward_to_developer_on: "bankLuForwardToDeveloperOn",
    developer_lu_received_on: "developerLuReceivedOn",
    developer_lu_dated: "developerLuDated",
    letter_disclaimer_received_on: "letterDisclaimerReceivedOn",
    letter_disclaimer_dated: "letterDisclaimerDated",
    loan_agreement_dated: "loanAgreementDated",
    loan_agreement_submitted_stamping_date: "loanAgreementSubmittedStampingDate",
    loan_agreement_stamped_date: "loanAgreementStampedDate",
    register_poa_on: "registerPoaOn",
    noa_served_on: "noaServedOn",
    advice_to_bank_date: "adviceToBankDate",
    bank_1st_release_on: "bank1stReleaseOn",
    mot_received_date: "motReceivedDate",
    mot_signed_date: "motSignedDate",
    mot_stamped_date: "motStampedDate",
    mot_registered_date: "motRegisteredDate",
    progressive_payment_date: "progressivePaymentDate",
    full_settlement_date: "fullSettlementDate",
    completion_date: "completionDate",
  } as const;

  type DateColKey = (typeof dateFieldMap)[keyof typeof dateFieldMap];
  type DateColValue = CaseKeyDatesInsert[DateColKey];
  const setDateCol = (target: Partial<CaseKeyDatesInsert>, key: DateColKey, value: DateColValue) => {
    (target as Partial<Record<DateColKey, DateColValue>>)[key] = value;
  };

  const insertValues: CaseKeyDatesInsert = { firmId: req.firmId!, caseId: params.data.caseId };
  const updateValues: Partial<CaseKeyDatesInsert> & { updatedAt: Date } = { updatedAt: new Date() };

  const changed: string[] = [];
  const providedKeyDateForWorkflowSync: Array<{ keyDateField: KeyDateField; ymd: string }> = [];
  const apiKeys = Object.keys(dateFieldMap) as Array<keyof typeof dateFieldMap>;
  for (const apiKey of apiKeys) {
    if (!Object.prototype.hasOwnProperty.call(body, apiKey)) continue;
    const parsed = parseDateOnlyInput(body[apiKey]);
    if (parsed === undefined) {
      res.status(400).json({ error: `Invalid ${apiKey}` });
      return;
    }
    const colKey = dateFieldMap[apiKey] as DateColKey;
    setDateCol(insertValues, colKey, parsed as DateColValue);
    setDateCol(updateValues, colKey, parsed as DateColValue);
    if (typeof parsed === "string") {
      const k = String(apiKey);
      if (Object.prototype.hasOwnProperty.call(KEY_DATE_FIELD_TO_STEP_KEY, k)) {
        providedKeyDateForWorkflowSync.push({ keyDateField: k as KeyDateField, ymd: parsed });
      }
    }
    changed.push(String(apiKey));
  }

  if (Object.prototype.hasOwnProperty.call(body, "letter_disclaimer_reference_nos")) {
    const v = body.letter_disclaimer_reference_nos;
    if (v === null) {
      insertValues.letterDisclaimerReferenceNos = null;
      updateValues.letterDisclaimerReferenceNos = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim() || null;
      insertValues.letterDisclaimerReferenceNos = trimmed;
      updateValues.letterDisclaimerReferenceNos = trimmed;
    }
    else {
      res.status(400).json({ error: "Invalid letter_disclaimer_reference_nos" });
      return;
    }
    changed.push("letter_disclaimer_reference_nos");
  }

  const redemptionSum = parseMoneyInput(body.redemption_sum);
  if (redemptionSum === undefined && Object.prototype.hasOwnProperty.call(body, "redemption_sum")) {
    res.status(400).json({ error: "Invalid redemption_sum" });
    return;
  }
  if (redemptionSum !== undefined) {
    insertValues.redemptionSum = redemptionSum;
    updateValues.redemptionSum = redemptionSum;
    changed.push("redemption_sum");
  }
  const firstRelease = parseMoneyInput(body.first_release_amount_rm);
  if (firstRelease === undefined && Object.prototype.hasOwnProperty.call(body, "first_release_amount_rm")) {
    res.status(400).json({ error: "Invalid first_release_amount_rm" });
    return;
  }
  if (firstRelease !== undefined) {
    insertValues.firstReleaseAmountRm = firstRelease;
    updateValues.firstReleaseAmountRm = firstRelease;
    changed.push("first_release_amount_rm");
  }

  if (Object.prototype.hasOwnProperty.call(body, "registered_poa_registration_number")) {
    const v = body.registered_poa_registration_number;
    if (v === null) {
      insertValues.registeredPoaRegistrationNumber = null;
      updateValues.registeredPoaRegistrationNumber = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim() || null;
      insertValues.registeredPoaRegistrationNumber = trimmed;
      updateValues.registeredPoaRegistrationNumber = trimmed;
    }
    else {
      res.status(400).json({ error: "Invalid registered_poa_registration_number" });
      return;
    }
    changed.push("registered_poa_registration_number");
  }

  const existing = await r
    .select({ id: caseKeyDatesTable.id })
    .from(caseKeyDatesTable)
    .where(and(eq(caseKeyDatesTable.caseId, params.data.caseId), eq(caseKeyDatesTable.firmId, req.firmId!)));

  let kd: any;
  if (existing[0]) {
    const [updated] = await r
      .update(caseKeyDatesTable)
      .set(updateValues)
      .where(and(eq(caseKeyDatesTable.caseId, params.data.caseId), eq(caseKeyDatesTable.firmId, req.firmId!)))
      .returning();
    kd = updated;
  } else {
    const [inserted] = await r
      .insert(caseKeyDatesTable)
      .values(insertValues)
      .returning();
    kd = inserted;
  }

  await r.insert(auditLogsTable).values({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "case.key_dates.updated",
    entityType: "case",
    entityId: params.data.caseId,
    detail: JSON.stringify(changed),
  });

  const workflowRows = await r
    .select({
      id: caseWorkflowStepsTable.id,
      stepKey: caseWorkflowStepsTable.stepKey,
      stepName: caseWorkflowStepsTable.stepName,
      status: caseWorkflowStepsTable.status,
      completedAt: caseWorkflowStepsTable.completedAt,
    })
    .from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, params.data.caseId));
  const workflowByKey = new Map<string, { id: number; stepKey: string; stepName: string; status: string; completedAt: Date | null }>();
  for (const s of workflowRows) {
    workflowByKey.set(s.stepKey, { id: s.id, stepKey: s.stepKey, stepName: s.stepName, status: s.status, completedAt: s.completedAt ?? null });
  }

  const syncedWorkflowSteps: string[] = [];
  const missingWorkflowSteps: string[] = [];
  for (const item of providedKeyDateForWorkflowSync) {
    const stepKey = KEY_DATE_FIELD_TO_STEP_KEY[item.keyDateField];
    const step = workflowByKey.get(stepKey);
    if (!step) {
      missingWorkflowSteps.push(stepKey);
      continue;
    }
    if (step.status === "completed" && step.completedAt) continue;
    const completedAt = ymdToUtcDate(item.ymd);
    const [updatedStep] = await r
      .update(caseWorkflowStepsTable)
      .set({
        status: "completed",
        completedBy: req.userId,
        completedAt: step.completedAt ?? completedAt,
        updatedAt: new Date(),
      })
      .where(and(eq(caseWorkflowStepsTable.id, step.id), eq(caseWorkflowStepsTable.caseId, params.data.caseId)))
      .returning();
    if (updatedStep) {
      syncedWorkflowSteps.push(stepKey);
      await r.insert(auditLogsTable).values({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: "firm_user",
        action: "workflow.step_synced_from_key_date",
        entityType: "case_workflow_step",
        entityId: updatedStep.id,
        detail: JSON.stringify({ keyDateField: item.keyDateField, stepKey, ymd: item.ymd }),
      });
    }
  }

  res.json(kd ? {
    spa_signed_date: kd.spaSignedDate ? String(kd.spaSignedDate) : null,
    spa_forward_to_developer_execution_on: kd.spaForwardToDeveloperExecutionOn ? String(kd.spaForwardToDeveloperExecutionOn) : null,
    spa_date: kd.spaDate ? String(kd.spaDate) : null,
    spa_stamped_date: kd.spaStampedDate ? String(kd.spaStampedDate) : null,
    stamped_spa_send_to_developer_on: kd.stampedSpaSendToDeveloperOn ? String(kd.stampedSpaSendToDeveloperOn) : null,
    stamped_spa_received_from_developer_on: kd.stampedSpaReceivedFromDeveloperOn ? String(kd.stampedSpaReceivedFromDeveloperOn) : null,
    letter_of_offer_date: kd.letterOfOfferDate ? String(kd.letterOfOfferDate) : null,
    letter_of_offer_stamped_date: kd.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
    loan_docs_pending_date: kd.loanDocsPendingDate ? String(kd.loanDocsPendingDate) : null,
    loan_docs_signed_date: kd.loanDocsSignedDate ? String(kd.loanDocsSignedDate) : null,
    acting_letter_issued_date: kd.actingLetterIssuedDate ? String(kd.actingLetterIssuedDate) : null,
    developer_confirmation_received_on: kd.developerConfirmationReceivedOn ? String(kd.developerConfirmationReceivedOn) : null,
    developer_confirmation_date: kd.developerConfirmationDate ? String(kd.developerConfirmationDate) : null,
    loan_sent_bank_execution_date: kd.loanSentBankExecutionDate ? String(kd.loanSentBankExecutionDate) : null,
    loan_bank_executed_date: kd.loanBankExecutedDate ? String(kd.loanBankExecutedDate) : null,
    bank_lu_received_date: kd.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
    bank_lu_forward_to_developer_on: kd.bankLuForwardToDeveloperOn ? String(kd.bankLuForwardToDeveloperOn) : null,
    developer_lu_received_on: kd.developerLuReceivedOn ? String(kd.developerLuReceivedOn) : null,
    developer_lu_dated: kd.developerLuDated ? String(kd.developerLuDated) : null,
    letter_disclaimer_received_on: kd.letterDisclaimerReceivedOn ? String(kd.letterDisclaimerReceivedOn) : null,
    letter_disclaimer_dated: kd.letterDisclaimerDated ? String(kd.letterDisclaimerDated) : null,
    letter_disclaimer_reference_nos: kd.letterDisclaimerReferenceNos ?? null,
    redemption_sum: kd.redemptionSum ? Number(kd.redemptionSum) : null,
    loan_agreement_dated: kd.loanAgreementDated ? String(kd.loanAgreementDated) : null,
    loan_agreement_submitted_stamping_date: kd.loanAgreementSubmittedStampingDate ? String(kd.loanAgreementSubmittedStampingDate) : null,
    loan_agreement_stamped_date: kd.loanAgreementStampedDate ? String(kd.loanAgreementStampedDate) : null,
    register_poa_on: kd.registerPoaOn ? String(kd.registerPoaOn) : null,
    registered_poa_registration_number: kd.registeredPoaRegistrationNumber ?? null,
    noa_served_on: kd.noaServedOn ? String(kd.noaServedOn) : null,
    advice_to_bank_date: kd.adviceToBankDate ? String(kd.adviceToBankDate) : null,
    bank_1st_release_on: kd.bank1stReleaseOn ? String(kd.bank1stReleaseOn) : null,
    first_release_amount_rm: kd.firstReleaseAmountRm ? Number(kd.firstReleaseAmountRm) : null,
    mot_received_date: kd.motReceivedDate ? String(kd.motReceivedDate) : null,
    mot_signed_date: kd.motSignedDate ? String(kd.motSignedDate) : null,
    mot_stamped_date: kd.motStampedDate ? String(kd.motStampedDate) : null,
    mot_registered_date: kd.motRegisteredDate ? String(kd.motRegisteredDate) : null,
    progressive_payment_date: kd.progressivePaymentDate ? String(kd.progressivePaymentDate) : null,
    full_settlement_date: kd.fullSettlementDate ? String(kd.fullSettlementDate) : null,
    completion_date: kd.completionDate ? String(kd.completionDate) : null,
    synced_workflow_steps: syncedWorkflowSteps,
    missing_workflow_steps: missingWorkflowSteps,
  } : { synced_workflow_steps: syncedWorkflowSteps, missing_workflow_steps: missingWorkflowSteps });
});

router.patch("/cases/:caseId", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = UpdateCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.purchaseMode !== undefined) updates.purchaseMode = parsed.data.purchaseMode;
  if (parsed.data.titleType !== undefined) updates.titleType = parsed.data.titleType;
  if (parsed.data.spaPrice !== undefined) updates.spaPrice = String(parsed.data.spaPrice);

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  if (parsed.data.assignedLawyerId !== undefined) {
    await r.update(caseAssignmentsTable)
      .set({ unassignedAt: new Date() })
      .where(and(eq(caseAssignmentsTable.caseId, params.data.caseId), eq(caseAssignmentsTable.roleInCase, "lawyer"), sql`unassigned_at IS NULL`));
    await r.insert(caseAssignmentsTable).values({
      caseId: params.data.caseId,
      userId: parsed.data.assignedLawyerId,
      roleInCase: "lawyer",
      assignedBy: req.userId,
    });
  }

  const [c] = await r
    .update(casesTable)
    .set(updates)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
    .returning();

  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  await r.insert(auditLogsTable).values({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "case.updated",
    entityType: "case",
    entityId: c.id,
    detail: JSON.stringify(updates),
  });

  res.json(await formatCaseDetail(r, c));
});

router.get("/cases/:caseId/workflow", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = GetCaseWorkflowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const steps = await r.select().from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, params.data.caseId))
    .orderBy(caseWorkflowStepsTable.stepOrder);

  const enriched = await Promise.all(
    steps.map(async (s) => {
      let completedByName: string | null = null;
      if (s.completedBy) {
        const [user] = await r.select().from(usersTable).where(eq(usersTable.id, s.completedBy));
        completedByName = user?.name ?? null;
      }
      return {
        id: s.id,
        caseId: s.caseId,
        stepKey: s.stepKey,
        stepName: s.stepName,
        stepOrder: s.stepOrder,
        status: s.status,
        pathType: s.pathType,
        completedBy: s.completedBy ?? null,
        completedByName,
        completedAt: s.completedAt?.toISOString() ?? null,
        notes: s.notes ?? null,
      };
    })
  );

  res.json(enriched);
});

router.patch("/cases/:caseId/workflow/:stepId", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = UpdateWorkflowStepParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateWorkflowStepBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.status !== undefined) {
    updates.status = parsed.data.status;
    if (parsed.data.status === "completed") {
      updates.completedBy = req.userId;
      updates.completedAt = new Date();
    }
  }
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const [step] = await r
    .update(caseWorkflowStepsTable)
    .set(updates)
    .where(and(eq(caseWorkflowStepsTable.id, params.data.stepId), eq(caseWorkflowStepsTable.caseId, params.data.caseId)))
    .returning();

  if (!step) {
    res.status(404).json({ error: "Workflow step not found" });
    return;
  }

  await r.insert(auditLogsTable).values({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "workflow.step_updated",
    entityType: "case_workflow_step",
    entityId: step.id,
    detail: `Step ${step.stepName} -> ${step.status}`,
  });

  let syncedKeyDateField: KeyDateField | null = null;
  if (step.status === "completed" && step.completedAt) {
    const mapped = WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD[step.stepKey];
    if (mapped) {
      const [existingKd] = await r
        .select()
        .from(caseKeyDatesTable)
        .where(and(eq(caseKeyDatesTable.caseId, params.data.caseId), eq(caseKeyDatesTable.firmId, req.firmId!)));
      if (shouldBackfillKeyDate(mapped, existingKd ?? null)) {
        const ymd = dateToYmd(step.completedAt);
        if (existingKd) {
          await r
            .update(caseKeyDatesTable)
            .set({ ...keyDatePatchFromWorkflow(mapped, ymd), updatedAt: new Date() })
            .where(and(eq(caseKeyDatesTable.caseId, params.data.caseId), eq(caseKeyDatesTable.firmId, req.firmId!)));
        } else {
          await r
            .insert(caseKeyDatesTable)
            .values({ firmId: req.firmId!, caseId: params.data.caseId, ...keyDatePatchFromWorkflow(mapped, ymd) });
        }
        syncedKeyDateField = mapped;
        await r.insert(auditLogsTable).values({
          firmId: req.firmId,
          actorId: req.userId,
          actorType: "firm_user",
          action: "case.key_date_synced_from_workflow",
          entityType: "case",
          entityId: params.data.caseId,
          detail: JSON.stringify({ stepKey: step.stepKey, keyDateField: mapped, ymd }),
        });
      }
    }
  }

  let completedByName: string | null = null;
  if (step.completedBy) {
    const [user] = await r.select().from(usersTable).where(eq(usersTable.id, step.completedBy));
    completedByName = user?.name ?? null;
  }

  res.json({
    id: step.id,
    caseId: step.caseId,
    stepKey: step.stepKey,
    stepName: step.stepName,
    stepOrder: step.stepOrder,
    status: step.status,
    pathType: step.pathType,
    completedBy: step.completedBy ?? null,
    completedByName,
    completedAt: step.completedAt?.toISOString() ?? null,
    notes: step.notes ?? null,
    syncedKeyDateField,
  });
});

router.get("/cases/:caseId/notes", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = GetCaseNotesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const notes = await r.select().from(caseNotesTable)
    .where(eq(caseNotesTable.caseId, params.data.caseId))
    .orderBy(desc(caseNotesTable.createdAt));

  const enriched = await Promise.all(
    notes.map(async (n) => {
      const [author] = await r.select().from(usersTable).where(eq(usersTable.id, n.authorId));
      return {
        id: n.id,
        caseId: n.caseId,
        authorId: n.authorId,
        authorName: author?.name ?? "Unknown",
        content: n.content,
        createdAt: n.createdAt.toISOString(),
      };
    })
  );

  res.json(enriched);
});

router.post("/cases/:caseId/notes", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = CreateCaseNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = CreateCaseNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const [note] = await r
    .insert(caseNotesTable)
    .values({
      caseId: params.data.caseId,
      authorId: req.userId!,
      content: parsed.data.content,
    })
    .returning();

  const [author] = await r.select().from(usersTable).where(eq(usersTable.id, note.authorId));

  res.status(201).json({
    id: note.id,
    caseId: note.caseId,
    authorId: note.authorId,
    authorName: author?.name ?? "Unknown",
    content: note.content,
    createdAt: note.createdAt.toISOString(),
  });
});

export default router;
