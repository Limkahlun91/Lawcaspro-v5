import express, {
  type NextFunction,
  type RequestHandler,
  type Response as ExpressResponse,
  type Router as ExpressRouter,
} from "express";
import { eq, count, desc, and, or, asc, inArray } from "drizzle-orm";
import {
  db, casesTable, casePurchasersTable, caseAssignmentsTable,
  caseWorkflowStepsTable, caseNotesTable, caseMessagesTable, caseMessageReadStatusTable,
  caseKeyDatesTable,
  caseWorkflowDocumentsTable,
  caseLoanStampingItemsTable,
  caseListSavedViewsTable,
  caseLedgersTable,
  projectsTable, developersTable, clientsTable, usersTable, rolesTable, auditLogsTable,
  permissionsTable,
  sql,
} from "@workspace/db";
import {
  CreateCaseBody, UpdateCaseBody, ListCasesQueryParams,
  GetCaseParams, UpdateCaseParams,
  GetCaseWorkflowParams, UpdateWorkflowStepParams, UpdateWorkflowStepBody,
  GetCaseNotesParams, CreateCaseNoteParams, CreateCaseNoteBody
} from "@workspace/api-zod";
import { z } from "zod/v4";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { buildWorkflowSteps } from "../lib/workflow.js";
import { KEY_DATE_FIELD_TO_STEP_KEY, WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD, type KeyDateField } from "../lib/keyDatesWorkflow.js";
import { loanStatusSql, milestoneDateSql, milestoneDateYmdSql, milestonePresenceWhereSql, spaStatusSql, type CaseMilestoneKey, type MilestonePresence } from "../lib/caseListLogic.js";
import { daysAgoSql } from "../lib/dateSql.js";
import { parseDateOnlyInput } from "../lib/dateOnly.js";
import { logger } from "../lib/logger.js";
import { isTransientDbConnectionError } from "../lib/auth-safe-db.js";
import { ObjectNotFoundError, SupabaseStorageService, getSupabaseStorageConfigError } from "../lib/objectStorage.js";
import { CASE_ATTACHMENT_ALLOWED_EXTENSIONS, WORKFLOW_DOCUMENT_ALLOWED_KEYS, fileExtLower, workflowDocumentLabel, workflowDocumentLegacyKeys, normalizeWorkflowDocumentKeyFromDb, type WorkflowDocumentMilestoneKey } from "../lib/caseWorkflowDocuments.js";
import { LOAN_STAMPING_ITEM_KEYS, type LoanStampingItemKey, isLoanStampingItemKeyAllowedForTitleType, normalizeTitleType } from "../lib/loanStamping.js";
import { ensureCaseWorkflowSteps, syncWorkflowStepsFromCaseState } from "../lib/workflowAutomationService.js";
import { WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY, deriveStatusFromRequirement } from "../lib/workflowAutomation.js";
import { computeStampingSummary, deriveStampingItemStatus, type StampingItemInput } from "../lib/stampingProgress.js";
import { resolveSmartFilename } from "../lib/smartFileNaming.js";

const router: ExpressRouter = express.Router();
const supabaseStorage = new SupabaseStorageService();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

type CaseKeyDatesInsert = typeof caseKeyDatesTable.$inferInsert;

const GetCaseMessagesParams = z.object({ caseId: z.coerce.number().int().positive() });
const CaseMessageChannel = z.enum(["client", "developer"]);
const CreateCaseMessageBody = z.object({
  channel: CaseMessageChannel.optional(),
  messageText: z.string().trim().min(1).max(2000),
  attachments: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
});

const GetCaseLedgerParams = z.object({ caseId: z.coerce.number().int().positive() });
const CreateCaseLedgerBody = z.object({
  transactionDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  entryCategory: z.enum(["office", "client"]),
  entryType: z.enum(["invoice_billed", "payment_received", "disbursement_paid", "trust_received", "trust_paid"]),
  description: z.string().trim().min(1).max(2000),
  amount: z.number().finite(),
});

async function hasRolePermission(
  r: DbConn,
  firmId: number,
  roleId: number | null | undefined,
  module: string,
  action: string,
): Promise<boolean> {
  if (!roleId) return false;
  const [role] = await r
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)));
  if (!role) return false;
  const [perm] = await r
    .select({ allowed: permissionsTable.allowed })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, roleId),
      eq(permissionsTable.module, module),
      eq(permissionsTable.action, action),
    ));
  return Boolean(perm?.allowed);
}

async function enforcePermission(req: AuthRequest, res: ExpressResponse, module: string, action: string): Promise<boolean> {
  let ok = false;
  const mw = requirePermission(module, action) as unknown as RequestHandler;
  await (mw as any)(req, res, () => { ok = true; });
  return ok;
}

async function getRoleName(r: DbConn, firmId: number, roleId: number | null | undefined): Promise<string> {
  if (!roleId) return "";
  const [row] = await r
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)))
    .limit(1);
  return typeof row?.name === "string" ? row.name : "";
}

async function canBypassCaseAssignment(r: DbConn, firmId: number, roleId: number | null | undefined): Promise<boolean> {
  const canAssignAny = await hasRolePermission(r, firmId, roleId, "cases", "assign_any");
  if (canAssignAny) return true;
  const roleName = await getRoleName(r, firmId, roleId);
  const rn = roleName.toLowerCase();
  return rn.includes("partner") || rn.includes("manager");
}

async function enforceCaseAccess(r: DbConn, req: AuthRequest, res: ExpressResponse, caseId: number): Promise<boolean> {
  const firmId = req.firmId;
  if (!firmId || !req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)))
    .limit(1);
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return false;
  }

  const elevated = await canBypassCaseAssignment(r, firmId, req.roleId);
  if (elevated) return true;

  const [assigned] = await r
    .select({ id: caseAssignmentsTable.id })
    .from(caseAssignmentsTable)
    .where(and(
      eq(caseAssignmentsTable.caseId, caseId),
      eq(caseAssignmentsTable.userId, req.userId),
      inArray(caseAssignmentsTable.roleInCase, ["lawyer", "clerk"]),
      sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
    ))
    .limit(1);
  if (assigned) return true;

  await writeAuditLog({
    firmId,
    actorId: req.userId,
    actorType: req.userType ?? "firm_user",
    action: "auth.forbidden.case_access_denied",
    entityType: "case",
    entityId: caseId,
    detail: "not_assigned",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });

  res.status(403).json({ error: "Forbidden" });
  return false;
}

type AuthedHandler = (
  req: AuthRequest,
  res: ExpressResponse,
  next: NextFunction
) => void | Promise<void>;

const requireAuthHandler = requireAuth as RequestHandler;
const requireFirmUserHandler = requireFirmUser as RequestHandler;

const authed = (handler: AuthedHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(handler(req as AuthRequest, res as ExpressResponse, next)).catch(next);
  };
};

async function tableExists(r: DbConn, reg: string): Promise<boolean> {
  const result = await r.execute(sql`SELECT to_regclass(${reg}) AS reg`);
  const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : ("rows" in result ? (result as { rows: Record<string, unknown>[] }).rows : []);
  return Boolean(rows[0]?.reg);
}

const one = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
};

function safeFilenameAscii(filename: string): string {
  const base = filename.replace(/[\r\n"]/g, "").trim();
  if (!base) return "download";
  return base.replace(/[^\x20-\x7E]/g, "_");
}

async function buildSmartNamingContext(r: DbConn, firmId: number, caseId: number): Promise<{
  referenceNo: string;
  parcelNo: string | null;
  status: string;
  titleType: string;
  projectName: string;
  developerName: string;
  clientName: string;
  borrowerNames: string;
  loanBank: string;
}> {
  const fallback = {
    referenceNo: "",
    parcelNo: null,
    status: "",
    titleType: "",
    projectName: "",
    developerName: "",
    clientName: "",
    borrowerNames: "",
    loanBank: "",
  };

  try {
    const [hasCases, hasProjects, hasDevelopers] = await Promise.all([
      tableExists(r, "public.cases"),
      tableExists(r, "public.projects"),
      tableExists(r, "public.developers"),
    ]);
    const baseExists = hasCases && hasProjects && hasDevelopers;
    if (!baseExists) return fallback;

    const basePromise = r
      .select({
        referenceNo: casesTable.referenceNo,
        parcelNo: casesTable.parcelNo,
        status: casesTable.status,
        titleType: casesTable.titleType,
        projectName: projectsTable.name,
        developerName: developersTable.name,
        loanDetails: casesTable.loanDetails,
        loanPartyType: casesTable.loanPartyType,
        borrowers: casesTable.borrowers,
      })
      .from(casesTable)
      .innerJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
      .innerJoin(developersTable, eq(developersTable.id, casesTable.developerId))
      .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)));

    const purchaserExistsPromise = Promise.all([
      tableExists(r, "public.case_purchasers"),
      tableExists(r, "public.clients"),
    ]).then(([hasCasePurchasers, hasClients]) => hasCasePurchasers && hasClients);

    const [baseRows, purchaserExists] = await Promise.all([basePromise, purchaserExistsPromise]);
    const base = baseRows[0];
    const purchaserNames = purchaserExists
      ? await r
          .select({ name: clientsTable.name })
          .from(casePurchasersTable)
          .innerJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
          .where(and(eq(casePurchasersTable.caseId, caseId)))
          .orderBy(asc(casePurchasersTable.orderNo))
          .limit(20)
      : [];
    const purchaserNameList = purchaserNames.map((x) => String(x.name ?? "").trim()).filter(Boolean);
    const [purchaser] = purchaserNameList.length > 0
      ? [{ name: purchaserNameList[0] }]
      : [undefined];

    const borrowerNames = (() => {
      const partyType = String((base as any)?.loanPartyType ?? "");
      if (partyType === "1st_party") return purchaserNameList.join(", ");
      const fromColumn = (base as any)?.borrowers;
      if (Array.isArray(fromColumn)) {
        return fromColumn.map((b: any) => (typeof b?.name === "string" ? b.name.trim() : "")).filter(Boolean).join(", ");
      }
      const raw = base?.loanDetails ? String(base.loanDetails) : "";
      if (!raw) return "";
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const b1 = typeof (obj as any)?.borrower1Name === "string" ? String((obj as any).borrower1Name).trim() : "";
        const b2 = typeof (obj as any)?.borrower2Name === "string" ? String((obj as any).borrower2Name).trim() : "";
        return [b1, b2].filter(Boolean).join(", ");
      } catch {
        return "";
      }
    })();

    const loanBank = (() => {
      const raw = base?.loanDetails ? String(base.loanDetails) : "";
      if (!raw) return "";
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const v = obj["end_financier"] ?? obj["endFinancier"] ?? obj["bank"] ?? obj["financier"];
        return v ? String(v) : "";
      } catch {
        return "";
      }
    })();

    return {
      referenceNo: String(base?.referenceNo ?? ""),
      parcelNo: base?.parcelNo ? String(base.parcelNo) : null,
      status: String(base?.status ?? ""),
      titleType: String(base?.titleType ?? ""),
      projectName: String(base?.projectName ?? ""),
      developerName: String(base?.developerName ?? ""),
      clientName: String(purchaser?.name ?? ""),
      borrowerNames,
      loanBank,
    };
  } catch (err) {
    logger.warn({ err, firmId, caseId }, "[cases] smart naming context unavailable");
    return fallback;
  }
}

function encodeRFC5987ValueChars(str: string): string {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A")
    .replace(/%(7C|60|5E)/g, (m) => m.toLowerCase());
}

function contentDispositionAttachment(filename: string): string {
  const ascii = safeFilenameAscii(filename);
  const encoded = encodeRFC5987ValueChars(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function streamSupabasePrivateObjectToResponse({
  objectPath,
  res,
  fileName,
  fallbackContentType,
}: {
  objectPath: string;
  res: ExpressResponse;
  fileName: string;
  fallbackContentType: string;
}): Promise<void> {
  const raw = await supabaseStorage.fetchPrivateObjectResponse(objectPath);

  type FetchResponseLike = {
    headers: { get: (name: string) => string | null };
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
  const isFetchResponseLike = (v: unknown): v is FetchResponseLike => {
    if (!v || typeof v !== "object") return false;
    if (!("headers" in v) || !("arrayBuffer" in v)) return false;
    const headers = (v as { headers?: unknown }).headers;
    if (!headers || typeof headers !== "object") return false;
    return (
      typeof (headers as { get?: unknown }).get === "function" &&
      typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function"
    );
  };

  if (!isFetchResponseLike(raw)) throw new Error("Invalid storage response");
  const response = raw;

  const contentType = response.headers.get("content-type") ?? fallbackContentType;
  const contentLength = response.headers.get("content-length");

  res.set("Content-Type", contentType);
  if (contentLength) res.set("Content-Length", contentLength);
  res.set("Content-Disposition", contentDispositionAttachment(fileName));

  const arrayBuffer = await response.arrayBuffer();
  res.send(Buffer.from(arrayBuffer));
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toIsoStringSafe(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return typeof v === "string" ? v : String(v);
  }
  return String(v ?? "");
}

function toIsoStringSafeOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = toIsoStringSafe(v);
  return s ? s : null;
}

const CASE_LIST_ROUTE_KEY = "cases" as const;
const ALLOWED_CASE_LIST_FILTER_KEYS = new Set([
  "search",
  "status",
  "projectId",
  "developerId",
  "assignedLawyerId",
  "assignedClerkId",
  "assignedToUserId",
  "purchaseMode",
  "titleType",
  "milestone",
  "milestonePresence",
  "overdueDays",
  "spaStatus",
  "loanStatus",
  "sortBy",
  "sortDir",
  "sortOrder",
  "limit",
  "pageSize",
]);

function sanitizeCaseListFiltersJson(raw: unknown): Record<string, string> {
  const obj = asObject(raw);
  if (!obj) return {};

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "page" || k === "returnTo") continue;
    if (!ALLOWED_CASE_LIST_FILTER_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      if (!v.trim()) continue;
      out[k] = v;
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = String(v);
      continue;
    }
    if (typeof v === "boolean") {
      out[k] = v ? "true" : "false";
      continue;
    }
  }

  if (out.pageSize && !out.limit) out.limit = out.pageSize;
  if (out.sortOrder && !out.sortDir) out.sortDir = out.sortOrder;

  delete out.pageSize;
  delete out.sortOrder;

  return out;
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
    case "loan_docs_pending_date": return !kd.loanDocsPendingDate;
    case "loan_docs_signed_date": return !kd.loanDocsSignedDate;
    case "acting_letter_issued_date": return !kd.actingLetterIssuedDate;
    case "advice_to_bank_date": return !kd.adviceToBankDate;
    case "loan_sent_bank_execution_date": return !kd.loanSentBankExecutionDate;
    case "loan_bank_executed_date": return !kd.loanBankExecutedDate;
    case "bank_lu_received_date": return !kd.bankLuReceivedDate;
    case "noa_served_on": return !kd.noaServedOn;
    case "register_poa_on": return !kd.registerPoaOn;
    case "letter_disclaimer_dated": return !kd.letterDisclaimerDated;
    default: return false;
  }
}

function keyDatePatchFromWorkflow(field: KeyDateField, ymd: string): Partial<CaseKeyDatesInsert> {
  switch (field) {
    case "spa_signed_date": return { spaSignedDate: ymd };
    case "spa_stamped_date": return { spaStampedDate: ymd };
    case "letter_of_offer_stamped_date": return { letterOfOfferStampedDate: ymd };
    case "loan_docs_pending_date": return { loanDocsPendingDate: ymd };
    case "loan_docs_signed_date": return { loanDocsSignedDate: ymd };
    case "acting_letter_issued_date": return { actingLetterIssuedDate: ymd };
    case "advice_to_bank_date": return { adviceToBankDate: ymd };
    case "loan_sent_bank_execution_date": return { loanSentBankExecutionDate: ymd };
    case "loan_bank_executed_date": return { loanBankExecutedDate: ymd };
    case "bank_lu_received_date": return { bankLuReceivedDate: ymd };
    case "noa_served_on": return { noaServedOn: ymd };
    case "register_poa_on": return { registerPoaOn: ymd };
    case "letter_disclaimer_dated": return { letterDisclaimerDated: ymd };
    default: return {};
  }
}

async function formatCaseDetail(r: DbConn, c: typeof casesTable.$inferSelect) {
  const proj = await (async () => {
    try {
      const [row] = await r
        .select({ id: projectsTable.id, name: projectsTable.name })
        .from(projectsTable)
        .where(eq(projectsTable.id, c.projectId));
      return row ?? null;
    } catch {
      return null;
    }
  })();

  const dev = await (async () => {
    try {
      const [row] = await r
        .select({ id: developersTable.id, name: developersTable.name })
        .from(developersTable)
        .where(eq(developersTable.id, c.developerId));
      return row ?? null;
    } catch {
      return null;
    }
  })();

  const purchaserRows = await (async () => {
    try {
      return await r.select().from(casePurchasersTable).where(eq(casePurchasersTable.caseId, c.id));
    } catch {
      return [];
    }
  })();
  const purchasers = await Promise.all(purchaserRows.map(async (p) => {
    const client = await (async () => {
      try {
        const [row] = await r
          .select({ id: clientsTable.id, name: clientsTable.name, icNo: clientsTable.icNo })
          .from(clientsTable)
          .where(eq(clientsTable.id, p.clientId));
        return row ?? null;
      } catch {
        return null;
      }
    })();
    return {
      id: p.id,
      clientId: p.clientId,
      clientName: client?.name ?? "Unknown",
      icNo: client?.icNo ?? null,
      role: p.role,
      orderNo: p.orderNo,
    };
  }));

  const assignRows = await (async () => {
    try {
      return await r.select().from(caseAssignmentsTable)
        .where(and(eq(caseAssignmentsTable.caseId, c.id), sql`${caseAssignmentsTable.unassignedAt} IS NULL`));
    } catch {
      return [];
    }
  })();
  const assignments = await Promise.all(assignRows.map(async (a) => {
    const user = await (async () => {
      try {
        const [row] = await r
          .select({ id: usersTable.id, name: usersTable.name })
          .from(usersTable)
          .where(eq(usersTable.id, a.userId));
        return row ?? null;
      } catch {
        return null;
      }
    })();
    return {
      id: a.id,
      userId: a.userId,
      userName: user?.name ?? "Unknown",
      roleInCase: a.roleInCase,
      assignedAt: toIsoStringSafe(a.assignedAt),
    };
  }));

  let spaDetails: any = null;
  let propertyDetails: any = null;
  let loanDetails: any = null;
  let companyDetails: any = null;
  try { if (c.spaDetails) spaDetails = JSON.parse(c.spaDetails); } catch {}
  try { if (c.propertyDetails) propertyDetails = JSON.parse(c.propertyDetails); } catch {}
  try { if (c.loanDetails) loanDetails = JSON.parse(c.loanDetails); } catch {}
  try { if (c.companyDetails) companyDetails = JSON.parse(c.companyDetails); } catch {}

  const kdExists = await tableExists(r, "public.case_key_dates");
  const [kd] = kdExists
    ? await r
        .select()
        .from(caseKeyDatesTable)
        .where(and(eq(caseKeyDatesTable.caseId, c.id), eq(caseKeyDatesTable.firmId, c.firmId)))
    : [];

  return {
    id: c.id,
    firmId: c.firmId,
    referenceNo: c.referenceNo,
    projectId: c.projectId,
    projectName: proj?.name ?? "Unknown",
    developerId: c.developerId,
    developerName: dev?.name ?? "Unknown",
    purchaseMode: c.purchaseMode,
    loanPartyType: c.loanPartyType ?? "1st_party",
    titleType: c.titleType,
    isEncumbered: c.isEncumbered,
    tenure: c.tenure,
    trackingToken: c.trackingToken,
    spaPrice: c.spaPrice ? Number(c.spaPrice) : null,
    status: c.status,
    lawyerStatus: c.lawyerStatus ?? null,
    lawyerStatusUpdatedAt: toIsoStringSafeOrNull(c.lawyerStatusUpdatedAt),
    developerStatus: c.developerStatus ?? null,
    developerStatusUpdatedAt: toIsoStringSafeOrNull(c.developerStatusUpdatedAt),
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
      discharge_date: kd.dischargeDate ? String(kd.dischargeDate) : null,
      consent_to_transfer_date: kd.consentToTransferDate ? String(kd.consentToTransferDate) : null,
      consent_to_charge_date: kd.consentToChargeDate ? String(kd.consentToChargeDate) : null,
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
    createdAt: toIsoStringSafe(c.createdAt),
  };
}

async function formatCaseSummary(r: DbConn, c: typeof casesTable.$inferSelect) {
  const [proj] = await r.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
  const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, c.developerId));
  const [lawyerAssign] = await r.select().from(caseAssignmentsTable)
    .where(and(eq(caseAssignmentsTable.caseId, c.id), eq(caseAssignmentsTable.roleInCase, "lawyer"), sql`${caseAssignmentsTable.unassignedAt} IS NULL`));
  let lawyerName: string | null = null;
  if (lawyerAssign) {
    const [lawyer] = await r
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, lawyerAssign.userId));
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
    createdAt: toIsoStringSafe(c.createdAt),
  };
}

router.get("/cases/stats/by-status", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const rows = await db
    .select({ status: casesTable.status, count: count() })
    .from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .groupBy(casesTable.status);
  res.json(rows.map(r => ({ status: r.status, count: Number(r.count) })));
}));

router.get("/cases/stats/by-type", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const rows = await db
    .select({ purchaseMode: casesTable.purchaseMode, count: count() })
    .from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .groupBy(casesTable.purchaseMode);
  res.json(rows.map(r => ({ purchaseMode: r.purchaseMode, count: Number(r.count) })));
}));

router.get("/cases/recent", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = rdb(req);
  const limitParam = req.query.limit ? Number(req.query.limit) : 5;
  const cases = await r.select().from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .orderBy(desc(casesTable.updatedAt))
    .limit(limitParam);
  const summaries = await Promise.all(cases.map((c) => formatCaseSummary(r, c)));
  res.json(summaries);
}));

router.get("/cases/filter-options", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = rdb(req);

  const stepDefs = buildWorkflowSteps("loan", "individual");
  const spaStatuses = ["Pending", ...stepDefs.filter(s => s.pathType === "common").sort((a, b) => a.stepOrder - b.stepOrder).map(s => s.stepName)];
  const loanStatuses = ["Pending", ...stepDefs.filter(s => s.pathType === "loan").sort((a, b) => a.stepOrder - b.stepOrder).map(s => s.stepName)];

  const assignmentRows = await r
    .select({ userId: usersTable.id, userName: usersTable.name, roleInCase: caseAssignmentsTable.roleInCase })
    .from(caseAssignmentsTable)
    .innerJoin(usersTable, eq(caseAssignmentsTable.userId, usersTable.id))
    .where(and(eq(usersTable.firmId, req.firmId!), sql`${caseAssignmentsTable.unassignedAt} IS NULL`));

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
      { key: "letter_of_offer_date", label: "LO Date" },
      { key: "letter_of_offer_stamped_date", label: "LO Stamped" },
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
      { key: "noa_served_on", label: "NOA Served" },
      { key: "register_poa_on", label: "POA Registered" },
      { key: "letter_disclaimer_dated", label: "Letter Disclaimer Dated" },
      { key: "loan_agreement_stamped_date", label: "Loan Doc Stamped" },
      { key: "bank_1st_release_on", label: "Bank Released" },
      { key: "discharge_date", label: "Discharge" },
      { key: "caveat_lodged_date", label: "Caveat Lodged" },
      { key: "first_advice_date", label: "1st Advice" },
      { key: "dev_informed_redemption_date", label: "Dev Informed Redemption" },
      { key: "request_discharge_date", label: "Request Discharge" },
      { key: "charge_date", label: "Charge" },
      { key: "presentation_date", label: "Presentation" },
      { key: "second_advice_date", label: "2nd Advice" },
      { key: "mot_received_date", label: "MOT Received" },
      { key: "mot_signed_date", label: "MOT Signed" },
      { key: "mot_stamped_date", label: "MOT Stamped" },
      { key: "mot_registered_date", label: "MOT Registered" },
      { key: "completion_date", label: "Completion Date" },
    ],
  });
}));

router.get("/case-list-views", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = rdb(req);

  const rows = await r
    .select()
    .from(caseListSavedViewsTable)
    .where(and(
      eq(caseListSavedViewsTable.firmId, req.firmId!),
      eq(caseListSavedViewsTable.userId, req.userId!),
      eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
    ))
    .orderBy(asc(caseListSavedViewsTable.name));

  res.json(rows.map((v) => ({
    id: v.id,
    firmId: v.firmId,
    userId: v.userId,
    routeKey: v.routeKey,
    name: v.name,
    filtersJson: v.params ?? {},
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  })));
}));

router.post("/case-list-views", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const body = asObject(req.body);
  const name = asString(body?.name)?.trim() ?? "";
  const routeKey = asString(body?.routeKey) ?? CASE_LIST_ROUTE_KEY;
  const filtersJson = sanitizeCaseListFiltersJson(body?.filtersJson);

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (routeKey !== CASE_LIST_ROUTE_KEY) {
    res.status(400).json({ error: "routeKey must be cases" });
    return;
  }

  try {
    const [created] = await r
      .insert(caseListSavedViewsTable)
      .values({
        firmId: req.firmId!,
        userId: req.userId!,
        routeKey: CASE_LIST_ROUTE_KEY,
        name,
        params: filtersJson,
        updatedAt: new Date(),
      })
      .returning();

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "cases.list_views.create",
      entityType: "case_list_view",
      entityId: created.id,
      detail: `name=${name}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.status(201).json({
      id: created.id,
      firmId: created.firmId,
      userId: created.userId,
      routeKey: created.routeKey,
      name: created.name,
      filtersJson: created.params ?? {},
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  } catch (err) {
    const code = (err as any)?.code;
    if (code === "23505") {
      res.status(409).json({ error: "A view with this name already exists" });
      return;
    }
    throw err;
  }
}));

router.patch("/case-list-views/:id", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const id = Number((req.params as Record<string, unknown>)?.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const body = asObject(req.body);
  if (!body) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const updates: Partial<typeof caseListSavedViewsTable.$inferInsert> = { updatedAt: new Date() };
  if ("name" in body) {
    const nextName = asString(body.name)?.trim() ?? "";
    if (!nextName) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    updates.name = nextName;
  }
  if ("filtersJson" in body) {
    updates.params = sanitizeCaseListFiltersJson((body as Record<string, unknown>).filtersJson);
  }

  try {
    const [updated] = await r
      .update(caseListSavedViewsTable)
      .set(updates)
      .where(and(
        eq(caseListSavedViewsTable.id, id),
        eq(caseListSavedViewsTable.firmId, req.firmId!),
        eq(caseListSavedViewsTable.userId, req.userId!),
        eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
      ))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "View not found" });
      return;
    }

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "cases.list_views.update",
      entityType: "case_list_view",
      entityId: id,
      detail: "updated",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json({
      id: updated.id,
      firmId: updated.firmId,
      userId: updated.userId,
      routeKey: updated.routeKey,
      name: updated.name,
      filtersJson: updated.params ?? {},
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    const code = (err as any)?.code;
    if (code === "23505") {
      res.status(409).json({ error: "A view with this name already exists" });
      return;
    }
    throw err;
  }
}));

router.delete("/case-list-views/:id", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const id = Number((req.params as Record<string, unknown>)?.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [deleted] = await r
    .delete(caseListSavedViewsTable)
    .where(and(
      eq(caseListSavedViewsTable.id, id),
      eq(caseListSavedViewsTable.firmId, req.firmId!),
      eq(caseListSavedViewsTable.userId, req.userId!),
      eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
    ))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "View not found" });
    return;
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.list_views.delete",
    entityType: "case_list_view",
    entityId: id,
    detail: `name=${deleted.name}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(204).end();
}));

router.get("/cases/views", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = rdb(req);
  const rows = await r
    .select()
    .from(caseListSavedViewsTable)
    .where(and(
      eq(caseListSavedViewsTable.firmId, req.firmId!),
      eq(caseListSavedViewsTable.userId, req.userId!),
      eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
    ))
    .orderBy(desc(caseListSavedViewsTable.isDefault), asc(caseListSavedViewsTable.name));

  res.json(rows.map((v) => ({
    id: v.id,
    name: v.name,
    isDefault: v.isDefault,
    params: v.params ?? {},
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  })));
}));

router.post("/cases/views", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const body = asObject(req.body);
  const name = asString(body?.name)?.trim() ?? "";
  const params = asObject(body?.params);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!params) {
    res.status(400).json({ error: "params must be an object" });
    return;
  }

  const isDefault = asBoolean(body?.isDefault) ?? false;
  if (isDefault) {
    await r
      .update(caseListSavedViewsTable)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(
        eq(caseListSavedViewsTable.firmId, req.firmId!),
        eq(caseListSavedViewsTable.userId, req.userId!),
        eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
      ));
  }

  const [created] = await r
    .insert(caseListSavedViewsTable)
    .values({ firmId: req.firmId!, userId: req.userId!, routeKey: CASE_LIST_ROUTE_KEY, name, params, isDefault, updatedAt: new Date() })
    .returning();

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.views.create",
    entityType: "case_list_saved_view",
    entityId: created.id,
    detail: `name=${name} default=${isDefault}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(201).json({
    id: created.id,
    name: created.name,
    isDefault: created.isDefault,
    params: created.params ?? {},
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
  });
}));

router.patch("/cases/views/:viewId", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const viewId = Number((req.params as Record<string, unknown>)?.viewId);
  if (!Number.isInteger(viewId)) {
    res.status(400).json({ error: "Invalid viewId" });
    return;
  }

  const body = asObject(req.body);
  if (!body) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const updates: Partial<typeof caseListSavedViewsTable.$inferInsert> = { updatedAt: new Date() };
  let changedDefault = false;
  if ("name" in body) {
    const nextName = asString(body.name)?.trim() ?? "";
    if (!nextName) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    updates.name = nextName;
  }
  if ("params" in body) {
    const nextParams = asObject(body.params);
    if (!nextParams) {
      res.status(400).json({ error: "params must be an object" });
      return;
    }
    updates.params = nextParams;
  }
  if ("isDefault" in body) {
    const nextDefault = asBoolean(body.isDefault);
    if (nextDefault === null) {
      res.status(400).json({ error: "isDefault must be boolean" });
      return;
    }
    updates.isDefault = nextDefault;
    changedDefault = nextDefault;
  }

  if (changedDefault) {
    await r
      .update(caseListSavedViewsTable)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(
        eq(caseListSavedViewsTable.firmId, req.firmId!),
        eq(caseListSavedViewsTable.userId, req.userId!),
        eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
      ));
  }

  const [updated] = await r
    .update(caseListSavedViewsTable)
    .set(updates)
    .where(and(
      eq(caseListSavedViewsTable.id, viewId),
      eq(caseListSavedViewsTable.firmId, req.firmId!),
      eq(caseListSavedViewsTable.userId, req.userId!),
      eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
    ))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "View not found" });
    return;
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.views.update",
    entityType: "case_list_saved_view",
    entityId: viewId,
    detail: "updated",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({
    id: updated.id,
    name: updated.name,
    isDefault: updated.isDefault,
    params: updated.params ?? {},
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
}));

router.delete("/cases/views/:viewId", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const viewId = Number((req.params as Record<string, unknown>)?.viewId);
  if (!Number.isInteger(viewId)) {
    res.status(400).json({ error: "Invalid viewId" });
    return;
  }

  const [deleted] = await r
    .delete(caseListSavedViewsTable)
    .where(and(
      eq(caseListSavedViewsTable.id, viewId),
      eq(caseListSavedViewsTable.firmId, req.firmId!),
      eq(caseListSavedViewsTable.userId, req.userId!),
      eq(caseListSavedViewsTable.routeKey, CASE_LIST_ROUTE_KEY),
    ))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "View not found" });
    return;
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.views.delete",
    entityType: "case_list_saved_view",
    entityId: viewId,
    detail: `name=${deleted.name}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(204).end();
}));

router.post("/cases/bulk/assign", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const ok = await enforcePermission(req, res, "cases", "assign_any");
  if (!ok) return;

  const body = asObject(req.body);
  const rawCaseIds = Array.isArray(body?.caseIds) ? body!.caseIds : [];
  const roleInCase = asString(body?.roleInCase);
  const userId = asNumber(body?.userId);

  const normalizedCaseIds = rawCaseIds
    .map((x: unknown) => Number(x))
    .filter((x: number) => Number.isInteger(x) && x > 0);

  if (normalizedCaseIds.length === 0) {
    res.status(400).json({ error: "caseIds is required" });
    return;
  }
  if (roleInCase !== "lawyer" && roleInCase !== "clerk") {
    res.status(400).json({ error: "roleInCase must be lawyer or clerk" });
    return;
  }
  if (!userId || !Number.isInteger(userId)) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  const targetUserId = userId;
  const now = new Date();

  const cases = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.firmId, req.firmId!), inArray(casesTable.id, normalizedCaseIds)));

  const existingIds = new Set(cases.map((c) => c.id));
  const missingIds = normalizedCaseIds.filter((id: number) => !existingIds.has(id));

  const failures: Array<{ caseId: number; error: string }> = missingIds.map((id) => ({ caseId: id, error: "Case not found" }));
  let succeeded = 0;

  for (const { id: caseId } of cases) {
    try {
      await r
        .update(caseAssignmentsTable)
        .set({ unassignedAt: now })
        .where(and(
          eq(caseAssignmentsTable.caseId, caseId),
          eq(caseAssignmentsTable.roleInCase, roleInCase),
          sql`${caseAssignmentsTable.unassignedAt} IS NULL`
        ));

      await r
        .insert(caseAssignmentsTable)
        .values({
          caseId,
          userId: targetUserId,
          roleInCase,
          assignedBy: req.userId ?? null,
          assignedAt: now,
        });

      await writeAuditLog({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: req.userType,
        action: "cases.bulk.assign",
        entityType: "case",
        entityId: caseId,
        detail: `role=${roleInCase} userId=${targetUserId}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });

      succeeded += 1;
    } catch (err) {
      failures.push({ caseId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.bulk.assign.summary",
    entityType: "case_assignment",
    detail: `role=${roleInCase} userId=${targetUserId} requested=${normalizedCaseIds.length} succeeded=${succeeded} failed=${failures.length}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({ requested: normalizedCaseIds.length, succeeded, failed: failures.length, failures });
}));

router.post("/cases/bulk/status", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const body = asObject(req.body);
  const rawCaseIds = Array.isArray(body?.caseIds) ? body!.caseIds : [];
  const moduleRaw = (asString(body?.module) ?? "").trim().toLowerCase();
  const statusName = (asString(body?.status) ?? "").trim();
  const dateInput = Object.prototype.hasOwnProperty.call(body ?? {}, "date") ? (body as any).date : undefined;

  const normalizedCaseIds = rawCaseIds
    .map((x: unknown) => Number(x))
    .filter((x: number) => Number.isInteger(x) && x > 0);

  if (normalizedCaseIds.length === 0) {
    res.status(400).json({ error: "caseIds is required" });
    return;
  }

  if (moduleRaw !== "spa" && moduleRaw !== "loan") {
    res.status(400).json({ error: "module must be spa or loan" });
    return;
  }

  if (!statusName) {
    res.status(400).json({ error: "status is required" });
    return;
  }

  const ymdParsed = parseDateOnlyInput(dateInput === undefined ? new Date() : dateInput);
  if (ymdParsed === undefined || ymdParsed === null) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const ymd = ymdParsed;

  const now = new Date();
  const cases = await r
    .select({ id: casesTable.id, purchaseMode: casesTable.purchaseMode, titleType: casesTable.titleType })
    .from(casesTable)
    .where(and(eq(casesTable.firmId, req.firmId!), inArray(casesTable.id, normalizedCaseIds)));

  const existingIds = new Set(cases.map((c) => c.id));
  const missingIds = normalizedCaseIds.filter((id: number) => !existingIds.has(id));

  const failures: Array<{ caseId: number; error: string }> = missingIds.map((id) => ({ caseId: id, error: "Case not found" }));
  let succeeded = 0;

  const pathType = moduleRaw === "spa" ? "common" : "loan";
  const statusNameLower = statusName.toLowerCase();

  for (const { id: caseId, purchaseMode: purchaseModeRaw, titleType: titleTypeRaw } of cases) {
    try {
      const purchaseMode = String(purchaseModeRaw || "").trim().toLowerCase();
      if (moduleRaw === "loan" && purchaseMode !== "loan") {
        failures.push({ caseId, error: "Not a loan case" });
        continue;
      }

      const titleTypeNorm = (normalizeTitleType(titleTypeRaw) ?? String(titleTypeRaw || "").trim().toLowerCase()) || "master";
      const defs = buildWorkflowSteps(purchaseMode, titleTypeNorm);
      const def = defs.find((d) => d.pathType === pathType && String(d.stepName || "").trim().toLowerCase() === statusNameLower);
      if (!def) {
        failures.push({ caseId, error: `Unsupported status for ${moduleRaw}` });
        continue;
      }

      await ensureCaseWorkflowSteps(r, req.firmId!, caseId);

      const requirement = WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY[def.stepKey];
      if (requirement) {
        const keyDateFieldRaw = requirement.keyDateField;
        if (!Object.prototype.hasOwnProperty.call(KEY_DATE_FIELD_TO_STEP_KEY, keyDateFieldRaw)) {
          failures.push({ caseId, error: "Invalid automated step mapping" });
          continue;
        }
        const keyDateField = keyDateFieldRaw as KeyDateField;

        if (requirement.kind === "dateAndWorkflowDoc") {
          const docKey = requirement.docKey as WorkflowDocumentMilestoneKey;
          const [doc] = await r
            .select({ id: caseWorkflowDocumentsTable.id })
            .from(caseWorkflowDocumentsTable)
            .where(and(
              eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
              eq(caseWorkflowDocumentsTable.caseId, caseId),
              eq(caseWorkflowDocumentsTable.milestoneKey, docKey),
              sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
              sql`${caseWorkflowDocumentsTable.objectPath} <> ''`,
              sql`${caseWorkflowDocumentsTable.fileName} <> ''`,
            ))
            .limit(1);
          if (!doc) {
            failures.push({ caseId, error: "Missing required attachment for this status" });
            continue;
          }
        }

        const patch = keyDatePatchFromWorkflow(keyDateField, ymd);
        const [existingKd] = await r
          .select({ id: caseKeyDatesTable.id })
          .from(caseKeyDatesTable)
          .where(and(eq(caseKeyDatesTable.caseId, caseId), eq(caseKeyDatesTable.firmId, req.firmId!)));
        if (existingKd) {
          await r
            .update(caseKeyDatesTable)
            .set({ ...patch, updatedAt: now })
            .where(and(eq(caseKeyDatesTable.caseId, caseId), eq(caseKeyDatesTable.firmId, req.firmId!)));
        } else {
          await r
            .insert(caseKeyDatesTable)
            .values({ firmId: req.firmId!, caseId, ...patch });
        }

        await r.insert(auditLogsTable).values({
          firmId: req.firmId,
          actorId: req.userId,
          actorType: "firm_user",
          action: "case.key_dates.updated",
          entityType: "case",
          entityId: caseId,
          detail: JSON.stringify([keyDateField]),
        });

        await syncWorkflowStepsFromCaseState(r, caseId, {
          firmId: req.firmId!,
          actorId: req.userId,
          actorType: req.userType ?? "firm_user",
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
      } else {
        const [step] = await r
          .select({ id: caseWorkflowStepsTable.id, stepName: caseWorkflowStepsTable.stepName })
          .from(caseWorkflowStepsTable)
          .where(and(eq(caseWorkflowStepsTable.caseId, caseId), eq(caseWorkflowStepsTable.stepKey, def.stepKey)))
          .limit(1);
        if (!step) {
          failures.push({ caseId, error: "Workflow step not found" });
          continue;
        }

        const [updated] = await r
          .update(caseWorkflowStepsTable)
          .set({
            status: "completed",
            completedBy: req.userId ?? null,
            completedAt: now,
            updatedAt: now,
          })
          .where(and(eq(caseWorkflowStepsTable.id, step.id), eq(caseWorkflowStepsTable.caseId, caseId)))
          .returning();
        if (!updated) {
          failures.push({ caseId, error: "Workflow step not found" });
          continue;
        }

        await r.insert(auditLogsTable).values({
          firmId: req.firmId,
          actorId: req.userId,
          actorType: "firm_user",
          action: "workflow.step_updated",
          entityType: "case_workflow_step",
          entityId: updated.id,
          detail: `Step ${String(step.stepName)} -> completed`,
        });
      }

      await writeAuditLog({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: req.userType,
        action: "cases.bulk.status",
        entityType: "case",
        entityId: caseId,
        detail: `module=${moduleRaw} status=${statusName} date=${ymd}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });

      succeeded += 1;
    } catch (err) {
      failures.push({ caseId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.bulk.status.summary",
    entityType: "case_workflow_step",
    detail: `module=${moduleRaw} status=${statusName} requested=${normalizedCaseIds.length} succeeded=${succeeded} failed=${failures.length} date=${ymd}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({ requested: normalizedCaseIds.length, succeeded, failed: failures.length, failures });
}));

router.patch("/cases/bulk/key-dates", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const kdExists = await tableExists(r, "public.case_key_dates");
  if (!kdExists) {
    res.status(503).json({ error: "Key dates table not available. Run migrations." });
    return;
  }

  const body = asObject(req.body);
  const rawCaseIds = Array.isArray(body?.caseIds) ? body!.caseIds : [];
  const field = (asString(body?.field) ?? "").trim();
  const dateInput = Object.prototype.hasOwnProperty.call(body ?? {}, "date") ? (body as any).date : undefined;

  const normalizedCaseIds = Array.from(new Set(
    rawCaseIds
      .map((x: unknown) => Number(x))
      .filter((x: number) => Number.isInteger(x) && x > 0)
  ));
  if (normalizedCaseIds.length === 0) {
    res.status(400).json({ error: "caseIds is required" });
    return;
  }
  if (!field) {
    res.status(400).json({ error: "field is required" });
    return;
  }
  if (dateInput === undefined) {
    res.status(400).json({ error: "date is required" });
    return;
  }

  const ymdParsed = parseDateOnlyInput(dateInput);
  if (ymdParsed === undefined || ymdParsed === null) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const ymd = ymdParsed;

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
    discharge_date: "dischargeDate",
    caveat_lodged_date: "caveatLodgedDate",
    first_advice_date: "firstAdviceDate",
    dev_informed_redemption_date: "devInformedRedemptionDate",
    request_discharge_date: "requestDischargeDate",
    charge_date: "chargeDate",
    presentation_date: "presentationDate",
    second_advice_date: "secondAdviceDate",
    consent_to_transfer_date: "consentToTransferDate",
    consent_to_charge_date: "consentToChargeDate",
    mot_received_date: "motReceivedDate",
    mot_signed_date: "motSignedDate",
    mot_stamped_date: "motStampedDate",
    mot_registered_date: "motRegisteredDate",
    progressive_payment_date: "progressivePaymentDate",
    full_settlement_date: "fullSettlementDate",
    completion_date: "completionDate",
  } as const;

  const colKey = (dateFieldMap as any)[field] as string | undefined;
  if (!colKey) {
    res.status(400).json({ error: "Unsupported field" });
    return;
  }

  const elevated = await canBypassCaseAssignment(r, req.firmId!, req.roleId);
  const requestedIds = normalizedCaseIds;

  const visibleCases = elevated
    ? await r
        .select({ id: casesTable.id })
        .from(casesTable)
        .where(and(eq(casesTable.firmId, req.firmId!), inArray(casesTable.id, requestedIds)))
    : await r
        .select({ id: casesTable.id })
        .from(casesTable)
        .innerJoin(caseAssignmentsTable, and(
          eq(caseAssignmentsTable.caseId, casesTable.id),
          eq(caseAssignmentsTable.userId, req.userId!),
          inArray(caseAssignmentsTable.roleInCase, ["lawyer", "clerk"]),
          sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
        ))
        .where(and(eq(casesTable.firmId, req.firmId!), inArray(casesTable.id, requestedIds)));

  const allowedIds = Array.from(new Set(visibleCases.map((c) => c.id)));
  const allowedSet = new Set(allowedIds);
  const failures: Array<{ caseId: number; error: string }> = requestedIds
    .filter((id) => !allowedSet.has(id))
    .map((id) => ({ caseId: id, error: "Forbidden" }));

  const now = new Date();
  let succeeded = 0;

  if (allowedIds.length > 0) {
    const existingRows = await r
      .select({ caseId: caseKeyDatesTable.caseId })
      .from(caseKeyDatesTable)
      .where(and(eq(caseKeyDatesTable.firmId, req.firmId!), inArray(caseKeyDatesTable.caseId, allowedIds)));
    const existingSet = new Set(existingRows.map((x) => x.caseId));
    const toUpdate = allowedIds.filter((id) => existingSet.has(id));
    const toInsert = allowedIds.filter((id) => !existingSet.has(id));

    if (toUpdate.length > 0) {
      const updateValues: any = { updatedAt: now };
      updateValues[colKey] = ymd;
      await r
        .update(caseKeyDatesTable)
        .set(updateValues)
        .where(and(eq(caseKeyDatesTable.firmId, req.firmId!), inArray(caseKeyDatesTable.caseId, toUpdate)));
      succeeded += toUpdate.length;
    }
    if (toInsert.length > 0) {
      const rows: any[] = toInsert.map((caseId) => {
        const v: any = { firmId: req.firmId!, caseId, updatedAt: now };
        v[colKey] = ymd;
        return v;
      });
      await r.insert(caseKeyDatesTable).values(rows);
      succeeded += toInsert.length;
    }

    const auditRows = allowedIds.map((caseId) => ({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: "firm_user",
      action: "case.key_dates.updated",
      entityType: "case",
      entityId: caseId,
      detail: JSON.stringify([field]),
    }));
    await r.insert(auditLogsTable).values(auditRows);

    for (const caseId of allowedIds) {
      try {
        await syncWorkflowStepsFromCaseState(r, caseId, {
          firmId: req.firmId!,
          actorId: req.userId,
          actorType: req.userType ?? "firm_user",
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
      } catch (err) {
        failures.push({ caseId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.bulk.key_dates.summary",
    entityType: "case_key_dates",
    detail: `field=${field} date=${ymd} requested=${requestedIds.length} succeeded=${succeeded} failed=${failures.length}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({ requested: requestedIds.length, succeeded, failed: failures.length, failures });
}));

function hasLoanOnlyMilestone(milestone: CaseMilestoneKey): boolean {
  return (
    milestone === "loan_docs_signed_date" ||
    milestone === "acting_letter_issued_date" ||
    milestone === "loan_sent_bank_execution_date" ||
    milestone === "loan_bank_executed_date" ||
    milestone === "bank_lu_received_date"
  );
}

function overdueAnySql(thresholdDays: number) {
  const createdBefore = sql`${casesTable.createdAt}::date <= ${daysAgoSql(thresholdDays)}`;
  const spaDateMissing = sql`${caseKeyDatesTable.spaDate} IS NULL AND ${createdBefore}`;

  const lofDate = sql`${caseKeyDatesTable.letterOfOfferDate}`;
  const loanDocsSigned = milestoneDateSql("loan_docs_signed_date");
  const actingLetterIssued = milestoneDateSql("acting_letter_issued_date");
  const loanSentBankExec = milestoneDateSql("loan_sent_bank_execution_date");
  const loanBankExecuted = milestoneDateSql("loan_bank_executed_date");
  const spaStamped = milestoneDateSql("spa_stamped_date");

  const loanDocsSignedMissingAfterLof = sql`
    ${casesTable.purchaseMode} = 'loan'
    AND ${lofDate} IS NOT NULL
    AND ${loanDocsSigned} IS NULL
    AND (${lofDate}::date <= ${daysAgoSql(thresholdDays)})
  `;

  const actingLetterMissingAfterLoanDocs = sql`
    ${casesTable.purchaseMode} = 'loan'
    AND ${loanDocsSigned} IS NOT NULL
    AND ${actingLetterIssued} IS NULL
    AND (${loanDocsSigned} <= ${daysAgoSql(thresholdDays)})
  `;

  const loanSentExecMissingAfterActing = sql`
    ${casesTable.purchaseMode} = 'loan'
    AND ${actingLetterIssued} IS NOT NULL
    AND ${loanSentBankExec} IS NULL
    AND (${actingLetterIssued} <= ${daysAgoSql(thresholdDays)})
  `;

  const completionAfterLaterStage = sql`
    ${caseKeyDatesTable.completionDate} IS NULL
    AND (
      (${casesTable.purchaseMode} = 'loan' AND ${loanBankExecuted} IS NOT NULL AND (${loanBankExecuted} <= ${daysAgoSql(thresholdDays)}))
      OR
      (${casesTable.purchaseMode} <> 'loan' AND ${spaStamped} IS NOT NULL AND (${spaStamped} <= ${daysAgoSql(thresholdDays)}))
    )
  `;

  return or(
    spaDateMissing,
    loanDocsSignedMissingAfterLof,
    actingLetterMissingAfterLoanDocs,
    loanSentExecMissingAfterActing,
    completionAfterLaterStage,
  );
}

router.get("/cases/workbench", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  try {
    const r = rdb(req);
    const hasKeyDates = await tableExists(r, "public.case_key_dates");

  const one = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;
  const staffUserIdRaw = one(req.query.userId as any);
  const staffUserId = staffUserIdRaw ? Number(staffUserIdRaw) : req.userId!;
  if (!Number.isInteger(staffUserId)) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  const wantsOtherUser = staffUserId !== req.userId;
  let canViewUsers = false;
  if (wantsOtherUser) {
    const canAssignAny = await hasRolePermission(r, req.firmId!, req.roleId, "cases", "assign_any");
    if (!canAssignAny) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }
    if (!req.roleId) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }
    const [perm] = await r
      .select()
      .from(permissionsTable)
      .where(and(
        eq(permissionsTable.roleId, req.roleId),
        eq(permissionsTable.module, "users"),
        eq(permissionsTable.action, "read"),
      ));
    canViewUsers = Boolean(perm?.allowed);
    if (!canViewUsers) {
      res.status(403).json({ error: "Permission denied" });
      return;
    }
  }

  const [staffUser] = await r
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(and(eq(usersTable.id, staffUserId), eq(usersTable.firmId, req.firmId!)));
  if (!staffUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (!wantsOtherUser && req.roleId) {
    const [perm] = await r
      .select()
      .from(permissionsTable)
      .where(and(
        eq(permissionsTable.roleId, req.roleId),
        eq(permissionsTable.module, "users"),
        eq(permissionsTable.action, "read"),
      ));
    canViewUsers = Boolean(perm?.allowed);
  }

  const baseConditions = [eq(casesTable.firmId, req.firmId!)];
  const projectId = Number(one(req.query.projectId as any));
  const developerId = Number(one(req.query.developerId as any));
  const purchaseMode = one(req.query.purchaseMode as any);
  const assignedLawyerId = Number(one(req.query.assignedLawyerId as any));
  const assignedClerkId = Number(one(req.query.assignedClerkId as any));

  if (Number.isInteger(projectId)) baseConditions.push(eq(casesTable.projectId, projectId));
  if (Number.isInteger(developerId)) baseConditions.push(eq(casesTable.developerId, developerId));
  if (purchaseMode === "cash" || purchaseMode === "loan") baseConditions.push(eq(casesTable.purchaseMode, purchaseMode));
  if (Number.isInteger(assignedLawyerId)) {
    baseConditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
        AND ${caseAssignmentsTable.userId} = ${assignedLawyerId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (Number.isInteger(assignedClerkId)) {
    baseConditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'clerk'
        AND ${caseAssignmentsTable.userId} = ${assignedClerkId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }

  const staffAssignedAnySql = sql`EXISTS (
    SELECT 1
    FROM ${caseAssignmentsTable}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.userId} = ${staffUserId}
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
  )`;

  const staffAssignedLawyerSql = sql`EXISTS (
    SELECT 1
    FROM ${caseAssignmentsTable}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
      AND ${caseAssignmentsTable.userId} = ${staffUserId}
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
  )`;
  const staffAssignedClerkSql = sql`EXISTS (
    SELECT 1
    FROM ${caseAssignmentsTable}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'clerk'
      AND ${caseAssignmentsTable.userId} = ${staffUserId}
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
  )`;

  const [{ c: assignedLawyerCount }] = await r
    .select({ c: sql<number>`COUNT(*)` })
    .from(casesTable)
    .where(and(...baseConditions, staffAssignedLawyerSql));
  const [{ c: assignedClerkCount }] = await r
    .select({ c: sql<number>`COUNT(*)` })
    .from(casesTable)
    .where(and(...baseConditions, staffAssignedClerkSql));
  let needingActionCount = 0;
  if (hasKeyDates) {
    const overdue7 = overdueAnySql(7) ?? sql`FALSE`;
    const [{ c }] = await r
      .select({ c: sql<number>`COUNT(DISTINCT ${casesTable.id})` })
      .from(casesTable)
      .leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)))
      .where(and(...baseConditions, staffAssignedAnySql, overdue7));
    needingActionCount = Number(c ?? 0);
  }

  const recentRows = await r
    .select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      projectName: projectsTable.name,
      updatedAt: casesTable.updatedAt,
    })
    .from(casesTable)
    .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .where(and(...baseConditions, staffAssignedAnySql))
    .orderBy(desc(casesTable.updatedAt))
    .limit(8);

  const milestones: Array<{ key: CaseMilestoneKey; label: string }> = [
    { key: "spa_date", label: "SPA Date Missing" },
    { key: "spa_stamped_date", label: "SPA Stamped Missing" },
    { key: "letter_of_offer_date", label: "LOF Date Missing" },
    { key: "loan_docs_signed_date", label: "Loan Docs Signed Missing" },
    { key: "completion_date", label: "Completion Date Missing" },
  ];

  const missingCards: Array<{ key: string; label: string; count: number; query: Record<string, string> }> = [];
  for (const m of milestones) {
    const loanOnly = hasLoanOnlyMilestone(m.key);
    let c = 0;
    if (hasKeyDates) {
      const [row] = await r
        .select({ c: sql<number>`COUNT(DISTINCT ${casesTable.id})` })
        .from(casesTable)
        .leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)))
        .where(and(...baseConditions, ...(loanOnly ? [eq(casesTable.purchaseMode, "loan")] : []), milestonePresenceWhereSql(m.key, "missing")));
      c = Number(row?.c ?? 0);
    }

    const query: Record<string, string> = { milestone: m.key, milestonePresence: "missing", page: "1", sortBy: "updatedAt", sortDir: "desc" };
    if (purchaseMode === "cash" || purchaseMode === "loan") query.purchaseMode = purchaseMode;
    if (Number.isInteger(projectId)) query.projectId = String(projectId);
    if (Number.isInteger(developerId)) query.developerId = String(developerId);
    if (Number.isInteger(assignedLawyerId)) query.assignedLawyerId = String(assignedLawyerId);
    if (Number.isInteger(assignedClerkId)) query.assignedClerkId = String(assignedClerkId);

    if (loanOnly) query.purchaseMode = "loan";

    missingCards.push({ key: m.key, label: m.label, count: c, query });
  }

  const overdueThresholds = [7, 14, 30] as const;
  const overdueCards = await Promise.all(overdueThresholds.map(async (days) => {
    let c = 0;
    if (hasKeyDates) {
      const overdue = overdueAnySql(days) ?? sql`FALSE`;
      const [row] = await r
        .select({ c: sql<number>`COUNT(DISTINCT ${casesTable.id})` })
        .from(casesTable)
        .leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)))
        .where(and(...baseConditions, overdue));
      c = Number(row?.c ?? 0);
    }

    const query: Record<string, string> = {
      overdueDays: String(days),
      page: "1",
      sortBy: "updatedAt",
      sortDir: "desc",
    };
    if (purchaseMode === "cash" || purchaseMode === "loan") query.purchaseMode = purchaseMode;
    if (Number.isInteger(projectId)) query.projectId = String(projectId);
    if (Number.isInteger(developerId)) query.developerId = String(developerId);
    if (Number.isInteger(assignedLawyerId)) query.assignedLawyerId = String(assignedLawyerId);
    if (Number.isInteger(assignedClerkId)) query.assignedClerkId = String(assignedClerkId);

    return { key: `overdue_${days}`, label: `Overdue > ${days} days`, count: c, query };
  }));

  const myWorkCards = [
    { key: "assigned_lawyer", label: "Assigned to me (Lawyer)", count: Number(assignedLawyerCount ?? 0), query: { assignedLawyerId: String(staffUserId), page: "1", sortBy: "updatedAt", sortDir: "desc" } },
    { key: "assigned_clerk", label: "Assigned to me (Clerk)", count: Number(assignedClerkCount ?? 0), query: { assignedClerkId: String(staffUserId), page: "1", sortBy: "updatedAt", sortDir: "desc" } },
    { key: "recently_updated", label: "Recently updated (my cases)", count: Number(recentRows.length), query: { assignedToUserId: String(staffUserId), page: "1", sortBy: "updatedAt", sortDir: "desc" } },
    { key: "needing_action", label: "Cases needing my action", count: Number(needingActionCount ?? 0), query: { assignedToUserId: String(staffUserId), overdueDays: "7", page: "1", sortBy: "updatedAt", sortDir: "desc" } },
  ];

  const staffOptions = canViewUsers
    ? await r
      .select({ id: usersTable.id, name: usersTable.name, roleName: rolesTable.name })
      .from(usersTable)
      .leftJoin(rolesTable, and(eq(rolesTable.id, usersTable.roleId), eq(rolesTable.firmId, req.firmId!)))
      .where(eq(usersTable.firmId, req.firmId!))
      .orderBy(asc(usersTable.name))
    : [];

    res.json({
      staffUser,
      staffOptions,
      myWork: {
        cards: myWorkCards,
        recent: recentRows.map((c) => ({ id: c.id, referenceNo: c.referenceNo, projectName: c.projectName ?? "Unknown", updatedAt: c.updatedAt.toISOString(), query: { search: c.referenceNo, page: "1", sortBy: "updatedAt", sortDir: "desc" } })),
      },
      missingDates: {
        cards: missingCards,
      },
      overdue: {
        cards: overdueCards,
      },
    });
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[cases-workbench]");
    res.status(isTransientDbConnectionError(err) ? 503 : 500).json({ error: isTransientDbConnectionError(err) ? "Workbench temporarily unavailable" : "Internal Server Error" });
  }
}));

function sanitizeCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const trimmed = s.trimStart();
  if (trimmed.startsWith("=") || trimmed.startsWith("+") || trimmed.startsWith("-") || trimmed.startsWith("@")) {
    return `'${s}`;
  }
  return s;
}

router.get("/cases/export.csv", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = rdb(req);

  const params = ListCasesQueryParams.safeParse(req.query);
  const status = params.success ? params.data.status : undefined;
  const projectId = params.success ? params.data.projectId : undefined;
  const developerId = params.success ? params.data.developerId : undefined;
  const purchaseMode = params.success ? params.data.purchaseMode : undefined;
  const titleType = params.success ? params.data.titleType : undefined;

  const one = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;
  const parseIntOrUndef = (v: string | string[] | undefined): number | undefined => {
    const s = one(v);
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n)) return undefined;
    return n;
  };

  const search = one(req.query.search as any);
  const spaStatus = one(req.query.spaStatus as any);
  const loanStatus = one(req.query.loanStatus as any);
  const milestone = one(req.query.milestone as any) as CaseMilestoneKey | undefined;
  const milestonePresence = one(req.query.milestonePresence as any) as MilestonePresence | undefined;
  const sortByRaw = one(req.query.sortBy as any);
  const sortDirRaw = one(req.query.sortDir as any);
  const overdueDaysRaw = one(req.query.overdueDays as any);
  const assignedLawyerId = params.success ? params.data.assignedLawyerId : parseIntOrUndef(req.query.assignedLawyerId as any);
  const assignedClerkId = parseIntOrUndef(req.query.assignedClerkId as any);
  const assignedToUserId = parseIntOrUndef(req.query.assignedToUserId as any);
  const overdueDays = overdueDaysRaw ? Number(overdueDaysRaw) : undefined;

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
  if (titleType) {
    const parts = String(titleType).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) conditions.push(eq(casesTable.titleType, parts[0]));
    else conditions.push(or(...parts.map((p) => eq(casesTable.titleType, p))));
  }
  if (assignedLawyerId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
        AND ${caseAssignmentsTable.userId} = ${assignedLawyerId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (assignedClerkId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'clerk'
        AND ${caseAssignmentsTable.userId} = ${assignedClerkId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (assignedToUserId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.userId} = ${assignedToUserId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (spaStatus) {
    if (spaStatus === "NOA Served") {
      conditions.push(milestonePresenceWhereSql("noa_served_on", "filled"));
    } else if (spaStatus === "Completed") {
      conditions.push(milestonePresenceWhereSql("completion_date", "filled"));
    } else {
      conditions.push(sql`${spaStatusSql()} = ${spaStatus}`);
    }
  }
  if (loanStatus) {
    conditions.push(sql`${loanStatusSql()} = ${loanStatus}`);
  }
  if (milestone && milestonePresence) {
    if (milestonePresence === "filled" || milestonePresence === "missing") {
      if (loanOnlyMilestones.has(milestone)) {
        conditions.push(eq(casesTable.purchaseMode, "loan"));
      }
      conditions.push(milestonePresenceWhereSql(milestone as any, milestonePresence));
    } else if (milestonePresence === "completed" || milestonePresence === "pending") {
      conditions.push(milestonePresenceWhereSql(milestone as any, milestonePresence));
    }
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

  if (overdueDays === 7 || overdueDays === 14 || overdueDays === 30) {
    const overdue = overdueAnySql(overdueDays) ?? sql`FALSE`;
    conditions.push(overdue);
  }

  const sortBy = ((): "updatedAt" | "createdAt" | "referenceNo" | "spaDate" => {
    if (sortByRaw === "createdAt") return "createdAt";
    if (sortByRaw === "referenceNo") return "referenceNo";
    if (sortByRaw === "spaDate") return "spaDate";
    return "updatedAt";
  })();
  const sortDir = (sortDirRaw === "asc" || sortDirRaw === "desc") ? sortDirRaw : "desc";
  const primaryOrder = (() => {
    if (sortBy === "createdAt") return sortDir === "asc" ? asc(casesTable.createdAt) : desc(casesTable.createdAt);
    if (sortBy === "referenceNo") return sortDir === "asc" ? asc(casesTable.referenceNo) : desc(casesTable.referenceNo);
    if (sortBy === "spaDate") {
      const expr = milestoneDateYmdSql("spa_date");
      return sortDir === "asc" ? sql`${expr} ASC NULLS LAST` : sql`${expr} DESC NULLS LAST`;
    }
    return sortDir === "asc" ? asc(casesTable.updatedAt) : desc(casesTable.updatedAt);
  })();

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
  const lawyerNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const clerkNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'clerk'
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;

  const rows = await r
    .select({
      referenceNo: casesTable.referenceNo,
      projectName: projectsTable.name,
      developerName: developersTable.name,
      parcelNo: casesTable.parcelNo,
      clientName: purchaserNameSql,
      purchaserCount: purchaserCountSql,
      assignedLawyerName: lawyerNameSql,
      assignedClerkName: clerkNameSql,
      spaStatus: spaStatusSql(),
      loanStatus: loanStatusSql(),
      mSpaDate: milestoneDateYmdSql("spa_date"),
      mSpaStampedDate: milestoneDateYmdSql("spa_stamped_date"),
      mLetterOfOfferDate: milestoneDateYmdSql("letter_of_offer_date"),
      mLoanDocsSignedDate: milestoneDateYmdSql("loan_docs_signed_date"),
      mCompletionDate: milestoneDateYmdSql("completion_date"),
      updatedAt: casesTable.updatedAt,
    })
    .from(casesTable)
    .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .leftJoin(developersTable, eq(developersTable.id, casesTable.developerId))
    .leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)))
    .where(and(...conditions))
    .orderBy(primaryOrder, desc(casesTable.updatedAt));

  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="cases_export.csv"`);

  const header = [
    "Our Reference",
    "Client / Purchaser",
    "Project / Property",
    "Assigned Lawyer",
    "Assigned Clerk",
    "SPA Status",
    "Loan Status",
    "SPA Date",
    "SPA Stamped",
    "LOF Date",
    "Loan Docs Signed",
    "Completion Date",
    "Updated At",
  ].join(",") + "\n";
  res.write(header);

  for (const row of rows) {
    const purchaserCount = Number(row.purchaserCount ?? 0);
    const baseName = row.clientName ?? "";
    const clientDisplayName = baseName && purchaserCount > 1 ? `${baseName} +${purchaserCount - 1}` : baseName;
    const projectProperty = [row.projectName ?? "", row.parcelNo ?? ""].filter(Boolean).join(" / ");

    const line = [
      sanitizeCsvCell(row.referenceNo),
      sanitizeCsvCell(clientDisplayName),
      sanitizeCsvCell(projectProperty),
      sanitizeCsvCell(row.assignedLawyerName ?? ""),
      sanitizeCsvCell(row.assignedClerkName ?? ""),
      sanitizeCsvCell(row.spaStatus),
      sanitizeCsvCell(row.loanStatus ?? ""),
      sanitizeCsvCell(row.mSpaDate ?? ""),
      sanitizeCsvCell(row.mSpaStampedDate ?? ""),
      sanitizeCsvCell(row.mLetterOfOfferDate ?? ""),
      sanitizeCsvCell(row.mLoanDocsSignedDate ?? ""),
      sanitizeCsvCell(row.mCompletionDate ?? ""),
      sanitizeCsvCell(row.updatedAt.toISOString()),
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",") + "\n";
    res.write(line);
  }
  res.end();
}));

router.get("/cases", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  try {
    const r = rdb(req);
    const hasKeyDates = await tableExists(r, "public.case_key_dates");
    const hasWorkflowSteps = await tableExists(r, "public.case_workflow_steps");
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
  const sortByRaw = one(req.query.sortBy as any);
  const sortDirRaw = one(req.query.sortDir as any);
  const overdueDaysRaw = one(req.query.overdueDays as any);
  const assignedLawyerId = params.success ? params.data.assignedLawyerId : parseIntOrUndef(req.query.assignedLawyerId as any);
  const assignedClerkId = parseIntOrUndef(req.query.assignedClerkId as any);
  const assignedToUserId = parseIntOrUndef(req.query.assignedToUserId as any);
  const overdueDays = overdueDaysRaw ? Number(overdueDaysRaw) : undefined;

  const spaStatusExpr = hasWorkflowSteps ? spaStatusSql() : sql<string>`'Pending'`;
  const loanStatusExpr = hasWorkflowSteps ? loanStatusSql() : sql<string | null>`CASE WHEN ${casesTable.purchaseMode} = 'loan' THEN 'Pending' ELSE NULL END`;
  const mSpaDateExpr = hasKeyDates ? milestoneDateYmdSql("spa_date") : sql<string | null>`NULL`;
  const mSpaStampedDateExpr = hasKeyDates ? milestoneDateYmdSql("spa_stamped_date") : sql<string | null>`NULL`;
  const mLetterOfOfferDateExpr = hasKeyDates ? milestoneDateYmdSql("letter_of_offer_date") : sql<string | null>`NULL`;
  const mLoanDocsSignedDateExpr = hasKeyDates ? milestoneDateYmdSql("loan_docs_signed_date") : sql<string | null>`NULL`;
  const mCompletionDateExpr = hasKeyDates ? milestoneDateYmdSql("completion_date") : sql<string | null>`NULL`;

  const loanOnlyMilestones: Set<CaseMilestoneKey> = new Set([
    "letter_of_offer_date",
    "letter_of_offer_stamped_date",
    "loan_docs_signed_date",
    "acting_letter_issued_date",
    "loan_sent_bank_execution_date",
    "loan_bank_executed_date",
    "bank_lu_received_date",
    "advice_to_bank_date",
    "noa_served_on",
    "register_poa_on",
    "letter_disclaimer_dated",
    "loan_agreement_stamped_date",
    "bank_1st_release_on",
    "discharge_date",
    "caveat_lodged_date",
    "first_advice_date",
    "dev_informed_redemption_date",
    "request_discharge_date",
    "charge_date",
    "presentation_date",
    "second_advice_date",
  ]);

  const encumbranceOnlyWhenMissing: Set<CaseMilestoneKey> = new Set([
    "caveat_lodged_date",
    "first_advice_date",
    "dev_informed_redemption_date",
    "request_discharge_date",
    "discharge_date",
  ]);

  const conditions = [eq(casesTable.firmId, req.firmId!)];
  const canAssignAny = await hasRolePermission(r, req.firmId!, req.roleId, "cases", "assign_any");
  if (!canAssignAny) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.userId} = ${req.userId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (status) conditions.push(eq(casesTable.status, status));
  if (projectId) conditions.push(eq(casesTable.projectId, projectId));
  if (developerId) conditions.push(eq(casesTable.developerId, developerId));
  if (purchaseMode) conditions.push(eq(casesTable.purchaseMode, purchaseMode));
  if (titleType) {
    const parts = String(titleType).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) conditions.push(eq(casesTable.titleType, parts[0]));
    else conditions.push(or(...parts.map((p) => eq(casesTable.titleType, p))));
  }
  if (assignedLawyerId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
        AND ${caseAssignmentsTable.userId} = ${assignedLawyerId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (assignedClerkId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.roleInCase} = 'clerk'
        AND ${caseAssignmentsTable.userId} = ${assignedClerkId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (assignedToUserId) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${caseAssignmentsTable}
      WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
        AND ${caseAssignmentsTable.userId} = ${assignedToUserId}
        AND ${caseAssignmentsTable.unassignedAt} IS NULL
    )`);
  }
  if (spaStatus) {
    if (spaStatus === "NOA Served" && hasKeyDates) {
      conditions.push(milestonePresenceWhereSql("noa_served_on", "filled"));
    } else if (spaStatus === "Completed" && hasKeyDates) {
      conditions.push(milestonePresenceWhereSql("completion_date", "filled"));
    } else {
      conditions.push(sql`${spaStatusExpr} = ${spaStatus}`);
    }
  }
  if (loanStatus) {
    conditions.push(sql`${loanStatusExpr} = ${loanStatus}`);
  }
  if (hasKeyDates && milestone && milestonePresence && (milestonePresence === "filled" || milestonePresence === "missing")) {
    if (loanOnlyMilestones.has(milestone)) {
      conditions.push(eq(casesTable.purchaseMode, "loan"));
    }
    if (milestonePresence === "missing" && encumbranceOnlyWhenMissing.has(milestone)) {
      conditions.push(eq(casesTable.isEncumbered, true));
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

  if (hasKeyDates && (overdueDays === 7 || overdueDays === 14 || overdueDays === 30)) {
    const overdue = overdueAnySql(overdueDays) ?? sql`FALSE`;
    conditions.push(overdue);
  }

  const sortBy = ((): "updatedAt" | "createdAt" | "referenceNo" | "spaDate" => {
    if (sortByRaw === "createdAt") return "createdAt";
    if (sortByRaw === "referenceNo") return "referenceNo";
    if (sortByRaw === "spaDate") return "spaDate";
    return "updatedAt";
  })();
  const sortDir = (sortDirRaw === "asc" || sortDirRaw === "desc") ? sortDirRaw : "desc";
  const primaryOrder = (() => {
    if (sortBy === "createdAt") return sortDir === "asc" ? asc(casesTable.createdAt) : desc(casesTable.createdAt);
    if (sortBy === "referenceNo") return sortDir === "asc" ? asc(casesTable.referenceNo) : desc(casesTable.referenceNo);
    if (sortBy === "spaDate") {
      if (!hasKeyDates) return sortDir === "asc" ? asc(casesTable.updatedAt) : desc(casesTable.updatedAt);
      return sortDir === "asc" ? sql`${mSpaDateExpr} ASC NULLS LAST` : sql`${mSpaDateExpr} DESC NULLS LAST`;
    }
    return sortDir === "asc" ? asc(casesTable.updatedAt) : desc(casesTable.updatedAt);
  })();

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
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const lawyerNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const clerkIdSql = sql<number | null>`(
    SELECT ${caseAssignmentsTable.userId}
    FROM ${caseAssignmentsTable}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'clerk'
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const clerkNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'clerk'
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;

  let rowsQuery = r
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
      spaStatus: spaStatusExpr,
      loanStatus: loanStatusExpr,
      mSpaDate: mSpaDateExpr,
      mSpaStampedDate: mSpaStampedDateExpr,
      mLetterOfOfferDate: mLetterOfOfferDateExpr,
      mLoanDocsSignedDate: mLoanDocsSignedDateExpr,
      mCompletionDate: mCompletionDateExpr,
    })
    .from(casesTable)
    .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .leftJoin(developersTable, eq(developersTable.id, casesTable.developerId));

  if (hasKeyDates) {
    rowsQuery = rowsQuery.leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)));
  }

  const rows = await rowsQuery
    .where(and(...conditions))
    .orderBy(primaryOrder, desc(casesTable.updatedAt))
    .limit(limit)
    .offset(offset);

  let totalQuery = r
    .select({ c: sql<number>`COUNT(DISTINCT ${casesTable.id})` })
    .from(casesTable)
    .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .leftJoin(developersTable, eq(developersTable.id, casesTable.developerId));

  if (hasKeyDates) {
    totalQuery = totalQuery.leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)));
  }

  const [totalRes] = await totalQuery.where(and(...conditions));

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
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, query: req.query }, "[cases]");
    res.status(500).json({ error: "Internal Server Error" });
  }
}));

router.post("/cases", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "create") as RequestHandler, authed(async (req, res) => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "POST /api/cases", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const createCaseSchema = z.object({
      projectId: z.coerce.number().int().positive(),
      developerId: z.coerce.number().int().positive().optional(),
      purchaseMode: z.string().transform((v) => v.trim().toLowerCase()),
      titleType: z.string().transform((v) => v.trim().toLowerCase()),
      spaPrice: z.coerce.number().optional(),
      assignedLawyerId: z.coerce.number().int().positive().optional(),
      assignedClerkId: z.coerce.number().int().positive().optional(),
      purchaserIds: z.array(z.coerce.number().int().positive()).optional(),
      purchasers: z.array(z.object({
        name: z.string(),
        ic: z.string().nullish(),
      })).optional(),
      loanPartyType: z.enum(["1st_party", "3rd_party"]).optional(),
      borrowers: z.array(z.object({
        name: z.string(),
        ic: z.string().nullish(),
        address: z.string().optional().transform((v) => (v ?? "").trim()),
      })).optional(),
    }).superRefine((v, ctx) => {
      if (v.purchaseMode !== "loan" && v.purchaseMode !== "cash") {
        ctx.addIssue({ code: "custom", path: ["purchaseMode"], message: "Invalid purchaseMode" });
      }
      const normalizedTitleType = normalizeTitleType(v.titleType);
      if (!normalizedTitleType) {
        ctx.addIssue({ code: "custom", path: ["titleType"], message: "Invalid titleType" });
      }
      const purchaserIds = v.purchaserIds ?? [];
      const hasPurchaserIds = purchaserIds.length > 0;
      const hasInlinePurchasers = Array.isArray(v.purchasers) && v.purchasers.some((p) => (p?.name ?? "").trim().length > 0);
      if (!hasPurchaserIds && !hasInlinePurchasers) {
        ctx.addIssue({ code: "custom", path: ["purchasers"], message: "At least one purchaser name is required" });
      }
      if (v.purchaseMode === "loan" && v.loanPartyType === "3rd_party") {
        const borrowers = Array.isArray(v.borrowers) ? v.borrowers : [];
        const hasBorrowers = borrowers.some((b) => (b?.name ?? "").trim().length > 0);
        if (!hasBorrowers) {
          ctx.addIssue({ code: "custom", path: ["borrowers"], message: "At least one borrower name is required for 3rd-party loan" });
        }
      }
    });

    const parsed = createCaseSchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({
        route: "POST /api/cases",
        firmId: req.firmId,
        userId: req.userId,
        fields: parsed.error.flatten().fieldErrors,
      }, "cases.create validation failed");
      res.status(400).json({ error: "Validation failed", fields: parsed.error.flatten().fieldErrors });
      return;
    }

    const { projectId, developerId: clientDeveloperId, purchaseMode, titleType, spaPrice, assignedLawyerId, assignedClerkId, purchaserIds, purchasers, loanPartyType, borrowers: requestedBorrowers } = parsed.data;
    const canAssignAny = await hasRolePermission(r, req.firmId!, req.roleId, "cases", "assign_any");
    const normalizedAssignedLawyerId = assignedLawyerId ?? undefined;
    const normalizedAssignedClerkId = assignedClerkId ?? undefined;
    if (canAssignAny && !normalizedAssignedLawyerId) {
      res.status(400).json({ error: "assignedLawyerId is required" });
      return;
    }
    if (!canAssignAny) {
      if (normalizedAssignedLawyerId !== undefined && normalizedAssignedLawyerId !== req.userId) {
        res.status(403).json({ error: "You cannot assign cases to other users" });
        return;
      }
      if (normalizedAssignedClerkId !== undefined && normalizedAssignedClerkId !== req.userId) {
        res.status(403).json({ error: "You cannot assign cases to other users" });
        return;
      }
    }

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
    const projectTitleType = normalizeTitleType(String((project as any).titleType ?? "")) ?? "master";
    const projectIsEncumbered = Boolean((project as any).isEncumbered ?? false);
    const projectTenure = (typeof (project as any).tenure === "string" && (String((project as any).tenure) === "leasehold" || String((project as any).tenure) === "freehold"))
      ? String((project as any).tenure)
      : "freehold";
    const normalizedTitleType = projectTitleType;

    const usersToCheck = [normalizedAssignedLawyerId, ...(normalizedAssignedClerkId ? [normalizedAssignedClerkId] : [])].filter((x): x is number => Number.isFinite(x));
    if (usersToCheck.length > 0) {
      const found = await r
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.firmId, req.firmId!), inArray(usersTable.id, usersToCheck)));
      const foundIds = new Set(found.map((u) => u.id));
      if (normalizedAssignedLawyerId !== undefined && !foundIds.has(normalizedAssignedLawyerId)) {
        res.status(400).json({ error: "Assigned lawyer not found" });
        return;
      }
      if (normalizedAssignedClerkId && !foundIds.has(normalizedAssignedClerkId)) {
        res.status(400).json({ error: "Assigned clerk not found" });
        return;
      }
    }

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
            createdBy: req.userId ?? null,
          } satisfies typeof clientsTable.$inferInsert;

          let client: typeof clientsTable.$inferSelect;
          [client] = await r
            .insert(clientsTable)
            .values(insertBase)
            .returning();
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

    const normalizeBorrowers = (raw: unknown): Array<{ name: string; ic?: string; address: string }> => {
      if (!Array.isArray(raw)) return [];
      const out: Array<{ name: string; ic?: string; address: string }> = [];
      for (const v of raw) {
        const name = typeof (v as any)?.name === "string" ? String((v as any).name).trim() : "";
        if (!name) continue;
        const icRaw = (v as any)?.ic;
        const ic = typeof icRaw === "string" ? icRaw.trim() : "";
        const addressRaw = (v as any)?.address;
        const address = typeof addressRaw === "string" ? addressRaw.trim() : "";
        out.push(ic ? { name, ic, address } : { name, address });
      }
      return out;
    };

    const normalizedRequestedBorrowers = normalizeBorrowers(requestedBorrowers);
    const isLoan = purchaseMode === "loan";
    const effectiveLoanPartyType: "1st_party" | "3rd_party" = isLoan ? (loanPartyType ?? "1st_party") : "1st_party";
    let borrowersToStore: Array<{ name: string; ic?: string; address: string }> = [];

    if (isLoan) {
      if (effectiveLoanPartyType === "1st_party") {
        const rows = await r
          .select({ id: clientsTable.id, name: clientsTable.name, ic: clientsTable.icNo, address: clientsTable.address })
          .from(clientsTable)
          .where(and(eq(clientsTable.firmId, req.firmId!), inArray(clientsTable.id, resolvedPurchaserIds)));
        const byId = new Map<number, { name: string; ic: string | null; address: string | null }>();
        for (const row of rows) byId.set(row.id, { name: String(row.name ?? ""), ic: row.ic ?? null, address: row.address ?? null });
        borrowersToStore = resolvedPurchaserIds
          .map((id) => {
            const v = byId.get(id);
            const name = v?.name?.trim() ?? "";
            const ic = v?.ic ? String(v.ic).trim() : "";
            const address = v?.address ? String(v.address).trim() : "";
            return ic ? { name, ic, address } : { name, address };
          })
          .filter((b) => b.name.trim().length > 0);
      } else {
        borrowersToStore = normalizedRequestedBorrowers;
        if (borrowersToStore.length === 0 && loanDetails && typeof loanDetails === "object") {
          const ld: any = loanDetails as any;
          const b1 = typeof ld.borrower1Name === "string" ? ld.borrower1Name.trim() : "";
          const i1 = typeof ld.borrower1Ic === "string" ? ld.borrower1Ic.trim() : "";
          const b2 = typeof ld.borrower2Name === "string" ? ld.borrower2Name.trim() : "";
          const i2 = typeof ld.borrower2Ic === "string" ? ld.borrower2Ic.trim() : "";
          const fallback: Array<{ name: string; ic?: string; address: string }> = [];
          if (b1) fallback.push(i1 ? { name: b1, ic: i1, address: "" } : { name: b1, address: "" });
          if (b2) fallback.push(i2 ? { name: b2, ic: i2, address: "" } : { name: b2, address: "" });
          borrowersToStore = fallback;
        }
      }
    }

    const insertCaseBase = {
      firmId: req.firmId!,
      projectId,
      developerId,
      referenceNo: refNo,
      purchaseMode,
      titleType: normalizedTitleType,
      isEncumbered: projectIsEncumbered,
      tenure: projectTenure,
      spaPrice: spaPrice !== undefined ? String(spaPrice) : null,
      status: "File Opened / SPA Pending Signing",
      caseType: caseType ?? null,
      parcelNo: parcelNo ?? null,
      spaDetails: spaDetails ? JSON.stringify(spaDetails) : null,
      propertyDetails: propertyDetails ? JSON.stringify(propertyDetails) : null,
      loanDetails: loanDetails ? JSON.stringify(loanDetails) : null,
      loanPartyType: purchaseMode === "loan" ? (loanPartyType ?? "1st_party") : "1st_party",
      borrowers: borrowersToStore,
      companyDetails: companyDetails ? JSON.stringify(companyDetails) : null,
      createdBy: req.userId ?? null,
    } satisfies typeof casesTable.$inferInsert;

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
    req.log.info({
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
      .values(insertCaseBase)
      .returning();

    for (let i = 0; i < resolvedPurchaserIds.length; i++) {
      await r.insert(casePurchasersTable).values({
        caseId: newCase.id,
        clientId: resolvedPurchaserIds[i],
        role: i === 0 ? "main" : "joint",
        orderNo: i + 1,
      });
    }

    const isSelfAssignOnly = !canAssignAny;
    if (isSelfAssignOnly) {
      await r.insert(caseAssignmentsTable).values({
        caseId: newCase.id,
        userId: req.userId!,
        roleInCase: "clerk",
        assignedBy: req.userId,
      });
    } else {
      if (!normalizedAssignedLawyerId) {
        res.status(400).json({ error: "assignedLawyerId is required" });
        return;
      }
      await r.insert(caseAssignmentsTable).values({
        caseId: newCase.id,
        userId: normalizedAssignedLawyerId,
        roleInCase: "lawyer",
        assignedBy: req.userId,
      });
      if (normalizedAssignedClerkId) {
        await r.insert(caseAssignmentsTable).values({
          caseId: newCase.id,
          userId: normalizedAssignedClerkId,
          roleInCase: "clerk",
          assignedBy: req.userId,
        });
      }
    }

    const workflowSteps = buildWorkflowSteps(purchaseMode, normalizedTitleType);
    if (workflowSteps.length > 0) {
      const wfExists = await tableExists(r, "public.case_workflow_steps");
      if (wfExists) {
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
    req.log.error({ err: e, pg }, "cases.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
}));

router.get("/cases/:caseId", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
    if (!ok) return;
    const [c] = await r
      .select()
      .from(casesTable)
      .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
    if (!c) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    res.json(await formatCaseDetail(r, c));
  } catch (e) {
    console.error("SQL ERR:", e);
    logger.error({ err: e, firmId: req.firmId, userId: req.userId, caseId: params.data.caseId }, "[cases] get case failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
}));

router.get("/cases/:caseId/key-dates", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const kdExists = await tableExists(r, "public.case_key_dates");
  if (!kdExists) {
    res.json({});
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;
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
    discharge_date: kd.dischargeDate ? String(kd.dischargeDate) : null,
    caveat_lodged_date: kd.caveatLodgedDate ? String(kd.caveatLodgedDate) : null,
    first_advice_date: kd.firstAdviceDate ? String(kd.firstAdviceDate) : null,
    dev_informed_redemption_date: kd.devInformedRedemptionDate ? String(kd.devInformedRedemptionDate) : null,
    request_discharge_date: kd.requestDischargeDate ? String(kd.requestDischargeDate) : null,
    charge_date: kd.chargeDate ? String(kd.chargeDate) : null,
    presentation_date: kd.presentationDate ? String(kd.presentationDate) : null,
    second_advice_date: kd.secondAdviceDate ? String(kd.secondAdviceDate) : null,
    consent_to_transfer_date: kd.consentToTransferDate ? String(kd.consentToTransferDate) : null,
    consent_to_charge_date: kd.consentToChargeDate ? String(kd.consentToChargeDate) : null,
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
}));

router.get("/cases/:caseId/progress", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  try {
    const r = req.rlsDb;
    if (!r) {
      logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const caseIdStr = one((req.params as any).caseId);
    const caseId = caseIdStr ? Number(caseIdStr) : NaN;
    if (!Number.isInteger(caseId) || caseId <= 0) {
      res.status(400).json({ error: "Invalid caseId" });
      return;
    }

    const ok = await enforceCaseAccess(r, req, res, caseId);
    if (!ok) return;

    const [caseRow] = await r
      .select({ purchaseMode: casesTable.purchaseMode, titleType: casesTable.titleType })
      .from(casesTable)
      .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, req.firmId!)));
    if (!caseRow) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    await ensureCaseWorkflowSteps(r, req.firmId!, caseId);

    const kdExists = await tableExists(r, "public.case_key_dates");
    let kd: typeof caseKeyDatesTable.$inferSelect | undefined;
    if (kdExists) {
      [kd] = await r
        .select()
        .from(caseKeyDatesTable)
        .where(and(eq(caseKeyDatesTable.caseId, caseId), eq(caseKeyDatesTable.firmId, req.firmId!)));
    }

  const docsExists = await tableExists(r, "public.case_workflow_documents");
  const workflowDocsRows = docsExists
    ? await r
        .select({
          milestoneKey: caseWorkflowDocumentsTable.milestoneKey,
          objectPath: caseWorkflowDocumentsTable.objectPath,
          fileName: caseWorkflowDocumentsTable.fileName,
          updatedAt: caseWorkflowDocumentsTable.updatedAt,
        })
        .from(caseWorkflowDocumentsTable)
        .where(and(
          eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
          eq(caseWorkflowDocumentsTable.caseId, caseId),
          sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
        ))
        .orderBy(desc(caseWorkflowDocumentsTable.updatedAt))
    : [];
  const workflowDocsByKey = new Map<string, { hasFile: boolean }>();
  for (const d of workflowDocsRows) {
    const normalized = normalizeWorkflowDocumentKeyFromDb(String(d.milestoneKey));
    if (!normalized) continue;
    if (workflowDocsByKey.has(normalized)) continue;
    workflowDocsByKey.set(normalized, { hasFile: Boolean(d.objectPath && d.fileName) });
  }

  const inputs = {
    keyDates: {
      spa_signed_date: kd?.spaSignedDate ? String(kd.spaSignedDate) : null,
      spa_stamped_date: kd?.spaStampedDate ? String(kd.spaStampedDate) : null,
      letter_of_offer_stamped_date: kd?.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
      loan_docs_signed_date: kd?.loanDocsSignedDate ? String(kd.loanDocsSignedDate) : null,
      acting_letter_issued_date: kd?.actingLetterIssuedDate ? String(kd.actingLetterIssuedDate) : null,
      loan_sent_bank_execution_date: kd?.loanSentBankExecutionDate ? String(kd.loanSentBankExecutionDate) : null,
      loan_bank_executed_date: kd?.loanBankExecutedDate ? String(kd.loanBankExecutedDate) : null,
      bank_lu_received_date: kd?.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
      noa_served_on: kd?.noaServedOn ? String(kd.noaServedOn) : null,
      register_poa_on: kd?.registerPoaOn ? String(kd.registerPoaOn) : null,
      letter_disclaimer_dated: kd?.letterDisclaimerDated ? String(kd.letterDisclaimerDated) : null,
      completion_date: kd?.completionDate ? String(kd.completionDate) : null,
    },
    workflowDocs: {
      spa_stamped: workflowDocsByKey.get("spa_stamped"),
      lo_stamped: workflowDocsByKey.get("lo_stamped"),
      register_poa: workflowDocsByKey.get("register_poa"),
      letter_disclaimer: workflowDocsByKey.get("letter_disclaimer"),
    } as any,
  };

  const wfExists = await tableExists(r, "public.case_workflow_steps");
  const steps = wfExists
    ? await r
        .select({
          stepKey: caseWorkflowStepsTable.stepKey,
          status: caseWorkflowStepsTable.status,
          pathType: caseWorkflowStepsTable.pathType,
          stepOrder: caseWorkflowStepsTable.stepOrder,
        })
        .from(caseWorkflowStepsTable)
        .where(eq(caseWorkflowStepsTable.caseId, caseId))
    : [];
  const stepStatusByKey = new Map<string, { status: string; pathType: string; stepOrder: number }>();
  for (const s of steps) stepStatusByKey.set(String(s.stepKey), { status: String(s.status), pathType: String(s.pathType), stepOrder: Number(s.stepOrder) });

  const derivedSteps = Array.from(stepStatusByKey.entries()).map(([stepKey, v]) => {
    const reqRule = WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY[stepKey];
    const derived = reqRule ? deriveStatusFromRequirement(reqRule, inputs) : null;
    return {
      stepKey,
      status: v.status,
      pathType: v.pathType,
      stepOrder: v.stepOrder,
      derivedStatus: derived,
    };
  });

  const purchaseMode = String(caseRow.purchaseMode || "").trim().toLowerCase();
  const titleType = normalizeTitleType(caseRow.titleType);

  const stampingExists = await tableExists(r, "public.case_loan_stamping_items");
  const stampingRows = stampingExists
    ? await r
        .select({
          id: caseLoanStampingItemsTable.id,
          itemKey: caseLoanStampingItemsTable.itemKey,
          customName: caseLoanStampingItemsTable.customName,
          datedOn: caseLoanStampingItemsTable.datedOn,
          stampedOn: caseLoanStampingItemsTable.stampedOn,
          objectPath: caseLoanStampingItemsTable.objectPath,
          fileName: caseLoanStampingItemsTable.fileName,
          sortOrder: caseLoanStampingItemsTable.sortOrder,
        })
        .from(caseLoanStampingItemsTable)
        .where(and(
          eq(caseLoanStampingItemsTable.firmId, req.firmId!),
          eq(caseLoanStampingItemsTable.caseId, caseId),
          sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`,
        ))
        .orderBy(asc(caseLoanStampingItemsTable.sortOrder), asc(caseLoanStampingItemsTable.id))
    : [];

  const fixedKeys: LoanStampingItemKey[] = ["facility_agreement", "deed_of_assignment", "power_of_attorney", "charge_annexure"];
  const fixed: StampingItemInput[] = [];
  for (const k of fixedKeys) {
    if (!isLoanStampingItemKeyAllowedForTitleType(titleType, k)) continue;
    const row = stampingRows.find((x) => String(x.itemKey) === k);
    fixed.push({
      id: row?.id ?? null,
      itemKey: k,
      customName: null,
      datedOn: row?.datedOn ? String(row.datedOn) : null,
      stampedOn: row?.stampedOn ? String(row.stampedOn) : null,
      hasFile: Boolean(row?.objectPath && row?.fileName),
      sortOrder: row?.sortOrder ?? 0,
    });
  }
  const others: StampingItemInput[] = stampingRows
    .filter((x) => String(x.itemKey) === "other")
    .map((x) => ({
      id: x.id,
      itemKey: "other",
      customName: x.customName ?? null,
      datedOn: x.datedOn ? String(x.datedOn) : null,
      stampedOn: x.stampedOn ? String(x.stampedOn) : null,
      hasFile: Boolean(x.objectPath && x.fileName),
      sortOrder: x.sortOrder ?? 0,
    }));
  const stampingSummary = purchaseMode === "loan"
    ? computeStampingSummary(titleType, [...fixed, ...others])
    : { completed: 0, total: 0, missing: [] as any[] };

  const section = (key: string, label: string, milestoneTab: "spa" | "loan" | "bank" | "mot", stepKeys: string[], extra?: { completed: number; total: number }) => {
    let completed = 0;
    let total = 0;
    for (const k of stepKeys) {
      const s = stepStatusByKey.get(k);
      if (!s) continue;
      total++;
      if (s.status === "completed") completed++;
    }
    if (extra) {
      completed += extra.completed;
      total += extra.total;
    }
    return { key, label, completed, total, target: { tab: "overview", milestoneTab } };
  };

  const spaStepKeys = ["file_opened", "spa_stamped", "lof_stamped"];
  const loanStepKeys = purchaseMode === "loan"
    ? ["loan_docs_pending", "loan_docs_signed", "acting_letter_pending", "acting_letter_issued", "loan_pending_bank_exec", "loan_sent_bank_exec", "loan_bank_executed"]
    : [];
  const bankStepKeys = purchaseMode === "loan"
    ? (titleType === "master"
        ? ["blu_received", "blu_confirmed", "noa_prepare", "noa_served", "pa_pending", "pa_registered", "letter_disclaimer"]
        : ["blu_received", "blu_confirmed"])
    : (titleType === "master" ? ["noa_prepare", "noa_served", "pa_pending", "pa_registered", "letter_disclaimer"] : []);
  const motStepKeys = titleType === "strata" || titleType === "individual"
    ? ["mot_pending", "mot_received", "mot_invoice_prepare", "mot_stamp_received", "mot_submitted_stamping", "mot_stamp"]
    : [];
  const completionCompleted = inputs.keyDates.completion_date ? 1 : 0;
  const completionTotal = 1;

  const sections = [
    section("spa", "SPA progress", "spa", spaStepKeys),
    section("loan", "Loan progress", "loan", loanStepKeys, purchaseMode === "loan" ? stampingSummary : undefined),
    section("bank", "Bank / LU / NOA progress", "bank", bankStepKeys),
    { ...section("mot", "MOT / Completion progress", "mot", motStepKeys, { completed: completionCompleted, total: completionTotal }), completionDate: inputs.keyDates.completion_date ? "completed" : "missing_date" },
  ];

  res.json({
    sections,
    workflowSteps: derivedSteps.sort((a, b) => a.stepOrder - b.stepOrder),
    attachments: [
      { docKey: "spa_stamped", label: "SPA Stamped", status: deriveStatusFromRequirement(WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY["spa_stamped"], inputs) },
      { docKey: "lo_stamped", label: "LO Stamped", status: deriveStatusFromRequirement(WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY["lof_stamped"], inputs) },
      { docKey: "register_poa", label: "Register POA", status: deriveStatusFromRequirement(WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY["pa_registered"], inputs) },
      { docKey: "letter_disclaimer", label: "Letter Disclaimer", status: deriveStatusFromRequirement(WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY["letter_disclaimer"], inputs) },
    ],
    stamping: stampingSummary,
    stampingItems: purchaseMode === "loan"
      ? [...fixed, ...others].map((x) => ({ id: x.id, itemKey: x.itemKey, sortOrder: x.sortOrder, status: deriveStampingItemStatus(x) }))
      : [],
  });
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] progress failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
}));

router.patch("/cases/:caseId/key-dates", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = UpdateCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;
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
    discharge_date: "dischargeDate",
    caveat_lodged_date: "caveatLodgedDate",
    first_advice_date: "firstAdviceDate",
    dev_informed_redemption_date: "devInformedRedemptionDate",
    request_discharge_date: "requestDischargeDate",
    charge_date: "chargeDate",
    presentation_date: "presentationDate",
    second_advice_date: "secondAdviceDate",
    consent_to_transfer_date: "consentToTransferDate",
    consent_to_charge_date: "consentToChargeDate",
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
  await syncWorkflowStepsFromCaseState(r, params.data.caseId, {
    firmId: req.firmId!,
    actorId: req.userId,
    actorType: req.userType ?? "firm_user",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

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
    discharge_date: kd.dischargeDate ? String(kd.dischargeDate) : null,
    caveat_lodged_date: kd.caveatLodgedDate ? String(kd.caveatLodgedDate) : null,
    first_advice_date: kd.firstAdviceDate ? String(kd.firstAdviceDate) : null,
    dev_informed_redemption_date: kd.devInformedRedemptionDate ? String(kd.devInformedRedemptionDate) : null,
    request_discharge_date: kd.requestDischargeDate ? String(kd.requestDischargeDate) : null,
    charge_date: kd.chargeDate ? String(kd.chargeDate) : null,
    presentation_date: kd.presentationDate ? String(kd.presentationDate) : null,
    second_advice_date: kd.secondAdviceDate ? String(kd.secondAdviceDate) : null,
    mot_received_date: kd.motReceivedDate ? String(kd.motReceivedDate) : null,
    mot_signed_date: kd.motSignedDate ? String(kd.motSignedDate) : null,
    mot_stamped_date: kd.motStampedDate ? String(kd.motStampedDate) : null,
    mot_registered_date: kd.motRegisteredDate ? String(kd.motRegisteredDate) : null,
    progressive_payment_date: kd.progressivePaymentDate ? String(kd.progressivePaymentDate) : null,
    full_settlement_date: kd.fullSettlementDate ? String(kd.fullSettlementDate) : null,
    completion_date: kd.completionDate ? String(kd.completionDate) : null,
  } : {});
}));

router.patch("/cases/:caseId", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = UpdateCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

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
  if (parsed.data.lawyerStatus !== undefined) {
    updates.lawyerStatus = parsed.data.lawyerStatus;
    updates.lawyerStatusUpdatedAt = new Date();
  }

  const wantsAssignLawyer = parsed.data.assignedLawyerId !== undefined;
  const wantsAssignClerk = (parsed.data as any)?.assignedClerkId !== undefined;
  if (wantsAssignLawyer || wantsAssignClerk) {
    const [roleRow] = await r
      .select({ name: rolesTable.name })
      .from(rolesTable)
      .where(and(eq(rolesTable.id, req.roleId!), eq(rolesTable.firmId, req.firmId!)))
      .limit(1);
    const roleName = String(roleRow?.name ?? "");
    const canEditAssignments = roleName === "Partner" || roleName === "Manager" || roleName.startsWith("Manager");
    if (!canEditAssignments) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  if (wantsAssignLawyer) {
    await r.update(caseAssignmentsTable)
      .set({ unassignedAt: new Date() })
      .where(and(eq(caseAssignmentsTable.caseId, params.data.caseId), eq(caseAssignmentsTable.roleInCase, "lawyer"), sql`${caseAssignmentsTable.unassignedAt} IS NULL`));
    await r.insert(caseAssignmentsTable).values({
      caseId: params.data.caseId,
      userId: parsed.data.assignedLawyerId,
      roleInCase: "lawyer",
      assignedBy: req.userId,
    });
  }
  if (wantsAssignClerk) {
    const assignedClerkId = (parsed.data as any).assignedClerkId as number | null | undefined;
    await r.update(caseAssignmentsTable)
      .set({ unassignedAt: new Date() })
      .where(and(eq(caseAssignmentsTable.caseId, params.data.caseId), eq(caseAssignmentsTable.roleInCase, "clerk"), sql`${caseAssignmentsTable.unassignedAt} IS NULL`));
    if (assignedClerkId !== null && assignedClerkId !== undefined) {
      await r.insert(caseAssignmentsTable).values({
        caseId: params.data.caseId,
        userId: assignedClerkId,
        roleInCase: "clerk",
        assignedBy: req.userId,
      });
    }
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
}));

router.get("/cases/:caseId/workflow-documents", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  if (!Number.isFinite(caseId)) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const milestoneKey = one((req.query as any).milestoneKey);
  if (milestoneKey && !WORKFLOW_DOCUMENT_ALLOWED_KEYS.has(milestoneKey)) {
    res.status(422).json({ error: "Invalid milestoneKey" });
    return;
  }
  const exists = await tableExists(r, "public.case_workflow_documents");
  if (!exists) {
    res.json([]);
    return;
  }
  const whereBase = and(
    eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
    eq(caseWorkflowDocumentsTable.caseId, caseId),
    sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
  );
  const milestoneKeyFilter = milestoneKey
    ? [milestoneKey, ...workflowDocumentLegacyKeys(milestoneKey as WorkflowDocumentMilestoneKey)]
    : null;
  const rows = await r
    .select({
      id: caseWorkflowDocumentsTable.id,
      caseId: caseWorkflowDocumentsTable.caseId,
      milestoneKey: caseWorkflowDocumentsTable.milestoneKey,
      label: caseWorkflowDocumentsTable.label,
      dateValue: caseWorkflowDocumentsTable.dateValue,
      fileName: caseWorkflowDocumentsTable.fileName,
      mimeType: caseWorkflowDocumentsTable.mimeType,
      fileSize: caseWorkflowDocumentsTable.fileSize,
      createdAt: caseWorkflowDocumentsTable.createdAt,
      updatedAt: caseWorkflowDocumentsTable.updatedAt,
    })
    .from(caseWorkflowDocumentsTable)
    .where(milestoneKeyFilter ? and(whereBase, inArray(caseWorkflowDocumentsTable.milestoneKey, milestoneKeyFilter)) : whereBase)
    .orderBy(desc(caseWorkflowDocumentsTable.updatedAt));
  const seen = new Set<string>();
  const out = [];
  for (const x of rows) {
    const normalized = normalizeWorkflowDocumentKeyFromDb(String(x.milestoneKey));
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      ...x,
      milestoneKey: normalized,
      label: workflowDocumentLabel(normalized) ?? x.label,
      dateValue: x.dateValue ? String(x.dateValue) : null,
      createdAt: x.createdAt ? toIsoStringSafeOrNull(x.createdAt) : null,
      updatedAt: x.updatedAt ? toIsoStringSafeOrNull(x.updatedAt) : null,
    });
  }
  res.json(out);
}));

router.post("/cases/:caseId/workflow-documents", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  if (!Number.isFinite(caseId)) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const body = asObject(req.body) ?? {};
  const milestoneKey = asString(body.milestoneKey);
  const objectPath = asString(body.objectPath);
  const fileName = asString(body.fileName);
  const mimeType = asString(body.mimeType);
  const fileSize = asNumber(body.fileSize);
  const dateYmd = body.dateYmd;

  if (!milestoneKey || !WORKFLOW_DOCUMENT_ALLOWED_KEYS.has(milestoneKey)) {
    res.status(422).json({ error: "Invalid milestoneKey" });
    return;
  }
  const resolvedLabel = workflowDocumentLabel(milestoneKey);
  if (!resolvedLabel) {
    res.status(422).json({ error: "Invalid milestoneKey" });
    return;
  }
  if (!objectPath || !objectPath.startsWith(`/objects/cases/${req.firmId}/case-${caseId}/workflow/${milestoneKey}/`)) {
    res.status(400).json({ error: "Invalid objectPath" });
    return;
  }
  if (!fileName?.trim()) {
    res.status(400).json({ error: "Missing fileName" });
    return;
  }
  const ext = fileExtLower(fileName);
  if (!CASE_ATTACHMENT_ALLOWED_EXTENSIONS.has(ext)) {
    res.status(422).json({ error: "Unsupported file type. Allowed: pdf, doc, docx, jpg, jpeg, png" });
    return;
  }
  const parsedDate = Object.prototype.hasOwnProperty.call(body, "dateYmd") ? parseDateOnlyInput(dateYmd) : undefined;
  if (parsedDate === undefined && Object.prototype.hasOwnProperty.call(body, "dateYmd")) {
    res.status(422).json({ error: "Invalid dateYmd" });
    return;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const exists = await tableExists(r, "public.case_workflow_documents");
  if (!exists) {
    res.status(503).json({ error: "Workflow documents not available" });
    return;
  }

  const now = new Date();
  const legacyKeys = workflowDocumentLegacyKeys(milestoneKey as WorkflowDocumentMilestoneKey);
  const selectExisting = async (keys: string[]) => (await r
    .select({ id: caseWorkflowDocumentsTable.id, objectPath: caseWorkflowDocumentsTable.objectPath, milestoneKey: caseWorkflowDocumentsTable.milestoneKey })
    .from(caseWorkflowDocumentsTable)
    .where(and(
      eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
      eq(caseWorkflowDocumentsTable.caseId, caseId),
      inArray(caseWorkflowDocumentsTable.milestoneKey, keys),
      sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
    ))
    .limit(1))[0];
  const existing = (await selectExisting([milestoneKey])) ?? (legacyKeys.length ? await selectExisting(legacyKeys) : undefined);

  const namingCtx = await buildSmartNamingContext(r, req.firmId!, caseId);
  const smartFileName = resolveSmartFilename({
    ctx: {
      caseId,
      firmId: req.firmId!,
      caseReferenceNo: namingCtx.referenceNo,
      parcelNo: namingCtx.parcelNo,
      clientName: namingCtx.clientName,
      projectName: namingCtx.projectName,
      developerName: namingCtx.developerName,
      documentName: resolvedLabel,
      templateName: "",
      status: namingCtx.status,
      titleType: namingCtx.titleType,
      loanBank: namingCtx.loanBank,
      sequence: 1,
    },
    rule: null,
    originalFileNameOrExt: fileName.trim(),
    fallbackExt: ext,
  }).fileName;

  const baseUpdate: Partial<typeof caseWorkflowDocumentsTable.$inferInsert> = {
    milestoneKey,
    label: resolvedLabel,
    dateValue: typeof parsedDate === "string" ? parsedDate : null,
    objectPath,
    fileName: smartFileName,
    mimeType: mimeType ?? null,
    fileSize: fileSize ?? null,
    uploadedBy: req.userId ?? null,
    updatedAt: now,
  };

  const row = existing
    ? (await r.update(caseWorkflowDocumentsTable)
        .set(baseUpdate)
        .where(and(eq(caseWorkflowDocumentsTable.id, existing.id), eq(caseWorkflowDocumentsTable.firmId, req.firmId!), eq(caseWorkflowDocumentsTable.caseId, caseId)))
        .returning())[0]
    : (await r.insert(caseWorkflowDocumentsTable).values({
        firmId: req.firmId!,
        caseId,
        milestoneKey,
        label: resolvedLabel,
        dateValue: typeof parsedDate === "string" ? parsedDate : null,
        objectPath,
        fileName: smartFileName,
        mimeType: mimeType ?? null,
        fileSize: fileSize ?? null,
        uploadedBy: req.userId ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning())[0];

  if (existing?.objectPath && existing.objectPath !== objectPath) {
    try {
      await supabaseStorage.deletePrivateObject(existing.objectPath);
    } catch (err) {
      if (!(err instanceof ObjectNotFoundError) && !getSupabaseStorageConfigError(err)) {
        logger.warn({ err, firmId: req.firmId, userId: req.userId, caseId, milestoneKey }, "[cases] workflow_document_old_object_delete_failed");
      }
    }
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: existing ? "cases.workflow_document.replace" : "cases.workflow_document.upload",
    entityType: "case",
    entityId: caseId,
    detail: `workflowDocumentId=${row.id} milestoneKey=${milestoneKey} fileName=${smartFileName}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  await syncWorkflowStepsFromCaseState(r, caseId, {
    firmId: req.firmId!,
    actorId: req.userId,
    actorType: req.userType ?? "firm_user",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(existing ? 200 : 201).json({
    id: row.id,
    caseId: row.caseId,
    milestoneKey: row.milestoneKey,
    label: row.label,
    dateValue: row.dateValue ? String(row.dateValue) : null,
    fileName: row.fileName,
    mimeType: row.mimeType ?? null,
    fileSize: row.fileSize ?? null,
    createdAt: toIsoStringSafeOrNull(row.createdAt),
    updatedAt: toIsoStringSafeOrNull(row.updatedAt),
  });
}));

router.delete("/cases/:caseId/workflow-documents/:id", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "delete") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const idStr = one((req.params as any).id);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  const id = idStr ? Number(idStr) : NaN;
  if (!Number.isFinite(caseId) || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const exists = await tableExists(r, "public.case_workflow_documents");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [existing] = await r
    .select({
      objectPath: caseWorkflowDocumentsTable.objectPath,
      milestoneKey: caseWorkflowDocumentsTable.milestoneKey,
      fileName: caseWorkflowDocumentsTable.fileName,
    })
    .from(caseWorkflowDocumentsTable)
    .where(and(
      eq(caseWorkflowDocumentsTable.id, id),
      eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
      eq(caseWorkflowDocumentsTable.caseId, caseId),
      sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
    ));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.objectPath) {
    try {
      await supabaseStorage.deletePrivateObject(existing.objectPath);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        void err;
      } else {
        const cfgErr = getSupabaseStorageConfigError(err);
        if (cfgErr) {
          res.status(cfgErr.statusCode).json({ error: cfgErr.error });
          return;
        }
        logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] workflow_document_delete_object_failed");
      }
    }
  }
  const [row] = await r
    .update(caseWorkflowDocumentsTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(caseWorkflowDocumentsTable.id, id),
      eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
      eq(caseWorkflowDocumentsTable.caseId, caseId),
      sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
    ))
    .returning({ id: caseWorkflowDocumentsTable.id });
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.workflow_document.delete",
    entityType: "case",
    entityId: caseId,
    detail: `workflowDocumentId=${id} milestoneKey=${existing.milestoneKey} fileName=${existing.fileName}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  await syncWorkflowStepsFromCaseState(r, caseId, {
    firmId: req.firmId!,
    actorId: req.userId,
    actorType: req.userType ?? "firm_user",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.status(204).end();
}));

router.get("/cases/:caseId/workflow-documents/:id/download", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const idStr = one((req.params as any).id);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  const id = idStr ? Number(idStr) : NaN;
  if (!Number.isFinite(caseId) || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const exists = await tableExists(r, "public.case_workflow_documents");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [row] = await r
    .select({
      objectPath: caseWorkflowDocumentsTable.objectPath,
      milestoneKey: caseWorkflowDocumentsTable.milestoneKey,
      fileName: caseWorkflowDocumentsTable.fileName,
      mimeType: caseWorkflowDocumentsTable.mimeType,
    })
    .from(caseWorkflowDocumentsTable)
    .where(and(
      eq(caseWorkflowDocumentsTable.id, id),
      eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
      eq(caseWorkflowDocumentsTable.caseId, caseId),
      sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
    ));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.workflow_document.download",
    entityType: "case",
    entityId: caseId,
    detail: `workflowDocumentId=${id} milestoneKey=${row.milestoneKey} fileName=${row.fileName}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  try {
    await streamSupabasePrivateObjectToResponse({
      objectPath: row.objectPath,
      res,
      fileName: row.fileName,
      fallbackContentType: row.mimeType ?? "application/octet-stream",
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      res.status(cfgErr.statusCode).json({ error: cfgErr.error });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] workflow_document_download_failed");
    res.status(500).json({ error: "Failed to download file" });
  }
}));

const ALLOWED_LOAN_STAMPING_ITEM_KEYS = new Set<string>(LOAN_STAMPING_ITEM_KEYS);

router.get("/cases/:caseId/loan-stamping", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  if (!Number.isFinite(caseId)) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const exists = await tableExists(r, "public.case_loan_stamping_items");
  if (!exists) {
    res.json([]);
    return;
  }
  const rows = await r
    .select({
      id: caseLoanStampingItemsTable.id,
      itemKey: caseLoanStampingItemsTable.itemKey,
      customName: caseLoanStampingItemsTable.customName,
      datedOn: caseLoanStampingItemsTable.datedOn,
      stampedOn: caseLoanStampingItemsTable.stampedOn,
      fileName: caseLoanStampingItemsTable.fileName,
      mimeType: caseLoanStampingItemsTable.mimeType,
      fileSize: caseLoanStampingItemsTable.fileSize,
      sortOrder: caseLoanStampingItemsTable.sortOrder,
      createdAt: caseLoanStampingItemsTable.createdAt,
      updatedAt: caseLoanStampingItemsTable.updatedAt,
    })
    .from(caseLoanStampingItemsTable)
    .where(and(
      eq(caseLoanStampingItemsTable.firmId, req.firmId!),
      eq(caseLoanStampingItemsTable.caseId, caseId),
      sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`,
    ))
    .orderBy(asc(caseLoanStampingItemsTable.sortOrder), asc(caseLoanStampingItemsTable.id));
  res.json(rows.map((x) => ({
    ...x,
    datedOn: x.datedOn ? String(x.datedOn) : null,
    stampedOn: x.stampedOn ? String(x.stampedOn) : null,
    createdAt: toIsoStringSafeOrNull(x.createdAt),
    updatedAt: toIsoStringSafeOrNull(x.updatedAt),
  })));
}));

router.post("/cases/:caseId/loan-stamping/ensure", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  if (!Number.isFinite(caseId)) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const exists = await tableExists(r, "public.case_loan_stamping_items");
  if (!exists) {
    res.status(503).json({ error: "Loan stamping not available" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const [caseRow] = await r
    .select({ titleType: casesTable.titleType })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const titleType = normalizeTitleType(caseRow.titleType);

  const body = asObject(req.body) ?? {};
  const itemKey = asString(body.itemKey);
  const customName = asString(body.customName);
  const sortOrder = asNumber(body.sortOrder);
  const datedOnRaw = body.datedOn;
  const stampedOnRaw = body.stampedOn;
  if (!itemKey || !ALLOWED_LOAN_STAMPING_ITEM_KEYS.has(itemKey)) {
    res.status(422).json({ error: "Invalid itemKey" });
    return;
  }
  if (!isLoanStampingItemKeyAllowedForTitleType(titleType, itemKey as LoanStampingItemKey)) {
    res.status(422).json({ error: "itemKey not allowed for title type" });
    return;
  }
  const datedOn = Object.prototype.hasOwnProperty.call(body, "datedOn") ? parseDateOnlyInput(datedOnRaw) : undefined;
  const stampedOn = Object.prototype.hasOwnProperty.call(body, "stampedOn") ? parseDateOnlyInput(stampedOnRaw) : undefined;
  if (datedOn === undefined && Object.prototype.hasOwnProperty.call(body, "datedOn")) {
    res.status(422).json({ error: "Invalid datedOn" });
    return;
  }
  if (stampedOn === undefined && Object.prototype.hasOwnProperty.call(body, "stampedOn")) {
    res.status(422).json({ error: "Invalid stampedOn" });
    return;
  }

  const now = new Date();
  let row: any;
  if (itemKey !== "other") {
    const [existing] = await r
      .select({ id: caseLoanStampingItemsTable.id })
      .from(caseLoanStampingItemsTable)
      .where(and(
        eq(caseLoanStampingItemsTable.firmId, req.firmId!),
        eq(caseLoanStampingItemsTable.caseId, caseId),
        eq(caseLoanStampingItemsTable.itemKey, itemKey),
        sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`,
      ))
      .limit(1);
    if (existing) {
      const setValues: Record<string, unknown> = { sortOrder: 0, updatedAt: now };
      if (datedOn !== undefined) setValues.datedOn = typeof datedOn === "string" ? datedOn : null;
      if (stampedOn !== undefined) setValues.stampedOn = typeof stampedOn === "string" ? stampedOn : null;
      const [updated] = await r
        .update(caseLoanStampingItemsTable)
        .set(setValues)
        .where(and(eq(caseLoanStampingItemsTable.id, existing.id), eq(caseLoanStampingItemsTable.firmId, req.firmId!), eq(caseLoanStampingItemsTable.caseId, caseId)))
        .returning();
      row = updated;
    } else {
      const [inserted] = await r
        .insert(caseLoanStampingItemsTable)
        .values({
          firmId: req.firmId!,
          caseId,
          itemKey,
          customName: null,
          datedOn: typeof datedOn === "string" ? datedOn : null,
          stampedOn: typeof stampedOn === "string" ? stampedOn : null,
          sortOrder: 0,
          uploadedBy: req.userId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      row = inserted;
    }
  } else {
    const [inserted] = await r
      .insert(caseLoanStampingItemsTable)
      .values({
        firmId: req.firmId!,
        caseId,
        itemKey,
        customName: customName?.trim() || null,
        datedOn: typeof datedOn === "string" ? datedOn : null,
        stampedOn: typeof stampedOn === "string" ? stampedOn : null,
        sortOrder: Number.isFinite(sortOrder ?? NaN) ? (sortOrder as number) : 1000,
        uploadedBy: req.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    row = inserted;
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.loan_stamping.ensure",
    entityType: "case",
    entityId: caseId,
    detail: `loanStampingItemId=${row?.id ?? ""} itemKey=${itemKey} sortOrder=${row?.sortOrder ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(200).json({
    id: row.id,
    itemKey: row.itemKey,
    customName: row.customName ?? null,
    datedOn: row.datedOn ? String(row.datedOn) : null,
    stampedOn: row.stampedOn ? String(row.stampedOn) : null,
    fileName: row.fileName ?? null,
    mimeType: row.mimeType ?? null,
    fileSize: row.fileSize ?? null,
    sortOrder: row.sortOrder ?? 0,
    createdAt: toIsoStringSafeOrNull(row.createdAt),
    updatedAt: toIsoStringSafeOrNull(row.updatedAt),
  });
}));

router.put("/cases/:caseId/loan-stamping", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  if (!Number.isFinite(caseId)) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const exists = await tableExists(r, "public.case_loan_stamping_items");
  if (!exists) {
    res.status(503).json({ error: "Loan stamping not available" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const [caseRow] = await r
    .select({ titleType: casesTable.titleType })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const titleType = normalizeTitleType(caseRow.titleType);
  const itemsRaw = (asObject(req.body)?.items ?? null);
  if (!Array.isArray(itemsRaw)) {
    res.status(400).json({ error: "Invalid items" });
    return;
  }

  const now = new Date();
  const results: any[] = [];
  for (let i = 0; i < itemsRaw.length; i++) {
    const it = asObject(itemsRaw[i]) ?? {};
    const id = asNumber(it.id);
    const itemKey = asString(it.itemKey);
    const customName = asString(it.customName);
    const sortOrder = asNumber(it.sortOrder) ?? i;
    const datedOnRaw = it.datedOn;
    const stampedOnRaw = it.stampedOn;

    if (!itemKey || !ALLOWED_LOAN_STAMPING_ITEM_KEYS.has(itemKey)) {
      res.status(422).json({ error: `Invalid itemKey at index ${i}` });
      return;
    }
    if (!isLoanStampingItemKeyAllowedForTitleType(titleType, itemKey as LoanStampingItemKey)) {
      res.status(422).json({ error: `itemKey not allowed for title type at index ${i}` });
      return;
    }
    if (itemKey === "other" && !customName?.trim()) {
      res.status(422).json({ error: `Missing customName at index ${i}` });
      return;
    }
    const datedOn = Object.prototype.hasOwnProperty.call(it, "datedOn") ? parseDateOnlyInput(datedOnRaw) : undefined;
    const stampedOn = Object.prototype.hasOwnProperty.call(it, "stampedOn") ? parseDateOnlyInput(stampedOnRaw) : undefined;
    if (datedOn === undefined && Object.prototype.hasOwnProperty.call(it, "datedOn")) {
      res.status(422).json({ error: `Invalid datedOn at index ${i}` });
      return;
    }
    if (stampedOn === undefined && Object.prototype.hasOwnProperty.call(it, "stampedOn")) {
      res.status(422).json({ error: `Invalid stampedOn at index ${i}` });
      return;
    }

    if (id) {
      const [updated] = await r
        .update(caseLoanStampingItemsTable)
        .set({
          itemKey,
          customName: itemKey === "other" ? customName!.trim() : null,
          datedOn: typeof datedOn === "string" ? datedOn : null,
          stampedOn: typeof stampedOn === "string" ? stampedOn : null,
          sortOrder,
          updatedAt: now,
        })
        .where(and(eq(caseLoanStampingItemsTable.id, id), eq(caseLoanStampingItemsTable.firmId, req.firmId!), eq(caseLoanStampingItemsTable.caseId, caseId), sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`))
        .returning();
      if (updated) results.push(updated);
      continue;
    }

    const [inserted] = await r
      .insert(caseLoanStampingItemsTable)
      .values({
        firmId: req.firmId!,
        caseId,
        itemKey,
        customName: itemKey === "other" ? customName!.trim() : null,
        datedOn: typeof datedOn === "string" ? datedOn : null,
        stampedOn: typeof stampedOn === "string" ? stampedOn : null,
        sortOrder,
        uploadedBy: req.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (inserted) results.push(inserted);
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.loan_stamping.save",
    entityType: "case",
    entityId: caseId,
    detail: `items=${itemsRaw.length}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json(results.map((x) => ({
    id: x.id,
    itemKey: x.itemKey,
    customName: x.customName ?? null,
    datedOn: x.datedOn ? String(x.datedOn) : null,
    stampedOn: x.stampedOn ? String(x.stampedOn) : null,
    fileName: x.fileName ?? null,
    mimeType: x.mimeType ?? null,
    fileSize: x.fileSize ?? null,
    sortOrder: x.sortOrder ?? 0,
    createdAt: toIsoStringSafeOrNull(x.createdAt),
    updatedAt: toIsoStringSafeOrNull(x.updatedAt),
  })));
}));

router.delete("/cases/:caseId/loan-stamping/:id", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "delete") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const idStr = one((req.params as any).id);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  const id = idStr ? Number(idStr) : NaN;
  if (!Number.isFinite(caseId) || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_loan_stamping_items");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [existing] = await r
    .select({
      objectPath: caseLoanStampingItemsTable.objectPath,
      itemKey: caseLoanStampingItemsTable.itemKey,
      fileName: caseLoanStampingItemsTable.fileName,
    })
    .from(caseLoanStampingItemsTable)
    .where(and(
      eq(caseLoanStampingItemsTable.id, id),
      eq(caseLoanStampingItemsTable.firmId, req.firmId!),
      eq(caseLoanStampingItemsTable.caseId, caseId),
      sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`,
    ));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.objectPath) {
    try {
      await supabaseStorage.deletePrivateObject(existing.objectPath);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        void err;
      } else {
        const cfgErr = getSupabaseStorageConfigError(err);
        if (cfgErr) {
          res.status(cfgErr.statusCode).json({ error: cfgErr.error });
          return;
        }
        logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] loan_stamping_delete_object_failed");
      }
    }
  }
  const [row] = await r
    .update(caseLoanStampingItemsTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(caseLoanStampingItemsTable.id, id), eq(caseLoanStampingItemsTable.firmId, req.firmId!), eq(caseLoanStampingItemsTable.caseId, caseId), sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`))
    .returning({ id: caseLoanStampingItemsTable.id });
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.loan_stamping.delete",
    entityType: "case",
    entityId: caseId,
    detail: `loanStampingItemId=${id} itemKey=${existing.itemKey} fileName=${existing.fileName ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.status(204).end();
}));

router.post("/cases/:caseId/loan-stamping/:id/file", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const idStr = one((req.params as any).id);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  const id = idStr ? Number(idStr) : NaN;
  if (!Number.isFinite(caseId) || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const body = asObject(req.body) ?? {};
  const objectPath = asString(body.objectPath);
  const fileName = asString(body.fileName);
  const mimeType = asString(body.mimeType);
  const fileSize = asNumber(body.fileSize);
  if (!objectPath || !objectPath.startsWith(`/objects/cases/${req.firmId}/case-${caseId}/loan-stamping/`)) {
    res.status(400).json({ error: "Invalid objectPath" });
    return;
  }
  if (!fileName?.trim()) {
    res.status(400).json({ error: "Missing fileName" });
    return;
  }
  const ext = fileExtLower(fileName);
  if (!CASE_ATTACHMENT_ALLOWED_EXTENSIONS.has(ext)) {
    res.status(422).json({ error: "Unsupported file type. Allowed: pdf, doc, docx, jpg, jpeg, png" });
    return;
  }
  const exists = await tableExists(r, "public.case_loan_stamping_items");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [existing] = await r
    .select({
      objectPath: caseLoanStampingItemsTable.objectPath,
      itemKey: caseLoanStampingItemsTable.itemKey,
    })
    .from(caseLoanStampingItemsTable)
    .where(and(
      eq(caseLoanStampingItemsTable.id, id),
      eq(caseLoanStampingItemsTable.firmId, req.firmId!),
      eq(caseLoanStampingItemsTable.caseId, caseId),
      sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`,
    ))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const namingCtx = await buildSmartNamingContext(r, req.firmId!, caseId);
  const smartFileName = resolveSmartFilename({
    ctx: {
      caseId,
      firmId: req.firmId!,
      caseReferenceNo: namingCtx.referenceNo,
      parcelNo: namingCtx.parcelNo,
      clientName: namingCtx.clientName,
      projectName: namingCtx.projectName,
      developerName: namingCtx.developerName,
      documentName: `Loan Stamping ${String(existing.itemKey ?? "")}`.trim(),
      templateName: "",
      status: namingCtx.status,
      titleType: namingCtx.titleType,
      loanBank: namingCtx.loanBank,
      sequence: 1,
    },
    rule: null,
    originalFileNameOrExt: fileName.trim(),
    fallbackExt: ext,
  }).fileName;
  const [row] = await r
    .update(caseLoanStampingItemsTable)
    .set({
      objectPath,
      fileName: smartFileName,
      mimeType: mimeType ?? null,
      fileSize: fileSize ?? null,
      uploadedBy: req.userId ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(caseLoanStampingItemsTable.id, id), eq(caseLoanStampingItemsTable.firmId, req.firmId!), eq(caseLoanStampingItemsTable.caseId, caseId), sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`))
    .returning({ id: caseLoanStampingItemsTable.id });
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.objectPath && existing.objectPath !== objectPath) {
    try {
      await supabaseStorage.deletePrivateObject(existing.objectPath);
    } catch (err) {
      if (!(err instanceof ObjectNotFoundError)) {
        const cfgErr = getSupabaseStorageConfigError(err);
        if (cfgErr) {
          res.status(cfgErr.statusCode).json({ error: cfgErr.error });
          return;
        }
        logger.warn({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] loan_stamping_old_object_delete_failed");
      }
    }
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: existing.objectPath ? "cases.loan_stamping.file_replace" : "cases.loan_stamping.file_upload",
    entityType: "case",
    entityId: caseId,
    detail: `loanStampingItemId=${id} itemKey=${existing.itemKey} fileName=${smartFileName}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json({ ok: true });
}));

router.delete("/cases/:caseId/loan-stamping/:id/file", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const idStr = one((req.params as any).id);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  const id = idStr ? Number(idStr) : NaN;
  if (!Number.isFinite(caseId) || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_loan_stamping_items");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const [existing] = await r
    .select({
      objectPath: caseLoanStampingItemsTable.objectPath,
      itemKey: caseLoanStampingItemsTable.itemKey,
      fileName: caseLoanStampingItemsTable.fileName,
    })
    .from(caseLoanStampingItemsTable)
    .where(and(eq(caseLoanStampingItemsTable.id, id), eq(caseLoanStampingItemsTable.firmId, req.firmId!), eq(caseLoanStampingItemsTable.caseId, caseId), sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.objectPath) {
    try {
      await supabaseStorage.deletePrivateObject(existing.objectPath);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        void err;
      } else {
        const cfgErr = getSupabaseStorageConfigError(err);
        if (cfgErr) {
          res.status(cfgErr.statusCode).json({ error: cfgErr.error });
          return;
        }
        logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] loan_stamping_clear_file_object_failed");
      }
    }
  }
  const [row] = await r
    .update(caseLoanStampingItemsTable)
    .set({ objectPath: null, fileName: null, mimeType: null, fileSize: null, updatedAt: new Date() })
    .where(and(eq(caseLoanStampingItemsTable.id, id), eq(caseLoanStampingItemsTable.firmId, req.firmId!), eq(caseLoanStampingItemsTable.caseId, caseId), sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`))
    .returning({ id: caseLoanStampingItemsTable.id });
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.loan_stamping.file_cleared",
    entityType: "case",
    entityId: caseId,
    detail: `loanStampingItemId=${id} itemKey=${existing.itemKey} fileName=${existing.fileName ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.status(204).end();
}));

router.get("/cases/:caseId/loan-stamping/:id/download", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const caseIdStr = one((req.params as any).caseId);
  const idStr = one((req.params as any).id);
  const caseId = caseIdStr ? Number(caseIdStr) : NaN;
  const id = idStr ? Number(idStr) : NaN;
  if (!Number.isFinite(caseId) || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_loan_stamping_items");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const [row] = await r
    .select({
      objectPath: caseLoanStampingItemsTable.objectPath,
      itemKey: caseLoanStampingItemsTable.itemKey,
      fileName: caseLoanStampingItemsTable.fileName,
      mimeType: caseLoanStampingItemsTable.mimeType,
    })
    .from(caseLoanStampingItemsTable)
    .where(and(eq(caseLoanStampingItemsTable.id, id), eq(caseLoanStampingItemsTable.firmId, req.firmId!), eq(caseLoanStampingItemsTable.caseId, caseId), sql`${caseLoanStampingItemsTable.deletedAt} IS NULL`));
  if (!row || !row.objectPath || !row.fileName) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.loan_stamping.download",
    entityType: "case",
    entityId: caseId,
    detail: `loanStampingItemId=${id} itemKey=${row.itemKey} fileName=${row.fileName}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  try {
    await streamSupabasePrivateObjectToResponse({
      objectPath: row.objectPath,
      res,
      fileName: row.fileName,
      fallbackContentType: row.mimeType ?? "application/octet-stream",
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      res.status(cfgErr.statusCode).json({ error: cfgErr.error });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] loan_stamping_download_failed");
    res.status(500).json({ error: "Failed to download file" });
  }
}));

router.get("/cases/:caseId/workflow", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseWorkflowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
    if (!ok) return;

    const wfExists = await tableExists(r, "public.case_workflow_steps");
    if (!wfExists) {
      res.json([]);
      return;
    }

    await ensureCaseWorkflowSteps(r, req.firmId!, params.data.caseId);

    const steps = await r.select().from(caseWorkflowStepsTable)
      .where(eq(caseWorkflowStepsTable.caseId, params.data.caseId))
      .orderBy(caseWorkflowStepsTable.stepOrder);

    const enriched = await Promise.all(
      steps.map(async (s) => {
        let completedByName: string | null = null;
        if (s.completedBy) {
          const [user] = await r
            .select({ name: usersTable.name })
            .from(usersTable)
            .where(eq(usersTable.id, s.completedBy));
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
          completedAt: toIsoStringSafeOrNull(s.completedAt),
          notes: s.notes ?? null,
        };
      })
    );

    res.json(enriched);
  } catch (e) {
    logger.error({ err: e, firmId: req.firmId, userId: req.userId, caseId: params.data.caseId }, "[cases] get workflow failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
}));

router.patch("/cases/:caseId/workflow/:stepId", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
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

  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const [existingStep] = await r
    .select({ id: caseWorkflowStepsTable.id, stepKey: caseWorkflowStepsTable.stepKey })
    .from(caseWorkflowStepsTable)
    .where(and(eq(caseWorkflowStepsTable.id, params.data.stepId), eq(caseWorkflowStepsTable.caseId, params.data.caseId)))
    .limit(1);
  if (!existingStep) {
    res.status(404).json({ error: "Workflow step not found" });
    return;
  }
  if (parsed.data.status !== undefined && Object.prototype.hasOwnProperty.call(WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY, String(existingStep.stepKey))) {
    res.status(422).json({ error: "This step is automated by key dates/attachments and cannot be updated manually." });
    return;
  }

  const [step] = await r
    .update(caseWorkflowStepsTable)
    .set(updates)
    .where(and(eq(caseWorkflowStepsTable.id, existingStep.id), eq(caseWorkflowStepsTable.caseId, params.data.caseId)))
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
      const kdExists = await tableExists(r, "public.case_key_dates");
      if (kdExists) {
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
  }

  let completedByName: string | null = null;
  if (step.completedBy) {
    const [user] = await r
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, step.completedBy));
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
    completedAt: toIsoStringSafeOrNull(step.completedAt),
    notes: step.notes ?? null,
    syncedKeyDateField,
  });
}));

router.get("/cases/:caseId/notes", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseNotesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const notes = await r.select().from(caseNotesTable)
    .where(eq(caseNotesTable.caseId, params.data.caseId))
    .orderBy(desc(caseNotesTable.createdAt));

  const enriched = await Promise.all(
    notes.map(async (n) => {
      const [author] = await r
        .select({ name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.id, n.authorId));
      return {
        id: n.id,
        caseId: n.caseId,
        authorId: n.authorId,
        authorName: author?.name ?? "Unknown",
        content: n.content,
        createdAt: toIsoStringSafe(n.createdAt),
      };
    })
  );

  res.json(enriched);
}));

router.post("/cases/:caseId/notes", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
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

  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const [note] = await r
    .insert(caseNotesTable)
    .values({
      caseId: params.data.caseId,
      authorId: req.userId!,
      content: parsed.data.content,
    })
    .returning();

  const [author] = await r
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, note.authorId));

  res.status(201).json({
    id: note.id,
    caseId: note.caseId,
    authorId: note.authorId,
    authorName: author?.name ?? "Unknown",
    content: note.content,
    createdAt: note.createdAt instanceof Date ? note.createdAt.toISOString() : new Date(note.createdAt).toISOString(),
  });
}));

router.get("/cases/:caseId/messages", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const channelRaw = one((req as any).query?.channel);
  const channel = CaseMessageChannel.safeParse(channelRaw).success ? (channelRaw as "client" | "developer") : "client";

  const rows = await r
    .select({
      id: caseMessagesTable.id,
      channel: caseMessagesTable.channel,
      senderType: caseMessagesTable.senderType,
      senderId: caseMessagesTable.senderId,
      senderName: usersTable.name,
      messageText: caseMessagesTable.messageText,
      attachments: caseMessagesTable.attachments,
      createdAt: caseMessagesTable.createdAt,
    })
    .from(caseMessagesTable)
    .leftJoin(usersTable, eq(caseMessagesTable.senderId, usersTable.id))
    .where(and(
      eq(caseMessagesTable.firmId, req.firmId!),
      eq(caseMessagesTable.caseId, params.data.caseId),
      eq(caseMessagesTable.channel, channel),
    ))
    .orderBy(asc(caseMessagesTable.createdAt))
    .limit(500);

  res.json({
    data: rows.map((m) => ({
      id: String(m.id),
      channel: String((m as any).channel ?? "client"),
      senderType: String(m.senderType) === "staff" ? "staff" : (String(m.senderType) === "developer" ? "developer" : "client"),
      senderId: m.senderId ?? null,
      senderName: String(m.senderType) === "staff"
        ? (m.senderName ? String(m.senderName) : "Staff")
        : (String(m.senderType) === "developer"
          ? (m.senderName ? String(m.senderName) : "Developer")
          : "Client"),
      messageText: String(m.messageText ?? ""),
      attachments: m.attachments ?? [],
      createdAt: toIsoStringSafe(m.createdAt),
    })),
  });
}));

router.get("/cases/:caseId/messages/unread-count", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const channels: Array<"client" | "developer"> = ["client", "developer"];
  const byChannel: Record<"client" | "developer", number> = { client: 0, developer: 0 };
  for (const ch of channels) {
    const [readStatus] = await r
      .select({ lastReadAt: caseMessageReadStatusTable.lastReadAt })
      .from(caseMessageReadStatusTable)
      .where(and(
        eq(caseMessageReadStatusTable.firmId, req.firmId!),
        eq(caseMessageReadStatusTable.caseId, params.data.caseId),
        eq(caseMessageReadStatusTable.userId, req.userId!),
        eq(caseMessageReadStatusTable.channel, ch),
      ));

    const lastReadAt = readStatus?.lastReadAt instanceof Date ? readStatus.lastReadAt : new Date(0);
    const [row] = await r
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(caseMessagesTable)
      .where(and(
        eq(caseMessagesTable.firmId, req.firmId!),
        eq(caseMessagesTable.caseId, params.data.caseId),
        eq(caseMessagesTable.channel, ch),
        inArray(caseMessagesTable.senderType, ["client", "developer"]),
        sql`${caseMessagesTable.createdAt} > ${lastReadAt}`,
      ));
    byChannel[ch] = Number((row as any)?.c ?? 0);
  }

  res.json({ totalUnreadCount: byChannel.client + byChannel.developer, unreadCountByChannel: byChannel });
}));

router.post("/cases/:caseId/messages/read", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const channelRaw = one((body as any).channel);
  const parsedChannel = CaseMessageChannel.safeParse(channelRaw);
  const channelsToMark: Array<"client" | "developer"> = parsedChannel.success ? [parsedChannel.data] : ["client", "developer"];
  const now = new Date();

  await Promise.all(channelsToMark.map((ch) =>
    r.insert(caseMessageReadStatusTable).values({
      firmId: req.firmId!,
      caseId: params.data.caseId,
      userId: req.userId!,
      channel: ch,
      lastReadAt: now,
    }).onConflictDoUpdate({
      target: [caseMessageReadStatusTable.firmId, caseMessageReadStatusTable.caseId, caseMessageReadStatusTable.userId, caseMessageReadStatusTable.channel],
      set: { lastReadAt: now },
    })
  ));

  res.json({ ok: true });
}));

router.post("/cases/:caseId/messages", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateCaseMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const channel = parsed.data.channel ?? "client";

  const [created] = await r
    .insert(caseMessagesTable)
    .values({
      firmId: req.firmId!,
      caseId: params.data.caseId,
      channel,
      senderType: "staff",
      senderId: req.userId!,
      messageText: parsed.data.messageText,
      attachments: parsed.data.attachments ?? [],
    })
    .returning({
      id: caseMessagesTable.id,
      senderType: caseMessagesTable.senderType,
      senderId: caseMessagesTable.senderId,
      messageText: caseMessagesTable.messageText,
      attachments: caseMessagesTable.attachments,
      createdAt: caseMessagesTable.createdAt,
    });

  const [sender] = await r
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, req.userId!));

  await writeAuditLog({
    firmId: req.firmId!,
    actorId: req.userId!,
    actorType: req.userType ?? "firm_user",
    action: "case_messages.staff.create",
    entityType: "case",
    entityId: params.data.caseId,
    detail: "staff_message",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });

  res.status(201).json({
    id: String(created?.id ?? ""),
    channel,
    senderType: "staff",
    senderId: created?.senderId ?? null,
    senderName: sender?.name ?? "Staff",
    messageText: String(created?.messageText ?? ""),
    attachments: created?.attachments ?? [],
    createdAt: toIsoStringSafe(created?.createdAt),
  });
}));

router.get("/cases/:caseId/ledger", requireAuthHandler, requireFirmUserHandler, requirePermission("accounting", "read") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseLedgerParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const rows = await r
    .select({
      id: caseLedgersTable.id,
      transactionDate: caseLedgersTable.transactionDate,
      entryCategory: caseLedgersTable.entryCategory,
      entryType: caseLedgersTable.entryType,
      description: caseLedgersTable.description,
      amount: caseLedgersTable.amount,
      createdAt: caseLedgersTable.createdAt,
      updatedAt: caseLedgersTable.updatedAt,
    })
    .from(caseLedgersTable)
    .where(and(eq(caseLedgersTable.firmId, req.firmId!), eq(caseLedgersTable.caseId, params.data.caseId)))
    .orderBy(asc(caseLedgersTable.transactionDate), asc(caseLedgersTable.createdAt));

  const sumByType = (t: string) => rows.reduce((acc, rr) => acc + (String(rr.entryType) === t ? Number(rr.amount ?? 0) : 0), 0);
  const totalBilled = sumByType("invoice_billed");
  const totalReceived = sumByType("payment_received");
  const outstandingBalance = totalBilled - totalReceived;
  const trustBalance = sumByType("trust_received") - sumByType("trust_paid");

  res.json({
    summary: {
      total_billed: totalBilled,
      total_received: totalReceived,
      outstanding_balance: outstandingBalance,
      trust_balance: trustBalance,
    },
    data: rows.map((x) => ({
      id: String(x.id),
      transactionDate: String(x.transactionDate),
      entryCategory: String(x.entryCategory),
      entryType: String(x.entryType),
      description: String(x.description),
      amount: Number(x.amount ?? 0),
      createdAt: toIsoStringSafe(x.createdAt),
      updatedAt: toIsoStringSafe(x.updatedAt),
    })),
  });
}));

router.post("/cases/:caseId/ledger", requireAuthHandler, requireFirmUserHandler, requirePermission("accounting", "write") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = GetCaseLedgerParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = CreateCaseLedgerBody.safeParse(req.body);
  if (!parsed.success) { res.status(422).json({ error: parsed.error.message }); return; }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const [created] = await r
    .insert(caseLedgersTable)
    .values({
      firmId: req.firmId!,
      caseId: params.data.caseId,
      transactionDate: parsed.data.transactionDate,
      entryCategory: parsed.data.entryCategory,
      entryType: parsed.data.entryType,
      description: parsed.data.description,
      amount: String(parsed.data.amount),
    } as any)
    .returning({
      id: caseLedgersTable.id,
      transactionDate: caseLedgersTable.transactionDate,
      entryCategory: caseLedgersTable.entryCategory,
      entryType: caseLedgersTable.entryType,
      description: caseLedgersTable.description,
      amount: caseLedgersTable.amount,
      createdAt: caseLedgersTable.createdAt,
      updatedAt: caseLedgersTable.updatedAt,
    });

  await writeAuditLog({
    firmId: req.firmId!,
    actorId: req.userId!,
    actorType: req.userType ?? "firm_user",
    action: "case_ledger.create",
    entityType: "case",
    entityId: params.data.caseId,
    detail: `${parsed.data.entryCategory}:${parsed.data.entryType} amount=${parsed.data.amount}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });

  res.status(201).json({
    id: String(created?.id ?? ""),
    transactionDate: String(created?.transactionDate ?? parsed.data.transactionDate),
    entryCategory: String(created?.entryCategory ?? parsed.data.entryCategory),
    entryType: String(created?.entryType ?? parsed.data.entryType),
    description: String(created?.description ?? parsed.data.description),
    amount: Number(created?.amount ?? parsed.data.amount),
    createdAt: toIsoStringSafe(created?.createdAt),
    updatedAt: toIsoStringSafe(created?.updatedAt),
  });
}));

export { router };
export default router;
