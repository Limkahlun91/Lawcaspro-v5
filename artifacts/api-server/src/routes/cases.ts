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
  caseLoanSuppDocumentsTable,
  caseListSavedViewsTable,
  caseLedgersTable,
  projectsTable, developersTable, clientsTable, usersTable, rolesTable, auditLogsTable,
  permissionsTable,
  sql,
} from "@workspace/db";
import {
  CreateCaseBody, ListCasesQueryParams,
  GetCaseParams, UpdateCaseParams,
  GetCaseWorkflowParams, UpdateWorkflowStepParams, UpdateWorkflowStepBody,
  GetCaseNotesParams, CreateCaseNoteParams, CreateCaseNoteBody
} from "@workspace/api-zod";
import { z } from "zod/v4";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { buildWorkflowSteps } from "../lib/workflow.js";
import { KEY_DATE_FIELD_TO_STEP_KEY, WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD, type KeyDateField } from "../lib/keyDatesWorkflow.js";
import { loanStatusSql, milestoneDateSql, milestoneDateYmdSql, milestonePresenceWhereSql, normalizeMilestoneFilter, spaStatusSql, type CaseMilestoneKey, type MilestonePresence } from "../lib/caseListLogic.js";
import { daysAgoSql } from "../lib/dateSql.js";
import { parseDateOnlyInput } from "../lib/dateOnly.js";
import { logger } from "../lib/logger.js";
import { ApiError } from "../lib/api-response.js";
import { isTransientDbConnectionError } from "../lib/auth-safe-db.js";
import { ObjectNotFoundError, SupabaseStorageService, getSupabaseStorageConfigError } from "../lib/objectStorage.js";
import { CASE_ATTACHMENT_ALLOWED_EXTENSIONS, WORKFLOW_DOCUMENT_ALLOWED_KEYS, fileExtLower, workflowDocumentLabel, workflowDocumentLegacyKeys, normalizeWorkflowDocumentKeyFromDb, type WorkflowDocumentMilestoneKey } from "../lib/caseWorkflowDocuments.js";
import { LOAN_STAMPING_ITEM_KEYS, type LoanStampingItemKey, isLoanStampingItemKeyAllowedForTitleType, normalizeTitleType } from "../lib/loanStamping.js";
import { ensureCaseWorkflowSteps, syncWorkflowStepsFromCaseState } from "../lib/workflowAutomationService.js";
import { WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY, deriveStatusFromRequirement } from "../lib/workflowAutomation.js";
import { computeStampingSummary, deriveStampingItemStatus, type StampingItemInput } from "../lib/stampingProgress.js";
import { checkFirmQuota } from "../lib/quota.js";
import { resolveSmartFilename } from "../lib/smartFileNaming.js";
import { computeDashboardStats } from "../services/dashboard-stats.js";
import { computeMilestonesSummary } from "../services/milestones-summary.js";

const router: ExpressRouter = express.Router();
const supabaseStorage = new SupabaseStorageService();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

const milestonesSummaryCache = new Map<string, { expiresAt: number; payload: unknown }>();

type CaseKeyDatesInsert = typeof caseKeyDatesTable.$inferInsert;

let casesSchemaHealthCache: { checkedAt: number; ok: boolean; issues: string[] } | null = null;

async function checkCasesSchemaHealth(r: DbConn): Promise<{ ok: boolean; issues: string[] }> {
  const now = Date.now();
  const cached = casesSchemaHealthCache;
  if (cached && now - cached.checkedAt < 60_000) return { ok: cached.ok, issues: cached.issues };

  const mustExist = [
    "firm_id",
    "project_id",
    "developer_id",
    "reference_no",
    "case_type",
    "approval_status",
    "submitted_by",
    "submitted_at",
    "approved_by",
    "approved_at",
    "approval_note",
    "encumbrances",
    "acting_for",
    "perfection_type",
  ] as const;

  const rows = await queryRows(r, sql`
    select column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'cases'
      and column_name in (${sql.join(mustExist.map((c) => sql`${c}`), sql`, `)})
  `);

  const byName = new Map<string, { isNullable: boolean }>();
  for (const row of rows) {
    const name = typeof row.column_name === "string" ? row.column_name : "";
    if (!name) continue;
    const isNullable = String(row.is_nullable ?? "").toUpperCase() === "YES";
    byName.set(name, { isNullable });
  }

  const issues: string[] = [];
  for (const col of mustExist) {
    if (!byName.has(col)) issues.push(`missing_column:${col}`);
  }
  for (const col of ["project_id", "developer_id", "reference_no"] as const) {
    const info = byName.get(col);
    if (info && info.isNullable === false) issues.push(`not_nullable:${col}`);
  }

  const ok = issues.length === 0;
  casesSchemaHealthCache = { checkedAt: now, ok, issues };
  return { ok, issues };
}

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

function normalizeCaseType(v: unknown): "developer_sales" | "subsale" | "perfection" | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;
  if (s === "developer_sales" || s === "developer sales" || s === "primary market" || s === "primary_market") return "developer_sales";
  if (s === "subsale" || s === "sub sale" || s === "sub_sale" || s === "secondary market" || s === "secondary_market") return "subsale";
  if (s === "perfection") return "perfection";
  return null;
}

function isCaseApprovalRoleName(roleName: string): boolean {
  const n = roleName.trim().toLowerCase();
  if (!n) return false;
  if (n.includes("partner")) return true;
  if (n === "account admin" || n === "account manager") return true;
  if (n.includes("account") && n.includes("admin")) return true;
  if (n.includes("account") && n.includes("manager")) return true;
  return false;
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

const getPgCode = (err: unknown): string | null => {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : null;
};
const isUndefinedColumnError = (err: unknown): boolean => getPgCode(err) === "42703";

async function queryRows(r: DbConn, q: unknown): Promise<Record<string, unknown>[]> {
  const result = await r.execute(q as any);
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : ("rows" in (result as any) ? ((result as any).rows as Record<string, unknown>[]) : []);
}

function pickValue(row: unknown, ...keys: string[]): unknown {
  if (!row || typeof row !== "object") return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) return (row as any)[k];
  }
  return undefined;
}

function pickString(row: unknown, ...keys: string[]): string | null {
  const v = pickValue(row, ...keys);
  return v === undefined || v === null ? null : String(v);
}

function pickNumber(row: unknown, ...keys: string[]): number | null {
  const v = pickValue(row, ...keys);
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickDateString(row: unknown, ...keys: string[]): string | null {
  const v = pickValue(row, ...keys);
  return v === undefined || v === null ? null : String(v);
}

function pickIsoString(row: unknown, ...keys: string[]): string | null {
  const v = pickValue(row, ...keys);
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s ? s : null;
}

async function fetchKeyDatesRow(r: DbConn, firmId: number, caseId: number): Promise<Record<string, unknown> | null> {
  const kdExists = await tableExists(r, "public.case_key_dates");
  if (!kdExists) return null;

  try {
    const [kd] = await r
      .select()
      .from(caseKeyDatesTable)
      .where(and(eq(caseKeyDatesTable.caseId, caseId), eq(caseKeyDatesTable.firmId, firmId)))
      .limit(1);
    return kd ? (kd as any) : null;
  } catch (err) {
    const code = getPgCode(err);
    if (code === "42P01" || code === "42501") return null;
    if (!isUndefinedColumnError(err)) throw err;
    try {
      const rows = await queryRows(r, sql`
        SELECT *
        FROM case_key_dates
        WHERE firm_id = ${firmId} AND case_id = ${caseId}
        LIMIT 1
      `);
      return rows[0] ?? null;
    } catch (rawErr) {
      const rawCode = getPgCode(rawErr);
      if (rawCode === "42P01" || rawCode === "42501") return null;
      throw rawErr;
    }
  }
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

function shouldBackfillKeyDate(field: KeyDateField, kd: Record<string, unknown> | null): boolean {
  if (!kd) return true;
  const has = (...keys: string[]): boolean => Boolean(pickValue(kd, ...keys));
  switch (field) {
    case "spa_signed_date": return !has("spaSignedDate", "spa_signed_date");
    case "spa_stamped_date": return !has("spaStampedDate", "spa_stamped_date");
    case "letter_of_offer_stamped_date": return !has("letterOfOfferStampedDate", "letter_of_offer_stamped_date");
    case "loan_docs_pending_date": return !has("loanDocsPendingDate", "loan_docs_pending_date");
    case "loan_docs_signed_date": return !has("loanDocsSignedDate", "loan_docs_signed_date");
    case "acting_letter_issued_date": return !has("actingLetterIssuedDate", "acting_letter_issued_date");
    case "advice_to_bank_date": return !has("adviceToBankDate", "advice_to_bank_date");
    case "loan_sent_bank_execution_date": return !has("loanSentBankExecutionDate", "loan_sent_bank_execution_date");
    case "loan_bank_executed_date": return !has("loanBankExecutedDate", "loan_bank_executed_date");
    case "bank_lu_received_date": return !has("bankLuReceivedDate", "bank_lu_received_date");
    case "noa_served_on": return !has("noaServedOn", "noa_served_on");
    case "register_poa_on": return !has("registerPoaOn", "register_poa_on");
    case "letter_disclaimer_dated": return !has("letterDisclaimerDated", "letter_disclaimer_dated");
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
      if (!c.projectId) return null;
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
      if (!c.developerId) return null;
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
          .select({
            id: clientsTable.id,
            name: clientsTable.name,
            icNo: clientsTable.icNo,
            phone: clientsTable.phone,
            email: clientsTable.email,
            address: clientsTable.address,
          })
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
      phone: client?.phone ?? null,
      email: client?.email ?? null,
      address: client?.address ?? null,
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
  const parseMaybeJson = (raw: unknown): unknown => {
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    if (typeof raw !== "string") return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  spaDetails = parseMaybeJson(c.spaDetails);
  propertyDetails = parseMaybeJson((c as any).propertyDetails);
  loanDetails = parseMaybeJson((c as any).loanDetails);
  companyDetails = parseMaybeJson(c.companyDetails);

  const kd = await (async () => {
    try {
      return await fetchKeyDatesRow(r, c.firmId, c.id);
    } catch (err) {
      logger.error({ err, pgCode: getPgCode(err), firmId: c.firmId, caseId: c.id }, "[cases] fetch key-dates failed");
      return null;
    }
  })();

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
    landCondition: c.tenure,
    trackingToken: c.trackingToken,
    spaPrice: c.spaPrice ? Number(c.spaPrice) : null,
    apdlPrice: c.apdlPrice ? Number(c.apdlPrice) : null,
    developerDiscount: c.developerDiscount ? Number(c.developerDiscount) : null,
    bumiputraDiscount: c.bumiputraDiscount ? Number(c.bumiputraDiscount) : null,
    status: c.status,
    lawyerStatus: c.lawyerStatus ?? null,
    lawyerStatusUpdatedAt: toIsoStringSafeOrNull(c.lawyerStatusUpdatedAt),
    developerStatus: c.developerStatus ?? null,
    developerStatusUpdatedAt: toIsoStringSafeOrNull(c.developerStatusUpdatedAt),
    caseType: c.caseType,
    approvalStatus: (c as any).approvalStatus ?? null,
    submittedBy: (c as any).submittedBy ?? null,
    submittedAt: toIsoStringSafeOrNull((c as any).submittedAt),
    approvedBy: (c as any).approvedBy ?? null,
    approvedAt: toIsoStringSafeOrNull((c as any).approvedAt),
    approvalNote: (c as any).approvalNote ?? null,
    encumbrances: (c as any).encumbrances ?? null,
    actingFor: (c as any).actingFor ?? null,
    perfectionType: (c as any).perfectionType ?? null,
    parcelNo: c.parcelNo,
    spaDetails,
    propertyDetails,
    loanDetails,
    companyDetails,
    keyDates: kd ? {
      spa_signed_date: pickDateString(kd, "spaSignedDate", "spa_signed_date"),
      spa_forward_to_developer_execution_on: pickDateString(kd, "spaForwardToDeveloperExecutionOn", "spa_forward_to_developer_execution_on"),
      spa_date: pickDateString(kd, "spaDate", "spa_date"),
      spa_stamped_date: pickDateString(kd, "spaStampedDate", "spa_stamped_date"),
      stamped_spa_send_to_developer_on: pickDateString(kd, "stampedSpaSendToDeveloperOn", "stamped_spa_send_to_developer_on"),
      stamped_spa_received_from_developer_on: pickDateString(kd, "stampedSpaReceivedFromDeveloperOn", "stamped_spa_received_from_developer_on"),
      letter_of_offer_date: pickDateString(kd, "letterOfOfferDate", "letter_of_offer_date"),
      letter_of_offer_stamped_date: pickDateString(kd, "letterOfOfferStampedDate", "letter_of_offer_stamped_date"),
      loan_docs_pending_date: pickDateString(kd, "loanDocsPendingDate", "loan_docs_pending_date"),
      loan_docs_signed_date: pickDateString(kd, "loanDocsSignedDate", "loan_docs_signed_date"),
      acting_letter_issued_date: pickDateString(kd, "actingLetterIssuedDate", "acting_letter_issued_date"),
      developer_confirmation_received_on: pickDateString(kd, "developerConfirmationReceivedOn", "developer_confirmation_received_on"),
      developer_confirmation_date: pickDateString(kd, "developerConfirmationDate", "developer_confirmation_date"),
      loan_sent_bank_execution_date: pickDateString(kd, "loanSentBankExecutionDate", "loan_sent_bank_execution_date"),
      loan_bank_executed_date: pickDateString(kd, "loanBankExecutedDate", "loan_bank_executed_date"),
      bank_lu_received_date: pickDateString(kd, "bankLuReceivedDate", "bank_lu_received_date"),
      bank_lu_forward_to_developer_on: pickDateString(kd, "bankLuForwardToDeveloperOn", "bank_lu_forward_to_developer_on"),
      developer_lu_received_on: pickDateString(kd, "developerLuReceivedOn", "developer_lu_received_on"),
      developer_lu_dated: pickDateString(kd, "developerLuDated", "developer_lu_dated"),
      letter_disclaimer_received_on: pickDateString(kd, "letterDisclaimerReceivedOn", "letter_disclaimer_received_on"),
      letter_disclaimer_dated: pickDateString(kd, "letterDisclaimerDated", "letter_disclaimer_dated"),
      letter_disclaimer_reference_nos: pickString(kd, "letterDisclaimerReferenceNos", "letter_disclaimer_reference_nos"),
      redemption_sum: pickNumber(kd, "redemptionSum", "redemption_sum"),
      loan_agreement_dated: pickDateString(kd, "loanAgreementDated", "loan_agreement_dated"),
      loan_agreement_submitted_stamping_date: pickDateString(kd, "loanAgreementSubmittedStampingDate", "loan_agreement_submitted_stamping_date"),
      loan_agreement_stamped_date: pickDateString(kd, "loanAgreementStampedDate", "loan_agreement_stamped_date"),
      register_poa_on: pickDateString(kd, "registerPoaOn", "register_poa_on"),
      registered_poa_registration_number: pickString(kd, "registeredPoaRegistrationNumber", "registered_poa_registration_number"),
      noa_served_on: pickDateString(kd, "noaServedOn", "noa_served_on"),
      advice_to_bank_date: pickDateString(kd, "adviceToBankDate", "advice_to_bank_date"),
      bank_1st_release_on: pickDateString(kd, "bank1stReleaseOn", "bank_1st_release_on"),
      first_release_amount_rm: pickNumber(kd, "firstReleaseAmountRm", "first_release_amount_rm"),
      discharge_date: pickDateString(kd, "dischargeDate", "discharge_date"),
      consent_to_transfer_date: pickDateString(kd, "consentToTransferDate", "consent_to_transfer_date"),
      consent_to_charge_date: pickDateString(kd, "consentToChargeDate", "consent_to_charge_date"),
      mot_received_date: pickDateString(kd, "motReceivedDate", "mot_received_date"),
      mot_signed_date: pickDateString(kd, "motSignedDate", "mot_signed_date"),
      mot_stamped_date: pickDateString(kd, "motStampedDate", "mot_stamped_date"),
      mot_registered_date: pickDateString(kd, "motRegisteredDate", "mot_registered_date"),
      progressive_payment_date: pickDateString(kd, "progressivePaymentDate", "progressive_payment_date"),
      full_settlement_date: pickDateString(kd, "fullSettlementDate", "full_settlement_date"),
      completion_date: pickDateString(kd, "completionDate", "completion_date"),
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
    spa_received_dev_return_spa_on: "spaReceivedDevReturnSpaOn",
    spa_date: "spaDate",
    spa_stamped_date: "spaStampedDate",
    stamped_spa_send_to_developer_on: "stampedSpaSendToDeveloperOn",
    stamped_spa_received_from_developer_on: "stampedSpaReceivedFromDeveloperOn",
    stamped_spa_sent_to_purchaser_on: "stampedSpaSentToPurchaserOn",
    li_date: "liDate",
    li_received_on: "liReceivedOn",
    letter_of_offer_date: "letterOfOfferDate",
    letter_of_offer_stamped_date: "letterOfOfferStampedDate",
    supp_lo_date: "suppLoDate",
    loan_docs_pending_date: "loanDocsPendingDate",
    loan_docs_signed_date: "loanDocsSignedDate",
    acting_letter_issued_date: "actingLetterIssuedDate",
    developer_confirmation_received_on: "developerConfirmationReceivedOn",
    developer_confirmation_date: "developerConfirmationDate",
    loan_sent_bank_execution_date: "loanSentBankExecutionDate",
    loan_bank_executed_date: "loanBankExecutedDate",
    differential_sum_settled_on: "differentialSumSettledOn",
    bank_lu_dated: "bankLuDated",
    bank_lu_received_date: "bankLuReceivedDate",
    bank_lu_forward_to_developer_on: "bankLuForwardToDeveloperOn",
    developer_lu_received_on: "developerLuReceivedOn",
    developer_lu_dated: "developerLuDated",
    letter_disclaimer_received_on: "letterDisclaimerReceivedOn",
    letter_disclaimer_dated: "letterDisclaimerDated",
    bankruptcy_search_dated: "bankruptcySearchDated",
    loan_agreement_dated: "loanAgreementDated",
    loan_agreement_submitted_stamping_date: "loanAgreementSubmittedStampingDate",
    loan_agreement_stamped_date: "loanAgreementStampedDate",
    statutory_declaration_dated: "statutoryDeclarationDated",
    statutory_declaration_stamped_on: "statutoryDeclarationStampedOn",
    fa_date: "faDate",
    fa_stamp_on: "faStampOn",
    doa_date: "doaDate",
    doa_stamp_on: "doaStampOn",
    poa_date: "poaDate",
    poa_stamp_on: "poaStampOn",
    noa_dated: "noaDated",
    register_pa_on: "registerPaOn",
    register_poa_on: "registerPoaOn",
    noa_served_on: "noaServedOn",
    advice_to_bank_date: "adviceToBankDate",
    bank_1st_release_on: "bank1stReleaseOn",
    discharge_date: "dischargeDate",
    discharge_title_received_on: "dischargeTitleReceivedOn",
    caveat_lodged_date: "caveatLodgedDate",
    first_advice_date: "firstAdviceDate",
    dev_informed_redemption_date: "devInformedRedemptionDate",
    request_discharge_date: "requestDischargeDate",
    charge_date: "chargeDate",
    charge_submit_stamping: "chargeSubmitStamping",
    charge_stamped: "chargeStamped",
    presentation_date: "presentationDate",
    second_advice_date: "secondAdviceDate",
    consent_to_transfer_date: "consentToTransferDate",
    consent_to_charge_date: "consentToChargeDate",
    request_letter_no_objection: "requestLetterNoObjection",
    received_letter_no_objection_on: "receivedLetterNoObjectionOn",
    blanket_consent_transfer_req: "blanketConsentTransferReq",
    blanket_consent_transfer_approval: "blanketConsentTransferApproval",
    consent_to_charge_req: "consentToChargeReq",
    consent_to_charge_approval: "consentToChargeApproval",
    mot_received_date: "motReceivedDate",
    mot_signed_date: "motSignedDate",
    mot_submit_stamping: "motSubmitStamping",
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

router.get("/cases/milestones-summary", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
  try {
    const r = rdb(req);
    const one = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;

    const assignedToMe = (() => {
      const raw = one((req.query as any)?.assignedToMe);
      if (!raw) return false;
      const v = raw.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    })();
    const assignedToUserId = (() => {
      const raw = one((req.query as any)?.assignedToUserId);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    })();

    const targetUserId = assignedToMe ? (req.userId ?? null) : assignedToUserId;
    if (!targetUserId) {
      res.status(400).json({ error: "assignedToMe or assignedToUserId is required" });
      return;
    }

    if (targetUserId !== req.userId) {
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
      if (!perm?.allowed) {
        res.status(403).json({ error: "Permission denied" });
        return;
      }
    }

    const cacheKey = `${req.firmId!}:${targetUserId}`;
    const now = Date.now();
    const cached = milestonesSummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      res.json(cached.payload);
      return;
    }

    const payload = await computeMilestonesSummary(r, req.firmId!, { assignedToUserId: targetUserId });
    const resp = {
      milestoneSections: Array.isArray((payload as any)?.milestoneSections) ? (payload as any).milestoneSections : [],
      milestoneCards: Array.isArray((payload as any)?.milestoneCards) ? (payload as any).milestoneCards : [],
    };
    milestonesSummaryCache.set(cacheKey, { expiresAt: now + 30_000, payload: resp });
    res.json(resp);
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[cases.milestones-summary]");
    res.status(isTransientDbConnectionError(err) ? 503 : 500).json({ error: isTransientDbConnectionError(err) ? "Milestones temporarily unavailable" : "Internal Server Error" });
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

  const normalizePresence = (raw: string | undefined): MilestonePresence | undefined => {
    if (!raw) return undefined;
    const v = raw.trim().toLowerCase();
    if (v === "done") return "completed";
    if (v === "pending") return "pending";
    if (v === "completed") return "completed";
    if (v === "filled") return "filled";
    if (v === "missing") return "missing";
    return undefined;
  };

  let milestone = one(req.query.milestone as any) as CaseMilestoneKey | undefined;
  let milestonePresence = normalizePresence(one(req.query.milestonePresence as any)) ?? normalizePresence(one((req.query as any).milestoneStatus));
  if (!milestone) {
    const legacyKeys: CaseMilestoneKey[] = [
      "spa_stamped",
      "lof_stamped",
      "loan_docs_pending",
      "loan_docs_signed",
      "acting_letter_issued",
      "advised",
      "loan_sent_bank_exec",
      "loan_bank_executed",
      "blu_received",
      "mot_received",
      "mot_submitted_stamping",
      "mot_stamp",
      "noa_served",
      "pa_registered",
      "letter_disclaimer",
    ];
    for (const k of legacyKeys) {
      const v = one((req.query as any)[k]);
      const vv = v ? v.trim().toLowerCase() : "";
      if (vv === "done") {
        milestone = k;
        milestonePresence = "completed";
        break;
      }
      if (vv === "pending") {
        milestone = k;
        milestonePresence = "pending";
        break;
      }
    }
  }
  ({ milestone, presence: milestonePresence } = normalizeMilestoneFilter(milestone, milestonePresence));
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
    let hasKeyDates = await tableExists(r, "public.case_key_dates");
    let hasWorkflowSteps = await tableExists(r, "public.case_workflow_steps");
    if (hasKeyDates) {
      try {
        await r.execute(sql`
          SELECT
            ${caseKeyDatesTable.spaDate},
            ${caseKeyDatesTable.spaStampedDate},
            ${caseKeyDatesTable.letterOfOfferDate},
            ${caseKeyDatesTable.loanDocsSignedDate},
            ${caseKeyDatesTable.completionDate},
            ${caseKeyDatesTable.completionSlaActivatedAt},
            ${caseKeyDatesTable.adviceToBankDate}
          FROM ${caseKeyDatesTable}
          WHERE ${caseKeyDatesTable.firmId} = ${req.firmId!}
          LIMIT 1
        `);
      } catch (err) {
        const code = getPgCode(err);
        if (code === "42P01" || code === "42703" || code === "42501") {
          hasKeyDates = false;
        } else {
          throw err;
        }
      }
    }
    if (hasWorkflowSteps) {
      try {
        await r.execute(sql`
          SELECT
            ${caseWorkflowStepsTable.stepName},
            ${caseWorkflowStepsTable.caseId},
            ${caseWorkflowStepsTable.pathType},
            ${caseWorkflowStepsTable.status},
            ${caseWorkflowStepsTable.stepOrder},
            ${caseWorkflowStepsTable.stepKey},
            ${caseWorkflowStepsTable.completedAt}
          FROM ${caseWorkflowStepsTable}
          LIMIT 1
        `);
      } catch (err) {
        const code = getPgCode(err);
        if (code === "42P01" || code === "42703" || code === "42501") {
          hasWorkflowSteps = false;
        } else {
          throw err;
        }
      }
    }
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
  const milestoneStatusAliasRaw = one(req.query.status as any);
  const milestonePresenceEffective: MilestonePresence | undefined =
    milestonePresence ??
    (milestone
      ? (milestoneStatusAliasRaw === "done" ? "completed"
        : milestoneStatusAliasRaw === "pending" ? "pending"
          : milestoneStatusAliasRaw === "completed" ? "completed"
            : milestoneStatusAliasRaw === "missing" ? "missing"
              : milestoneStatusAliasRaw === "filled" ? "filled"
                : undefined)
      : undefined);
  const sortByRaw = one(req.query.sortBy as any);
  const sortDirRaw = one(req.query.sortDir as any);
  const overdueDaysRaw = one(req.query.overdueDays as any);
  const assignedLawyerId = params.success ? params.data.assignedLawyerId : parseIntOrUndef(req.query.assignedLawyerId as any);
  const assignedClerkId = parseIntOrUndef(req.query.assignedClerkId as any);
  const assignedToUserId = parseIntOrUndef(req.query.assignedToUserId as any);
  const overdueDays = overdueDaysRaw ? Number(overdueDaysRaw) : undefined;
  const approvalStatusRaw = one(req.query.approvalStatus as any);
  const approvalStatus = (() => {
    const s = (approvalStatusRaw ?? "").trim().toLowerCase();
    if (s === "pending_approval") return "pending_approval";
    if (s === "rejected") return "rejected";
    if (s === "needs_correction") return "needs_correction";
    if (s === "approved") return "approved";
    return "approved";
  })();
  const roleNameForApproval = await getRoleName(r, req.firmId!, req.roleId);
  const canReviewApproval = isCaseApprovalRoleName(roleNameForApproval);
  if (approvalStatus !== "approved" && !canReviewApproval) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const spaStatusExpr = hasWorkflowSteps ? spaStatusSql() : sql<string>`'Pending'`;
  const loanStatusExpr = hasWorkflowSteps ? loanStatusSql() : sql<string | null>`CASE WHEN ${casesTable.purchaseMode} = 'loan' THEN 'Pending' ELSE NULL END`;
  const mSpaDateExpr = hasKeyDates ? sql<string | null>`(${caseKeyDatesTable.spaDate}::text)` : sql<string | null>`NULL`;
  const mSpaStampedDateExpr = hasKeyDates ? sql<string | null>`(${caseKeyDatesTable.spaStampedDate}::text)` : sql<string | null>`NULL`;
  const mLetterOfOfferDateExpr = hasKeyDates ? sql<string | null>`(${caseKeyDatesTable.letterOfOfferDate}::text)` : sql<string | null>`NULL`;
  const mLoanDocsSignedDateExpr = hasKeyDates ? sql<string | null>`(${caseKeyDatesTable.loanDocsSignedDate}::text)` : sql<string | null>`NULL`;
  const mCompletionDateExpr = hasKeyDates ? sql<string | null>`(${caseKeyDatesTable.completionDate}::text)` : sql<string | null>`NULL`;
  const completionSlaActivatedAtExpr = hasKeyDates ? sql<string | null>`(${caseKeyDatesTable.completionSlaActivatedAt}::text)` : sql<string | null>`NULL`;
  const completionSlaHoursElapsedExpr = hasKeyDates ? sql<number | null>`CASE
    WHEN ${caseKeyDatesTable.completionSlaActivatedAt} IS NULL THEN NULL
    ELSE EXTRACT(epoch FROM (now() - ${caseKeyDatesTable.completionSlaActivatedAt})) / 3600.0
  END` : sql<number | null>`NULL`;
  const completionSlaStatusExpr = hasKeyDates ? sql<string | null>`CASE
    WHEN ${caseKeyDatesTable.adviceToBankDate} IS NOT NULL THEN NULL
    WHEN ${caseKeyDatesTable.completionSlaActivatedAt} IS NULL THEN NULL
    WHEN (now() - ${caseKeyDatesTable.completionSlaActivatedAt}) >= interval '72 hours' THEN 'overdue'
    WHEN (now() - ${caseKeyDatesTable.completionSlaActivatedAt}) >= interval '48 hours' THEN 'soon'
    ELSE 'due'
  END` : sql<string | null>`NULL`;

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

  const conditions = [
    eq(casesTable.firmId, req.firmId!),
    sql`${casesTable.deletedAt} IS NULL`,
    eq(casesTable.approvalStatus, approvalStatus),
  ];
  const canAssignAny = await hasRolePermission(r, req.firmId!, req.roleId, "cases", "assign_any");
  const canAssignAnyEffective = canAssignAny || (approvalStatus !== "approved" && canReviewApproval);
  if (!canAssignAnyEffective) {
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
      conditions.push(sql`${caseKeyDatesTable.noaServedOn} IS NOT NULL`);
    } else if (spaStatus === "Completed" && hasKeyDates) {
      conditions.push(sql`${caseKeyDatesTable.completionDate} IS NOT NULL`);
    } else {
      conditions.push(sql`${spaStatusExpr} = ${spaStatus}`);
    }
  }
  if (loanStatus) {
    conditions.push(sql`${loanStatusExpr} = ${loanStatus}`);
  }
  if (milestone && milestonePresenceEffective) {
    if (milestonePresenceEffective === "filled" || milestonePresenceEffective === "missing") {
      if (hasKeyDates && hasWorkflowSteps) {
        if (loanOnlyMilestones.has(milestone)) {
          conditions.push(eq(casesTable.purchaseMode, "loan"));
        }
        if (milestonePresenceEffective === "missing" && encumbranceOnlyWhenMissing.has(milestone)) {
          conditions.push(eq(casesTable.isEncumbered, true));
        }
        conditions.push(milestonePresenceWhereSql(milestone, milestonePresenceEffective));
      }
    } else if (milestonePresenceEffective === "completed" || milestonePresenceEffective === "pending") {
      if (hasWorkflowSteps) {
        conditions.push(milestonePresenceWhereSql(milestone, milestonePresenceEffective));
      }
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
  const submittedByNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${usersTable}
    WHERE ${usersTable.id} = ${casesTable.submittedBy}
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
      completionSlaStatus: completionSlaStatusExpr,
      completionSlaActivatedAt: completionSlaActivatedAtExpr,
      completionSlaHoursElapsed: completionSlaHoursElapsedExpr,
      approvalStatus: casesTable.approvalStatus,
      submittedAt: casesTable.submittedAt,
      submittedBy: casesTable.submittedBy,
      submittedByName: submittedByNameSql,
      caseType: casesTable.caseType,
      tenure: casesTable.tenure,
      encumbrances: casesTable.encumbrances,
      actingFor: casesTable.actingFor,
      perfectionType: casesTable.perfectionType,
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
  if (process.env.DEBUG_DATA_DUMP === "1") {
    console.log(
      "!!! DEBUG_DATA_DUMP:",
      JSON.stringify({
        route: "GET /cases",
        firmId: req.firmId,
        rowsCount: rows.length,
        total: Number(totalRes?.c ?? 0),
        sample: rows.slice(0, 3).map((r) => ({ id: r.id, referenceNo: r.referenceNo })),
      })
    );
  }

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
      approvalStatus: row.approvalStatus,
      submittedAt: row.submittedAt ? new Date(row.submittedAt as any).toISOString() : null,
      submittedBy: row.submittedBy ?? null,
      submittedByName: row.submittedByName ?? null,
      caseType: row.caseType,
      tenure: row.tenure,
      encumbrances: row.encumbrances ?? null,
      actingFor: row.actingFor ?? null,
      perfectionType: row.perfectionType ?? null,
      milestones: {
        spa_date: row.mSpaDate ?? null,
        spa_stamped_date: row.mSpaStampedDate ?? null,
        letter_of_offer_date: row.mLetterOfOfferDate ?? null,
        loan_docs_signed_date: row.mLoanDocsSignedDate ?? null,
        completion_date: row.mCompletionDate ?? null,
      },
      completionSla: row.completionSlaStatus ? {
        status: row.completionSlaStatus,
        activatedAt: row.completionSlaActivatedAt ?? null,
        hoursElapsed: Number(row.completionSlaHoursElapsed ?? 0),
      } : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

    res.json({ data, total: Number(totalRes?.c ?? 0), page, limit });
  } catch (err) {
    console.error("!!! DB_DEBUG: Cases list error:", err);
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, query: req.query }, "[cases]");
    try {
      const r = rdb(req);
      let canAssignAnyFallback = false;
      try {
        canAssignAnyFallback = await hasRolePermission(r, req.firmId!, req.roleId, "cases", "assign_any");
      } catch {
        canAssignAnyFallback = false;
      }
      const params2 = ListCasesQueryParams.safeParse(req.query);
      const search2 = params2.success ? params2.data.search : undefined;
      const status2 = params2.success ? params2.data.status : undefined;
      const projectId2 = params2.success ? params2.data.projectId : undefined;
      const developerId2 = params2.success ? params2.data.developerId : undefined;
      const purchaseMode2 = params2.success ? params2.data.purchaseMode : undefined;
      const titleType2 = params2.success ? params2.data.titleType : undefined;
      const page2 = params2.success ? (params2.data.page ?? 1) : 1;
      const limit2 = params2.success ? (params2.data.limit ?? 20) : 20;
      const offset2 = (page2 - 1) * limit2;

      const one2 = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v;
      const approvalStatusRaw2 = one2(req.query.approvalStatus as any);
      const approvalStatus2 = (() => {
        const s = (approvalStatusRaw2 ?? "").trim().toLowerCase();
        if (s === "pending_approval") return "pending_approval";
        if (s === "rejected") return "rejected";
        if (s === "needs_correction") return "needs_correction";
        if (s === "approved") return "approved";
        return "approved";
      })();
      const roleNameForApproval2 = await getRoleName(r, req.firmId!, req.roleId);
      const canReviewApproval2 = isCaseApprovalRoleName(roleNameForApproval2);
      if (approvalStatus2 !== "approved" && !canReviewApproval2) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const conditions2 = [
        eq(casesTable.firmId, req.firmId!),
        sql`${casesTable.deletedAt} IS NULL`,
        eq(casesTable.approvalStatus, approvalStatus2),
      ];
      const canAssignAnyEffective2 = canAssignAnyFallback || (approvalStatus2 !== "approved" && canReviewApproval2);
      if (!canAssignAnyEffective2) {
        conditions2.push(sql`EXISTS (
          SELECT 1
          FROM ${caseAssignmentsTable}
          WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
            AND ${caseAssignmentsTable.userId} = ${req.userId}
            AND ${caseAssignmentsTable.unassignedAt} IS NULL
        )`);
      }
      if (status2) conditions2.push(eq(casesTable.status, status2));
      if (projectId2) conditions2.push(eq(casesTable.projectId, projectId2));
      if (developerId2) conditions2.push(eq(casesTable.developerId, developerId2));
      if (purchaseMode2) conditions2.push(eq(casesTable.purchaseMode, purchaseMode2));
      if (titleType2) {
        const parts = String(titleType2).split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length === 1) conditions2.push(eq(casesTable.titleType, parts[0]));
        else conditions2.push(or(...parts.map((p) => eq(casesTable.titleType, p))));
      }
      if (search2 && search2.trim()) {
        const like = `%${search2.trim()}%`;
        conditions2.push(or(
          sql`${casesTable.referenceNo} ILIKE ${like}`,
          sql`COALESCE(${casesTable.parcelNo}, '') ILIKE ${like}`
        ));
      }

      const baseRows = await r
        .select({
          id: casesTable.id,
          referenceNo: casesTable.referenceNo,
          status: casesTable.status,
          purchaseMode: casesTable.purchaseMode,
          titleType: casesTable.titleType,
          parcelNo: casesTable.parcelNo,
          createdAt: casesTable.createdAt,
          updatedAt: casesTable.updatedAt,
          approvalStatus: casesTable.approvalStatus,
          submittedAt: casesTable.submittedAt,
          submittedBy: casesTable.submittedBy,
          caseType: casesTable.caseType,
          tenure: casesTable.tenure,
          encumbrances: casesTable.encumbrances,
          actingFor: casesTable.actingFor,
          perfectionType: casesTable.perfectionType,
        })
        .from(casesTable)
        .where(and(...conditions2))
        .orderBy(desc(casesTable.updatedAt))
        .limit(limit2)
        .offset(offset2);

      const [totalRow] = await r
        .select({ c: count() })
        .from(casesTable)
        .where(and(...conditions2));

      const data = baseRows.map((row) => ({
        id: row.id,
        referenceNo: row.referenceNo,
        clientName: null,
        projectName: "Unknown",
        developerName: "Unknown",
        property: row.parcelNo ?? null,
        purchaseMode: row.purchaseMode,
        titleType: row.titleType,
        status: row.status,
        assignedLawyerId: null,
        assignedLawyerName: null,
        assignedClerkId: null,
        assignedClerkName: null,
        spaStatus: "Pending",
        loanStatus: row.purchaseMode === "loan" ? "Pending" : null,
        approvalStatus: row.approvalStatus,
        submittedAt: row.submittedAt ? new Date(row.submittedAt as any).toISOString() : null,
        submittedBy: row.submittedBy ?? null,
        submittedByName: null,
        caseType: row.caseType,
        tenure: row.tenure,
        encumbrances: row.encumbrances ?? null,
        actingFor: row.actingFor ?? null,
        perfectionType: row.perfectionType ?? null,
        milestones: {
          spa_date: null,
          spa_stamped_date: null,
          letter_of_offer_date: null,
          loan_docs_signed_date: null,
          completion_date: null,
        },
        completionSla: null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));

      res.json({ data, total: Number(totalRow?.c ?? 0), page: page2, limit: limit2 });
      return;
    } catch (fallbackErr) {
      logger.error({ err: fallbackErr, path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] list fallback failed");
      res.json({ data: [], total: 0, page: 1, limit: 20 });
      return;
    }
  }
}));

router.post("/cases", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "create") as RequestHandler, authed(async (req, res) => {
  let safeReqBody: Record<string, unknown> | null = null;
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "POST /api/cases", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }

    try {
      const health = await checkCasesSchemaHealth(r);
      if (!health.ok) {
        req.log.error({ route: "POST /api/cases", firmId: req.firmId, userId: req.userId, issues: health.issues }, "cases schema out of date");
        if (process.env.API_ERROR_DETAILS === "1") {
          res.status(503).json({ error: "Database schema out of date", code: "DB_MIGRATION_REQUIRED", issues: health.issues });
          return;
        }
        res.status(503).json({ error: "Database schema out of date", code: "DB_MIGRATION_REQUIRED" });
        return;
      }
    } catch (schemaErr) {
      req.log.error({ err: schemaErr, route: "POST /api/cases", firmId: req.firmId, userId: req.userId }, "cases schema check failed");
    }

    const money = z.preprocess((v) => {
      if (v === "" || v === undefined || v === null) return null;
      if (typeof v === "number") return v;
      if (typeof v === "string") return Number(v.replace(/[^0-9.]/g, ""));
      return v;
    }, z.number().finite().nullable());

    const optionalTrimmedString = (value: unknown): string | undefined => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const normalizeOptionalLower = (value: unknown): string | undefined => {
      const trimmed = optionalTrimmedString(value);
      return trimmed ? trimmed.toLowerCase() : undefined;
    };

    const createCaseSchema = z.object({
      caseType: z.string().min(1),
      projectId: z.coerce.number().int().positive().optional(),
      developerId: z.coerce.number().int().positive().optional(),
      referenceNo: z.string().trim().max(80).optional(),
      purchaseMode: z.preprocess((v) => normalizeOptionalLower(v), z.string().optional()).default("cash"),
      titleType: z.preprocess((v) => normalizeOptionalLower(v), z.string().optional()),
      landCondition: z.preprocess((v) => normalizeOptionalLower(v), z.string().optional()),
      encumbrances: z.preprocess((v) => normalizeOptionalLower(v), z.string().optional()),
      actingFor: z.preprocess((v) => normalizeOptionalLower(v), z.string().optional()),
      perfectionType: z.preprocess((v) => normalizeOptionalLower(v), z.string().optional()),
      spaPrice: money.optional(),
      apdlPrice: money.optional(),
      developerDiscount: money.optional(),
      bumiputraDiscount: money.optional(),
      assignedLawyerId: z.coerce.number().int().positive().optional(),
      assignedClerkId: z.coerce.number().int().positive().optional(),
      purchaserIds: z.array(z.coerce.number().int().positive()).optional(),
      purchasers: z.array(z.object({
        isCompany: z.boolean().optional(),
        name: z.string(),
        ic: z.string().nullish(),
        phone: z.string().nullish(),
        email: z.string().nullish(),
        address: z.string().nullish(),
      }).passthrough()).optional(),
      loanPartyType: z.enum(["1st_party", "3rd_party"]).optional(),
      borrowers: z.array(z.object({
        name: z.string(),
        ic: z.string().nullish(),
        hp: z.string().nullish(),
        email: z.string().nullish(),
        address: z.string().nullish().transform((v) => (typeof v === "string" ? v : "")).transform((v) => v.trim()),
      }).passthrough()).optional(),
      parcelNo: z.string().optional(),
      spaDetails: z.record(z.string(), z.unknown()).optional(),
      propertyDetails: z.unknown().optional(),
      propertyAddress: z.string().optional(),
      loanDetails: z.unknown().optional(),
      companyDetails: z.record(z.string(), z.unknown()).optional(),
    }).passthrough().superRefine((v, ctx) => {
      const normalizedCaseType = normalizeCaseType(v.caseType);
      if (!normalizedCaseType) {
        ctx.addIssue({ code: "custom", path: ["caseType"], message: "Invalid caseType" });
        return;
      }
      if (v.purchaseMode !== "loan" && v.purchaseMode !== "cash" && v.purchaseMode !== "other") {
        ctx.addIssue({ code: "custom", path: ["purchaseMode"], message: "Invalid purchaseMode" });
      }

      const normalizedTitleType = v.titleType ? normalizeTitleType(v.titleType) : null;
      const landCondition = (v.landCondition || "").trim().toLowerCase();
      const encumbrances = (v.encumbrances || "").trim().toLowerCase();
      const actingFor = (v.actingFor || "").trim().toLowerCase();
      const perfectionType = (v.perfectionType || "").trim().toLowerCase();

      if (normalizedCaseType === "developer_sales") {
        if (!Number.isInteger(v.projectId) || Number(v.projectId) <= 0) {
          ctx.addIssue({ code: "custom", path: ["projectId"], message: "Project is required" });
        }
        const tt = normalizedTitleType ?? normalizeTitleType("master");
        if (!tt) ctx.addIssue({ code: "custom", path: ["titleType"], message: "Invalid titleType" });
      } else if (normalizedCaseType === "subsale") {
        if (!normalizedTitleType) ctx.addIssue({ code: "custom", path: ["titleType"], message: "Title Category is required" });
        if (landCondition !== "freehold" && landCondition !== "leasehold") {
          ctx.addIssue({ code: "custom", path: ["landCondition"], message: "Land Condition is required" });
        }
        if (encumbrances !== "no_encumbrance" && encumbrances !== "has_encumbrance" && encumbrances !== "to_confirm") {
          ctx.addIssue({ code: "custom", path: ["encumbrances"], message: "Encumbrances is required" });
        }
        if (actingFor !== "vendor" && actingFor !== "purchaser" && actingFor !== "both") {
          ctx.addIssue({ code: "custom", path: ["actingFor"], message: "Acting is required" });
        }
      } else if (normalizedCaseType === "perfection") {
        if (perfectionType !== "transfer_and_charge" && perfectionType !== "transfer" && perfectionType !== "charge") {
          ctx.addIssue({ code: "custom", path: ["perfectionType"], message: "Perfection Type is required" });
        }
      }

      if (v.apdlPrice !== null && v.apdlPrice !== undefined && v.spaPrice !== null && v.spaPrice !== undefined) {
        const expected = v.apdlPrice - (v.developerDiscount ?? 0) - (v.bumiputraDiscount ?? 0);
        if (Math.abs(expected - v.spaPrice) > 0.009) {
          ctx.addIssue({ code: "custom", path: ["spaPrice"], message: "spaPrice must equal apdlPrice - developerDiscount - bumiputraDiscount" });
        }
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
      const errors = parsed.error.issues.map((i) => ({
        path: i.path.map((p) => String(p)).join("."),
        message: i.message,
      }));
      res.status(400).json({ error: "Validation failed", errors, fields: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      await checkFirmQuota(r, req.firmId!, "cases");
    } catch (err) {
      if (err instanceof ApiError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }

    const {
      caseType,
      projectId: projectIdRaw,
      developerId: clientDeveloperId,
      purchaseMode,
      titleType,
      landCondition,
      encumbrances,
      actingFor,
      perfectionType,
      spaPrice,
      apdlPrice,
      developerDiscount,
      bumiputraDiscount,
      assignedLawyerId,
      assignedClerkId,
      purchaserIds,
      purchasers,
      loanPartyType,
      borrowers: requestedBorrowers,
      parcelNo,
      spaDetails,
      propertyDetails: propertyDetailsRaw,
      propertyAddress,
      loanDetails: loanDetailsRaw,
      companyDetails,
    } = parsed.data;

    safeReqBody = {
      caseType,
      projectId: projectIdRaw ?? null,
      developerId: clientDeveloperId ?? null,
      titleType: titleType ?? null,
      purchaseMode: purchaseMode ?? null,
      landCondition: landCondition ?? null,
      encumbrances: encumbrances ?? null,
      actingFor: actingFor ?? null,
      perfectionType: perfectionType ?? null,
    };

    const canAssignAny = await hasRolePermission(r, req.firmId!, req.roleId, "cases", "assign_any");
    const normalizedAssignedLawyerId = assignedLawyerId ?? undefined;
    const normalizedAssignedClerkId = assignedClerkId ?? undefined;
    const normalizedCaseType = normalizeCaseType(caseType);
    if (!normalizedCaseType) {
      res.status(400).json({ error: "Invalid caseType" });
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

    const landConditionNorm = typeof landCondition === "string" ? landCondition.trim().toLowerCase() : "";
    const encumbrancesNorm = typeof encumbrances === "string" ? encumbrances.trim().toLowerCase() : "";
    const actingForNorm = typeof actingFor === "string" ? actingFor.trim().toLowerCase() : "";
    const perfectionTypeNorm = typeof perfectionType === "string" ? perfectionType.trim().toLowerCase() : "";

    let effectiveProjectId: number | null = null;
    let effectiveDeveloperId: number | null = null;
    let effectiveTenure: "freehold" | "leasehold" = "freehold";
    let effectiveIsEncumbered = false;

    const normalizedTitleType = (() => {
      if (normalizedCaseType === "developer_sales") {
        const n = normalizeTitleType(titleType ?? "");
        return n ?? "master";
      }
      if (normalizedCaseType === "subsale") {
        const n = normalizeTitleType(titleType ?? "");
        return n ?? "master";
      }
      return "master";
    })();

    if (normalizedCaseType === "developer_sales") {
      if (!projectIdRaw) {
        res.status(400).json({ error: "Project is required" });
        return;
      }
      const [project] = await r.select().from(projectsTable).where(eq(projectsTable.id, projectIdRaw));
      if (!project || project.firmId !== req.firmId) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      effectiveProjectId = projectIdRaw;
      if (clientDeveloperId !== undefined) {
        const [dev] = await r
          .select({ id: developersTable.id })
          .from(developersTable)
          .where(and(eq(developersTable.firmId, req.firmId!), eq(developersTable.id, clientDeveloperId)))
          .limit(1);
        if (!dev) {
          res.status(400).json({ error: "Developer not found" });
          return;
        }
        effectiveDeveloperId = clientDeveloperId;
      } else if (project.developerId) {
        effectiveDeveloperId = project.developerId;
      }
      if (!effectiveDeveloperId) {
        res.status(422).json({ error: "Developer is required" });
        return;
      }
      effectiveIsEncumbered = Boolean((project as any).isEncumbered ?? false);
      const projectTenure = String((project as any).tenure ?? "").trim().toLowerCase();
      effectiveTenure = projectTenure === "leasehold" ? "leasehold" : "freehold";
    } else if (normalizedCaseType === "subsale") {
      effectiveTenure = landConditionNorm === "leasehold" ? "leasehold" : "freehold";
      effectiveIsEncumbered = encumbrancesNorm === "has_encumbrance";
    } else {
      effectiveTenure = "freehold";
      effectiveIsEncumbered = false;
    }

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
        const trimmedName = String(p.name ?? "").trim();
        if (!trimmedName) continue;
        const trimmedIc = typeof p.ic === "string" ? p.ic.trim() : null;
        const trimmedPhone = typeof p.phone === "string" ? p.phone.trim() : null;
        const trimmedEmail = typeof p.email === "string" ? p.email.trim() : null;
        const trimmedAddress = typeof p.address === "string" ? p.address.trim() : null;

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
          if (trimmedPhone || trimmedEmail || trimmedAddress) {
            const [existing] = await r
              .select({ id: clientsTable.id, phone: clientsTable.phone, email: clientsTable.email, address: clientsTable.address })
              .from(clientsTable)
              .where(and(eq(clientsTable.firmId, req.firmId!), eq(clientsTable.id, existingClientId)))
              .limit(1);
            if (existing) {
              const patch: Record<string, unknown> = {};
              if (trimmedPhone && !String(existing.phone ?? "").trim()) patch.phone = trimmedPhone;
              if (trimmedEmail && !String(existing.email ?? "").trim()) patch.email = trimmedEmail;
              if (trimmedAddress && !String(existing.address ?? "").trim()) patch.address = trimmedAddress;
              if (Object.keys(patch).length > 0) {
                await r.update(clientsTable).set(patch).where(and(eq(clientsTable.firmId, req.firmId!), eq(clientsTable.id, existingClientId)));
              }
            }
          }
        } else {
          const insertBase = {
            firmId: req.firmId!,
            name: trimmedName,
            icNo: trimmedIc,
            phone: trimmedPhone,
            email: trimmedEmail,
            address: trimmedAddress,
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

    const normalizeBorrowers = (raw: unknown): Array<{ name: string; ic?: string; hp?: string; email?: string; address: string }> => {
      if (!Array.isArray(raw)) return [];
      const out: Array<{ name: string; ic?: string; hp?: string; email?: string; address: string }> = [];
      for (const v of raw) {
        const name = typeof (v as any)?.name === "string" ? String((v as any).name).trim() : "";
        if (!name) continue;
        const icRaw = (v as any)?.ic;
        const ic = typeof icRaw === "string" ? icRaw.trim() : "";
        const hpRaw = (v as any)?.hp;
        const hp = typeof hpRaw === "string" ? hpRaw.trim() : "";
        const emailRaw = (v as any)?.email;
        const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
        const addressRaw = (v as any)?.address;
        const address = typeof addressRaw === "string" ? addressRaw.trim() : "";
        const base = ic ? { name, ic, address } : { name, address };
        if (hp) (base as any).hp = hp;
        if (email) (base as any).email = email;
        out.push(base as any);
      }
      return out;
    };

    const normalizedRequestedBorrowers = normalizeBorrowers(requestedBorrowers);
    const isLoan = purchaseMode === "loan";
    const effectiveLoanPartyType: "1st_party" | "3rd_party" = isLoan ? (loanPartyType ?? "1st_party") : "1st_party";
    let borrowersToStore: Array<{ name: string; ic?: string; hp?: string; email?: string; address: string }> = [];

    if (isLoan) {
      if (effectiveLoanPartyType === "1st_party") {
        if (resolvedPurchaserIds.length === 0) {
          borrowersToStore = [];
        } else {
        const rows = await r
          .select({ id: clientsTable.id, name: clientsTable.name, ic: clientsTable.icNo, phone: clientsTable.phone, email: clientsTable.email, address: clientsTable.address })
          .from(clientsTable)
          .where(and(eq(clientsTable.firmId, req.firmId!), inArray(clientsTable.id, resolvedPurchaserIds)));
        const byId = new Map<number, { name: string; ic: string | null; phone: string | null; email: string | null; address: string | null }>();
        for (const row of rows) byId.set(row.id, { name: String(row.name ?? ""), ic: row.ic ?? null, phone: row.phone ?? null, email: row.email ?? null, address: row.address ?? null });
        borrowersToStore = resolvedPurchaserIds
          .map((id) => {
            const v = byId.get(id);
            const name = v?.name?.trim() ?? "";
            const ic = v?.ic ? String(v.ic).trim() : "";
            const hp = v?.phone ? String(v.phone).trim() : "";
            const email = v?.email ? String(v.email).trim() : "";
            const address = v?.address ? String(v.address).trim() : "";
            const base = ic ? { name, ic, address } : { name, address };
            if (hp) (base as any).hp = hp;
            if (email) (base as any).email = email;
            return base as any;
          })
          .filter((b) => b.name.trim().length > 0);
        }
      } else {
        borrowersToStore = normalizedRequestedBorrowers;
        if (borrowersToStore.length === 0 && loanDetailsRaw && typeof loanDetailsRaw === "object") {
          const ld: any = loanDetailsRaw as any;
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

    const normalizedPropertyDetails = (() => {
      if (!propertyDetailsRaw || typeof propertyDetailsRaw !== "object" || Array.isArray(propertyDetailsRaw)) {
        return propertyAddress ? ({ propertyAddress: String(propertyAddress).trim() } as Record<string, unknown>) : null;
      }
      const base = { ...(propertyDetailsRaw as Record<string, unknown>) };
      if (propertyAddress !== undefined) base.propertyAddress = String(propertyAddress).trim();
      return base;
    })();

    const normalizedLoanDetails = (loanDetailsRaw && typeof loanDetailsRaw === "object" && !Array.isArray(loanDetailsRaw))
      ? (loanDetailsRaw as Record<string, unknown>)
      : null;

    const spaPriceToInsert = spaPrice !== undefined && spaPrice !== null ? String(spaPrice) : null;
    const apdlPriceToInsert = apdlPrice !== undefined && apdlPrice !== null ? String(apdlPrice) : null;
    const developerDiscountToInsert = developerDiscount !== undefined && developerDiscount !== null ? String(developerDiscount) : null;
    const bumiputraDiscountToInsert = bumiputraDiscount !== undefined && bumiputraDiscount !== null ? String(bumiputraDiscount) : null;

    const insertCaseBase = {
      firmId: req.firmId!,
      projectId: effectiveProjectId,
      developerId: effectiveDeveloperId,
      purchaseMode,
      titleType: normalizedTitleType,
      isEncumbered: effectiveIsEncumbered,
      tenure: effectiveTenure,
      spaPrice: spaPriceToInsert,
      apdlPrice: apdlPriceToInsert,
      developerDiscount: developerDiscountToInsert,
      bumiputraDiscount: bumiputraDiscountToInsert,
      status: "Pending Approval",
      caseType: normalizedCaseType,
      parcelNo: parcelNo ?? null,
      spaDetails: spaDetails ? JSON.stringify(spaDetails) : null,
      propertyDetails: normalizedPropertyDetails,
      loanDetails: normalizedLoanDetails,
      loanPartyType: purchaseMode === "loan" ? (loanPartyType ?? "1st_party") : "1st_party",
      borrowers: borrowersToStore,
      companyDetails: companyDetails ? JSON.stringify(companyDetails) : null,
      createdBy: req.userId ?? null,
      approvalStatus: "pending_approval",
      submittedBy: req.userId ?? null,
      submittedAt: new Date(),
      encumbrances: normalizedCaseType === "subsale" ? (encumbrancesNorm || null) : null,
      actingFor: normalizedCaseType === "subsale" ? (actingForNorm || null) : null,
      perfectionType: normalizedCaseType === "perfection" ? (perfectionTypeNorm || null) : null,
    } satisfies Omit<typeof casesTable.$inferInsert, "referenceNo">;

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

    const [newCase] = await r
      .insert(casesTable)
      .values({ ...insertCaseBase, referenceNo: null } satisfies typeof casesTable.$inferInsert)
      .returning();
    if (!newCase) {
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }

    for (let i = 0; i < resolvedPurchaserIds.length; i++) {
      await r.insert(casePurchasersTable).values({
        caseId: newCase.id,
        clientId: resolvedPurchaserIds[i],
        role: i === 0 ? "main" : "joint",
        orderNo: i + 1,
      });
    }

    const wantsExplicitAssignments = Boolean(canAssignAny && (normalizedAssignedLawyerId || normalizedAssignedClerkId));
    if (!wantsExplicitAssignments) {
      await r.insert(caseAssignmentsTable).values({
        caseId: newCase.id,
        userId: req.userId!,
        roleInCase: "clerk",
        assignedBy: req.userId,
      });
    } else {
      if (normalizedAssignedLawyerId) {
        await r.insert(caseAssignmentsTable).values({
          caseId: newCase.id,
          userId: normalizedAssignedLawyerId,
          roleInCase: "lawyer",
          assignedBy: req.userId,
        });
      }
      if (normalizedAssignedClerkId) {
        await r.insert(caseAssignmentsTable).values({
          caseId: newCase.id,
          userId: normalizedAssignedClerkId,
          roleInCase: "clerk",
          assignedBy: req.userId,
        });
      }
    }

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: "firm_user",
      action: "cases.create",
      entityType: "case",
      entityId: newCase.id,
      detail: `referenceNo=null purchasersCreated=${purchasersCreated} purchasersReused=${purchasersReused} approvalStatus=pending_approval`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const detail = await formatCaseDetail(r, newCase);
    res.status(201).json({ ...detail, purchasersCreated, purchasersReused, message: "Case submitted for approval." });
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
          const table = typeof cur.table === "string" ? cur.table : undefined;
          const column = typeof cur.column === "string" ? cur.column : undefined;
          return { code, message, detail, constraint, table, column };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    req.log.error({ err: e, pg, body: safeReqBody }, "cases.create failed");
    if (process.env.API_ERROR_DETAILS === "1") {
      res.status(500).json({
        error: "Internal Server Error",
        details: pg?.message ?? null,
        code: pg?.code ?? null,
        constraint: pg?.constraint ?? null,
        table: (pg as any)?.table ?? null,
        column: (pg as any)?.column ?? null,
      });
      return;
    }
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
}));

const CaseApprovalParams = z.object({ caseId: z.coerce.number().int().positive() });

router.patch("/cases/:caseId/approval", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = CaseApprovalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const roleName = await getRoleName(r, req.firmId!, req.roleId);
  if (!isCaseApprovalRoleName(roleName)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const bodySchema = z.object({ approvalNote: z.string().trim().max(5000).optional().nullable() });
  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Validation failed" });
    return;
  }
  const [c] = await r
    .select({ id: casesTable.id, approvalStatus: casesTable.approvalStatus })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  if (c.approvalStatus !== "pending_approval") {
    res.status(409).json({ error: "Case is not pending approval" });
    return;
  }
  await r
    .update(casesTable)
    .set({ approvalNote: body.data.approvalNote ?? null })
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "cases.approval.save",
    entityType: "case",
    entityId: params.data.caseId,
    detail: "approval_note_updated",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });
  res.json({ ok: true });
}));

router.post("/cases/:caseId/approve", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = CaseApprovalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const roleName = await getRoleName(r, req.firmId!, req.roleId);
  if (!isCaseApprovalRoleName(roleName)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const bodySchema = z.object({
    referenceNo: z.string().trim().min(1).max(80),
    approvalNote: z.string().trim().max(5000).optional().nullable(),
  });
  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Validation failed", fields: body.error.flatten().fieldErrors });
    return;
  }
  const [c] = await r
    .select({
      id: casesTable.id,
      approvalStatus: casesTable.approvalStatus,
      caseType: casesTable.caseType,
      purchaseMode: casesTable.purchaseMode,
      titleType: casesTable.titleType,
    })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  if (c.approvalStatus !== "pending_approval") {
    res.status(409).json({ error: "Case is not pending approval" });
    return;
  }
  try {
    await r
      .update(casesTable)
      .set({
        approvalStatus: "approved",
        referenceNo: body.data.referenceNo.trim(),
        approvedBy: req.userId ?? null,
        approvedAt: new Date(),
        approvalNote: body.data.approvalNote ?? null,
        status: "File Opened / SPA Pending Signing",
      })
      .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  } catch (err: any) {
    const code = typeof err?.code === "string" ? err.code : "";
    if (code === "23505") {
      res.status(409).json({ error: "Reference Number already exists in this firm" });
      return;
    }
    throw err;
  }

  if (c.caseType === "developer_sales") {
    const wfExists = await tableExists(r, "public.case_workflow_steps");
    if (wfExists) {
      const existing = await r
        .select({ id: caseWorkflowStepsTable.id })
        .from(caseWorkflowStepsTable)
        .where(eq(caseWorkflowStepsTable.caseId, params.data.caseId))
        .limit(1);
      if (existing.length === 0) {
        const workflowSteps = buildWorkflowSteps(c.purchaseMode === "loan" ? "loan" : "cash", normalizeTitleType(c.titleType) ?? "master");
        if (workflowSteps.length > 0) {
          await r.insert(caseWorkflowStepsTable).values(
            workflowSteps.map((s) => ({
              caseId: params.data.caseId,
              stepKey: s.stepKey,
              stepName: s.stepName,
              stepOrder: s.stepOrder,
              pathType: s.pathType,
              status: "pending",
            }))
          );
        }
      }
    }
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "cases.approve",
    entityType: "case",
    entityId: params.data.caseId,
    detail: `referenceNo=${body.data.referenceNo.trim()}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });
  res.json({ ok: true });
}));

router.post("/cases/:caseId/reject", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
  const params = CaseApprovalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const roleName = await getRoleName(r, req.firmId!, req.roleId);
  if (!isCaseApprovalRoleName(roleName)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const bodySchema = z.object({ approvalNote: z.string().trim().min(1).max(5000) });
  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Validation failed", fields: body.error.flatten().fieldErrors });
    return;
  }
  const [c] = await r
    .select({ id: casesTable.id, approvalStatus: casesTable.approvalStatus })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  if (c.approvalStatus !== "pending_approval") {
    res.status(409).json({ error: "Case is not pending approval" });
    return;
  }
  await r
    .update(casesTable)
    .set({
      approvalStatus: "rejected",
      approvedBy: req.userId ?? null,
      approvedAt: new Date(),
      approvalNote: body.data.approvalNote.trim(),
      status: "Rejected",
    })
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "cases.reject",
    entityType: "case",
    entityId: params.data.caseId,
    detail: "rejected",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });
  res.json({ ok: true });
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
    logger.error({ err: e, pgCode: getPgCode(e), firmId: req.firmId, userId: req.userId, caseId: params.data.caseId }, "[cases] get case failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
}));

async function updateCompletionSlaState(r: DbConn, firmId: number, caseId: number): Promise<{ activatedAt: string | null; notified48hAt: string | null }> {
  const kdExists = await tableExists(r, "public.case_key_dates");
  if (!kdExists) return { activatedAt: null, notified48hAt: null };

  let kd: any = null;
  try {
    [kd] = await r
      .select({
        id: caseKeyDatesTable.id,
        differentialSumSettledOn: caseKeyDatesTable.differentialSumSettledOn,
        noaDated: caseKeyDatesTable.noaDated,
        registerPoaOn: caseKeyDatesTable.registerPoaOn,
        registeredPoaRegistrationNumber: caseKeyDatesTable.registeredPoaRegistrationNumber,
        adviceToBankDate: caseKeyDatesTable.adviceToBankDate,
        completionSlaActivatedAt: caseKeyDatesTable.completionSlaActivatedAt,
        completionSlaNotified48hAt: caseKeyDatesTable.completionSlaNotified48hAt,
      })
      .from(caseKeyDatesTable)
      .where(and(eq(caseKeyDatesTable.firmId, firmId), eq(caseKeyDatesTable.caseId, caseId)))
      .limit(1);
  } catch (err) {
    if (isUndefinedColumnError(err)) return { activatedAt: null, notified48hAt: null };
    throw err;
  }
  if (!kd) return { activatedAt: null, notified48hAt: null };

  const wfExists = await tableExists(r, "public.case_workflow_documents");
  const poaKeys = ["register_poa", ...(workflowDocumentLegacyKeys("register_poa" as WorkflowDocumentMilestoneKey) ?? [])];
  const hasPoaFile = wfExists
    ? Boolean((await r
        .select({ id: caseWorkflowDocumentsTable.id })
        .from(caseWorkflowDocumentsTable)
        .where(and(
          eq(caseWorkflowDocumentsTable.firmId, firmId),
          eq(caseWorkflowDocumentsTable.caseId, caseId),
          inArray(caseWorkflowDocumentsTable.milestoneKey, poaKeys),
          sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
          sql`${caseWorkflowDocumentsTable.objectPath} IS NOT NULL`,
          sql`${caseWorkflowDocumentsTable.fileName} IS NOT NULL`,
        ))
        .limit(1))[0])
    : false;

  const ready = Boolean(kd.differentialSumSettledOn && kd.noaDated && kd.registerPoaOn && kd.registeredPoaRegistrationNumber?.trim() && hasPoaFile);
  const shouldClear = Boolean(kd.adviceToBankDate) || (!ready && Boolean(kd.completionSlaActivatedAt));
  const shouldActivate = ready && !kd.completionSlaActivatedAt && !kd.adviceToBankDate;

  if (shouldClear) {
    const [row] = await r
      .update(caseKeyDatesTable)
      .set({ completionSlaActivatedAt: null, completionSlaNotified48hAt: null })
      .where(and(eq(caseKeyDatesTable.firmId, firmId), eq(caseKeyDatesTable.caseId, caseId)))
      .returning({ completionSlaActivatedAt: caseKeyDatesTable.completionSlaActivatedAt, completionSlaNotified48hAt: caseKeyDatesTable.completionSlaNotified48hAt });
    return {
      activatedAt: row?.completionSlaActivatedAt ? row.completionSlaActivatedAt.toISOString() : null,
      notified48hAt: row?.completionSlaNotified48hAt ? row.completionSlaNotified48hAt.toISOString() : null,
    };
  }

  if (shouldActivate) {
    const [row] = await r
      .update(caseKeyDatesTable)
      .set({ completionSlaActivatedAt: new Date() })
      .where(and(eq(caseKeyDatesTable.firmId, firmId), eq(caseKeyDatesTable.caseId, caseId)))
      .returning({ completionSlaActivatedAt: caseKeyDatesTable.completionSlaActivatedAt, completionSlaNotified48hAt: caseKeyDatesTable.completionSlaNotified48hAt });
    await writeAuditLog({ firmId, actorId: null, actorType: "system", action: "cases.completion_sla.activated", entityType: "case", entityId: caseId, detail: "Completion SLA activated" });
    return {
      activatedAt: row?.completionSlaActivatedAt ? row.completionSlaActivatedAt.toISOString() : null,
      notified48hAt: row?.completionSlaNotified48hAt ? row.completionSlaNotified48hAt.toISOString() : null,
    };
  }

  return {
    activatedAt: kd.completionSlaActivatedAt ? kd.completionSlaActivatedAt.toISOString() : null,
    notified48hAt: kd.completionSlaNotified48hAt ? kd.completionSlaNotified48hAt.toISOString() : null,
  };
}

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
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;
  let kd: Record<string, unknown> | null = null;
  try {
    kd = await fetchKeyDatesRow(r, req.firmId!, params.data.caseId);
  } catch (err) {
    logger.error({ err, pgCode: getPgCode(err), firmId: req.firmId, userId: req.userId, caseId: params.data.caseId }, "[cases] get key-dates failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const out: Record<string, unknown> = kd ? {
    spa_signed_date: pickDateString(kd, "spaSignedDate", "spa_signed_date"),
    spa_forward_to_developer_execution_on: pickDateString(kd, "spaForwardToDeveloperExecutionOn", "spa_forward_to_developer_execution_on"),
    spa_received_dev_return_spa_on: pickDateString(kd, "spaReceivedDevReturnSpaOn", "spa_received_dev_return_spa_on"),
    spa_date: pickDateString(kd, "spaDate", "spa_date"),
    spa_stamped_date: pickDateString(kd, "spaStampedDate", "spa_stamped_date"),
    stamped_spa_send_to_developer_on: pickDateString(kd, "stampedSpaSendToDeveloperOn", "stamped_spa_send_to_developer_on"),
    stamped_spa_received_from_developer_on: pickDateString(kd, "stampedSpaReceivedFromDeveloperOn", "stamped_spa_received_from_developer_on"),
    stamped_spa_sent_to_purchaser_on: pickDateString(kd, "stampedSpaSentToPurchaserOn", "stamped_spa_sent_to_purchaser_on"),
    li_date: pickDateString(kd, "liDate", "li_date"),
    li_received_on: pickDateString(kd, "liReceivedOn", "li_received_on"),
    letter_of_offer_date: pickDateString(kd, "letterOfOfferDate", "letter_of_offer_date"),
    letter_of_offer_stamped_date: pickDateString(kd, "letterOfOfferStampedDate", "letter_of_offer_stamped_date"),
    supp_lo_date: pickDateString(kd, "suppLoDate", "supp_lo_date"),
    loan_docs_pending_date: pickDateString(kd, "loanDocsPendingDate", "loan_docs_pending_date"),
    loan_docs_signed_date: pickDateString(kd, "loanDocsSignedDate", "loan_docs_signed_date"),
    acting_letter_issued_date: pickDateString(kd, "actingLetterIssuedDate", "acting_letter_issued_date"),
    developer_confirmation_received_on: pickDateString(kd, "developerConfirmationReceivedOn", "developer_confirmation_received_on"),
    developer_confirmation_date: pickDateString(kd, "developerConfirmationDate", "developer_confirmation_date"),
    loan_sent_bank_execution_date: pickDateString(kd, "loanSentBankExecutionDate", "loan_sent_bank_execution_date"),
    loan_bank_executed_date: pickDateString(kd, "loanBankExecutedDate", "loan_bank_executed_date"),
    differential_sum_rm: pickNumber(kd, "differentialSumRm", "differential_sum_rm"),
    differential_sum_settled_on: pickDateString(kd, "differentialSumSettledOn", "differential_sum_settled_on"),
    bank_lu_dated: pickDateString(kd, "bankLuDated", "bank_lu_dated"),
    bank_lu_received_date: pickDateString(kd, "bankLuReceivedDate", "bank_lu_received_date"),
    bank_lu_forward_to_developer_on: pickDateString(kd, "bankLuForwardToDeveloperOn", "bank_lu_forward_to_developer_on"),
    developer_lu_received_on: pickDateString(kd, "developerLuReceivedOn", "developer_lu_received_on"),
    developer_lu_dated: pickDateString(kd, "developerLuDated", "developer_lu_dated"),
    master_lu_exempted: Boolean(pickValue(kd, "masterLuExempted", "master_lu_exempted")),
    encumbrance_free_exempted: Boolean(pickValue(kd, "encumbranceFreeExempted", "encumbrance_free_exempted")),
    letter_disclaimer_received_on: pickDateString(kd, "letterDisclaimerReceivedOn", "letter_disclaimer_received_on"),
    letter_disclaimer_dated: pickDateString(kd, "letterDisclaimerDated", "letter_disclaimer_dated"),
    letter_disclaimer_reference_nos: pickString(kd, "letterDisclaimerReferenceNos", "letter_disclaimer_reference_nos"),
    redemption_sum: pickNumber(kd, "redemptionSum", "redemption_sum"),
    balance_sum_less_last_5_rm: pickNumber(kd, "balanceSumLessLast5Rm", "balance_sum_less_last_5_rm"),
    bankruptcy_search_dated: pickDateString(kd, "bankruptcySearchDated", "bankruptcy_search_dated"),
    loan_agreement_dated: pickDateString(kd, "loanAgreementDated", "loan_agreement_dated"),
    loan_agreement_submitted_stamping_date: pickDateString(kd, "loanAgreementSubmittedStampingDate", "loan_agreement_submitted_stamping_date"),
    loan_agreement_stamped_date: pickDateString(kd, "loanAgreementStampedDate", "loan_agreement_stamped_date"),
    received_executed_document_on_1: pickDateString(kd, "receivedExecutedDocumentOn1", "received_executed_document_on_1"),
    received_unexecuted_document_on: pickDateString(kd, "receivedUnexecutedDocumentOn", "received_unexecuted_document_on"),
    resent_bank_execution_dated: pickDateString(kd, "resentBankExecutionDated", "resent_bank_execution_dated"),
    received_executed_document_on_2: pickDateString(kd, "receivedExecutedDocumentOn2", "received_executed_document_on_2"),
    statutory_declaration_dated: pickDateString(kd, "statutoryDeclarationDated", "statutory_declaration_dated"),
    statutory_declaration_stamped_on: pickDateString(kd, "statutoryDeclarationStampedOn", "statutory_declaration_stamped_on"),
    fa_date: pickDateString(kd, "faDate", "fa_date"),
    fa_adjudication_number: pickString(kd, "faAdjudicationNumber", "fa_adjudication_number"),
    fa_stamp_on: pickDateString(kd, "faStampOn", "fa_stamp_on"),
    doa_date: pickDateString(kd, "doaDate", "doa_date"),
    doa_stamp_on: pickDateString(kd, "doaStampOn", "doa_stamp_on"),
    poa_date: pickDateString(kd, "poaDate", "poa_date"),
    poa_stamp_on: pickDateString(kd, "poaStampOn", "poa_stamp_on"),
    noa_dated: pickDateString(kd, "noaDated", "noa_dated"),
    register_pa_on: pickDateString(kd, "registerPaOn", "register_pa_on"),
    pa_no: pickString(kd, "paNo", "pa_no"),
    register_poa_on: pickDateString(kd, "registerPoaOn", "register_poa_on"),
    registered_poa_registration_number: pickString(kd, "registeredPoaRegistrationNumber", "registered_poa_registration_number"),
    noa_served_on: pickDateString(kd, "noaServedOn", "noa_served_on"),
    advice_to_bank_date: pickDateString(kd, "adviceToBankDate", "advice_to_bank_date"),
    completion_sla_activated_at: pickIsoString(kd, "completionSlaActivatedAt", "completion_sla_activated_at"),
    completion_sla_notified_48h_at: pickIsoString(kd, "completionSlaNotified48hAt", "completion_sla_notified_48h_at"),
    bank_1st_release_on: pickDateString(kd, "bank1stReleaseOn", "bank_1st_release_on"),
    first_release_amount_rm: pickNumber(kd, "firstReleaseAmountRm", "first_release_amount_rm"),
    discharge_date: pickDateString(kd, "dischargeDate", "discharge_date"),
    discharge_title_received_on: pickDateString(kd, "dischargeTitleReceivedOn", "discharge_title_received_on"),
    caveat_lodged_date: pickDateString(kd, "caveatLodgedDate", "caveat_lodged_date"),
    first_advice_date: pickDateString(kd, "firstAdviceDate", "first_advice_date"),
    dev_informed_redemption_date: pickDateString(kd, "devInformedRedemptionDate", "dev_informed_redemption_date"),
    request_discharge_date: pickDateString(kd, "requestDischargeDate", "request_discharge_date"),
    charge_date: pickDateString(kd, "chargeDate", "charge_date"),
    charge_submit_stamping: pickDateString(kd, "chargeSubmitStamping", "charge_submit_stamping"),
    charge_stamped: pickDateString(kd, "chargeStamped", "charge_stamped"),
    presentation_date: pickDateString(kd, "presentationDate", "presentation_date"),
    second_advice_date: pickDateString(kd, "secondAdviceDate", "second_advice_date"),
    request_letter_no_objection: pickDateString(kd, "requestLetterNoObjection", "request_letter_no_objection"),
    received_letter_no_objection_on: pickDateString(kd, "receivedLetterNoObjectionOn", "received_letter_no_objection_on"),
    blanket_consent_transfer_req: pickDateString(kd, "blanketConsentTransferReq", "blanket_consent_transfer_req"),
    blanket_consent_transfer_approval: pickDateString(kd, "blanketConsentTransferApproval", "blanket_consent_transfer_approval") ?? pickDateString(kd, "consentToTransferDate", "consent_to_transfer_date"),
    consent_to_charge_req: pickDateString(kd, "consentToChargeReq", "consent_to_charge_req"),
    consent_to_charge_approval: pickDateString(kd, "consentToChargeApproval", "consent_to_charge_approval") ?? pickDateString(kd, "consentToChargeDate", "consent_to_charge_date"),
    consent_to_transfer_date: pickDateString(kd, "consentToTransferDate", "consent_to_transfer_date"),
    consent_to_charge_date: pickDateString(kd, "consentToChargeDate", "consent_to_charge_date"),
    mot_received_date: pickDateString(kd, "motReceivedDate", "mot_received_date"),
    mot_signed_date: pickDateString(kd, "motSignedDate", "mot_signed_date"),
    mot_submit_stamping: pickDateString(kd, "motSubmitStamping", "mot_submit_stamping"),
    mot_stamped_date: pickDateString(kd, "motStampedDate", "mot_stamped_date"),
    mot_registered_date: pickDateString(kd, "motRegisteredDate", "mot_registered_date"),
    progressive_payment_date: pickDateString(kd, "progressivePaymentDate", "progressive_payment_date"),
    full_settlement_date: pickDateString(kd, "fullSettlementDate", "full_settlement_date"),
    completion_date: pickDateString(kd, "completionDate", "completion_date"),
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

    const kd = await (async () => {
      try {
        return await fetchKeyDatesRow(r, req.firmId!, caseId);
      } catch (err) {
        logger.error({ err, pgCode: getPgCode(err), firmId: req.firmId, userId: req.userId, caseId }, "[cases] progress fetch key-dates failed");
        return null;
      }
    })();

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
    spa_received_dev_return_spa_on: "spaReceivedDevReturnSpaOn",
    spa_date: "spaDate",
    spa_stamped_date: "spaStampedDate",
    stamped_spa_send_to_developer_on: "stampedSpaSendToDeveloperOn",
    stamped_spa_received_from_developer_on: "stampedSpaReceivedFromDeveloperOn",
    stamped_spa_sent_to_purchaser_on: "stampedSpaSentToPurchaserOn",
    li_date: "liDate",
    li_received_on: "liReceivedOn",
    letter_of_offer_date: "letterOfOfferDate",
    letter_of_offer_stamped_date: "letterOfOfferStampedDate",
    supp_lo_date: "suppLoDate",
    loan_docs_pending_date: "loanDocsPendingDate",
    loan_docs_signed_date: "loanDocsSignedDate",
    acting_letter_issued_date: "actingLetterIssuedDate",
    developer_confirmation_received_on: "developerConfirmationReceivedOn",
    developer_confirmation_date: "developerConfirmationDate",
    loan_sent_bank_execution_date: "loanSentBankExecutionDate",
    loan_bank_executed_date: "loanBankExecutedDate",
    differential_sum_settled_on: "differentialSumSettledOn",
    bank_lu_dated: "bankLuDated",
    bank_lu_received_date: "bankLuReceivedDate",
    bank_lu_forward_to_developer_on: "bankLuForwardToDeveloperOn",
    developer_lu_received_on: "developerLuReceivedOn",
    developer_lu_dated: "developerLuDated",
    letter_disclaimer_received_on: "letterDisclaimerReceivedOn",
    letter_disclaimer_dated: "letterDisclaimerDated",
    bankruptcy_search_dated: "bankruptcySearchDated",
    loan_agreement_dated: "loanAgreementDated",
    loan_agreement_submitted_stamping_date: "loanAgreementSubmittedStampingDate",
    loan_agreement_stamped_date: "loanAgreementStampedDate",
    received_executed_document_on_1: "receivedExecutedDocumentOn1",
    received_unexecuted_document_on: "receivedUnexecutedDocumentOn",
    resent_bank_execution_dated: "resentBankExecutionDated",
    received_executed_document_on_2: "receivedExecutedDocumentOn2",
    statutory_declaration_dated: "statutoryDeclarationDated",
    statutory_declaration_stamped_on: "statutoryDeclarationStampedOn",
    fa_date: "faDate",
    fa_stamp_on: "faStampOn",
    doa_date: "doaDate",
    doa_stamp_on: "doaStampOn",
    poa_date: "poaDate",
    poa_stamp_on: "poaStampOn",
    noa_dated: "noaDated",
    register_pa_on: "registerPaOn",
    register_poa_on: "registerPoaOn",
    noa_served_on: "noaServedOn",
    advice_to_bank_date: "adviceToBankDate",
    bank_1st_release_on: "bank1stReleaseOn",
    discharge_date: "dischargeDate",
    discharge_title_received_on: "dischargeTitleReceivedOn",
    caveat_lodged_date: "caveatLodgedDate",
    first_advice_date: "firstAdviceDate",
    dev_informed_redemption_date: "devInformedRedemptionDate",
    request_discharge_date: "requestDischargeDate",
    charge_date: "chargeDate",
    charge_submit_stamping: "chargeSubmitStamping",
    charge_stamped: "chargeStamped",
    presentation_date: "presentationDate",
    second_advice_date: "secondAdviceDate",
    request_letter_no_objection: "requestLetterNoObjection",
    received_letter_no_objection_on: "receivedLetterNoObjectionOn",
    blanket_consent_transfer_req: "blanketConsentTransferReq",
    blanket_consent_transfer_approval: "blanketConsentTransferApproval",
    consent_to_charge_req: "consentToChargeReq",
    consent_to_charge_approval: "consentToChargeApproval",
    consent_to_transfer_date: "consentToTransferDate",
    consent_to_charge_date: "consentToChargeDate",
    mot_received_date: "motReceivedDate",
    mot_signed_date: "motSignedDate",
    mot_submit_stamping: "motSubmitStamping",
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

  const parseBool = (v: unknown): boolean | undefined => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "no") return false;
    }
    return undefined;
  };
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
  const differentialSum = parseMoneyInput(body.differential_sum_rm);
  if (differentialSum === undefined && Object.prototype.hasOwnProperty.call(body, "differential_sum_rm")) {
    res.status(400).json({ error: "Invalid differential_sum_rm" });
    return;
  }

  const masterLuExempted = Object.prototype.hasOwnProperty.call(body, "master_lu_exempted") ? parseBool(body.master_lu_exempted) : undefined;
  if (masterLuExempted === undefined && Object.prototype.hasOwnProperty.call(body, "master_lu_exempted")) {
    res.status(400).json({ error: "Invalid master_lu_exempted" });
    return;
  }
  if (masterLuExempted !== undefined) {
    (insertValues as any).masterLuExempted = masterLuExempted;
    (updateValues as any).masterLuExempted = masterLuExempted;
    changed.push("master_lu_exempted");
    if (masterLuExempted) {
      (insertValues as any).bankLuDated = null;
      insertValues.bankLuReceivedDate = null;
      insertValues.bankLuForwardToDeveloperOn = null;
      insertValues.developerLuReceivedOn = null;
      insertValues.developerLuDated = null;
      (updateValues as any).bankLuDated = null;
      updateValues.bankLuReceivedDate = null;
      updateValues.bankLuForwardToDeveloperOn = null;
      updateValues.developerLuReceivedOn = null;
      updateValues.developerLuDated = null;
      changed.push("bank_lu_dated", "bank_lu_received_date", "bank_lu_forward_to_developer_on", "developer_lu_received_on", "developer_lu_dated");
    }
  }

  const encumbranceExempted = Object.prototype.hasOwnProperty.call(body, "encumbrance_free_exempted") ? parseBool(body.encumbrance_free_exempted) : undefined;
  if (encumbranceExempted === undefined && Object.prototype.hasOwnProperty.call(body, "encumbrance_free_exempted")) {
    res.status(400).json({ error: "Invalid encumbrance_free_exempted" });
    return;
  }
  if (encumbranceExempted !== undefined) {
    (insertValues as any).encumbranceFreeExempted = encumbranceExempted;
    (updateValues as any).encumbranceFreeExempted = encumbranceExempted;
    changed.push("encumbrance_free_exempted");
    if (encumbranceExempted) {
      insertValues.letterDisclaimerReceivedOn = null;
      insertValues.letterDisclaimerDated = null;
      insertValues.letterDisclaimerReferenceNos = null;
      updateValues.letterDisclaimerReceivedOn = null;
      updateValues.letterDisclaimerDated = null;
      updateValues.letterDisclaimerReferenceNos = null;
      changed.push("letter_disclaimer_received_on", "letter_disclaimer_dated", "letter_disclaimer_reference_nos");
    }
  }
  if (differentialSum !== undefined) {
    (insertValues as any).differentialSumRm = differentialSum;
    (updateValues as any).differentialSumRm = differentialSum;
    changed.push("differential_sum_rm");
  }
  const balanceSumLessLast5 = parseMoneyInput(body.balance_sum_less_last_5_rm);
  if (balanceSumLessLast5 === undefined && Object.prototype.hasOwnProperty.call(body, "balance_sum_less_last_5_rm")) {
    res.status(400).json({ error: "Invalid balance_sum_less_last_5_rm" });
    return;
  }
  if (balanceSumLessLast5 !== undefined) {
    (insertValues as any).balanceSumLessLast5Rm = balanceSumLessLast5;
    (updateValues as any).balanceSumLessLast5Rm = balanceSumLessLast5;
    changed.push("balance_sum_less_last_5_rm");
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

  if (Object.prototype.hasOwnProperty.call(body, "fa_adjudication_number")) {
    const v = body.fa_adjudication_number;
    if (v === null) {
      (insertValues as any).faAdjudicationNumber = null;
      (updateValues as any).faAdjudicationNumber = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim() || null;
      (insertValues as any).faAdjudicationNumber = trimmed;
      (updateValues as any).faAdjudicationNumber = trimmed;
    } else {
      res.status(400).json({ error: "Invalid fa_adjudication_number" });
      return;
    }
    changed.push("fa_adjudication_number");
  }

  if (Object.prototype.hasOwnProperty.call(body, "pa_no")) {
    const v = body.pa_no;
    if (v === null) {
      (insertValues as any).paNo = null;
      (updateValues as any).paNo = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim() || null;
      (insertValues as any).paNo = trimmed;
      (updateValues as any).paNo = trimmed;
    } else {
      res.status(400).json({ error: "Invalid pa_no" });
      return;
    }
    changed.push("pa_no");
  }

  let currentKd: any = null;
  try {
    [currentKd] = await r
      .select({
        id: caseKeyDatesTable.id,
        spaStampedDate: caseKeyDatesTable.spaStampedDate,
        letterOfOfferStampedDate: caseKeyDatesTable.letterOfOfferStampedDate,
        actingLetterIssuedDate: caseKeyDatesTable.actingLetterIssuedDate,
        loanBankExecutedDate: caseKeyDatesTable.loanBankExecutedDate,
        developerConfirmationDate: caseKeyDatesTable.developerConfirmationDate,
        registeredPoaOn: caseKeyDatesTable.registerPoaOn,
        registeredPoaRegistrationNumber: caseKeyDatesTable.registeredPoaRegistrationNumber,
        differentialSumRm: (caseKeyDatesTable as any).differentialSumRm,
      })
      .from(caseKeyDatesTable)
      .where(and(eq(caseKeyDatesTable.caseId, params.data.caseId), eq(caseKeyDatesTable.firmId, req.firmId!)))
      .limit(1);
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    currentKd = null;
  }

  const wantsLoStamp = Object.prototype.hasOwnProperty.call(body, "letter_of_offer_stamped_date");
  const wantsActingLetter = Object.prototype.hasOwnProperty.call(body, "acting_letter_issued_date");
  const wantsBankExec = Object.prototype.hasOwnProperty.call(body, "loan_bank_executed_date");
  const wantsDeveloperConfirmation = Object.prototype.hasOwnProperty.call(body, "developer_confirmation_date");
  const wantsRegisteredPoa = Object.prototype.hasOwnProperty.call(body, "register_poa_on") || Object.prototype.hasOwnProperty.call(body, "registered_poa_registration_number");

  const effectiveSpaStampedDate = (updateValues as any).spaStampedDate ?? currentKd?.spaStampedDate ?? null;
  const effectiveLoStampedDate = (updateValues as any).letterOfOfferStampedDate ?? currentKd?.letterOfOfferStampedDate ?? null;
  const effectiveActingLetterDate = (updateValues as any).actingLetterIssuedDate ?? currentKd?.actingLetterIssuedDate ?? null;
  const effectiveBankExecDate = (updateValues as any).loanBankExecutedDate ?? currentKd?.loanBankExecutedDate ?? null;
  const effectiveDeveloperConfirmationDate = (updateValues as any).developerConfirmationDate ?? currentKd?.developerConfirmationDate ?? null;
  const effectiveDifferentialSumRm = (updateValues as any).differentialSumRm ?? (currentKd as any)?.differentialSumRm ?? null;
  const effectiveRegisteredPoaOn = (updateValues as any).registerPoaOn ?? currentKd?.registeredPoaOn ?? null;
  const effectiveRegisteredPoaRegNo = (updateValues as any).registeredPoaRegistrationNumber ?? currentKd?.registeredPoaRegistrationNumber ?? null;

  const requiresWorkflowDocsCheck = wantsLoStamp || wantsActingLetter || wantsBankExec || wantsRegisteredPoa;
  const wfExists = requiresWorkflowDocsCheck ? await tableExists(r, "public.case_workflow_documents") : true;
  if (requiresWorkflowDocsCheck && !wfExists) {
    res.status(503).json({ error: "Workflow documents not available" });
    return;
  }
  const hasWorkflowDoc = async (milestoneKey: string): Promise<boolean> => {
    const [row] = await r
      .select({ id: caseWorkflowDocumentsTable.id })
      .from(caseWorkflowDocumentsTable)
      .where(and(
        eq(caseWorkflowDocumentsTable.firmId, req.firmId!),
        eq(caseWorkflowDocumentsTable.caseId, params.data.caseId),
        eq(caseWorkflowDocumentsTable.milestoneKey, milestoneKey),
        sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
      ))
      .limit(1);
    return Boolean(row?.id);
  };

  if (wantsDeveloperConfirmation) {
    if (effectiveDeveloperConfirmationDate && !effectiveDifferentialSumRm) {
      res.status(422).json({ error: "Differential Sum (RM) is required when Developer Confirmation dated is set" });
      return;
    }
  }

  if (wantsLoStamp) {
    if (effectiveLoStampedDate && !(await hasWorkflowDoc("lo_stamped"))) {
      res.status(422).json({ error: "Stamped LO PDF is required for LO Stamping date" });
      return;
    }
  }

  if (wantsActingLetter) {
    if (effectiveActingLetterDate) {
      if (!effectiveLoStampedDate || !(await hasWorkflowDoc("lo_stamped"))) {
        res.status(422).json({ error: "LO stamping date + Stamped LO PDF are required before setting Acting Letter dated" });
        return;
      }
    }
  }

  if (wantsBankExec) {
    if (effectiveBankExecDate) {
      const spaOk = Boolean(effectiveSpaStampedDate) && (await hasWorkflowDoc("spa_stamped"));
      const loOk = Boolean(effectiveLoStampedDate) && (await hasWorkflowDoc("lo_stamped"));
      if (!spaOk || !loOk) {
        res.status(422).json({ error: "SPA stamping (date+file) and LO stamping (date+file) are required before setting Bank execution dated" });
        return;
      }
    }
  }

  if (wantsRegisteredPoa) {
    if (effectiveRegisteredPoaOn) {
      const hasNo = typeof effectiveRegisteredPoaRegNo === "string" && effectiveRegisteredPoaRegNo.trim();
      const hasFile = await hasWorkflowDoc("register_poa");
      if (!hasNo || !hasFile) {
        res.status(422).json({ error: "Registered POA requires Presentation Number and file upload" });
        return;
      }
    }
  }

  let kd: any;
  if (currentKd?.id) {
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

  const sla = await updateCompletionSlaState(r, req.firmId!, params.data.caseId);

  res.json(kd ? {
    spa_signed_date: kd.spaSignedDate ? String(kd.spaSignedDate) : null,
    spa_forward_to_developer_execution_on: kd.spaForwardToDeveloperExecutionOn ? String(kd.spaForwardToDeveloperExecutionOn) : null,
    spa_received_dev_return_spa_on: (kd as any).spaReceivedDevReturnSpaOn ? String((kd as any).spaReceivedDevReturnSpaOn) : null,
    spa_date: kd.spaDate ? String(kd.spaDate) : null,
    spa_stamped_date: kd.spaStampedDate ? String(kd.spaStampedDate) : null,
    stamped_spa_send_to_developer_on: kd.stampedSpaSendToDeveloperOn ? String(kd.stampedSpaSendToDeveloperOn) : null,
    stamped_spa_received_from_developer_on: kd.stampedSpaReceivedFromDeveloperOn ? String(kd.stampedSpaReceivedFromDeveloperOn) : null,
    stamped_spa_sent_to_purchaser_on: (kd as any).stampedSpaSentToPurchaserOn ? String((kd as any).stampedSpaSentToPurchaserOn) : null,
    li_date: (kd as any).liDate ? String((kd as any).liDate) : null,
    li_received_on: (kd as any).liReceivedOn ? String((kd as any).liReceivedOn) : null,
    letter_of_offer_date: kd.letterOfOfferDate ? String(kd.letterOfOfferDate) : null,
    letter_of_offer_stamped_date: kd.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
    supp_lo_date: (kd as any).suppLoDate ? String((kd as any).suppLoDate) : null,
    loan_docs_pending_date: kd.loanDocsPendingDate ? String(kd.loanDocsPendingDate) : null,
    loan_docs_signed_date: kd.loanDocsSignedDate ? String(kd.loanDocsSignedDate) : null,
    acting_letter_issued_date: kd.actingLetterIssuedDate ? String(kd.actingLetterIssuedDate) : null,
    developer_confirmation_received_on: kd.developerConfirmationReceivedOn ? String(kd.developerConfirmationReceivedOn) : null,
    developer_confirmation_date: kd.developerConfirmationDate ? String(kd.developerConfirmationDate) : null,
    loan_sent_bank_execution_date: kd.loanSentBankExecutionDate ? String(kd.loanSentBankExecutionDate) : null,
    loan_bank_executed_date: kd.loanBankExecutedDate ? String(kd.loanBankExecutedDate) : null,
    differential_sum_rm: (kd as any).differentialSumRm ? Number((kd as any).differentialSumRm) : null,
    differential_sum_settled_on: (kd as any).differentialSumSettledOn ? String((kd as any).differentialSumSettledOn) : null,
    bank_lu_dated: (kd as any).bankLuDated ? String((kd as any).bankLuDated) : null,
    bank_lu_received_date: kd.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
    bank_lu_forward_to_developer_on: kd.bankLuForwardToDeveloperOn ? String(kd.bankLuForwardToDeveloperOn) : null,
    developer_lu_received_on: kd.developerLuReceivedOn ? String(kd.developerLuReceivedOn) : null,
    developer_lu_dated: kd.developerLuDated ? String(kd.developerLuDated) : null,
    master_lu_exempted: Boolean((kd as any).masterLuExempted),
    encumbrance_free_exempted: Boolean((kd as any).encumbranceFreeExempted),
    letter_disclaimer_received_on: kd.letterDisclaimerReceivedOn ? String(kd.letterDisclaimerReceivedOn) : null,
    letter_disclaimer_dated: kd.letterDisclaimerDated ? String(kd.letterDisclaimerDated) : null,
    letter_disclaimer_reference_nos: kd.letterDisclaimerReferenceNos ?? null,
    redemption_sum: kd.redemptionSum ? Number(kd.redemptionSum) : null,
    balance_sum_less_last_5_rm: (kd as any).balanceSumLessLast5Rm ? Number((kd as any).balanceSumLessLast5Rm) : null,
    bankruptcy_search_dated: (kd as any).bankruptcySearchDated ? String((kd as any).bankruptcySearchDated) : null,
    loan_agreement_dated: kd.loanAgreementDated ? String(kd.loanAgreementDated) : null,
    loan_agreement_submitted_stamping_date: kd.loanAgreementSubmittedStampingDate ? String(kd.loanAgreementSubmittedStampingDate) : null,
    loan_agreement_stamped_date: kd.loanAgreementStampedDate ? String(kd.loanAgreementStampedDate) : null,
    received_executed_document_on_1: (kd as any).receivedExecutedDocumentOn1 ? String((kd as any).receivedExecutedDocumentOn1) : null,
    received_unexecuted_document_on: (kd as any).receivedUnexecutedDocumentOn ? String((kd as any).receivedUnexecutedDocumentOn) : null,
    resent_bank_execution_dated: (kd as any).resentBankExecutionDated ? String((kd as any).resentBankExecutionDated) : null,
    received_executed_document_on_2: (kd as any).receivedExecutedDocumentOn2 ? String((kd as any).receivedExecutedDocumentOn2) : null,
    statutory_declaration_dated: (kd as any).statutoryDeclarationDated ? String((kd as any).statutoryDeclarationDated) : null,
    statutory_declaration_stamped_on: (kd as any).statutoryDeclarationStampedOn ? String((kd as any).statutoryDeclarationStampedOn) : null,
    fa_date: (kd as any).faDate ? String((kd as any).faDate) : null,
    fa_adjudication_number: (kd as any).faAdjudicationNumber ?? null,
    fa_stamp_on: (kd as any).faStampOn ? String((kd as any).faStampOn) : null,
    doa_date: (kd as any).doaDate ? String((kd as any).doaDate) : null,
    doa_stamp_on: (kd as any).doaStampOn ? String((kd as any).doaStampOn) : null,
    poa_date: (kd as any).poaDate ? String((kd as any).poaDate) : null,
    poa_stamp_on: (kd as any).poaStampOn ? String((kd as any).poaStampOn) : null,
    noa_dated: (kd as any).noaDated ? String((kd as any).noaDated) : null,
    register_pa_on: (kd as any).registerPaOn ? String((kd as any).registerPaOn) : null,
    pa_no: (kd as any).paNo ?? null,
    register_poa_on: kd.registerPoaOn ? String(kd.registerPoaOn) : null,
    registered_poa_registration_number: kd.registeredPoaRegistrationNumber ?? null,
    noa_served_on: kd.noaServedOn ? String(kd.noaServedOn) : null,
    advice_to_bank_date: kd.adviceToBankDate ? String(kd.adviceToBankDate) : null,
    completion_sla_activated_at: sla.activatedAt,
    completion_sla_notified_48h_at: sla.notified48hAt,
    bank_1st_release_on: kd.bank1stReleaseOn ? String(kd.bank1stReleaseOn) : null,
    first_release_amount_rm: kd.firstReleaseAmountRm ? Number(kd.firstReleaseAmountRm) : null,
    discharge_date: kd.dischargeDate ? String(kd.dischargeDate) : null,
    discharge_title_received_on: (kd as any).dischargeTitleReceivedOn ? String((kd as any).dischargeTitleReceivedOn) : null,
    caveat_lodged_date: kd.caveatLodgedDate ? String(kd.caveatLodgedDate) : null,
    first_advice_date: kd.firstAdviceDate ? String(kd.firstAdviceDate) : null,
    dev_informed_redemption_date: kd.devInformedRedemptionDate ? String(kd.devInformedRedemptionDate) : null,
    request_discharge_date: kd.requestDischargeDate ? String(kd.requestDischargeDate) : null,
    charge_date: kd.chargeDate ? String(kd.chargeDate) : null,
    charge_submit_stamping: (kd as any).chargeSubmitStamping ? String((kd as any).chargeSubmitStamping) : null,
    charge_stamped: (kd as any).chargeStamped ? String((kd as any).chargeStamped) : null,
    presentation_date: kd.presentationDate ? String(kd.presentationDate) : null,
    second_advice_date: kd.secondAdviceDate ? String(kd.secondAdviceDate) : null,
    request_letter_no_objection: (kd as any).requestLetterNoObjection ? String((kd as any).requestLetterNoObjection) : null,
    received_letter_no_objection_on: (kd as any).receivedLetterNoObjectionOn ? String((kd as any).receivedLetterNoObjectionOn) : null,
    blanket_consent_transfer_req: (kd as any).blanketConsentTransferReq ? String((kd as any).blanketConsentTransferReq) : null,
    blanket_consent_transfer_approval: ((kd as any).blanketConsentTransferApproval ? String((kd as any).blanketConsentTransferApproval) : (kd.consentToTransferDate ? String(kd.consentToTransferDate) : null)),
    consent_to_charge_req: (kd as any).consentToChargeReq ? String((kd as any).consentToChargeReq) : null,
    consent_to_charge_approval: ((kd as any).consentToChargeApproval ? String((kd as any).consentToChargeApproval) : (kd.consentToChargeDate ? String(kd.consentToChargeDate) : null)),
    consent_to_transfer_date: kd.consentToTransferDate ? String(kd.consentToTransferDate) : null,
    consent_to_charge_date: kd.consentToChargeDate ? String(kd.consentToChargeDate) : null,
    mot_received_date: kd.motReceivedDate ? String(kd.motReceivedDate) : null,
    mot_signed_date: kd.motSignedDate ? String(kd.motSignedDate) : null,
    mot_submit_stamping: (kd as any).motSubmitStamping ? String((kd as any).motSubmitStamping) : null,
    mot_stamped_date: kd.motStampedDate ? String(kd.motStampedDate) : null,
    mot_registered_date: kd.motRegisteredDate ? String(kd.motRegisteredDate) : null,
    progressive_payment_date: kd.progressivePaymentDate ? String(kd.progressivePaymentDate) : null,
    full_settlement_date: kd.fullSettlementDate ? String(kd.fullSettlementDate) : null,
    completion_date: kd.completionDate ? String(kd.completionDate) : null,
  } : {});
}));

router.patch("/cases/:caseId", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  try {
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

    const UpdateCaseBody = z.object({
      status: z.string().trim().optional().nullable(),
      purchaseMode: z.string().trim().toLowerCase().optional().nullable(),
      titleType: z.string().trim().toLowerCase().optional().nullable(),
      spaPrice: z.coerce.number().optional().nullable(),
      assignedLawyerId: z.coerce.number().optional().nullable(),
      assignedClerkId: z.coerce.number().optional().nullable(),
      purchaserIds: z.array(z.coerce.number()).optional().nullable(),
      purchasers: z.array(
        z.object({
          isCompany: z.boolean().optional().nullable(),
          name: z.string().trim().min(1),
          ic: z.string().trim().optional().nullable(),
          phone: z.string().trim().optional().nullable(),
          email: z.string().trim().optional().nullable(),
          address: z.string().trim().optional().nullable(),
        })
      ).optional().nullable(),
      referenceNo: z.string().trim().optional().nullable(),
      projectId: z.coerce.number().optional().nullable(),
      developerId: z.coerce.number().optional().nullable(),
      caseType: z.string().trim().optional().nullable(),
      parcelNo: z.string().trim().optional().nullable(),
      spaDetails: z.record(z.string(), z.unknown()).optional().nullable(),
      propertyDetails: z.any().optional().nullable(),
      loanDetails: z.any().optional().nullable(),
      companyDetails: z.record(z.string(), z.unknown()).optional().nullable(),
      lawyerStatus: z.string().trim().optional().nullable(),
      borrowers: z.array(
        z.object({
          name: z.string().trim().min(1),
          ic: z.string().trim().optional().nullable(),
          hp: z.string().trim().optional().nullable(),
          email: z.string().trim().optional().nullable(),
          address: z.string().trim().optional().nullable(),
        })
      ).optional().nullable(),
      loanPartyType: z.enum(["1st_party", "3rd_party"]).optional().nullable(),
      apdlPrice: z.coerce.number().optional().nullable(),
      developerDiscount: z.coerce.number().optional().nullable(),
      bumiputraDiscount: z.coerce.number().optional().nullable(),
      propertyAddress: z.string().trim().optional().nullable(),
    });

    const PatchCaseBody = UpdateCaseBody.superRefine((v, ctx) => {
      if (v.purchaseMode !== undefined && v.purchaseMode !== null) {
        const pm = String(v.purchaseMode ?? "").trim().toLowerCase();
        if (pm !== "loan" && pm !== "cash" && pm !== "other") {
          ctx.addIssue({ code: "custom", path: ["purchaseMode"], message: "Invalid purchaseMode" });
        }
      }
      if (v.titleType !== undefined && v.titleType !== null) {
        const tt = normalizeTitleType(String(v.titleType ?? ""));
        if (!tt) {
          ctx.addIssue({ code: "custom", path: ["titleType"], message: "Invalid titleType" });
        }
      }
      if (v.apdlPrice !== null && v.apdlPrice !== undefined && v.spaPrice !== undefined && v.spaPrice !== null) {
        const expected = v.apdlPrice - (v.developerDiscount ?? 0) - (v.bumiputraDiscount ?? 0);
        if (Math.abs(expected - v.spaPrice) > 0.009) {
          ctx.addIssue({ code: "custom", path: ["spaPrice"], message: "spaPrice must equal apdlPrice - developerDiscount - bumiputraDiscount" });
        }
      }
    });

    const parsed = PatchCaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const bodyRec = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
    const parseJsonObj = (raw: unknown): Record<string, unknown> => {
      if (!raw) return {};
      if (typeof raw === "object") return raw as Record<string, unknown>;
      if (typeof raw !== "string") return {};
      try {
        const out = JSON.parse(raw);
        return out && typeof out === "object" ? out as Record<string, unknown> : {};
      } catch {
        return {};
      }
    };

    const [existingCase] = await r
      .select({
        id: casesTable.id,
        firmId: casesTable.firmId,
        projectId: casesTable.projectId,
        developerId: casesTable.developerId,
        purchaseMode: casesTable.purchaseMode,
        loanPartyType: casesTable.loanPartyType,
        propertyDetails: casesTable.propertyDetails,
        spaDetails: casesTable.spaDetails,
        loanDetails: casesTable.loanDetails,
        companyDetails: casesTable.companyDetails,
        apdlPrice: casesTable.apdlPrice,
        developerDiscount: casesTable.developerDiscount,
        bumiputraDiscount: casesTable.bumiputraDiscount,
      })
      .from(casesTable)
      .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
      .limit(1);
    if (!existingCase) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.status !== undefined && parsed.data.status !== null) {
      const v = String(parsed.data.status ?? "").trim();
      if (v) updates.status = v;
    }
    if (parsed.data.referenceNo !== undefined && parsed.data.referenceNo !== null) {
      const v = String(parsed.data.referenceNo ?? "").trim();
      if (!v) {
        res.status(400).json({ error: "Invalid referenceNo" });
        return;
      }
      updates.referenceNo = v;
    }
    if (parsed.data.projectId !== undefined && parsed.data.projectId !== null) {
      const [project] = await r.select().from(projectsTable).where(and(eq(projectsTable.id, parsed.data.projectId), eq(projectsTable.firmId, req.firmId!))).limit(1);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      updates.projectId = project.id;
      updates.isEncumbered = Boolean((project as any).isEncumbered ?? false);
      const tenure = (typeof (project as any).tenure === "string" && (String((project as any).tenure) === "leasehold" || String((project as any).tenure) === "freehold"))
        ? String((project as any).tenure)
        : "freehold";
      updates.tenure = tenure;
      if (parsed.data.developerId === undefined && project.developerId) {
        updates.developerId = project.developerId;
      }
    }
    if (parsed.data.developerId !== undefined && parsed.data.developerId !== null) {
      const [dev] = await r
        .select({ id: developersTable.id })
        .from(developersTable)
        .where(and(eq(developersTable.firmId, req.firmId!), eq(developersTable.id, parsed.data.developerId)))
        .limit(1);
      if (!dev) {
        res.status(400).json({ error: "Developer not found" });
        return;
      }
      updates.developerId = parsed.data.developerId;
    }
    if (parsed.data.purchaseMode !== undefined && parsed.data.purchaseMode !== null) {
      updates.purchaseMode = String(parsed.data.purchaseMode).trim().toLowerCase();
    }
    if (parsed.data.titleType !== undefined && parsed.data.titleType !== null) {
      const tt = normalizeTitleType(String(parsed.data.titleType ?? ""));
      if (!tt) {
        res.status(400).json({ error: "Invalid titleType" });
        return;
      }
      updates.titleType = tt;
    }
    if (parsed.data.spaPrice !== undefined) updates.spaPrice = parsed.data.spaPrice === null ? null : String(parsed.data.spaPrice);
    if (parsed.data.apdlPrice !== undefined) updates.apdlPrice = parsed.data.apdlPrice === null ? null : String(parsed.data.apdlPrice);
    if (parsed.data.developerDiscount !== undefined) updates.developerDiscount = parsed.data.developerDiscount === null ? null : String(parsed.data.developerDiscount);
    if (parsed.data.bumiputraDiscount !== undefined) updates.bumiputraDiscount = parsed.data.bumiputraDiscount === null ? null : String(parsed.data.bumiputraDiscount);
    if (parsed.data.lawyerStatus !== undefined) {
      updates.lawyerStatus = parsed.data.lawyerStatus;
      updates.lawyerStatusUpdatedAt = new Date();
    }

    if (parsed.data.caseType !== undefined) {
      const v = String(parsed.data.caseType ?? "").trim();
      updates.caseType = v ? v : null;
    }
    if (parsed.data.parcelNo !== undefined) {
      const v = String(parsed.data.parcelNo ?? "").trim();
      updates.parcelNo = v ? v : null;
    }

    const wantsUpdatePropertyDetails = bodyRec.propertyDetails !== undefined || bodyRec.propertyAddress !== undefined;
    if (wantsUpdatePropertyDetails) {
      const rawAddress = (bodyRec as any).propertyAddress;
      const hasIncomingPropertyAddress = rawAddress !== undefined;
      const incomingPropertyAddress = typeof rawAddress === "string" ? rawAddress.trim() : "";
      const incomingPropertyDetails = bodyRec.propertyDetails;
      const base = parseJsonObj(existingCase.propertyDetails);
      const incoming =
        typeof incomingPropertyDetails === "string"
          ? parseJsonObj(incomingPropertyDetails)
          : (incomingPropertyDetails && typeof incomingPropertyDetails === "object")
            ? (incomingPropertyDetails as Record<string, unknown>)
            : {};

      const next = { ...base, ...incoming };
      if (hasIncomingPropertyAddress) {
        next.propertyAddress = incomingPropertyAddress;
      }
      const nextAddress = typeof rawAddress === "string" ? rawAddress.trim() : "";
      if (hasIncomingPropertyAddress && !nextAddress) {
        res.status(422).json({ error: "Please fill in Property Address in Case Details first", code: "PROPERTY_ADDRESS_REQUIRED" });
        return;
      }
      updates.propertyDetails = hasIncomingPropertyAddress ? { ...next, propertyAddress: nextAddress } : next;
    }

    if (parsed.data.spaDetails !== undefined) {
      const base = parseJsonObj(existingCase.spaDetails);
      const incoming = parsed.data.spaDetails && typeof parsed.data.spaDetails === "object" ? parsed.data.spaDetails : {};
      updates.spaDetails = JSON.stringify({ ...base, ...incoming });
    }

    if (parsed.data.loanDetails !== undefined) {
      const base = parseJsonObj(existingCase.loanDetails);
      const incoming = parsed.data.loanDetails && typeof parsed.data.loanDetails === "object" ? parsed.data.loanDetails : {};
      updates.loanDetails = { ...base, ...incoming };
    }

    if (parsed.data.companyDetails !== undefined) {
      const base = parseJsonObj(existingCase.companyDetails);
      const incoming = parsed.data.companyDetails && typeof parsed.data.companyDetails === "object" ? parsed.data.companyDetails : {};
      updates.companyDetails = JSON.stringify({ ...base, ...incoming });
    }

    const wantsAssignLawyer = parsed.data.assignedLawyerId !== undefined;
    const wantsAssignClerk = (parsed.data as any)?.assignedClerkId !== undefined;
    if (wantsAssignLawyer && parsed.data.assignedLawyerId === null) {
      res.status(400).json({ error: "assignedLawyerId cannot be null" });
      return;
    }
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

    const wantsUpdatePurchasers = (parsed.data.purchaserIds !== undefined) || (parsed.data.purchasers !== undefined);
    let resolvedPurchaserIds: number[] = [];
    if (wantsUpdatePurchasers) {
      const purchaserIds = parsed.data.purchaserIds ?? [];
      const purchasers = parsed.data.purchasers ?? [];

      if (purchaserIds.length > 0) {
        const rows = await r
          .select({ id: clientsTable.id })
          .from(clientsTable)
          .where(and(eq(clientsTable.firmId, req.firmId!), inArray(clientsTable.id, purchaserIds)));
        const found = new Set(rows.map((x) => x.id));
        const missing = purchaserIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          res.status(400).json({ error: "Invalid purchaserIds" });
          return;
        }
        resolvedPurchaserIds = purchaserIds;
      } else {
        for (const p of purchasers) {
          const trimmedName = String(p.name ?? "").trim();
          if (!trimmedName) continue;
          const trimmedIc = typeof p.ic === "string" ? p.ic.trim() : null;
          const trimmedPhone = typeof (p as any).phone === "string" ? String((p as any).phone).trim() : null;
          const trimmedEmail = typeof (p as any).email === "string" ? String((p as any).email).trim() : null;
          const trimmedAddress = typeof (p as any).address === "string" ? String((p as any).address).trim() : null;

          let existingClientId: number | null = null;
          if (trimmedIc) {
            const [byIc] = await r
              .select()
              .from(clientsTable)
              .where(and(eq(clientsTable.firmId, req.firmId!), eq(clientsTable.icNo, trimmedIc)));
            if (byIc) existingClientId = byIc.id;
          }

          if (!existingClientId) {
            const byName = await r
              .select()
              .from(clientsTable)
              .where(and(eq(clientsTable.firmId, req.firmId!), sql`LOWER(${clientsTable.name}) = LOWER(${trimmedName})`));
            if (byName.length === 1) existingClientId = byName[0].id;
          }

          if (existingClientId) {
            resolvedPurchaserIds.push(existingClientId);
            if (trimmedPhone || trimmedEmail || trimmedAddress) {
              const [existing] = await r
                .select({ id: clientsTable.id, phone: clientsTable.phone, email: clientsTable.email, address: clientsTable.address })
                .from(clientsTable)
                .where(and(eq(clientsTable.firmId, req.firmId!), eq(clientsTable.id, existingClientId)))
                .limit(1);
              if (existing) {
                const patch: Record<string, unknown> = {};
                if (trimmedPhone && !String(existing.phone ?? "").trim()) patch.phone = trimmedPhone;
                if (trimmedEmail && !String(existing.email ?? "").trim()) patch.email = trimmedEmail;
                if (trimmedAddress && !String(existing.address ?? "").trim()) patch.address = trimmedAddress;
                if (Object.keys(patch).length > 0) {
                  await r.update(clientsTable).set(patch).where(and(eq(clientsTable.firmId, req.firmId!), eq(clientsTable.id, existingClientId)));
                }
              }
            }
          } else {
            const insertBase = {
              firmId: req.firmId!,
              name: trimmedName,
              icNo: trimmedIc,
              phone: trimmedPhone,
              email: trimmedEmail,
              address: trimmedAddress,
              createdBy: req.userId ?? null,
            } satisfies typeof clientsTable.$inferInsert;
            const [client] = await r.insert(clientsTable).values(insertBase).returning();
            resolvedPurchaserIds.push(client.id);
          }
        }
      }

      resolvedPurchaserIds = Array.from(new Set(resolvedPurchaserIds));
      if (resolvedPurchaserIds.length === 0) {
        res.status(400).json({ error: "At least one purchaser is required" });
        return;
      }
    }

    const normalizeBorrowers = (raw: unknown): Array<{ name: string; ic?: string; hp?: string; email?: string; address: string }> => {
      if (!Array.isArray(raw)) return [];
      const out: Array<{ name: string; ic?: string; hp?: string; email?: string; address: string }> = [];
      for (const v of raw) {
        const name = typeof (v as any)?.name === "string" ? String((v as any).name).trim() : "";
        if (!name) continue;
        const icRaw = (v as any)?.ic;
        const ic = typeof icRaw === "string" ? icRaw.trim() : "";
        const hpRaw = (v as any)?.hp;
        const hp = typeof hpRaw === "string" ? hpRaw.trim() : "";
        const emailRaw = (v as any)?.email;
        const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
        const addressRaw = (v as any)?.address;
        const address = typeof addressRaw === "string" ? addressRaw.trim() : "";
        const base = ic ? { name, ic, address } : { name, address };
        if (hp) (base as any).hp = hp;
        if (email) (base as any).email = email;
        out.push(base as any);
      }
      return out;
    };

    const effectivePurchaseMode = parsed.data.purchaseMode !== undefined ? parsed.data.purchaseMode : String(existingCase.purchaseMode ?? "");
    const effectiveLoanPartyType = parsed.data.loanPartyType !== undefined
      ? parsed.data.loanPartyType
      : (String(existingCase.loanPartyType ?? "") === "3rd_party" ? "3rd_party" : "1st_party");
    if (parsed.data.loanPartyType !== undefined) updates.loanPartyType = parsed.data.loanPartyType;

    if (effectivePurchaseMode === "loan") {
      if (effectiveLoanPartyType === "1st_party") {
        const ids = wantsUpdatePurchasers ? resolvedPurchaserIds : [];
        if (ids.length > 0) {
          const rows = await r
            .select({ id: clientsTable.id, name: clientsTable.name, ic: clientsTable.icNo, phone: clientsTable.phone, email: clientsTable.email, address: clientsTable.address })
            .from(clientsTable)
            .where(and(eq(clientsTable.firmId, req.firmId!), inArray(clientsTable.id, ids)));
          const byId = new Map<number, { name: string; ic: string | null; phone: string | null; email: string | null; address: string | null }>();
          for (const row of rows) byId.set(row.id, { name: String(row.name ?? ""), ic: row.ic ?? null, phone: row.phone ?? null, email: row.email ?? null, address: row.address ?? null });
          const borrowersToStore = ids
            .map((id) => {
              const v = byId.get(id);
              const name = v?.name?.trim() ?? "";
              const ic = v?.ic ? String(v.ic).trim() : "";
              const hp = v?.phone ? String(v.phone).trim() : "";
              const email = v?.email ? String(v.email).trim() : "";
              const address = v?.address ? String(v.address).trim() : "";
              const base = ic ? { name, ic, address } : { name, address };
              if (hp) (base as any).hp = hp;
              if (email) (base as any).email = email;
              return base as any;
            })
            .filter((b) => b.name.trim().length > 0);
          updates.borrowers = borrowersToStore;
        }
      } else {
        if (parsed.data.borrowers !== undefined) {
          updates.borrowers = normalizeBorrowers(parsed.data.borrowers);
        }
      }
    } else {
      if (parsed.data.borrowers !== undefined) {
        updates.borrowers = normalizeBorrowers(parsed.data.borrowers);
      }
    }

    if (Object.keys(updates).length === 0 && !wantsUpdatePurchasers && !wantsAssignLawyer && !wantsAssignClerk) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const result = await (r as any).transaction(async (tx: DbConn) => {
      if (wantsAssignLawyer) {
        await tx.update(caseAssignmentsTable)
          .set({ unassignedAt: new Date() })
          .where(and(eq(caseAssignmentsTable.caseId, params.data.caseId), eq(caseAssignmentsTable.roleInCase, "lawyer"), sql`${caseAssignmentsTable.unassignedAt} IS NULL`));
        await tx.insert(caseAssignmentsTable).values({
          caseId: params.data.caseId,
          userId: parsed.data.assignedLawyerId,
          roleInCase: "lawyer",
          assignedBy: req.userId,
        });
      }
      if (wantsAssignClerk) {
        const assignedClerkId = (parsed.data as any).assignedClerkId as number | null | undefined;
        await tx.update(caseAssignmentsTable)
          .set({ unassignedAt: new Date() })
          .where(and(eq(caseAssignmentsTable.caseId, params.data.caseId), eq(caseAssignmentsTable.roleInCase, "clerk"), sql`${caseAssignmentsTable.unassignedAt} IS NULL`));
        if (assignedClerkId !== null && assignedClerkId !== undefined) {
          await tx.insert(caseAssignmentsTable).values({
            caseId: params.data.caseId,
            userId: assignedClerkId,
            roleInCase: "clerk",
            assignedBy: req.userId,
          });
        }
      }

      if (wantsUpdatePurchasers) {
        await tx.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, params.data.caseId));
        for (let i = 0; i < resolvedPurchaserIds.length; i++) {
          await tx.insert(casePurchasersTable).values({
            caseId: params.data.caseId,
            clientId: resolvedPurchaserIds[i],
            role: i === 0 ? "main" : "joint",
            orderNo: i + 1,
          });
        }
      }

      let c = existingCase as typeof casesTable.$inferSelect;
      if (Object.keys(updates).length > 0) {
        const [updated] = await tx
          .update(casesTable)
          .set(updates)
          .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
          .returning();
        if (!updated) return null;
        c = updated;
      } else {
        const [fresh] = await tx
          .select()
          .from(casesTable)
          .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
          .limit(1);
        if (!fresh) return null;
        c = fresh;
      }

      await tx.insert(auditLogsTable).values({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: "firm_user",
        action: "case.updated",
        entityType: "case",
        entityId: c.id,
        detail: JSON.stringify({
          updates,
          purchasersUpdated: wantsUpdatePurchasers,
          assignmentsUpdated: wantsAssignLawyer || wantsAssignClerk,
        }),
      });

      return await formatCaseDetail(tx, c);
    });

    if (!result) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[cases] update_failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
}));

const UpdateCaseAssignmentsParams = z.object({ caseId: z.coerce.number().int().positive() });
const UpdateCaseAssignmentsBody = z.object({
  lawyerIds: z.array(z.coerce.number().int().positive()).min(1).max(10),
  clerkIds: z.array(z.coerce.number().int().positive()).max(10).optional().default([]),
});

router.patch("/cases/:caseId/assignments", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "update") as RequestHandler, authed(async (req, res) => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[cases.assignments] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const params = UpdateCaseAssignmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, params.data.caseId);
  if (!ok) return;

  const parsed = UpdateCaseAssignmentsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

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

  const uniq = (xs: number[]) => Array.from(new Set(xs));
  const lawyerIds = uniq(parsed.data.lawyerIds);
  const clerkIds = uniq(parsed.data.clerkIds ?? []);

  const overlap = clerkIds.filter((id) => lawyerIds.includes(id));
  if (overlap.length > 0) {
    res.status(400).json({ error: "A user cannot be assigned as both lawyer and clerk on the same case" });
    return;
  }

  const allIds = uniq([...lawyerIds, ...clerkIds]);
  const existingUsers = await r
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.firmId, req.firmId!), inArray(usersTable.id, allIds)));
  if (existingUsers.length !== allIds.length) {
    res.status(400).json({ error: "One or more selected users were not found in this firm" });
    return;
  }

  const now = new Date();
  await r.update(caseAssignmentsTable)
    .set({ unassignedAt: now })
    .where(and(
      eq(caseAssignmentsTable.caseId, params.data.caseId),
      inArray(caseAssignmentsTable.roleInCase, ["lawyer", "clerk"]),
      sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
    ));

  await r.insert(caseAssignmentsTable).values([
    ...lawyerIds.map((id) => ({ caseId: params.data.caseId, userId: id, roleInCase: "lawyer" as const, assignedBy: req.userId, assignedAt: now })),
    ...clerkIds.map((id) => ({ caseId: params.data.caseId, userId: id, roleInCase: "clerk" as const, assignedBy: req.userId, assignedAt: now })),
  ]);

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "cases.assignments.updated",
    entityType: "case",
    entityId: params.data.caseId,
    detail: `lawyers=${lawyerIds.join(",")} clerks=${clerkIds.join(",")}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });

  const [c] = await r
    .select()
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
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

  const poaLegacyKeys = workflowDocumentLegacyKeys("register_poa" as WorkflowDocumentMilestoneKey) ?? [];
  if (milestoneKey === "register_poa" || poaLegacyKeys.includes(milestoneKey)) {
    await updateCompletionSlaState(r, req.firmId!, caseId);
  }

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
  const poaLegacyKeys = workflowDocumentLegacyKeys("register_poa" as WorkflowDocumentMilestoneKey) ?? [];
  if (existing.milestoneKey === "register_poa" || poaLegacyKeys.includes(String(existing.milestoneKey))) {
    await updateCompletionSlaState(r, req.firmId!, caseId);
  }
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

router.get("/cases/:caseId/supp-lo-documents", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "read") as RequestHandler, authed(async (req, res) => {
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
  const exists = await tableExists(r, "public.case_loan_supp_documents");
  if (!exists) {
    res.json([]);
    return;
  }
  const rows = await r
    .select({
      id: caseLoanSuppDocumentsTable.id,
      documentName: caseLoanSuppDocumentsTable.documentName,
      documentDate: caseLoanSuppDocumentsTable.documentDate,
      objectPath: caseLoanSuppDocumentsTable.objectPath,
      fileName: caseLoanSuppDocumentsTable.fileName,
      mimeType: caseLoanSuppDocumentsTable.mimeType,
      fileSize: caseLoanSuppDocumentsTable.fileSize,
      sortOrder: caseLoanSuppDocumentsTable.sortOrder,
      createdAt: caseLoanSuppDocumentsTable.createdAt,
      updatedAt: caseLoanSuppDocumentsTable.updatedAt,
    })
    .from(caseLoanSuppDocumentsTable)
    .where(and(
      eq(caseLoanSuppDocumentsTable.firmId, req.firmId!),
      eq(caseLoanSuppDocumentsTable.caseId, caseId),
      sql`${caseLoanSuppDocumentsTable.deletedAt} IS NULL`,
    ))
    .orderBy(asc(caseLoanSuppDocumentsTable.sortOrder), asc(caseLoanSuppDocumentsTable.id));
  res.json(rows.map((x) => ({
    ...x,
    documentDate: x.documentDate ? String(x.documentDate) : null,
    createdAt: toIsoStringSafeOrNull(x.createdAt),
    updatedAt: toIsoStringSafeOrNull(x.updatedAt),
  })));
}));

router.post("/cases/:caseId/supp-lo-documents", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
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
  const exists = await tableExists(r, "public.case_loan_supp_documents");
  if (!exists) {
    res.status(503).json({ error: "Supplementary loan documents not available" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const body = asObject(req.body) ?? {};
  const documentName = asString(body.documentName);
  const documentDateRaw = body.documentDate;
  const sortOrder = asNumber(body.sortOrder);
  if (!documentName?.trim()) {
    res.status(422).json({ error: "Missing documentName" });
    return;
  }
  const documentDate = Object.prototype.hasOwnProperty.call(body, "documentDate") ? parseDateOnlyInput(documentDateRaw) : undefined;
  if (documentDate === undefined && Object.prototype.hasOwnProperty.call(body, "documentDate")) {
    res.status(422).json({ error: "Invalid documentDate" });
    return;
  }
  const [row] = await r
    .insert(caseLoanSuppDocumentsTable)
    .values({
      firmId: req.firmId!,
      caseId,
      documentName: documentName.trim(),
      documentDate: typeof documentDate === "string" ? documentDate : null,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      uploadedBy: req.userId ?? null,
    })
    .returning();
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.supp_lo_document.created",
    entityType: "case",
    entityId: caseId,
    detail: `suppLoDocumentId=${row.id} name=${row.documentName}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.status(201).json({ ...row, documentDate: row.documentDate ? String(row.documentDate) : null, createdAt: toIsoStringSafeOrNull(row.createdAt), updatedAt: toIsoStringSafeOrNull(row.updatedAt) });
}));

router.patch("/cases/:caseId/supp-lo-documents/:id", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
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
  const exists = await tableExists(r, "public.case_loan_supp_documents");
  if (!exists) {
    res.status(503).json({ error: "Supplementary loan documents not available" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const body = asObject(req.body) ?? {};
  const nextName = Object.prototype.hasOwnProperty.call(body, "documentName") ? asString(body.documentName) : undefined;
  const nextDateRaw = body.documentDate;
  const nextObjectPath = Object.prototype.hasOwnProperty.call(body, "objectPath") ? asString(body.objectPath) : undefined;
  const nextFileName = Object.prototype.hasOwnProperty.call(body, "fileName") ? asString(body.fileName) : undefined;
  const nextMimeType = Object.prototype.hasOwnProperty.call(body, "mimeType") ? asString(body.mimeType) : undefined;
  const nextFileSize = Object.prototype.hasOwnProperty.call(body, "fileSize") ? asNumber(body.fileSize) : undefined;
  const nextSortOrder = Object.prototype.hasOwnProperty.call(body, "sortOrder") ? asNumber(body.sortOrder) : undefined;

  const parsedDate = Object.prototype.hasOwnProperty.call(body, "documentDate") ? parseDateOnlyInput(nextDateRaw) : undefined;
  if (parsedDate === undefined && Object.prototype.hasOwnProperty.call(body, "documentDate")) {
    res.status(422).json({ error: "Invalid documentDate" });
    return;
  }

  if (nextObjectPath !== undefined) {
    const prefix = `/objects/cases/${req.firmId}/case-${caseId}/supp-lo/${id}/`;
    if (!nextObjectPath.startsWith(prefix)) {
      res.status(400).json({ error: "Invalid objectPath" });
      return;
    }
  }
  if (nextFileName !== undefined) {
    if (!nextFileName?.trim()) {
      res.status(400).json({ error: "Missing fileName" });
      return;
    }
    const ext = fileExtLower(nextFileName);
    if (!CASE_ATTACHMENT_ALLOWED_EXTENSIONS.has(ext)) {
      res.status(422).json({ error: "Unsupported file type. Allowed: pdf, doc, docx, jpg, jpeg, png" });
      return;
    }
  }

  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (nextName !== undefined) {
    if (!nextName?.trim()) {
      res.status(422).json({ error: "Missing documentName" });
      return;
    }
    setValues.documentName = nextName.trim();
  }
  if (parsedDate !== undefined) setValues.documentDate = typeof parsedDate === "string" ? parsedDate : null;
  if (nextSortOrder !== undefined && Number.isFinite(nextSortOrder)) setValues.sortOrder = nextSortOrder;
  if (nextObjectPath !== undefined) setValues.objectPath = nextObjectPath;
  if (nextFileName !== undefined) setValues.fileName = nextFileName;
  if (nextMimeType !== undefined) setValues.mimeType = nextMimeType;
  if (nextFileSize !== undefined && Number.isFinite(nextFileSize)) setValues.fileSize = nextFileSize;
  if (Object.prototype.hasOwnProperty.call(body, "fileSize") && (nextFileSize === null || nextFileSize === undefined)) setValues.fileSize = null;

  const [row] = await r
    .update(caseLoanSuppDocumentsTable)
    .set(setValues)
    .where(and(eq(caseLoanSuppDocumentsTable.id, id), eq(caseLoanSuppDocumentsTable.firmId, req.firmId!), eq(caseLoanSuppDocumentsTable.caseId, caseId), sql`${caseLoanSuppDocumentsTable.deletedAt} IS NULL`))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.supp_lo_document.updated",
    entityType: "case",
    entityId: caseId,
    detail: `suppLoDocumentId=${id}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json({ ...row, documentDate: row.documentDate ? String(row.documentDate) : null, createdAt: toIsoStringSafeOrNull(row.createdAt), updatedAt: toIsoStringSafeOrNull(row.updatedAt) });
}));

router.delete("/cases/:caseId/supp-lo-documents/:id", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "update") as RequestHandler, authed(async (req, res) => {
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
  const exists = await tableExists(r, "public.case_loan_supp_documents");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const [existing] = await r
    .select({ objectPath: caseLoanSuppDocumentsTable.objectPath, fileName: caseLoanSuppDocumentsTable.fileName })
    .from(caseLoanSuppDocumentsTable)
    .where(and(eq(caseLoanSuppDocumentsTable.id, id), eq(caseLoanSuppDocumentsTable.firmId, req.firmId!), eq(caseLoanSuppDocumentsTable.caseId, caseId), sql`${caseLoanSuppDocumentsTable.deletedAt} IS NULL`))
    .limit(1);
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
        logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] supp_lo_document_delete_object_failed");
      }
    }
  }
  await r
    .update(caseLoanSuppDocumentsTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(caseLoanSuppDocumentsTable.id, id), eq(caseLoanSuppDocumentsTable.firmId, req.firmId!), eq(caseLoanSuppDocumentsTable.caseId, caseId), sql`${caseLoanSuppDocumentsTable.deletedAt} IS NULL`));
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.supp_lo_document.deleted",
    entityType: "case",
    entityId: caseId,
    detail: `suppLoDocumentId=${id} fileName=${existing.fileName ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.status(204).end();
}));

router.get("/cases/:caseId/supp-lo-documents/:id/download", requireAuthHandler, requireFirmUserHandler, requirePermission("documents", "read") as RequestHandler, authed(async (req, res) => {
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
  const exists = await tableExists(r, "public.case_loan_supp_documents");
  if (!exists) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const ok = await enforceCaseAccess(r, req, res, caseId);
  if (!ok) return;
  const [row] = await r
    .select({ objectPath: caseLoanSuppDocumentsTable.objectPath, fileName: caseLoanSuppDocumentsTable.fileName, mimeType: caseLoanSuppDocumentsTable.mimeType })
    .from(caseLoanSuppDocumentsTable)
    .where(and(eq(caseLoanSuppDocumentsTable.id, id), eq(caseLoanSuppDocumentsTable.firmId, req.firmId!), eq(caseLoanSuppDocumentsTable.caseId, caseId), sql`${caseLoanSuppDocumentsTable.deletedAt} IS NULL`));
  if (!row || !row.objectPath || !row.fileName) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "cases.supp_lo_document.download",
    entityType: "case",
    entityId: caseId,
    detail: `suppLoDocumentId=${id} fileName=${row.fileName}`,
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
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, id }, "[cases] supp_lo_document_download_failed");
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
        const existingKd = await (async () => {
          try {
            return await fetchKeyDatesRow(r, req.firmId!, params.data.caseId);
          } catch (err) {
            logger.error({ err, pgCode: getPgCode(err), firmId: req.firmId, userId: req.userId, caseId: params.data.caseId }, "[cases] workflow backfill fetch key-dates failed");
            return null;
          }
        })();
        if (shouldBackfillKeyDate(mapped, existingKd)) {
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
    const countUnreadSince = async (lastReadAt: Date, withChannel: boolean): Promise<number> => {
      try {
        const [row] = await r
          .select({ c: sql<number>`COUNT(*)::int` })
          .from(caseMessagesTable)
          .where(and(
            eq(caseMessagesTable.firmId, req.firmId!),
            eq(caseMessagesTable.caseId, params.data.caseId),
            ...(withChannel ? [eq(caseMessagesTable.channel, ch)] : []),
            inArray(caseMessagesTable.senderType, ["client", "developer"]),
            sql`${caseMessagesTable.createdAt} > ${lastReadAt}`,
          ));
        return Number((row as any)?.c ?? 0);
      } catch (e) {
        const code = getPgCode(e);
        if (code === "42703" && withChannel) return await countUnreadSince(lastReadAt, false);
        if (code === "42P01" || code === "42501" || code === "42703") return 0;
        throw e;
      }
    };

    try {
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
      byChannel[ch] = await countUnreadSince(lastReadAt, true);
    } catch (e) {
      const code = getPgCode(e);
      if (code === "42P01" || code === "42501") {
        byChannel[ch] = 0;
        continue;
      }
      if (code === "42703") {
        try {
          const [readStatusLegacy] = await r
            .select({ lastReadAt: caseMessageReadStatusTable.lastReadAt })
            .from(caseMessageReadStatusTable)
            .where(and(
              eq(caseMessageReadStatusTable.firmId, req.firmId!),
              eq(caseMessageReadStatusTable.caseId, params.data.caseId),
              eq(caseMessageReadStatusTable.userId, req.userId!),
            ));
          const lastReadAt = readStatusLegacy?.lastReadAt instanceof Date ? readStatusLegacy.lastReadAt : new Date(0);
          byChannel[ch] = await countUnreadSince(lastReadAt, true);
        } catch (legacyErr) {
          const legacyCode = getPgCode(legacyErr);
          if (legacyCode === "42P01" || legacyCode === "42501" || legacyCode === "42703") {
            byChannel[ch] = 0;
            continue;
          }
          throw legacyErr;
        }
        continue;
      }
      throw e;
    }
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
      sourceType: caseLedgersTable.sourceType,
      sourceId: caseLedgersTable.sourceId,
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
  const outstandingAdvances = sumByType("advance_paid") - sumByType("advance_recovered");

  res.json({
    summary: {
      total_billed: totalBilled,
      total_received: totalReceived,
      outstanding_balance: outstandingBalance,
      trust_balance: trustBalance,
      outstanding_advances: outstandingAdvances,
    },
    data: rows.map((x) => ({
      id: String(x.id),
      transactionDate: String(x.transactionDate),
      entryCategory: String(x.entryCategory),
      entryType: String(x.entryType),
      description: String(x.description),
      amount: Number(x.amount ?? 0),
      sourceType: x.sourceType ? String(x.sourceType) : null,
      sourceId: typeof x.sourceId === "number" ? x.sourceId : (x.sourceId ? Number(x.sourceId) : null),
      createdAt: toIsoStringSafe(x.createdAt),
      updatedAt: toIsoStringSafe(x.updatedAt),
    })),
  });
}));

router.get("/cases/:caseId/advances", requireAuthHandler, requireFirmUserHandler, requirePermission("cases", "read") as RequestHandler, authed(async (req, res) => {
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

  const [row] = await r
    .select({
      outstanding: sql<string>`
        COALESCE(SUM(CASE WHEN ${caseLedgersTable.entryType} = 'advance_paid' THEN ${caseLedgersTable.amount} ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ${caseLedgersTable.entryType} = 'advance_recovered' THEN ${caseLedgersTable.amount} ELSE 0 END), 0)
      `,
    })
    .from(caseLedgersTable)
    .where(and(eq(caseLedgersTable.firmId, req.firmId!), eq(caseLedgersTable.caseId, params.data.caseId)))
    .limit(1);
  res.json({ outstanding_advances: Number(row?.outstanding ?? 0) });
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
      sourceType: caseLedgersTable.sourceType,
      sourceId: caseLedgersTable.sourceId,
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
    sourceType: created?.sourceType ? String(created.sourceType) : null,
    sourceId: typeof (created as any)?.sourceId === "number" ? (created as any).sourceId : ((created as any)?.sourceId ? Number((created as any).sourceId) : null),
    createdAt: toIsoStringSafe(created?.createdAt),
    updatedAt: toIsoStringSafe(created?.updatedAt),
  });
}));

export { router };
export default router;
