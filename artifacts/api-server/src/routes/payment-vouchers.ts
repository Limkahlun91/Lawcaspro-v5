import express, { type NextFunction, type Response, type Router as ExpressRouter } from "express";
import crypto from "crypto";
import { eq, and, desc, asc, inArray, ne, isNull, count, or } from "drizzle-orm";
import {
  accountingSettingsTable,
  auditLogsTable,
  caseAssignmentsTable,
  caseLedgersTable,
  caseNotificationsTable,
  casePurchasersTable,
  casesTable,
  clientsTable,
  db,
  firmBankAccountsTable,
  ledgerEntriesTable,
  paymentVoucherActionsTable,
  paymentVoucherCreateRequestsTable,
  paymentVoucherItemsTable,
  paymentVouchersTable,
  permissionsTable,
  pool,
  projectsTable,
  quotationItemsTable,
  quotationsTable,
  rolesTable,
  sql,
  userNotificationsTable,
  usersTable,
} from "@workspace/db";
import { CreatePaymentVoucherBody, PaymentVoucherTransitionBody } from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requireFirmUserSession, requireFirmUserFinancialSession, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { sensitiveRateLimiter } from "../lib/rate-limit.js";
import { queryOne } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import {
  accountingSettingsErrorHttpStatus,
  AccountingSettingsLoaderError,
  addBusinessHours,
  getDefaultAccountingSettings,
  normalizeAccountingSettings,
  resolveApprovalRequirement,
  resolvePaymentVoucherSlaHours,
  safeLoadAccountingSettingsOrDefault,
  safeLoadAccountingSettings,
  type AccountingSettingsRecord,
} from "../modules/accounting/accounting-settings.js";
import { resolvePaymentVoucherApprovalStatus } from "../modules/accounting/payment-voucher-approval.js";
import {
  updatePvTrackingFailed,
  updatePvTrackingFailedInTx,
  PV_CREATE_PRELOCK_TIMEOUT_MS,
  PV_CREATE_TRACKING_UPDATE_STATEMENT_TIMEOUT_MS,
  type TrackingDbConn,
  type TrackingInTxConn,
} from "../modules/accounting/payment-voucher-create-tracking.js";
import {
  isPaymentVoucherCreateRequestStale,
  PAYMENT_VOUCHER_CREATE_STALE_MS,
  resolvePaymentVoucherCreateStatus,
} from "../modules/accounting/payment-voucher-create-status.js";
import {
  ensureExactlyOneCreateRequestCompleted,
  writePaymentVoucherCreateAuditEvents,
} from "../modules/accounting/payment-voucher-create-request.js";
import { withDbStatementTimeout, type StatementTimeoutCategory } from "../modules/db/statement-timeout.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbConn = TrackingDbConn;
type DbTxConn = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;
const rdb = (req: AuthRequest): DbConn => (req.rlsDb ?? db) as unknown as DbConn;

function parsePageLimit(
  req: AuthRequest,
  defaults: { defaultLimit: number; maxLimit: number } = { defaultLimit: 30, maxLimit: 200 },
): { page: number; limit: number; offset: number } {
  const pageRaw = queryOne(req.query, "page");
  const limitRaw = queryOne(req.query, "limit");
  let page = Number.parseInt(pageRaw ?? "1", 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let limit = Number.parseInt(limitRaw ?? String(defaults.defaultLimit), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaults.defaultLimit;
  if (limit > defaults.maxLimit) limit = defaults.maxLimit;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

const createSectionTimer = (req: AuthRequest, key: string) => {
  const start = Date.now();
  let stopped = false;
  return () => {
    if (stopped) {
      return (req.timing?.sections?.[key] as number | undefined) ?? 0;
    }
    stopped = true;
    const ms = Math.max(0, Date.now() - start);
    if (req.timing?.sections) {
      req.timing.sections[key] = (req.timing.sections[key] ?? 0) + ms;
    }
    return ms;
  };
};

const PV_CREATE_REQUEST_BUDGET_MS = 25_000;
const PV_CREATE_SMALL_QUERY_TIMEOUT_MS = 3_000;
const PV_CREATE_AGGREGATE_TIMEOUT_MS = 5_000;
const PV_CREATE_TX_LOCK_TIMEOUT_MS = 2_000;
const PV_CREATE_TX_STATEMENT_TIMEOUT_MS = 15_000;
const PV_CREATE_COMMIT_MAX_MS = 3_000;
const PV_CREATE_OVERHEAD_RESERVE_MS = 2_000;

type PvCreateTimingStage =
  | "request_received"
  | "payload_validated"
  | "auth_resolved"
  | "permission_checked"
  | "accounting_settings_loaded"
  | "idempotency_tracking_started"
  | "idempotency_tracking_inserted"
  | "case_and_reference_loaded"
  | "preflight_validation_passed"
  | "transaction_started"
  | "voucher_inserted"
  | "items_inserted"
  | "audit_written"
  | "tracking_completed"
  | "response_sent"
  | "failed";

function getPoolStatsSnapshot() {
  try {
    return {
      poolTotalCount: pool.totalCount ?? 0,
      poolIdleCount: pool.idleCount ?? 0,
      poolWaitingCount: pool.waitingCount ?? 0,
    };
  } catch {
    return { poolTotalCount: 0, poolIdleCount: 0, poolWaitingCount: 0 };
  }
}

const getReqIdForLog = (req: AuthRequest): string | null => {
  const id = (req as unknown as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

export class PvTimeoutSetupFailed extends Error {
  readonly name = "PvTimeoutSetupFailed";
  constructor(
    readonly sqlState: string | null,
    readonly stage: string,
    readonly timeoutMs: number,
  ) {
    super(`pv.statement_timeout.setup_failed@${stage} t=${timeoutMs}ms sqlState=${sqlState ?? "none"}`);
  }
}

export async function setRlsClientStatementTimeout(
  req: AuthRequest,
  timeoutMs: number,
  stage: string,
): Promise<void> {
  const client = req.rlsClient;
  if (!client) return;
  const safeMs = Math.max(100, Math.floor(timeoutMs));
  try {
    await client.query({
      text: `SET LOCAL statement_timeout = '${safeMs}ms'`,
    });
  } catch (err) {
    const sqlState = (() => {
      if (!err || typeof err !== "object") return null;
      const c = err as { code?: unknown; sqlState?: unknown; sqlstate?: unknown };
      for (const v of [c.sqlState, c.sqlstate, c.code]) {
        if (typeof v === "string") return v;
      }
      return null;
    })();
    logger.warn(
      {
        reqId: getReqIdForLog(req),
        firmId: req.firmId ?? null,
        clientRequestId: (req as { pvClientRequestId?: string }).pvClientRequestId ?? null,
        userId: req.userId ?? null,
        stage,
        timeoutMs: safeMs,
        sqlState,
        err,
      },
      "payment_voucher.set_statement_timeout_failed",
    );
    throw new PvTimeoutSetupFailed(sqlState, stage, safeMs);
  }
}

import { makeRlsDb } from "@workspace/db";
import type { RlsDb, PoolClient } from "@workspace/db";

export async function setSessionStatementTimeout(
  req: AuthRequest,
  timeoutMs: number,
  stage: string,
): Promise<void> {
  const safeMs = Math.max(100, Math.floor(timeoutMs));
  const client = req.rlsClient;

  if (!client) {
    logger.error(
      {
        event:
          "payment_voucher.session_timeout_client_missing",
        reqId: getReqIdForLog(req),
        firmId: req.firmId ?? null,
        userId: req.userId ?? null,
        clientRequestId:
          (req as { pvClientRequestId?: string })
            .pvClientRequestId ?? null,
        stage,
        timeoutMs: safeMs,
      },
      "PV financial session client missing while installing timeout",
    );

    throw new PvTimeoutSetupFailed(
      "CLIENT_MISSING",
      stage,
      safeMs,
    );
  }

  try {
    await client.query({
      text:
        `SET SESSION statement_timeout = '${safeMs}ms'`,
    });
  } catch (err) {
    const sqlState = (() => {
      if (!err || typeof err !== "object") return null;

      const c = err as {
        code?: unknown;
        sqlState?: unknown;
        sqlstate?: unknown;
      };

      for (const v of [
        c.sqlState,
        c.sqlstate,
        c.code,
      ]) {
        if (typeof v === "string") return v;
      }

      return null;
    })();

    logger.warn(
      {
        reqId: getReqIdForLog(req),
        firmId: req.firmId ?? null,
        clientRequestId:
          (req as { pvClientRequestId?: string })
            .pvClientRequestId ?? null,
        userId: req.userId ?? null,
        stage,
        timeoutMs: safeMs,
        sqlState,
        err,
      },
      "payment_voucher.set_session_statement_timeout_failed",
    );

    throw new PvTimeoutSetupFailed(
      sqlState,
      stage,
      safeMs,
    );
  }
}

type TenantTxResult<T> =
  | { ok: true; value: T; commitMs: number }
  | { ok: false; error: unknown; sqlState: string | null; rollbackMs: number; code?: "TX_BEGIN_FAILED" | "TX_TIMEOUT_SETUP_FAILED" | "TX_WORK_FAILED" | "TX_COMMIT_FAILED" };

export async function withTenantScopedTx<T>(
  req: AuthRequest,
  opts: {
    timeoutMs: number;
    lockTimeoutMs?: number;
    stage: string;
  },
  work: (txR: RlsDb, client: PoolClient) => Promise<T>,
): Promise<TenantTxResult<T>> {
  const client = req.rlsClient;
  if (!client) {
    return {
      ok: false,
      error: new Error("req.rlsClient missing for tenant tx"),
      sqlState: null,
      rollbackMs: 0,
      code: "TX_BEGIN_FAILED",
    };
  }
  const sqlStateFrom = (err: unknown): string | null => {
    if (!err || typeof err !== "object") return null;
    const c = err as { code?: unknown; sqlState?: unknown; sqlstate?: unknown };
    for (const v of [c.sqlState, c.sqlstate, c.code]) {
      if (typeof v === "string") return v;
    }
    return null;
  };

  const safeMs = Math.max(100, Math.floor(opts.timeoutMs));
  const safeLockMs = Math.max(50, Math.floor(opts.lockTimeoutMs ?? PV_CREATE_PRELOCK_TIMEOUT_MS));
  try {
    await client.query("BEGIN");
  } catch (err) {
    return { ok: false, error: err, sqlState: sqlStateFrom(err), rollbackMs: 0, code: "TX_BEGIN_FAILED" };
  }
  try {
    await client.query(`SET LOCAL lock_timeout = '${safeLockMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${safeMs}ms'`);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    return { ok: false, error: err, sqlState: sqlStateFrom(err), rollbackMs: 0, code: "TX_TIMEOUT_SETUP_FAILED" };
  }
  const txR = makeRlsDb(client);
  try {
    const value = await work(txR, client);
    const t1 = Date.now();
    try {
      await client.query("COMMIT");
      const commitMs = Date.now() - t1;
      return { ok: true, value, commitMs };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      return { ok: false, error: err, sqlState: sqlStateFrom(err), rollbackMs: Date.now() - t1, code: "TX_COMMIT_FAILED" };
    }
  } catch (err) {
    const t1 = Date.now();
    try { await client.query("ROLLBACK"); } catch {}
    return { ok: false, error: err, sqlState: sqlStateFrom(err), rollbackMs: Date.now() - t1, code: "TX_WORK_FAILED" };
  }
}

export async function pvMarkTrackingFailedDurable(
  req: AuthRequest,
  normalizedClientRequestId: string | null | undefined,
  error: string,
  stage: string = "unknown",
): Promise<{ ok: boolean }> {
  if (!normalizedClientRequestId) return { ok: true };
  const firmId = req.firmId;
  const userId = req.userId;
  if (!firmId || !userId) return { ok: false };
  // Test-only: request-scoped armed flag (stored on req via well-known internal
  // symbol, set only by test harness, never from HTTP headers or globalThis).
  // Production hard gate: NODE_ENV !== "test" → NEVER activate this branch.
  const hookSym: unique symbol = Symbol.for("lawcaspro.pv_p0_test_hooks") as any;
  let testHooks: any = undefined;
  if (process.env.NODE_ENV === "test") {
    testHooks = (req as any)[hookSym];
  }
  const trackingUpdateInject: any = testHooks?.injectTrackingUpdateError;
  if (trackingUpdateInject && typeof trackingUpdateInject === "object" && trackingUpdateInject !== null) {
    (req as any)[hookSym] = { ...testHooks, _armedTrackingUpdateError: { ...trackingUpdateInject } };
  }
  const safeError = sanitizePvErrorForTracking(error, stage);
  const res = await withTenantScopedTx(
    req,
    { timeoutMs: PV_CREATE_SMALL_QUERY_TIMEOUT_MS, lockTimeoutMs: PV_CREATE_PRELOCK_TIMEOUT_MS, stage: `tracking_failed:${stage}` },
    async (txR) => {
      try {
        await updatePvTrackingFailedInTx(txR as TrackingInTxConn, firmId, userId, normalizedClientRequestId, safeError, stage);
      } catch (dbErr: any) {
        // Structured event exactly matching the helper's legacy path. NEVER silent.
        logger.warn(
          {
            event: "payment_voucher.tracking_failure_update_failed",
            firmId,
            userId,
            clientRequestId: normalizedClientRequestId,
            stage,
            sqlstate: String(dbErr?.code ?? ""),
            code: "DB_ERROR",
            boundedLockTimeoutMs: PV_CREATE_PRELOCK_TIMEOUT_MS,
            boundedStatementTimeoutMs: PV_CREATE_TRACKING_UPDATE_STATEMENT_TIMEOUT_MS,
          },
          "tracking update DB error (pvMarkTrackingFailedDurable scope)",
        );
        throw dbErr;
      }
      return true;
    },
  );
  return { ok: res.ok };
}

function extractPgErrorMeta(err: unknown): { pgCode: string; constraint: string; column: string; tableName: string } {
  const pgCode = String((err as any)?.code ?? (err as any)?.sqlstate ?? (err as any)?.sqlState ?? "").slice(0, 12);
  const constraint = String((err as any)?.constraint ?? "").slice(0, 120);
  const column = String((err as any)?.column ?? "").slice(0, 120);
  const tableName = String((err as any)?.table ?? "").slice(0, 120);
  return { pgCode, constraint, column, tableName };
}

function sanitizePvErrorForTracking(raw: string, stage: string): string {
  const s = String(raw ?? "");
  const stripped = s
    .replace(/\binsert\s+into\s+"[^"]*"(\s*\([^)]*\))?\s*values[\s\S]*$/gi, `[REDACTED_SQL_VALUES]`)
    .replace(/\bfailed\s+query:[\s\S]*$/gi, `[REDACTED_FAILED_QUERY]`)
    .replace(/\$\d+/g, "?")
    .replace(/\bERROR:\s*column\s+"[^"]*"\s+of\s+relation\s+"[^"]*"\s+does\s+not\s+exist/gi, "[REDACTED_COLUMN_MISSING]")
    .replace(/\bERROR:\s*/gi, "")
    .slice(0, 200);
  return `PV_FAIL:stage=${stage || "unknown"}:${stripped || "unknown_error"}`;
}

function sendPvSafeErrorResponse(
  res: Response,
  req: AuthRequest,
  opts: {
    normalizedClientRequestId: string | null | undefined;
    rawErr: unknown;
    stage: string;
  },
): void {
  const requestId = typeof (res as any).locals?.requestId === "string" ? String((res as any).locals.requestId) : typeof (req as any).id === "string" ? String((req as any).id) : "";
  const { pgCode, constraint, column, tableName } = extractPgErrorMeta(opts.rawErr);
  logger.warn(
    {
      event: "payment_voucher.create_failed",
      reqId: requestId,
      clientRequestId: opts.normalizedClientRequestId ?? null,
      firmId: req.firmId ?? null,
      userId: req.userId ?? null,
      stage: opts.stage,
      pgCode: pgCode || null,
      constraint: constraint || null,
      column: column || null,
      tableName: tableName || null,
      durationMs: req.timing?.sections?.totalRequestMs ?? null,
    },
    "payment_voucher create failed - SAFE shape returned to client",
  );
  const retryable =
    pgCode === "55P03" ||
    pgCode === "57014" ||
    pgCode === "40P01" ||
    pgCode === "40001";
  res.status(500).json({
    ok: false,
    code: "PAYMENT_VOUCHER_CREATE_FAILED",
    message: "Payment Voucher could not be created.",
    requestId,
    ...(opts.normalizedClientRequestId ? { clientRequestId: opts.normalizedClientRequestId } : {}),
    ...(retryable ? { retryable: true, retryAfterMs: 2000 } : { retryable: false }),
  });
}

function getPvE2eStartAt(req: AuthRequest): number {
  if (req.timing && typeof req.timing.startAt === "number") return req.timing.startAt;
  const v = (req as { pvCreateStartedAt?: number }).pvCreateStartedAt;
  if (typeof v === "number") return v;
  return Date.now();
}

function checkPvCreateBudget(
  req: AuthRequest,
  stage: PvCreateTimingStage,
): { exceeded: boolean; elapsedMs: number; remainingMs: number } {
  const startedAt = getPvE2eStartAt(req);
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  if (elapsedMs >= PV_CREATE_REQUEST_BUDGET_MS) {
    return { exceeded: true, elapsedMs, remainingMs: 0 };
  }
  return { exceeded: false, elapsedMs, remainingMs: Math.max(0, PV_CREATE_REQUEST_BUDGET_MS - elapsedMs) };
}

function emitPvCreateTiming(
  req: AuthRequest,
  stage: PvCreateTimingStage,
  meta: Record<string, unknown> = {},
) {
  const now = Date.now();
  const startedAt = getPvE2eStartAt(req);
  const elapsedMs = Math.max(0, now - startedAt);
  const lastEmit = (req as { pvCreateLastEmitAt?: number }).pvCreateLastEmitAt ?? startedAt;
  const stageMs = Math.max(0, now - lastEmit);
  (req as { pvCreateLastEmitAt?: number }).pvCreateLastEmitAt = now;
  if (req.timing?.sections) {
    req.timing.sections[`pv.stage.${stage}`] = (req.timing.sections[`pv.stage.${stage}`] ?? 0) + stageMs;
  }
  const sections = req.timing?.sections ?? null;
  const event = {
    reqId: getReqIdForLog(req),
    clientRequestId: (req as { pvClientRequestId?: string }).pvClientRequestId ?? null,
    firmId: req.firmId ?? null,
    userId: req.userId ?? null,
    stage,
    elapsedMs,
    stageMs,
    authMs: sections && typeof sections.authSessionMs === "number" ? sections.authSessionMs : null,
    dbPoolConnectMs: sections && typeof sections.tenantContextDbConnectMs === "number" ? sections.tenantContextDbConnectMs : null,
    tenantContextMs: sections && typeof sections.tenantContextMs === "number" ? sections.tenantContextMs : null,
    handlerElapsedMs: (req as { pvCreateStartedAt?: number }).pvCreateStartedAt ? Math.max(0, now - (req as { pvCreateStartedAt?: number }).pvCreateStartedAt!) : null,
    ...getPoolStatsSnapshot(),
    ...meta,
  };
  if (elapsedMs >= 2000 || stage === "failed") {
    logger.info(event, "payment_voucher.create_timing");
  }
}

async function getRoleName(req: AuthRequest): Promise<string> {
  return String((req as { roleName?: unknown }).roleName ?? "").trim();
}

async function roleHasPermission(req: AuthRequest, module: string, action: string): Promise<boolean> {
  if (!req.roleId) return false;
  const r = rdb(req);
  const rows = await r
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, req.roleId),
      eq(permissionsTable.module, module),
      eq(permissionsTable.action, action),
      eq(permissionsTable.allowed, true),
    ))
    .limit(1);
  return Boolean(rows[0]);
}

function classifyCaseWorkflowRole(roleName: string): "partner" | "lawyer" | "staff" {
  const lower = (roleName ?? "").trim().toLowerCase();
  if (lower === "partner" || lower === "founder") return "partner";
  if (lower === "manager" || lower === "senior lawyer" || lower === "lawyer") return "lawyer";
  return "staff";
}

async function resolveIsPartnerBySettingsOrName(
  settings: AccountingSettingsRecord,
  roleId: number | null | undefined,
  roleName: string,
): Promise<boolean> {
  if (roleId) {
    const partnerRuleIds = Array.isArray((settings.approvalRules as any)?.partnerRoleIds)
      ? (settings.approvalRules as any).partnerRoleIds.map(Number)
      : [];
    if (partnerRuleIds.includes(Number(roleId))) return true;
    if (partnerRuleIds.length > 0) return false;
  }
  const lower = (roleName ?? "").trim().toLowerCase();
  return lower === "partner" || lower === "founder";
}

async function resolveIsAccountManagerOrAdminBySettings(
  settings: AccountingSettingsRecord,
  roleId: number | null | undefined,
): Promise<boolean> {
  if (!roleId) return false;
  const mgrIds = Array.isArray(settings.accountManagerRoleIds) ? settings.accountManagerRoleIds.map(Number) : [];
  const admIds = Array.isArray(settings.accountAdminRoleIds) ? settings.accountAdminRoleIds.map(Number) : [];
  const nid = Number(roleId);
  return mgrIds.includes(nid) || admIds.includes(nid);
}

async function classifyCaseWorkflowRoleWithSettings(
  req: AuthRequest,
  roleName: string,
  settings: AccountingSettingsRecord,
): Promise<"partner" | "lawyer" | "staff"> {
  const roleId = req.roleId;
  if (roleId) {
    const isPartner = await resolveIsPartnerBySettingsOrName(settings, roleId, roleName);
    if (isPartner) return "partner";
  }
  if (roleId && await resolveIsAccountManagerOrAdminBySettings(settings, roleId)) {
    return "lawyer";
  }
  return classifyCaseWorkflowRole(roleName);
}

async function loadResponsibleLawyerFromCase(
  r: DbConn,
  firmId: number,
  caseId: number,
): Promise<number | null> {
  const [row] = await r
    .select({ userId: caseAssignmentsTable.userId })
    .from(caseAssignmentsTable)
    .where(and(
      eq(caseAssignmentsTable.caseId, caseId),
      eq(caseAssignmentsTable.roleInCase, "lawyer"),
      isNull(caseAssignmentsTable.unassignedAt),
    ))
    .orderBy(caseAssignmentsTable.assignedAt)
    .limit(1);
  return row?.userId ? Number(row.userId) : null;
}

async function validateQuotationAndBuildWarning(
  r: DbConn,
  firmId: number,
  caseId: number | null,
  quotationId: number,
): Promise<{ valid: boolean; error?: string; warning?: string }> {
  const [q] = await r
    .select()
    .from(quotationsTable)
    .where(and(
      eq(quotationsTable.firmId, firmId),
      eq(quotationsTable.id, quotationId),
      isNull(quotationsTable.deletedAt),
    ))
    .limit(1);
  if (!q) return { valid: false, error: "Quotation not found" };
  if (caseId && q.caseId && Number(q.caseId) !== Number(caseId)) {
    return { valid: false, error: "Quotation belongs to a different case" };
  }
  const warnings: string[] = [];
  if (q.status === "accepted") {
    warnings.push("Quotation already marked as accepted");
  }
  if (q.acceptedAt) {
    warnings.push(`Quotation accepted at ${new Date(q.acceptedAt).toISOString().slice(0, 10)}`);
  }
  const [existingLink] = await r
    .select({ id: paymentVouchersTable.id, voucherNo: paymentVouchersTable.voucherNo })
    .from(paymentVouchersTable)
    .where(and(
      eq(paymentVouchersTable.firmId, firmId),
      eq(paymentVouchersTable.quotationId, quotationId),
      ne(paymentVouchersTable.status, "rejected"),
    ))
    .limit(1);
  if (existingLink) {
    warnings.push(`Already linked to PV ${String(existingLink.voucherNo ?? existingLink.id)}`);
  }
  return { valid: true, warning: warnings.length ? warnings.join("; ") : undefined };
}

function normalizeForFuzzyMatch(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s\u4e00-\u9fff]/g, "")
    .trim();
}

function descriptionFuzzyMatches(needleNorm: string, hayNorm: string): boolean {
  if (!needleNorm || !hayNorm) return false;
  if (needleNorm === hayNorm) return true;
  if (hayNorm.includes(needleNorm)) return true;
  if (needleNorm.includes(hayNorm)) return true;
  const tokens = needleNorm.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return false;
  let hit = 0;
  for (const tk of tokens) {
    if (hayNorm.includes(tk)) hit++;
  }
  return hit >= Math.min(2, tokens.length);
}

async function buildQuotationUnclaimedWarnings(
  r: DbConn,
  firmId: number,
  caseId: number | null,
  explicitQuotationId: number | null,
  pvItems: Array<{ description: string; amount?: number | string | null }>,
): Promise<Array<{ item: string; matchedQuotationId?: number | null; matchedQuotationRef?: string | null }>> {
  const warnings: Array<{ item: string; matchedQuotationId?: number | null; matchedQuotationRef?: string | null }> = [];
  if (!pvItems || pvItems.length === 0) return warnings;
  if (!caseId && !explicitQuotationId) return warnings;

  const quotationIdsToLoad: number[] = [];
  if (explicitQuotationId) quotationIdsToLoad.push(explicitQuotationId);
  if (caseId && !quotationIdsToLoad.length) {
    const rows = await r
      .select({ id: quotationsTable.id, referenceNo: quotationsTable.referenceNo })
      .from(quotationsTable)
      .where(and(
        eq(quotationsTable.firmId, firmId),
        eq(quotationsTable.caseId, caseId),
        isNull(quotationsTable.deletedAt),
      ));
    for (const row of rows) quotationIdsToLoad.push(Number(row.id));
  }
  if (quotationIdsToLoad.length === 0) return warnings;
  const qItems = await r
    .select({
      description: quotationItemsTable.description,
      quotationId: quotationItemsTable.quotationId,
      referenceNo: quotationsTable.referenceNo,
    })
    .from(quotationItemsTable)
    .leftJoin(quotationsTable, eq(quotationsTable.id, quotationItemsTable.quotationId))
    .where(and(
      eq(quotationsTable.firmId, firmId),
      inArray(quotationItemsTable.quotationId, quotationIdsToLoad),
    ));
  const normalizedQItems = qItems.map((qi) => ({
    norm: normalizeForFuzzyMatch(String(qi.description ?? "")),
    quotationId: qi.quotationId,
    referenceNo: qi.referenceNo,
  }));

  for (const pvItem of pvItems) {
    const rawDesc = String(pvItem.description ?? "").trim();
    if (!rawDesc) continue;
    const needle = normalizeForFuzzyMatch(rawDesc);
    if (!needle) continue;
    let found = false;
    for (const qi of normalizedQItems) {
      if (descriptionFuzzyMatches(needle, qi.norm)) {
        found = true;
        break;
      }
    }
    if (!found) {
      warnings.push({
        item: rawDesc,
        matchedQuotationId: explicitQuotationId,
        matchedQuotationRef:
          explicitQuotationId
            ? (qItems.find((x) => Number(x.quotationId) === Number(explicitQuotationId))?.referenceNo ?? null)
            : null,
      });
    }
  }
  return warnings;
}

async function getAccountingSettings(req: AuthRequest): Promise<AccountingSettingsRecord> {
  const r = rdb(req);
  try {
    const result = await safeLoadAccountingSettings({
      firmId: req.firmId!,
      db: r as any,
      accountingSettingsTable,
      sql,
      eq,
    });
    if (!result.rowExisted) {
      return getDefaultAccountingSettings(req.firmId!);
    }
    return result.settings;
  } catch (err) {
    if (err instanceof AccountingSettingsLoaderError) {
      if (err.code === "MIGRATION_MISSING" || err.code === "ACCOUNTING_SETTINGS_UNAVAILABLE" || err.code === "DATABASE_PERMISSION_ERROR") {
        return getDefaultAccountingSettings(req.firmId!);
      }
    }
    return getDefaultAccountingSettings(req.firmId!);
  }
}

function writeAccountingSettingsErrorResponse(res: Response, err: unknown): void {
  if (err instanceof AccountingSettingsLoaderError) {
    res.status(accountingSettingsErrorHttpStatus(err.code)).json({
      error: "Accounting settings unavailable",
      code: err.code,
      sqlstate: err.sqlstate ?? undefined,
    });
    return;
  }
  res.status(503).json({
    error: "Accounting settings unavailable",
    code: "ACCOUNTING_SETTINGS_UNAVAILABLE",
  });
}

function generateVoucherNo(now: Date): string {
  const yr = now.getFullYear();
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `PV-${yr}-${suffix}`;
}

function hashCreatePayload(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

function buildCreateRequestLockKey(firmId: number, createdByUserId: number, clientRequestId: string) {
  return `${firmId}:${createdByUserId}:${clientRequestId}`;
}

async function tryAcquireCreateRequestTxnLock(tx: DbTxConn, firmId: number, createdByUserId: number, clientRequestId: string): Promise<boolean> {
  const key = buildCreateRequestLockKey(firmId, createdByUserId, clientRequestId);
  const rows = await (tx as any).select({
    locked: sql<boolean>`pg_try_advisory_xact_lock(hashtext(${key}), hashtext(${key}))`,
  }).from(sql`(select 1) as __dual__`);
  return Boolean(rows?.[0]?.locked);
}

async function isCreateRequestActivelyLocked(r: DbConn, firmId: number, createdByUserId: number, clientRequestId: string): Promise<boolean> {
  const key = buildCreateRequestLockKey(firmId, createdByUserId, clientRequestId);
  return await r.transaction(async (tx) => {
    const rows = await (tx as any).select({
      locked: sql<boolean>`pg_try_advisory_xact_lock(hashtext(${key}), hashtext(${key}))`,
    }).from(sql`(select 1) as __dual__`);
    return !Boolean(rows?.[0]?.locked);
  });
}

async function loadVoucherByClientRequest(r: DbConn | DbTxConn, firmId: number, clientRequestId: string) {
  const [pv] = await r
    .select()
    .from(paymentVouchersTable)
    .where(and(
      eq(paymentVouchersTable.firmId, firmId),
      eq(paymentVouchersTable.clientRequestId, clientRequestId),
    ))
    .limit(1);
  return pv ?? null;
}

function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42703" || code === "42P01";
}

async function createUserNotification(args: {
  tx: DbTxConn;
  firmId: number;
  userId: number;
  sourceType: string;
  sourceId: number;
  caseId?: number | null;
  notificationType: string;
  title: string;
  message: string;
  actorUserId?: number | null;
  meta?: Record<string, unknown> | null;
}) {
  await args.tx.insert(userNotificationsTable).values({
    firmId: args.firmId,
    userId: args.userId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    caseId: args.caseId ?? null,
    notificationType: args.notificationType,
    title: args.title,
    message: args.message,
    meta: args.meta ?? null,
  });
  if (args.caseId) {
    await args.tx.insert(caseNotificationsTable).values({
      firmId: args.firmId,
      caseId: args.caseId,
      recipientUserId: args.userId,
      actorUserId: args.actorUserId ?? null,
      type: args.notificationType,
      title: args.title,
      message: args.message,
      meta: args.meta ?? null,
    });
  }
}

function normalizeLedgerAccountType(v: unknown): "client" | "office" | "balance_sheet" {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "trust") return "client";
  if (s === "balance_sheet" || s === "fixed_deposit") return "balance_sheet";
  if (s === "office") return "office";
  return "client";
}

async function postLedgerTx(tx: DbTxConn, args: {
  firmId: number;
  caseId: number | null;
  entryDate: string;
  entryType: string;
  accountType: string;
  debit: number;
  credit: number;
  description: string;
  referenceNo?: string | null;
  sourceType: string;
  sourceId: number;
  createdBy: number;
}) {
  const [last] = await tx
    .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
    .from(ledgerEntriesTable)
    .where(and(
      eq(ledgerEntriesTable.firmId, args.firmId),
      eq(ledgerEntriesTable.accountType, args.accountType),
      args.caseId ? eq(ledgerEntriesTable.caseId, args.caseId) : sql`case_id IS NULL`,
    ));
  const prevBal = Number(last?.bal ?? 0);
  const balanceAfter = prevBal + args.credit - args.debit;
  await tx.insert(ledgerEntriesTable).values({
    firmId: args.firmId,
    caseId: args.caseId,
    entryDate: args.entryDate,
    entryType: args.entryType,
    accountType: args.accountType,
    debit: args.debit.toFixed(2),
    credit: args.credit.toFixed(2),
    balanceAfter: balanceAfter.toFixed(2),
    description: args.description,
    referenceNo: args.referenceNo ?? null,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    createdBy: args.createdBy,
  });
}

function isPartnerRoleName(roleName: unknown): boolean {
  const n = typeof roleName === "string" ? roleName.trim().toLowerCase() : "";
  if (!n) return false;
  return (
    n === "partner" ||
    n === "managing partner" ||
    n === "senior partner"
  );
}

function isLawyerRoleName(roleName: unknown): boolean {
  const n = typeof roleName === "string" ? roleName.trim().toLowerCase() : "";
  if (!n) return false;
  return n === "lawyer" || n === "paralegal" || n === "associate";
}

router.get("/payment-vouchers/create-options", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.payment_voucher"), requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const firmId = req.firmId!;
  const caseIdRaw = one((req.query as any).caseId);
  const caseId = caseIdRaw ? Number(caseIdRaw) : NaN;
  const caseIdValue = Number.isFinite(caseId) && caseId > 0 ? Number(caseId) : null;
  const r = rdb(req);

  const [responsibleLawyers, approvingPartners] = await Promise.all([
    r
      .select({
        id: usersTable.id,
        name: usersTable.name,
        roleId: usersTable.roleId,
        roleName: rolesTable.name,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
      .where(and(
        eq(usersTable.firmId, firmId),
        eq(usersTable.status, "active"),
      ))
      .orderBy(asc(usersTable.name)),
    r
      .select({
        id: usersTable.id,
        name: usersTable.name,
        roleId: usersTable.roleId,
        roleName: rolesTable.name,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
      .where(and(
        eq(usersTable.firmId, firmId),
        eq(usersTable.status, "active"),
      ))
      .orderBy(asc(usersTable.name)),
  ]);

  const filteredLawyers = responsibleLawyers.filter((u) => isLawyerRoleName(u.roleName));
  const filteredPartners = approvingPartners.filter((u) => isPartnerRoleName(u.roleName));

  let quotations: Array<{ id: number; referenceNo: string | null; caseId: number | null; status: string | null; clientName: string | null }> = [];
  if (caseIdValue) {
    quotations = await r
      .select({
        id: quotationsTable.id,
        referenceNo: quotationsTable.referenceNo,
        caseId: quotationsTable.caseId,
        status: quotationsTable.status,
        clientName: quotationsTable.clientName,
      })
      .from(quotationsTable)
      .where(and(
        eq(quotationsTable.firmId, firmId),
        eq(quotationsTable.caseId, caseIdValue),
        isNull(quotationsTable.deletedAt),
      ))
      .orderBy(desc(quotationsTable.createdAt));
  }

  let responsibleLawyerId: number | null = null;
  if (caseIdValue) {
    const fromAssignments = await loadResponsibleLawyerFromCase(r, firmId, caseIdValue);
    if (fromAssignments) {
      responsibleLawyerId = fromAssignments;
    }
  }
  if (!responsibleLawyerId && filteredLawyers.length === 1) {
    responsibleLawyerId = Number(filteredLawyers[0].id);
  }

  const approvingPartnerId = filteredPartners.length > 0 ? Number(filteredPartners[0].id) : null;
  const quotationId = quotations.length === 1 ? Number(quotations[0].id) : null;

  res.setHeader("Cache-Control", "no-store");
  res.json({
    responsibleLawyers: filteredLawyers.map((u) => ({
      id: Number(u.id),
      name: String(u.name ?? ""),
      roleName: u.roleName ? String(u.roleName) : null,
    })),
    approvingPartners: filteredPartners.map((u) => ({
      id: Number(u.id),
      name: String(u.name ?? ""),
      roleName: u.roleName ? String(u.roleName) : null,
    })),
    quotations: quotations.map((q) => ({
      id: Number(q.id),
      referenceNo: q.referenceNo ? String(q.referenceNo) : null,
      caseId: q.caseId ? Number(q.caseId) : null,
      status: q.status ? String(q.status) : null,
      clientName: q.clientName ? String(q.clientName) : null,
    })),
    defaults: {
      responsibleLawyerId,
      approvingPartnerId,
      quotationId,
    },
  });
});

router.get("/payment-vouchers/my-approvals", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.payment_voucher"), async (req: AuthRequest, res: Response): Promise<void> => {
  const firmId = req.firmId!;
  const userId = req.userId!;
  const r = rdb(req);

  try {
    const rows = await r
      .select({
        id: paymentVouchersTable.id,
        voucherNo: paymentVouchersTable.voucherNo,
        caseId: paymentVouchersTable.caseId,
        caseReferenceNo: casesTable.referenceNo,
        clientName: clientsTable.name,
        payeeName: paymentVouchersTable.payeeName,
        purpose: paymentVouchersTable.purpose,
        amount: paymentVouchersTable.amount,
        approvalStatus: paymentVouchersTable.approvalStatus,
        status: paymentVouchersTable.status,
        createdAt: paymentVouchersTable.createdAt,
      })
      .from(paymentVouchersTable)
      .leftJoin(casesTable, and(eq(casesTable.id, paymentVouchersTable.caseId), eq(casesTable.firmId, firmId)))
      .leftJoin(casePurchasersTable, and(eq(casePurchasersTable.caseId, casesTable.id), eq(casePurchasersTable.orderNo, 1)))
      .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
      .where(and(
        eq(paymentVouchersTable.firmId, firmId),
        eq(paymentVouchersTable.approvingPartnerId, userId),
        eq(paymentVouchersTable.approvalStatus, "pending_approval"),
      ))
      .orderBy(desc(paymentVouchersTable.createdAt));

    res.setHeader("Cache-Control", "no-store");
    res.json(rows.map((r) => ({
      id: Number(r.id),
      referenceNo: r.voucherNo ? String(r.voucherNo) : null,
      caseRef: r.caseId && r.caseReferenceNo ? `#${r.caseId} ${String(r.caseReferenceNo)}` : (r.caseId ? `#${r.caseId}` : null),
      client: r.clientName ? String(r.clientName) : null,
      payee: r.payeeName ? String(r.payeeName) : null,
      purpose: r.purpose ? String(r.purpose) : null,
      amount: r.amount ? String(r.amount) : null,
      approvalStatus: r.approvalStatus ? String(r.approvalStatus) : null,
      status: r.status ? String(r.status) : null,
      createdAt: r.createdAt,
    })));
  } catch (err) {
    if (isMissingSchemaError(err)) {
      res.status(500).json({ error: "Database migration missing. Apply required migration for payment voucher approvals fields.", code: "MIGRATION_MISSING" });
      return;
    }
    throw err;
  }
});

// List
router.get("/payment-vouchers", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.payment_voucher"), requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const caseId = one((req.query as any).caseId);
  const status = one((req.query as any).status);
  const pageRaw = one((req.query as any).page);
  const limitRaw = one((req.query as any).limit);
  const page = pageRaw ? parseInt(pageRaw, 10) : 1;
  const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(50, limit) : 50;
  const offset = (safePage - 1) * safeLimit;
  const firmId = req.firmId!;
  const conds = [eq(paymentVouchersTable.firmId, firmId)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(paymentVouchersTable.caseId, n));
  }
  if (status) conds.push(eq(paymentVouchersTable.status, status));
  const r = rdb(req);
  try {
    const withScopedTimeouts = async <T,>(fn: (conn: any) => Promise<T>): Promise<T> => {
      if (req.rlsDb) {
        await (r as any).execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await (r as any).execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return await fn(r as any);
      }
      return await (r as any).transaction(async (tx: any) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return await fn(tx);
      });
    };

    const queryStartedAt = Date.now();
    const rows = await withScopedTimeouts(async (tx) => {
      return await tx
        .select({
          id: paymentVouchersTable.id,
          firmId: paymentVouchersTable.firmId,
          caseId: paymentVouchersTable.caseId,
          voucherType: paymentVouchersTable.voucherType,
          targetCaseId: paymentVouchersTable.targetCaseId,
          targetAccountId: paymentVouchersTable.targetAccountId,
          approvalStatus: paymentVouchersTable.approvalStatus,
          isAdvance: paymentVouchersTable.isAdvance,
          approvedBy: paymentVouchersTable.approvedBy,
          voucherNo: paymentVouchersTable.voucherNo,
          status: paymentVouchersTable.status,
          fundStatus: paymentVouchersTable.fundStatus,
          payeeName: paymentVouchersTable.payeeName,
          paymentMethod: paymentVouchersTable.paymentMethod,
          bankAccountId: paymentVouchersTable.bankAccountId,
          accountType: paymentVouchersTable.accountType,
          bankChequeRefNo: paymentVouchersTable.bankChequeRefNo,
          amount: paymentVouchersTable.amount,
          purpose: paymentVouchersTable.purpose,
          receivedAt: paymentVouchersTable.receivedAt,
          paymentDueAt: paymentVouchersTable.paymentDueAt,
          assignedAccountUserId: paymentVouchersTable.assignedAccountUserId,
          assignedClerkUserId: paymentVouchersTable.assignedClerkUserId,
          paidAt: paymentVouchersTable.paidAt,
          paidBy: paymentVouchersTable.paidBy,
          updatedAt: paymentVouchersTable.updatedAt,
          createdAt: paymentVouchersTable.createdAt,
          caseReferenceNo: casesTable.referenceNo,
          clientName: clientsTable.name,
          projectId: casesTable.projectId,
          propertyDetails: casesTable.propertyDetails,
          projectName: (projectsTable as any).name,
          projectOrProperty: (casesTable as any).propertyDetails,
        })
        .from(paymentVouchersTable)
        .leftJoin(casesTable, and(eq(casesTable.id, paymentVouchersTable.caseId), eq(casesTable.firmId, firmId)))
        .leftJoin(projectsTable, and(eq(projectsTable.id, casesTable.projectId), eq((projectsTable as any).firmId, firmId)))
        .leftJoin(casePurchasersTable, and(eq(casePurchasersTable.caseId, casesTable.id), eq(casePurchasersTable.orderNo, 1)))
        .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
        .where(and(...conds))
        .orderBy(desc(paymentVouchersTable.createdAt))
        .limit(safeLimit)
        .offset(offset);
    });
    const enriched = rows.map((row) => {
      const projectOrProperty = (() => {
        if (row.projectName) return String(row.projectName);
        if (row.projectId) return `Project #${row.projectId}`;
        try {
          const pd = row.propertyDetails;
          if (pd && typeof pd === "object") {
            const anyPd = pd as any;
            if (anyPd.parcelNo) return String(anyPd.parcelNo);
            if (anyPd.address) return String(anyPd.address).slice(0, 120);
            if (anyPd.description) return String(anyPd.description).slice(0, 120);
          }
        } catch {}
        return row.caseId ? `Case #${row.caseId}` : null;
      })();
      return {
        ...row,
        referenceNo: row.voucherNo ? String(row.voucherNo) : null,
        fileReference: row.caseReferenceNo ? String(row.caseReferenceNo) : (row.caseId ? `#${row.caseId}` : null),
        clientName: row.clientName ? String(row.clientName) : null,
        payee: row.payeeName ? String(row.payeeName) : null,
        approval: row.approvalStatus ? String(row.approvalStatus) : null,
        projectOrProperty,
        currency: "MYR",
      };
    });
    const queryMs = Date.now() - queryStartedAt;
    const durationMs = Date.now() - startedAt;
    const serializeStartedAt = Date.now();
    const payload = JSON.stringify(enriched);
    const serializeMs = Date.now() - serializeStartedAt;
    const timing = {
      authMs: req.timing?.sections?.authSessionMs ?? null,
      permissionMs: req.timing?.sections?.permissionMs ?? null,
      tenantContextDbAcquireMs: req.timing?.sections?.tenantContextDbConnectMs ?? null,
      tenantContextMs: req.timing?.sections?.tenantContextMs ?? null,
      queryMs,
      serializeMs,
      totalMs: durationMs,
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("x-lawcaspro-timing", JSON.stringify(timing));
    res.type("application/json").send(payload);
    if (durationMs >= 2000) {
      logger.warn({ durationMs, firmId: req.firmId, userId: req.userId, safePage, safeLimit }, "payment_voucher.list_slow");
    }
  } catch (err) {
    const code = err && typeof err === "object" && "code" in (err as any) ? String((err as any).code) : null;
    if (code === "57014") {
      res.status(503).json({ error: "Payment voucher list timed out", code: "QUERY_TIMEOUT" });
      return;
    }
    if (code === "55P03") {
      res.status(503).json({ error: "Payment voucher list temporarily unavailable", code: "LOCK_TIMEOUT" });
      return;
    }
    if (isMissingSchemaError(err)) {
      res.status(500).json({ error: "Database migration missing for Payment Voucher SLA fields. Apply migration 0122_accounting_settings_and_payment_voucher_sla.sql", code: "MIGRATION_MISSING" });
      return;
    }
    throw err;
  }
});

// Detail
router.get("/payment-vouchers/:id(\\d+)", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.payment_voucher"), requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const r = rdb(req);
  const [pv] = await r.select().from(paymentVouchersTable).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Payment voucher not found" }); return; }
  const items = await r.select().from(paymentVoucherItemsTable).where(eq(paymentVoucherItemsTable.voucherId, id)).orderBy(paymentVoucherItemsTable.sortOrder);
  const actorIds = [
    pv.createdBy ? Number(pv.createdBy) : null,
    pv.preparedBy ? Number(pv.preparedBy) : null,
    pv.lawyerApprovedBy ? Number(pv.lawyerApprovedBy) : null,
    pv.partnerApprovedBy ? Number(pv.partnerApprovedBy) : null,
    pv.paidBy ? Number(pv.paidBy) : null,
  ].filter((x): x is number => Number.isFinite(x) && x > 0);
  const actorRows = actorIds.length > 0
    ? await r.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(and(eq(usersTable.firmId, req.firmId!), inArray(usersTable.id, actorIds)))
    : [];
  const nameById = new Map<number, string>();
  for (const u of actorRows) nameById.set(Number(u.id), String(u.name ?? ""));
  const createdByName = pv.createdBy ? (nameById.get(Number(pv.createdBy)) ?? null) : null;
  const preparedByName = pv.preparedBy ? (nameById.get(Number(pv.preparedBy)) ?? null) : null;
  const lawyerApprovedByName = pv.lawyerApprovedBy ? (nameById.get(Number(pv.lawyerApprovedBy)) ?? null) : null;
  const partnerApprovedByName = pv.partnerApprovedBy ? (nameById.get(Number(pv.partnerApprovedBy)) ?? null) : null;
  const paidByName = pv.paidBy ? (nameById.get(Number(pv.paidBy)) ?? null) : null;
  const caseId = pv.caseId ? Number(pv.caseId) : NaN;
  const caseInfo = Number.isFinite(caseId) && caseId > 0
    ? await r
      .select({
        referenceNo: casesTable.referenceNo,
        clientName: clientsTable.name,
        orderNo: casePurchasersTable.orderNo,
      })
      .from(casesTable)
      .leftJoin(casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
      .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
      .where(and(eq(casesTable.firmId, req.firmId!), eq(casesTable.id, caseId)))
      .orderBy(asc(casePurchasersTable.orderNo))
    : [];
  const caseReferenceNo = caseInfo?.[0]?.referenceNo ? String(caseInfo[0].referenceNo) : null;
  const clientNames = Array.from(new Set(caseInfo.map((x) => String(x.clientName ?? "").trim()).filter(Boolean))).join(", ");

  const targetCaseIdNum = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
  const targetCaseInfo = Number.isFinite(targetCaseIdNum) && targetCaseIdNum > 0
    ? await r
      .select({
        referenceNo: casesTable.referenceNo,
        clientName: clientsTable.name,
        orderNo: casePurchasersTable.orderNo,
      })
      .from(casesTable)
      .leftJoin(casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
      .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
      .where(and(eq(casesTable.firmId, req.firmId!), eq(casesTable.id, targetCaseIdNum)))
      .orderBy(asc(casePurchasersTable.orderNo))
    : [];
  const targetCaseReferenceNo = targetCaseInfo?.[0]?.referenceNo ? String(targetCaseInfo[0].referenceNo) : null;
  const targetClientNames = Array.from(new Set(targetCaseInfo.map((x) => String(x.clientName ?? "").trim()).filter(Boolean))).join(", ");

  res.json({
    ...pv,
    items,
    caseReferenceNo,
    clientNames: clientNames || null,
    targetCaseReferenceNo,
    targetClientNames: targetClientNames || null,
    createdByName,
    preparedByName,
    lawyerApprovedByName,
    partnerApprovedByName,
    paidByName,
  });
});

router.get("/payment-vouchers/:id", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.payment_voucher"), requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  res.status(400).json({ error: "Invalid voucher ID" });
});

// Create
router.post("/payment-vouchers", sensitiveRateLimiter, requireAuth, requireFirmUserFinancialSession, requireUserFeatureAccess("accounting.payment_voucher"), async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
  (req as { pvCreateStartedAt?: number }).pvCreateStartedAt = startedAt;
  emitPvCreateTiming(req, "request_received");
  const stopParse = createSectionTimer(req, "pv.create.parse");
  const parsed = CreatePaymentVoucherBody.safeParse(req.body);
  stopParse();
  if (!parsed.success) {
    emitPvCreateTiming(req, "failed", { code: "INVALID_PAYLOAD" });
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  emitPvCreateTiming(req, "payload_validated");
  const r = rdb(req);
  const now = new Date();
  const normalizedClientRequestId =
    typeof parsed.data.clientRequestId === "string" && parsed.data.clientRequestId.trim()
      ? parsed.data.clientRequestId.trim()
      : null;
  (req as { pvClientRequestId?: string }).pvClientRequestId = normalizedClientRequestId ?? undefined;
  const requestPayloadHash = normalizedClientRequestId
    ? hashCreatePayload({
      ...parsed.data,
      clientRequestId: undefined,
    })
    : null;

  const {
    caseId,
    voucherType,
    targetCaseId,
    targetAccountId,
    isAdvance,
    payeeName,
    payeeBank,
    payeeAccountNo,
    beneficiaryBank,
    beneficiaryAccountNo,
    paymentMethod,
    bankAccountId,
    accountType,
    amount,
    purpose,
    notes,
    items,
    lineItems,
    fundStatus,
    responsibleLawyerId: rawResponsibleLawyerId,
    approvingPartnerId: rawApprovingPartnerId,
    quotationId: rawQuotationId,
    acknowledgedUnclaimedItems,
  } = parsed.data;

  emitPvCreateTiming(req, "auth_resolved");

  const normalizedLineItems =
    Array.isArray(lineItems) && lineItems.length > 0
      ? lineItems.map((x) => ({ purpose: String(x.purpose ?? "").trim(), amount: Number(x.amount) })).filter((x) => x.purpose && Number.isFinite(x.amount) && x.amount > 0)
      : null;

  const effectiveItems = (Array.isArray(items) && items.length > 0)
    ? items
    : (normalizedLineItems && normalizedLineItems.length > 0)
      ? normalizedLineItems.map((i) => ({ description: i.purpose, itemType: "disbursement" as const, amount: i.amount }))
      : [{ description: purpose, itemType: "disbursement" as const, amount }];

  const effectiveAmount = effectiveItems.reduce((sum, i) => sum + Number(i.amount), 0);
  try {
    await setSessionStatementTimeout(req, PV_CREATE_SMALL_QUERY_TIMEOUT_MS, "pre_tracking_checks");
  } catch (err) {
    if (err instanceof PvTimeoutSetupFailed) {
      emitPvCreateTiming(req, "failed", { code: "TIMEOUT_SETUP_FAILED", stage: "pre_tracking_checks" });
      res.status(503).json({ error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: err.sqlState, stage: "pre_tracking_checks", timeoutMs: err.timeoutMs, retryAfterMs: 1000 });
      return;
    }
    throw err;
  }
  const storedPurpose =
    normalizedLineItems && normalizedLineItems.length > 1
      ? `${normalizedLineItems[0].purpose} (+${normalizedLineItems.length - 1} more)`
      : purpose;

  const stopPermissions = createSectionTimer(req, "pv.create.permissions");
  try {
    await setSessionStatementTimeout(req, PV_CREATE_SMALL_QUERY_TIMEOUT_MS, "permissions_checks");
  } catch (err) {
    if (err instanceof PvTimeoutSetupFailed) {
      emitPvCreateTiming(req, "failed", { code: "TIMEOUT_SETUP_FAILED", stage: "permissions_checks" });
      res.status(503).json({ error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: err.sqlState, stage: "permissions_checks", timeoutMs: err.timeoutMs, retryAfterMs: 1000 });
      return;
    }
    throw err;
  }
  const roleName = await getRoleName(req);
  const roleKind = classifyCaseWorkflowRole(roleName);
  const canCreateAccountingRequest = await roleHasPermission(req, "accounting", "create");
  const canCreateCaseScopedRequest = await roleHasPermission(req, "cases", "update");
  if ((voucherType === "account_transfer" || voucherType === "internal_transfer" || voucherType === "file_to_file_transfer") && !canCreateAccountingRequest) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  if (voucherType === "external_payment" || voucherType === "file_transfer") {
    if (!caseId) {
      if (!canCreateAccountingRequest) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }
    } else if (!canCreateAccountingRequest && !canCreateCaseScopedRequest) {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
      return;
    }
  } else if (!canCreateAccountingRequest) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  if (voucherType === "internal_transfer") {
    if (!caseId) {
      res.status(400).json({ error: "caseId is required" }); return;
    }
  }
  if (voucherType === "file_transfer" || voucherType === "file_to_file_transfer") {
    if (!caseId || !targetCaseId) {
      res.status(400).json({ error: "caseId and targetCaseId are required" }); return;
    }
    if (caseId === targetCaseId) {
      res.status(400).json({ error: "targetCaseId must be different from caseId" }); return;
    }
  }
  if (voucherType === "account_transfer") {
    if (!bankAccountId || !targetAccountId) {
      res.status(400).json({ error: "bankAccountId and targetAccountId are required" }); return;
    }
    if (bankAccountId === targetAccountId) {
      res.status(400).json({ error: "targetAccountId must be different from bankAccountId" }); return;
    }
  }
  stopPermissions();
  emitPvCreateTiming(req, "permission_checked");
  {
    const budget = checkPvCreateBudget(req, "permission_checked");
    if (budget.exceeded) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "REQUEST_BUDGET_EXCEEDED:permission_checked", "permission_checked");
      emitPvCreateTiming(req, "failed", { code: "REQUEST_BUDGET_EXCEEDED", elapsedMs: budget.elapsedMs });
      res.status(503).json({ error: "Service unavailable - request timeout budget exceeded", code: "REQUEST_BUDGET_EXCEEDED" });
      return;
    }
  }

  let idempotencyConflictResponse: { httpStatus: number; body: any } | null = null;
  if (normalizedClientRequestId) {
    const stopIdempotency = createSectionTimer(req, "pv.create.early_idempotency");
    emitPvCreateTiming(req, "idempotency_tracking_started");
    let thisRequestJustReservedTheRow = false;
    try {
      const reserved = await withTenantScopedTx(
        req,
        { timeoutMs: PV_CREATE_SMALL_QUERY_TIMEOUT_MS + 400, lockTimeoutMs: PV_CREATE_PRELOCK_TIMEOUT_MS, stage: "idempotency_reservation" },
        async (txR) => {
          const inserted = await txR
            .insert(paymentVoucherCreateRequestsTable)
            .values({
              firmId: req.firmId!,
              createdByUserId: req.userId!,
              clientRequestId: normalizedClientRequestId,
              requestPayloadHash,
              status: "processing",
            })
            .onConflictDoNothing()
            .returning({ id: paymentVoucherCreateRequestsTable.id });
          const justReserved = inserted.length === 1;
          if (!justReserved) {
            const preExisting = await txR
              .select()
              .from(paymentVoucherCreateRequestsTable)
              .where(and(
                eq(paymentVoucherCreateRequestsTable.firmId, req.firmId!),
                eq(paymentVoucherCreateRequestsTable.createdByUserId, req.userId!),
                eq(paymentVoucherCreateRequestsTable.clientRequestId, normalizedClientRequestId),
              ))
              .limit(1);
            const existingRequest = preExisting[0];
            if (!existingRequest) {
              const byAnyUser = await txR
                .select()
                .from(paymentVoucherCreateRequestsTable)
                .where(and(
                  eq(paymentVoucherCreateRequestsTable.firmId, req.firmId!),
                  eq(paymentVoucherCreateRequestsTable.clientRequestId, normalizedClientRequestId),
                ))
                .limit(1);
              const crossUserRequest = byAnyUser[0];
              if (!crossUserRequest) {
                const existingVoucher = await loadVoucherByClientRequest(txR as any, req.firmId!, normalizedClientRequestId);
                if (existingVoucher) {
                  idempotencyConflictResponse = { httpStatus: 200, body: existingVoucher };
                }
              } else if (crossUserRequest.requestPayloadHash && requestPayloadHash && crossUserRequest.requestPayloadHash !== requestPayloadHash) {
                idempotencyConflictResponse = { httpStatus: 409, body: { error: "clientRequestId already used for a different request", code: "CLIENT_REQUEST_ID_REUSED" } };
              } else if (crossUserRequest.status === "completed") {
                const existingVoucher =
                  crossUserRequest.paymentVoucherId
                    ? (await txR
                      .select()
                      .from(paymentVouchersTable)
                      .where(and(
                        eq(paymentVouchersTable.firmId, req.firmId!),
                        eq(paymentVouchersTable.id, Number(crossUserRequest.paymentVoucherId)),
                      ))
                      .limit(1))[0] ?? null
                    : await loadVoucherByClientRequest(txR as any, req.firmId!, normalizedClientRequestId);
                if (existingVoucher) {
                  idempotencyConflictResponse = { httpStatus: 200, body: existingVoucher };
                } else {
                  idempotencyConflictResponse = { httpStatus: 202, body: { status: "processing", clientRequestId: normalizedClientRequestId } };
                }
              } else {
                idempotencyConflictResponse = { httpStatus: 202, body: { status: "processing", clientRequestId: normalizedClientRequestId } };
              }
            } else if (existingRequest.requestPayloadHash && requestPayloadHash && existingRequest.requestPayloadHash !== requestPayloadHash) {
              idempotencyConflictResponse = { httpStatus: 409, body: { error: "clientRequestId already used for a different request", code: "CLIENT_REQUEST_ID_REUSED" } };
            } else if (existingRequest.status === "failed") {
              const existingVoucher = await loadVoucherByClientRequest(txR as any, req.firmId!, normalizedClientRequestId);
              if (existingVoucher) {
                idempotencyConflictResponse = { httpStatus: 200, body: existingVoucher };
              } else {
                const reclaimed = await txR
                  .update(paymentVoucherCreateRequestsTable)
                  .set({
                    status: "processing",
                    lastError: null,
                    completedAt: null,
                    updatedAt: now,
                    requestPayloadHash,
                  })
                  .where(and(
                    eq(paymentVoucherCreateRequestsTable.firmId, req.firmId!),
                    eq(paymentVoucherCreateRequestsTable.createdByUserId, req.userId!),
                    eq(paymentVoucherCreateRequestsTable.clientRequestId, normalizedClientRequestId),
                    eq(paymentVoucherCreateRequestsTable.status, "failed"),
                  ))
                  .returning({ id: paymentVoucherCreateRequestsTable.id });
                if (!reclaimed[0]) {
                  idempotencyConflictResponse = { httpStatus: 202, body: { status: "processing", clientRequestId: normalizedClientRequestId } };
                }
              }
            } else {
              const requestOwnerId = Number(existingRequest.createdByUserId ?? req.userId!);
              if (existingRequest.status === "completed") {
                const existingVoucher =
                  existingRequest.paymentVoucherId
                    ? (await txR
                      .select()
                      .from(paymentVouchersTable)
                      .where(and(
                        eq(paymentVouchersTable.firmId, req.firmId!),
                        eq(paymentVouchersTable.id, Number(existingRequest.paymentVoucherId)),
                      ))
                      .limit(1))[0] ?? null
                    : await loadVoucherByClientRequest(txR as any, req.firmId!, normalizedClientRequestId);
                if (existingVoucher) {
                  idempotencyConflictResponse = { httpStatus: 200, body: existingVoucher };
                }
              }
              if (!idempotencyConflictResponse) {
                const fallbackVoucher = await loadVoucherByClientRequest(txR as any, req.firmId!, normalizedClientRequestId);
                if (fallbackVoucher) {
                  idempotencyConflictResponse = { httpStatus: 200, body: fallbackVoucher };
                } else {
                  const stale = isPaymentVoucherCreateRequestStale(existingRequest.updatedAt, now);
                  if (stale) {
                    const activeLockHeld = await isCreateRequestActivelyLocked(txR as any, req.firmId!, requestOwnerId, normalizedClientRequestId);
                    if (!activeLockHeld) {
                      const reclaimed = await txR
                        .update(paymentVoucherCreateRequestsTable)
                        .set({ updatedAt: now, lastError: null })
                        .where(and(
                          eq(paymentVoucherCreateRequestsTable.firmId, req.firmId!),
                          eq(paymentVoucherCreateRequestsTable.createdByUserId, requestOwnerId),
                          eq(paymentVoucherCreateRequestsTable.clientRequestId, normalizedClientRequestId),
                          eq(paymentVoucherCreateRequestsTable.status, "processing"),
                          eq(paymentVoucherCreateRequestsTable.updatedAt, existingRequest.updatedAt as any),
                        ))
                        .returning({ id: paymentVoucherCreateRequestsTable.id });
                      if (!reclaimed[0]) {
                        idempotencyConflictResponse = { httpStatus: 202, body: { status: "processing", clientRequestId: normalizedClientRequestId } };
                      }
                    } else {
                      idempotencyConflictResponse = { httpStatus: 202, body: { status: "processing", clientRequestId: normalizedClientRequestId } };
                    }
                  } else {
                    idempotencyConflictResponse = { httpStatus: 202, body: { status: "processing", clientRequestId: normalizedClientRequestId } };
                  }
                }
              }
            }
          }
          return justReserved;
        },
      );
      if (!reserved.ok) {
        const bad = reserved as Extract<typeof reserved, { ok: false }>;
        const code = String((bad.error as any)?.code ?? "");
        if (code === "55P03" || code === "57014") {
          const fallbackVoucher = await loadVoucherByClientRequest(r as any, req.firmId!, normalizedClientRequestId);
          if (fallbackVoucher) {
            idempotencyConflictResponse = { httpStatus: 200, body: fallbackVoucher };
          } else {
            idempotencyConflictResponse = { httpStatus: 202, body: { status: "processing", clientRequestId: normalizedClientRequestId } };
          }
        } else if (!isMissingSchemaError(bad.error)) {
          await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, `EARLY_IDEMPOTENCY:${String((bad.error as any)?.message ?? bad.error ?? "").slice(0, 300)}`);
          emitPvCreateTiming(req, "failed", { code, message: String((bad.error as any)?.message ?? "").slice(0, 120) });
          stopIdempotency();
          throw bad.error;
        } else {
          stopIdempotency();
          res.status(500).json({ error: "Database migration missing for idempotency. Apply migration 0126_payment_voucher_create_request_tracking.sql", code: "MIGRATION_MISSING" });
          return;
        }
      } else {
        thisRequestJustReservedTheRow = reserved.value;
      }
      emitPvCreateTiming(req, "idempotency_tracking_inserted", { reserved: thisRequestJustReservedTheRow });
      {
        const budget = checkPvCreateBudget(req, "idempotency_tracking_inserted");
        if (budget.exceeded) {
          await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "REQUEST_BUDGET_EXCEEDED:idempotency", "idempotency");
          emitPvCreateTiming(req, "failed", { code: "REQUEST_BUDGET_EXCEEDED", elapsedMs: budget.elapsedMs });
          stopIdempotency();
          res.status(503).json({ error: "Service unavailable - request timeout budget exceeded", code: "REQUEST_BUDGET_EXCEEDED" });
          return;
        }
      }
    } finally {
      stopIdempotency();
    }
    if (idempotencyConflictResponse) {
      res.status(idempotencyConflictResponse.httpStatus).json(idempotencyConflictResponse.body);
      return;
    }
  }

  const initialStatus =
    (() => {
      const isSimplified = !paymentMethod && !accountType && !bankAccountId;
      if (isSimplified) return "pending_account";
      if (canCreateAccountingRequest) return "pending_account";
      return roleKind === "partner"
        ? "pending_account"
        : roleKind === "lawyer"
          ? "pending_partner"
          : "pending_lawyer";
    })();

  const effectiveIsAdvance = Boolean(isAdvance);
  const effectiveFundStatus = effectiveIsAdvance ? "request_advance" : (fundStatus ?? "client_paid");
  const stopSettings = createSectionTimer(req, "pv.create.settings");
  let settings: AccountingSettingsRecord;
  try {
    try {
      await setSessionStatementTimeout(req, PV_CREATE_SMALL_QUERY_TIMEOUT_MS, "accounting_settings_load");
    } catch (err) {
      if (err instanceof PvTimeoutSetupFailed) {
        emitPvCreateTiming(req, "failed", { code: "TIMEOUT_SETUP_FAILED", stage: "accounting_settings_load" });
        res.status(503).json({ error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: err.sqlState, stage: "accounting_settings_load", timeoutMs: err.timeoutMs, retryAfterMs: 1000 });
        return;
      }
      throw err;
    }
    const loaded = await safeLoadAccountingSettings({
      firmId: req.firmId!,
      db: rdb(req) as any,
      accountingSettingsTable,
      sql,
      eq,
    });
    settings = loaded.rowExisted ? loaded.settings : getDefaultAccountingSettings(req.firmId!);
  } catch (err) {
    if (err instanceof AccountingSettingsLoaderError && (
      err.code === "QUERY_TIMEOUT" || err.code === "LOCK_TIMEOUT"
    )) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, `ACCOUNTING_SETTINGS:${err.code}`);
      emitPvCreateTiming(req, "failed", { code: err.code, message: String(err.message ?? "").slice(0, 120) });
      stopSettings();
      writeAccountingSettingsErrorResponse(res, err);
      return;
    }
    settings = getDefaultAccountingSettings(req.firmId!);
  }
  const approvalDecision = resolveApprovalRequirement(effectiveAmount, voucherType, settings);
  const approvalStatus = resolvePaymentVoucherApprovalStatus({
    voucherType,
    isAdvance: effectiveIsAdvance,
    fundStatus: effectiveFundStatus,
    requiresPartnerApproval: Boolean(approvalDecision.requiresPartnerApproval),
  });
  stopSettings();
  emitPvCreateTiming(req, "accounting_settings_loaded");
  {
    const budget = checkPvCreateBudget(req, "accounting_settings_loaded");
    if (budget.exceeded) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "REQUEST_BUDGET_EXCEEDED:accounting_settings", "accounting_settings");
      emitPvCreateTiming(req, "failed", { code: "REQUEST_BUDGET_EXCEEDED", elapsedMs: budget.elapsedMs });
      res.status(503).json({ error: "Service unavailable - request timeout budget exceeded", code: "REQUEST_BUDGET_EXCEEDED" });
      return;
    }
  }

  const stopCaseCheck = createSectionTimer(req, "pv.create.case_check");
  try {
    await setSessionStatementTimeout(req, PV_CREATE_SMALL_QUERY_TIMEOUT_MS, "case_and_bank_validity");
  } catch (err) {
    if (err instanceof PvTimeoutSetupFailed) {
      emitPvCreateTiming(req, "failed", { code: "TIMEOUT_SETUP_FAILED", stage: "case_and_bank_validity" });
      res.status(503).json({ error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: err.sqlState, stage: "case_and_bank_validity", timeoutMs: err.timeoutMs, retryAfterMs: 1000 });
      return;
    }
    throw err;
  }
  const caseIdValue = typeof caseId === "number" && Number.isFinite(caseId) ? Number(caseId) : null;
  const targetCaseIdValue = typeof targetCaseId === "number" && Number.isFinite(targetCaseId) ? Number(targetCaseId) : null;
  if (caseIdValue) {
    const rows = await r
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(and(
        eq(casesTable.firmId, req.firmId!),
        eq(casesTable.id, caseIdValue),
        isNull(casesTable.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "CASE_NOT_FOUND");
      emitPvCreateTiming(req, "failed", { code: "CASE_NOT_FOUND" });
      res.status(404).json({ error: "Case not found" });
      return;
    }
  }
  if (targetCaseIdValue) {
    const rows = await r
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(and(
        eq(casesTable.firmId, req.firmId!),
        eq(casesTable.id, targetCaseIdValue),
        isNull(casesTable.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "TARGET_CASE_NOT_FOUND");
      emitPvCreateTiming(req, "failed", { code: "TARGET_CASE_NOT_FOUND" });
      res.status(404).json({ error: "Target case not found" });
      return;
    }
  }

  let responsibleLawyerId: number | null =
    typeof rawResponsibleLawyerId === "number" && Number.isFinite(rawResponsibleLawyerId) && rawResponsibleLawyerId > 0
      ? Number(rawResponsibleLawyerId)
      : null;
  let approvingPartnerId: number | null =
    typeof rawApprovingPartnerId === "number" && Number.isFinite(rawApprovingPartnerId) && rawApprovingPartnerId > 0
      ? Number(rawApprovingPartnerId)
      : null;
  let quotationId: number | null =
    typeof rawQuotationId === "number" && Number.isFinite(rawQuotationId) && rawQuotationId > 0
      ? Number(rawQuotationId)
      : null;
  let quotationClaimWarning: string | null = null;

  if (!responsibleLawyerId && caseIdValue) {
    const autoLawyerId = await loadResponsibleLawyerFromCase(r, req.firmId!, caseIdValue);
    if (autoLawyerId) responsibleLawyerId = autoLawyerId;
  }
  if (responsibleLawyerId) {
    const [u] = await r
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, req.firmId!), eq(usersTable.id, responsibleLawyerId), eq(usersTable.status, "active")))
      .limit(1);
    if (!u) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "INVALID_RESPONSIBLE_LAWYER");
      emitPvCreateTiming(req, "failed", { code: "INVALID_RESPONSIBLE_LAWYER" });
      res.status(400).json({ error: "Responsible lawyer is invalid", code: "INVALID_RESPONSIBLE_LAWYER" });
      return;
    }
  }
  if (approvingPartnerId) {
    const [u] = await r
      .select({ id: usersTable.id, roleId: usersTable.roleId })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, req.firmId!), eq(usersTable.id, approvingPartnerId), eq(usersTable.status, "active")))
      .limit(1);
    if (!u) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "INVALID_APPROVING_PARTNER");
      emitPvCreateTiming(req, "failed", { code: "INVALID_APPROVING_PARTNER" });
      res.status(400).json({ error: "Approving partner is invalid", code: "INVALID_APPROVING_PARTNER" });
      return;
    }
    if (u.roleId) {
      const isPartner = await resolveIsPartnerBySettingsOrName(settings, Number(u.roleId), "");
      if (!isPartner) {
        await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "INVALID_APPROVING_PARTNER_ROLE");
        emitPvCreateTiming(req, "failed", { code: "INVALID_APPROVING_PARTNER_ROLE" });
        res.status(400).json({ error: "Approving partner must have Partner role", code: "INVALID_APPROVING_PARTNER_ROLE" });
        return;
      }
    }
  }
  if (quotationId) {
    const qCheck = await validateQuotationAndBuildWarning(r, req.firmId!, caseIdValue, quotationId);
    if (!qCheck.valid) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, `INVALID_QUOTATION:${qCheck.error ?? ""}`);
      emitPvCreateTiming(req, "failed", { code: "INVALID_QUOTATION" });
      res.status(400).json({ error: qCheck.error ?? "Invalid quotation", code: "INVALID_QUOTATION" });
      return;
    }
    if (qCheck.warning) quotationClaimWarning = qCheck.warning;
  }
  stopCaseCheck();
  emitPvCreateTiming(req, "case_and_reference_loaded");
  {
    const budget = checkPvCreateBudget(req, "case_and_reference_loaded");
    if (budget.exceeded) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "REQUEST_BUDGET_EXCEEDED:case_and_reference", "case_and_reference");
      emitPvCreateTiming(req, "failed", { code: "REQUEST_BUDGET_EXCEEDED", elapsedMs: budget.elapsedMs });
      res.status(503).json({ error: "Service unavailable - request timeout budget exceeded", code: "REQUEST_BUDGET_EXCEEDED" });
      return;
    }
  }
  emitPvCreateTiming(req, "preflight_validation_passed");
  {
    const budget = checkPvCreateBudget(req, "preflight_validation_passed");
    if (budget.exceeded) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "REQUEST_BUDGET_EXCEEDED:preflight", "preflight");
      emitPvCreateTiming(req, "failed", { code: "REQUEST_BUDGET_EXCEEDED", elapsedMs: budget.elapsedMs });
      res.status(503).json({ error: "Service unavailable - request timeout budget exceeded", code: "REQUEST_BUDGET_EXCEEDED" });
      return;
    }
  }

  const voucherNo = generateVoucherNo(now);
  if (voucherType === "account_transfer") {
    try {
      await setSessionStatementTimeout(req, PV_CREATE_SMALL_QUERY_TIMEOUT_MS, "bank_account_existence");
    } catch (err) {
      if (err instanceof PvTimeoutSetupFailed) {
        emitPvCreateTiming(req, "failed", { code: "TIMEOUT_SETUP_FAILED", stage: "bank_account_existence" });
        res.status(503).json({ error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: err.sqlState, stage: "bank_account_existence", timeoutMs: err.timeoutMs, retryAfterMs: 1000 });
        return;
      }
      throw err;
    }
    const rows = await r
      .select({ id: firmBankAccountsTable.id })
      .from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, bankAccountId!)))
      .limit(1);
    if (!rows[0]) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "SOURCE_BANK_NOT_FOUND");
      emitPvCreateTiming(req, "failed", { code: "SOURCE_BANK_NOT_FOUND" });
      res.status(404).json({ error: "Source bank account not found" });
      return;
    }
    const rows2 = await r
      .select({ id: firmBankAccountsTable.id })
      .from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, targetAccountId!)))
      .limit(1);
    if (!rows2[0]) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "TARGET_BANK_NOT_FOUND");
      emitPvCreateTiming(req, "failed", { code: "TARGET_BANK_NOT_FOUND" });
      res.status(404).json({ error: "Target bank account not found" });
      return;
    }
  }

  const normalizedAccountType = accountType ? normalizeLedgerAccountType(accountType) : null;
  const effectivePayeeName = (voucherType === "internal_transfer" && typeof payeeName === "string" && !payeeName.trim())
    ? "Client Account → Office Account Transfer"
    : payeeName;

  if (normalizedAccountType === "client") {
    const stopBalance = createSectionTimer(req, "pv.create.balance_check");
    const cid = caseId ? Number(caseId) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "CASE_REQUIRED_FOR_CLIENT_ACCOUNT");
      emitPvCreateTiming(req, "failed", { code: "CASE_REQUIRED_FOR_CLIENT_ACCOUNT" });
      res.status(400).json({ error: "caseId is required when deducting from Client Account" });
      return;
    }
    try {
      await setSessionStatementTimeout(req, PV_CREATE_AGGREGATE_TIMEOUT_MS, "client_balance_aggregate");
    } catch (err) {
      if (err instanceof PvTimeoutSetupFailed) {
        emitPvCreateTiming(req, "failed", { code: "TIMEOUT_SETUP_FAILED", stage: "client_balance_aggregate" });
        res.status(503).json({ error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: err.sqlState, stage: "client_balance_aggregate", timeoutMs: err.timeoutMs, retryAfterMs: 1000 });
        return;
      }
      throw err;
    }
    const [row] = await r.select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` }).from(ledgerEntriesTable).where(and(
      eq(ledgerEntriesTable.firmId, req.firmId!),
      eq(ledgerEntriesTable.caseId, cid),
      sql`${ledgerEntriesTable.accountType} IN ('client','trust')`,
    )).limit(1);
    const bal = Number(row?.bal ?? 0);
    if (bal + 1e-9 < effectiveAmount) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "INSUFFICIENT_CLIENT_BALANCE");
      emitPvCreateTiming(req, "failed", { code: "INSUFFICIENT_CLIENT_BALANCE", balance: bal, required: effectiveAmount });
      res.status(400).json({ error: "Insufficient Client Account Balance", code: "INSUFFICIENT_CLIENT_BALANCE" });
      return;
    }
    stopBalance();
  }

  {
    const budget = checkPvCreateBudget(req, "transaction_started");
    if (budget.exceeded) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, "REQUEST_BUDGET_EXCEEDED:before_main_tx", "before_main_tx");
      emitPvCreateTiming(req, "failed", { code: "REQUEST_BUDGET_EXCEEDED", elapsedMs: budget.elapsedMs });
      res.status(503).json({ error: "Service unavailable - request timeout budget exceeded", code: "REQUEST_BUDGET_EXCEEDED" });
      return;
    }
  }

  let pv: typeof paymentVouchersTable.$inferSelect;
  const stopTx = createSectionTimer(req, "pv.create.tx");
  let lastDesiredSqlState: string | null = null;
  let abortHandle: ReturnType<typeof setTimeout> | null = null;
  const e2eStartAt = getPvE2eStartAt(req);
  const hardBudgetLeftMs = Math.max(500, PV_CREATE_REQUEST_BUDGET_MS - (Date.now() - e2eStartAt));
  const commitReserveMs = Math.min(PV_CREATE_COMMIT_MAX_MS, Math.max(1000, Math.floor(hardBudgetLeftMs * 0.15)));
  const budgetLeftBeforeMainTxMs = Math.max(1500, hardBudgetLeftMs - commitReserveMs - PV_CREATE_OVERHEAD_RESERVE_MS);
  const txStatementMs = Math.max(1500, Math.min(budgetLeftBeforeMainTxMs, PV_CREATE_TX_STATEMENT_TIMEOUT_MS));
  const txLockMs = Math.max(500, Math.min(budgetLeftBeforeMainTxMs - 1000, PV_CREATE_TX_LOCK_TIMEOUT_MS));
  const lastResortMs = PV_CREATE_REQUEST_BUDGET_MS - (Date.now() - e2eStartAt) + 500;
  let commitMs = 0;
  try {
    if (req.rlsClient) {
      const rlsClient = req.rlsClient;
      abortHandle = setTimeout(() => {
        try {
          logger.warn(
            {
              reqId: getReqIdForLog(req),
              clientRequestId: normalizedClientRequestId,
              firmId: req.firmId ?? null,
              userId: req.userId ?? null,
              lastResortMs,
            },
            "payment_voucher.create_last_resort_abort",
          );
          try { (rlsClient as any).query("ROLLBACK").catch(() => {}); } catch {}
          try { (rlsClient as any).release?.(true); } catch {}
        } catch {}
      }, Math.max(500, lastResortMs));
      abortHandle.unref?.();
    }
    const finTx = await withTenantScopedTx(
      req,
      { timeoutMs: txStatementMs, lockTimeoutMs: txLockMs, stage: "main_financial_tx" },
      async (txR, client) => {
        // Test-only fault hooks: NEVER activate outside NODE_ENV=test.
        // Read from request-scoped well-known internal symbol, NEVER HTTP.
        const hookSym: unique symbol = Symbol.for("lawcaspro.pv_p0_test_hooks") as any;
        let diag: any = undefined;
        if (process.env.NODE_ENV === "test") {
          diag = (req as any)[hookSym];
        }
        if (normalizedClientRequestId) {
          const locked = await tryAcquireCreateRequestTxnLock(txR as any, req.firmId!, req.userId!, normalizedClientRequestId);
          if (!locked) {
            throw Object.assign(new Error("Payment Voucher create request is already active"), { code: "CLIENT_REQUEST_IN_PROGRESS" });
          }
        }
        if (diag?.injectWorkErrorAfterReservation) {
          const info = diag.injectWorkErrorAfterReservation;
          const e: any = new Error(info.message ?? "INJECTED_WORK_FAILURE_AFTER_RESERVATION");
          if (info.code) e.code = info.code;
          if (info.sqlstate) { e.sqlstate = info.sqlstate; e.sqlState = info.sqlstate; }
          throw e;
        }

        const [createdVoucher] = await txR.insert(paymentVouchersTable).values({
          firmId: req.firmId!,
          caseId: caseId ?? null,
          voucherType,
          targetCaseId: targetCaseId ?? null,
          targetAccountId: targetAccountId ?? null,
          approvalStatus,
          isAdvance: effectiveIsAdvance,
          approvedBy: null,
          voucherNo,
          clientRequestId: normalizedClientRequestId,
          status: initialStatus,
          fundStatus: effectiveFundStatus,
          payeeName: effectivePayeeName,
          payeeBank: payeeBank ?? beneficiaryBank ?? null,
          payeeAccountNo: payeeAccountNo ?? beneficiaryAccountNo ?? null,
          beneficiaryBank: beneficiaryBank ?? payeeBank ?? null,
          beneficiaryAccountNo: beneficiaryAccountNo ?? payeeAccountNo ?? null,
          paymentMethod: paymentMethod ?? null,
          bankAccountId: bankAccountId ?? null,
          accountType: normalizedAccountType,
          amount: effectiveAmount.toFixed(2),
          purpose: storedPurpose,
          notes: notes ?? null,
          responsibleLawyerId,
          approvingPartnerId,
          quotationId,
          quotationClaimWarning,
          preparedBy: req.userId!,
          preparedAt: now,
          createdBy: req.userId!,
        }).returning();
        emitPvCreateTiming(req, "voucher_inserted", { voucherId: createdVoucher.id });

        await txR.insert(paymentVoucherItemsTable).values(effectiveItems.map((i, idx) => ({
          voucherId: createdVoucher.id,
          description: i.description,
          itemType: i.itemType,
          amount: i.amount.toFixed(2),
          sortOrder: idx,
        })));
        emitPvCreateTiming(req, "items_inserted", { itemCount: effectiveItems.length });

        await writePaymentVoucherCreateAuditEvents({
          writeAuditLog,
          db: txR as unknown,
          firmId: req.firmId,
          actorId: req.userId,
          actorType: req.userType,
          paymentVoucherId: createdVoucher.id,
          voucherNo: String(createdVoucher.voucherNo),
          initialStatus,
          approvalStatus,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
        emitPvCreateTiming(req, "audit_written");

        if (normalizedClientRequestId) {
          await ensureExactlyOneCreateRequestCompleted({
            performUpdate: async () => {
              const rows = await txR
                .update(paymentVoucherCreateRequestsTable)
                .set({
                  status: "completed",
                  paymentVoucherId: createdVoucher.id,
                  completedAt: now,
                  updatedAt: now,
                  lastError: null,
                })
                .where(and(
                  eq(paymentVoucherCreateRequestsTable.firmId, req.firmId!),
                  eq(paymentVoucherCreateRequestsTable.createdByUserId, req.userId!),
                  eq(paymentVoucherCreateRequestsTable.clientRequestId, normalizedClientRequestId),
                ))
                .returning({ id: paymentVoucherCreateRequestsTable.id });
              return rows.length;
            },
          });
          emitPvCreateTiming(req, "tracking_completed");
        }

        if (diag?.injectCommitError) {
          try { await client.query("ROLLBACK"); } catch {}
          throw Object.assign(new Error("INJECTED_COMMIT_FAILURE"), { code: "INJECTED_COMMIT_FAILURE" });
        }
        return createdVoucher;
      },
    );
    if (abortHandle) { try { clearTimeout(abortHandle); abortHandle = null; } catch {} }
    if (!finTx.ok) {
      const bad = finTx as Extract<typeof finTx, { ok: false }>;
      const errCode = String((bad.error as any)?.code ?? "");
      if (bad.code === "TX_TIMEOUT_SETUP_FAILED") {
        lastDesiredSqlState = bad.sqlState;
        await pvMarkTrackingFailedDurable(
          req,
          normalizedClientRequestId,
          `TIMEOUT_SETUP_FAILED:main_tx_entry:${lastDesiredSqlState ?? "unknown"}`,
          "timeout_setup",
        );
        emitPvCreateTiming(req, "failed", { code: "TIMEOUT_SETUP_FAILED", stage: "main_tx_entry", sqlState: lastDesiredSqlState });
        res.status(503).json({ error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: lastDesiredSqlState, retryAfterMs: 1000 });
        return;
      }
      await pvMarkTrackingFailedDurable(
        req,
        normalizedClientRequestId,
        `MAIN_TX:${bad.code ?? "unknown"}:${String((bad.error as any)?.message ?? bad.error ?? "").slice(0, 400)}`,
        bad.code ?? "main_tx",
      );
      emitPvCreateTiming(req, "failed", { code: errCode || bad.code || "TX_FAILED", sqlState: bad.sqlState, rollbackMs: bad.rollbackMs });
      if (errCode === "CLIENT_REQUEST_IN_PROGRESS" && normalizedClientRequestId) {
        res.status(202).json({ status: "processing", clientRequestId: normalizedClientRequestId, code: "CLIENT_REQUEST_IN_PROGRESS", retryAfterMs: 500 });
        stopTx();
        return;
      }
      if (errCode === "23505" && normalizedClientRequestId) {
        const existingVoucher = await loadVoucherByClientRequest(r, req.firmId!, normalizedClientRequestId);
        if (existingVoucher) {
          res.status(200).json(existingVoucher);
          stopTx();
          return;
        }
      }
      if (bad.code === "TX_COMMIT_FAILED") {
        res.status(500).json({ error: "Database unavailable", code: "TRANSACTION_COMMIT_FAILED", sqlState: bad.sqlState, innerCode: bad.code });
        stopTx();
        return;
      }
      if (normalizedClientRequestId && (errCode === "55P03" || errCode === "57014" || errCode === "40P01" || bad.sqlState === "55P03" || bad.sqlState === "57014" || bad.sqlState === "40P01")) {
        res.status(503).json({ status: "failed", code: "RETRYABLE_DB_CONTENTION", clientRequestId: normalizedClientRequestId, sqlstate: errCode || bad.sqlState, retryAfterMs: 2000 });
        stopTx();
        return;
      }
      if (errCode === "INJECTED_COMMIT_FAILURE") {
        res.status(500).json({ error: "Database unavailable", code: "TRANSACTION_COMMIT_FAILED", sqlState: bad.sqlState, innerCode: errCode || bad.code });
        stopTx();
        return;
      }
      stopTx();
      sendPvSafeErrorResponse(res, req, { normalizedClientRequestId, rawErr: bad.error ?? errCode ?? bad.code, stage: `main_tx:${bad.code ?? "unknown"}` });
      return;
    }
    pv = finTx.value;
    commitMs = finTx.commitMs;
    if (req.timing?.sections) {
      req.timing.sections.pvCommitMs = commitMs;
      req.timing.sections.pvCommitReleaseMs = 0;
      req.timing.sections.totalRequestMs = Math.max(0, Date.now() - e2eStartAt);
    }
  } catch (err: any) {
    if (abortHandle) { try { clearTimeout(abortHandle); abortHandle = null; } catch {} }
    const errCode = String(err?.code ?? "");
    await pvMarkTrackingFailedDurable(
      req,
      normalizedClientRequestId,
      String(err?.message ?? err ?? "").slice(0, 500),
      "main_transaction_catch",
    );
    emitPvCreateTiming(req, "failed", { code: errCode, message: String(err?.message ?? "").slice(0, 120), trackingMarkedFailed: Boolean(normalizedClientRequestId) });
    if (err instanceof PvTimeoutSetupFailed) {
      await pvMarkTrackingFailedDurable(req, normalizedClientRequestId, `TIMEOUT_SETUP_FAILED:${err.stage}:${err.sqlState ?? "unknown"}`, "timeout_setup");
      const resp503: any = { error: "Service unavailable - request protection not available", code: "TIMEOUT_SETUP_FAILED", sqlState: err.sqlState, stage: err.stage, timeoutMs: err.timeoutMs, retryAfterMs: 1000 };
      if (normalizedClientRequestId) resp503.clientRequestId = normalizedClientRequestId;
      res.status(503).json(resp503);
      stopTx();
      return;
    }
    if (errCode === "CLIENT_REQUEST_IN_PROGRESS" && normalizedClientRequestId) {
      res.status(202).json({ status: "processing", clientRequestId: normalizedClientRequestId, code: "CLIENT_REQUEST_IN_PROGRESS", retryAfterMs: 500 });
      stopTx();
      return;
    }
    if (errCode === "23505" && normalizedClientRequestId) {
      const existingVoucher = await loadVoucherByClientRequest(r, req.firmId!, normalizedClientRequestId);
      if (existingVoucher) {
        res.status(200).json(existingVoucher);
        stopTx();
        return;
      }
    }
    if (normalizedClientRequestId && (errCode === "55P03" || errCode === "57014" || errCode === "40P01")) {
      res.status(503).json({ status: "failed", code: "RETRYABLE_DB_CONTENTION", clientRequestId: normalizedClientRequestId, sqlstate: errCode, retryAfterMs: 2000 });
      stopTx();
      return;
    }
    stopTx();
    sendPvSafeErrorResponse(res, req, { normalizedClientRequestId, rawErr: err, stage: "main_transaction_catch" });
    return;
  } finally {
    stopTx();
    if (abortHandle) { try { clearTimeout(abortHandle); } catch {} }
  }

  emitPvCreateTiming(req, "response_sent", { voucherId: pv.id, committedBefore201: true });
  res.status(201).json(pv);
  const durationMs = Date.now() - startedAt;
  const totalRequestMs = Math.max(0, Date.now() - e2eStartAt);
  if (durationMs >= 2000 || totalRequestMs >= 5000) {
    logger.warn(
      {
        reqId: getReqIdForLog(req),
        clientRequestId: normalizedClientRequestId,
        durationMs,
        totalRequestMs,
        firmId: req.firmId,
        userId: req.userId,
        voucherType,
        voucherId: pv.id,
        sections: req.timing?.sections ?? null,
        ...getPoolStatsSnapshot(),
      },
      "payment_voucher.create_slow",
    );
  }
});

router.post("/payment-vouchers/preflight", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = CreatePaymentVoucherBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const r = rdb(req);
  const settings = await safeLoadAccountingSettingsOrDefault({
    firmId: req.firmId!,
    db: r as any,
    accountingSettingsTable,
    sql,
    eq,
  });

  const { caseId, quotationId, items, lineItems, purpose, amount } = parsed.data;
  const caseIdValue = typeof caseId === "number" && Number.isFinite(caseId) && caseId > 0 ? Number(caseId) : null;
  const explicitQuotationId = typeof quotationId === "number" && Number.isFinite(quotationId) && quotationId > 0 ? Number(quotationId) : null;

  const normalizedLineItems =
    Array.isArray(lineItems) && lineItems.length > 0
      ? lineItems.map((x) => ({ purpose: String(x.purpose ?? "").trim(), amount: Number(x.amount) })).filter((x) => x.purpose && Number.isFinite(x.amount) && x.amount > 0)
      : null;
  const effectiveItems = (Array.isArray(items) && items.length > 0)
    ? items
    : (normalizedLineItems && normalizedLineItems.length > 0)
      ? normalizedLineItems.map((i) => ({ description: i.purpose, itemType: "disbursement" as const, amount: i.amount }))
      : purpose ? [{ description: purpose, itemType: "disbursement" as const, amount: amount ?? 0 }] : [];

  let quotationClaimWarning: string | null = null;
  if (explicitQuotationId) {
    const qCheck = await validateQuotationAndBuildWarning(r, req.firmId!, caseIdValue, explicitQuotationId);
    if (!qCheck.valid) {
      res.status(200).json({ warnings: [], quotationClaimWarnings: [], quotationClaimWarning: null, valid: false, error: qCheck.error, code: "INVALID_QUOTATION" });
      return;
    }
    if (qCheck.warning) quotationClaimWarning = qCheck.warning;
  }

  const unclaimedWarnings = await buildQuotationUnclaimedWarnings(r, req.firmId!, caseIdValue, explicitQuotationId, effectiveItems);
  const structuredItemWarnings = unclaimedWarnings.map((w) => ({
    code: "PV_ITEM_NOT_IN_QUOTATION",
    severity: "warning",
    blocking: false,
    message: `Item \"${w.item}\" not found in quotation claims`,
    item: w.item,
    matchedQuotationId: w.matchedQuotationId ?? null,
    matchedQuotationRef: w.matchedQuotationRef ?? null,
  }));
  res.status(200).json({
    warnings: structuredItemWarnings,
    unclaimedWarnings,
    quotationClaimWarnings: quotationClaimWarning ? [quotationClaimWarning] : [],
    quotationClaimWarning,
    valid: true,
  });
});

router.get("/payment-vouchers/by-client-request/:clientRequestId", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const raw = one(req.params.clientRequestId);
  const clientRequestId = typeof raw === "string" ? raw.trim() : "";
  if (!clientRequestId || clientRequestId.length > 80) {
    res.status(400).json({ error: "Invalid clientRequestId" });
    return;
  }
  const r = rdb(req);
  try {
    const stopPermissions = createSectionTimer(req, "pv.by_client_request.permissions");
    const [canReadAccounting, canReviewAccounting, canApproveAccounting, roleName] = await Promise.all([
      roleHasPermission(req, "accounting", "read"),
      roleHasPermission(req, "accounting", "review"),
      roleHasPermission(req, "accounting", "approve"),
      getRoleName(req),
    ]);
    const roleKind = classifyCaseWorkflowRole(roleName);
    stopPermissions();
    const canViewOtherUsers = Boolean(canReadAccounting || canReviewAccounting || canApproveAccounting || roleKind === "partner");
    const stopRequestLoad = createSectionTimer(req, "pv.by_client_request.request_state");

    const requestStates = await r
      .select()
      .from(paymentVoucherCreateRequestsTable)
      .where(canViewOtherUsers
        ? and(
          eq(paymentVoucherCreateRequestsTable.firmId, req.firmId!),
          eq(paymentVoucherCreateRequestsTable.clientRequestId, clientRequestId),
        )
        : and(
          eq(paymentVoucherCreateRequestsTable.firmId, req.firmId!),
          eq(paymentVoucherCreateRequestsTable.createdByUserId, req.userId!),
          eq(paymentVoucherCreateRequestsTable.clientRequestId, clientRequestId),
        ))
      .orderBy(desc(paymentVoucherCreateRequestsTable.createdAt))
      .limit(2);

    let requestState: typeof paymentVoucherCreateRequestsTable.$inferSelect | null = requestStates[0] ?? null;
    if (requestState && !canViewOtherUsers && Number(requestState.createdByUserId) !== Number(req.userId)) {
      requestState = null;
    }
    stopRequestLoad();
    if (!requestState) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const isOwner = Number(requestState.createdByUserId ?? 0) === Number(req.userId);
    if (!isOwner && !canViewOtherUsers) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const stopVoucherLookup = createSectionTimer(req, "pv.by_client_request.voucher_lookup");
    const pvIdRaw = requestState.paymentVoucherId;
    const pvId = pvIdRaw != null ? Number(pvIdRaw) : null;
    const voucherCandidates = await r
      .select({
        id: paymentVouchersTable.id,
        voucherNo: paymentVouchersTable.voucherNo,
      })
      .from(paymentVouchersTable)
      .where(and(
        eq(paymentVouchersTable.firmId, req.firmId!),
        or(
          pvId ? eq(paymentVouchersTable.id, pvId) : sql`FALSE`,
          eq(paymentVouchersTable.clientRequestId, clientRequestId),
        ),
      ))
      .limit(1);
    const voucher = voucherCandidates[0] ?? null;
    stopVoucherLookup();

    const requestOwnerId = Number(requestState.createdByUserId ?? req.userId!);
    const stopLockProbe = createSectionTimer(req, "pv.by_client_request.lock_probe");
    const activeLockHeld =
      requestState?.status === "processing" && isPaymentVoucherCreateRequestStale(requestState.updatedAt)
        ? await isCreateRequestActivelyLocked(r, req.firmId!, requestOwnerId, clientRequestId)
        : false;
    stopLockProbe();

    const stopResolve = createSectionTimer(req, "pv.by_client_request.resolve");
    const resolved = resolvePaymentVoucherCreateStatus({
      clientRequestId,
      requestState: requestState ?? undefined,
      voucher,
      isViewerAllowed: Boolean(canViewOtherUsers || isOwner || requestOwnerId === Number(req.userId)),
      activeLockHeld,
    });
    stopResolve();
    if (resolved.httpStatus === 403) {
      res.status(403).json(resolved.body);
      return;
    }
    res.status(resolved.httpStatus).json(
      resolved.httpStatus === 409 && resolved.body.status === "stale"
        ? { ...resolved.body, staleAfterMs: PAYMENT_VOUCHER_CREATE_STALE_MS }
        : resolved.body,
    );
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 1000) {
      logger.warn({ durationMs, firmId: req.firmId, userId: req.userId, sections: req.timing?.sections ?? null }, "payment_voucher.by_client_request_slow");
    }
  } catch (err) {
    if (isMissingSchemaError(err)) {
      res.status(500).json({ error: "Database migration missing for idempotency. Apply migration 0126_payment_voucher_create_request_tracking.sql", code: "MIGRATION_MISSING" });
      return;
    }
    if (err instanceof AccountingSettingsLoaderError) {
      writeAccountingSettingsErrorResponse(res, err);
      return;
    }
    const code = typeof (err as { code?: unknown } | null)?.code === "string" ? String((err as { code?: unknown }).code) : "";
    if (code === "57014") {
      res.status(503).json({ error: "Status check timed out", code: "QUERY_TIMEOUT" });
      return;
    }
    if (code === "55P03") {
      res.status(503).json({ error: "Status check temporarily unavailable", code: "LOCK_TIMEOUT" });
      return;
    }
    res.status(503).json({ error: "Status check failed", code: "STATUS_CHECK_UNAVAILABLE" });
    return;
  }
});

router.post("/payment-vouchers/discard-draft", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.payment_voucher"), async (req: AuthRequest, res: Response): Promise<void> => {
  const firmId = req.firmId!;
  const bodyRaw = req.body as any;
  const clientRequestIdRaw = bodyRaw?.clientRequestId;
  const clientRequestId = typeof clientRequestIdRaw === "string" && clientRequestIdRaw.trim() ? clientRequestIdRaw.trim() : null;
  if (!clientRequestId) {
    res.status(400).json({ error: "clientRequestId is required", code: "CLIENT_REQUEST_ID_REQUIRED" });
    return;
  }
  const r = rdb(req);
  try {
    const [existing] = await r
      .select({ id: paymentVouchersTable.id, status: paymentVouchersTable.status, clientRequestId: paymentVouchersTable.clientRequestId })
      .from(paymentVouchersTable)
      .where(and(
        eq(paymentVouchersTable.firmId, firmId),
        eq(paymentVouchersTable.clientRequestId, clientRequestId),
      ))
      .limit(1);
    if (!existing) {
      res.status(200).json({ ok: true, discarded: false, reason: "not_found" });
      return;
    }
    if (String(existing.status ?? "") !== "draft") {
      res.status(200).json({ ok: true, discarded: false, reason: "not_draft", currentStatus: existing.status });
      return;
    }
    await r
      .update(paymentVouchersTable)
      .set({ status: "discarded", updatedAt: new Date() } as any)
      .where(and(
        eq(paymentVouchersTable.id, Number(existing.id)),
        eq(paymentVouchersTable.firmId, firmId),
      ));
    await writeAuditLog({
      firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "payment_voucher.discard_draft",
      entityType: "payment_voucher",
      entityId: Number(existing.id),
      detail: `clientRequestId=${clientRequestId} status from draft to discarded`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, discarded: true, id: Number(existing.id) });
  } catch (err) {
    const code = typeof (err as any)?.code === "string" ? String((err as any).code) : null;
    if (code === "57014") {
      res.status(503).json({ error: "Discard draft timed out", code: "QUERY_TIMEOUT" });
      return;
    }
    throw err;
  }
});

// Status transition
router.post("/payment-vouchers/:id/transition", sensitiveRateLimiter, requireAuth, requireFirmUser, requireReAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const parsed = PaymentVoucherTransitionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const r = rdb(req);
  const [pv] = await r.select().from(paymentVouchersTable).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Voucher not found" }); return; }
  if (pv.isReversed) { res.status(400).json({ error: "Reversed voucher cannot be transitioned" }); return; }

  const roleName = await getRoleName(req);
  const now = new Date();
  let settings: AccountingSettingsRecord;
  try {
    settings = await safeLoadAccountingSettingsOrDefault({
      firmId: req.firmId!,
      db: r as any,
      accountingSettingsTable,
      sql,
      eq,
    });
  } catch (err) {
    writeAccountingSettingsErrorResponse(res, err);
    return;
  }
  const roleKind = await classifyCaseWorkflowRoleWithSettings(req, roleName, settings);
  const canReview = await roleHasPermission(req, "accounting", "review");
  const canApprove = await roleHasPermission(req, "accounting", "approve");
  const canMarkReceived = await roleHasPermission(req, "accounting", "mark_received");
  const canMarkPaid = await roleHasPermission(req, "accounting", "mark_paid");
  const canOverrideSla = await roleHasPermission(req, "accounting", "override_sla");

  const updateFields: Partial<typeof paymentVouchersTable.$inferInsert> = { updatedAt: now };
  const fromStatus = pv.status;
  let toStatus: string | null = null;
  let updatedPv: any | null = null;

  if (parsed.data.action === "lawyer_approve") {
    if (pv.status !== "pending_lawyer") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (roleKind !== "lawyer" && roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    toStatus = "pending_partner";
    updateFields.status = toStatus;
    updateFields.lawyerApprovedBy = req.userId!;
    updateFields.lawyerApprovedAt = now;
  } else if (parsed.data.action === "partner_approve") {
    if (pv.status !== "pending_partner") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    toStatus = "pending_account";
    updateFields.status = toStatus;
    updateFields.partnerApprovedBy = req.userId!;
    updateFields.partnerApprovedAt = now;
  } else if (parsed.data.action === "approve") {
    if (roleKind !== "partner" && !canApprove) { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (pv.approvalStatus !== "pending_approval") { res.status(409).json({ error: "Not pending approval", code: "NOT_PENDING_APPROVAL" }); return; }
    const decision = parsed.data.decision;
    updateFields.approvalStatus = decision;
    updateFields.approvedBy = decision === "approved" ? req.userId! : null;
    updateFields.partnerApprovedBy = req.userId!;
    updateFields.partnerApprovedAt = now;
    toStatus = fromStatus;
  } else if (parsed.data.action === "received_by_accounts") {
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!canMarkReceived && !canReview) { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (pv.receivedAt) { res.status(409).json({ error: "Voucher already received by accounts", code: "ALREADY_RECEIVED" }); return; }
    const assignedAccountUserId = parsed.data.assignedAccountUserId ?? req.userId!;
    const [assignedUser] = await r
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, req.firmId!), eq(usersTable.id, assignedAccountUserId), eq(usersTable.status, "active")))
      .limit(1);
    if (!assignedUser) { res.status(400).json({ error: "Assigned account user is invalid", code: "INVALID_ASSIGNEE" }); return; }
    const slaHours = resolvePaymentVoucherSlaHours(Number(pv.amount), String(pv.voucherType ?? ""), parsed.data.isUrgent === true, settings);
    const paymentDueAt = addBusinessHours(now, slaHours, settings);
    updateFields.receivedBy = req.userId!;
    updateFields.receivedAt = now;
    updateFields.assignedAccountUserId = assignedAccountUserId;
    updateFields.paymentDueAt = paymentDueAt;
    updateFields.slaPolicySnapshot = {
      hours: slaHours,
      timezone: settings.timezone,
      dueSoonMinutes: settings.paymentVoucherSla.dueSoonMinutes,
      isUrgent: parsed.data.isUrgent === true,
    };
    toStatus = fromStatus;
  } else if (parsed.data.action === "reassign_account_user") {
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!pv.receivedAt) { res.status(409).json({ error: "Voucher has not been received by accounts", code: "NOT_RECEIVED" }); return; }
    if (!canMarkReceived && !canReview) { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    const [assignedUser] = await r
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, req.firmId!), eq(usersTable.id, parsed.data.assignedAccountUserId), eq(usersTable.status, "active")))
      .limit(1);
    if (!assignedUser) { res.status(400).json({ error: "Assigned account user is invalid", code: "INVALID_ASSIGNEE" }); return; }
    updateFields.assignedAccountUserId = parsed.data.assignedAccountUserId;
    toStatus = fromStatus;
  } else if (parsed.data.action === "override_deadline") {
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!pv.receivedAt) { res.status(409).json({ error: "Voucher has not been received by accounts", code: "NOT_RECEIVED" }); return; }
    if (!canOverrideSla && roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    updateFields.paymentDueAt = new Date(parsed.data.paymentDueAt);
    updateFields.deadlineOverrideReason = parsed.data.reason;
    updateFields.deadlineOverriddenBy = req.userId!;
    updateFields.deadlineOverriddenAt = now;
    toStatus = fromStatus;
  } else if (parsed.data.action === "reject") {
    if (pv.status !== "pending_lawyer" && pv.status !== "pending_partner" && pv.status !== "pending_account") {
      res.status(400).json({ error: "Invalid status for reject", code: "INVALID_STATUS" }); return;
    }
    if (roleKind !== "lawyer" && roleKind !== "partner" && !canReview && !canApprove) {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return;
    }
    if (pv.status === "pending_lawyer" && roleKind !== "lawyer" && roleKind !== "partner") {
      res.status(403).json({ error: "Only lawyer/partner can reject at this stage", code: "FORBIDDEN" }); return;
    }
    if (pv.status === "pending_partner" && roleKind !== "partner") {
      res.status(403).json({ error: "Only partner can reject at this stage", code: "FORBIDDEN" }); return;
    }
    const reasonText = String(parsed.data.reason ?? "").trim();
    if (reasonText.length < 3) { res.status(400).json({ error: "Rejection reason required (min 3 chars)", code: "REJECTION_REASON_REQUIRED" }); return; }
    toStatus = "rejected";
    updateFields.status = toStatus;
    updateFields.rejectedBy = req.userId!;
    updateFields.rejectedAt = now;
    updateFields.rejectionReason = reasonText;
  } else if (parsed.data.action === "mark_paid") {
    const markPaidData = parsed.data;
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!canMarkPaid && roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (!pv.receivedAt) { res.status(409).json({ error: "Voucher must be received by accounts first", code: "NOT_RECEIVED" }); return; }
    if (pv.approvalStatus && pv.approvalStatus !== "approved") {
      res.status(409).json({ error: "Voucher pending approval", code: "PENDING_APPROVAL" });
      return;
    }
    toStatus = "paid_pending_collection";
    updateFields.status = toStatus;
    const normalizedPaidAccountType = normalizeLedgerAccountType(markPaidData.accountType);
    const paidAmountValue = Number(markPaidData.paidAmount ?? pv.amount);
    if (!Number.isFinite(paidAmountValue) || paidAmountValue <= 0) {
      res.status(400).json({ error: "Invalid payment amount", code: "INVALID_PAYMENT_AMOUNT" });
      return;
    }
    if (Math.abs(paidAmountValue - Number(pv.amount)) > 0.009) {
      res.status(409).json({ error: "Payment amount does not match approved voucher amount", code: "PAYMENT_AMOUNT_MISMATCH" });
      return;
    }
    if (settings.paymentProofRequired && !markPaidData.proofDocumentPath) {
      res.status(400).json({ error: "Proof of payment is required", code: "PROOF_REQUIRED" });
      return;
    }
    if (markPaidData.nextActionType === "Custom Action" && !markPaidData.nextActionCustom) {
      res.status(400).json({ error: "Custom next action requires details", code: "CUSTOM_ACTION_REQUIRED" });
      return;
    }
    const voucherCaseId = pv.caseId ? Number(pv.caseId) : NaN;
    const requiresClerkAction = Number.isFinite(voucherCaseId) && voucherCaseId > 0;
    if (requiresClerkAction && !markPaidData.assignedClerkUserId) {
      res.status(400).json({ error: "Assigned clerk is required for case-linked payment vouchers", code: "CLERK_REQUIRED" });
      return;
    }
    if (!requiresClerkAction && !markPaidData.clerkActionExemptReason) {
      res.status(400).json({ error: "Exemption reason is required when no clerk action will be created", code: "CLERK_ACTION_EXEMPTION_REQUIRED" });
      return;
    }
    updateFields.accountType = normalizedPaidAccountType;
    updateFields.paymentMethod = markPaidData.paymentMethod;
    updateFields.bankChequeRefNo = markPaidData.bankChequeRefNo;
    updateFields.paidAmount = paidAmountValue.toFixed(2);
    updateFields.proofDocumentPath = markPaidData.proofDocumentPath ?? null;
    updateFields.nextActionType = markPaidData.nextActionType;
    updateFields.nextActionCustom = markPaidData.nextActionCustom ?? null;
    updateFields.nextActionRemarks = markPaidData.nextActionRemarks ?? null;
    updateFields.assignedClerkUserId = markPaidData.assignedClerkUserId ?? null;
    updateFields.clerkActionExemptReason = markPaidData.clerkActionExemptReason ?? null;
    updateFields.lateCompletionReason = markPaidData.lateCompletionReason ?? null;
    updateFields.paidAt = now;
    updateFields.paidBy = req.userId!;
    const amountNum = paidAmountValue;
    const amt = Number.isFinite(amountNum) ? amountNum.toFixed(2) : "0";
    const accountType = normalizedPaidAccountType;
    try {
      updatedPv = await r.transaction(async (tx) => {
        let createdActionId: number | null = null;
        const amtNum = Number(amt);
        const getClientBalance = async (caseId: number): Promise<number> => {
          const [row] = await tx
            .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
            .from(ledgerEntriesTable)
            .where(and(
              eq(ledgerEntriesTable.firmId, req.firmId!),
              eq(ledgerEntriesTable.caseId, caseId),
              sql`${ledgerEntriesTable.accountType} IN ('client','trust')`,
            ))
            .limit(1);
          return Number(row?.bal ?? 0);
        };

        if (pv.isAdvance && accountType !== "office") {
          throw Object.assign(new Error("ADVANCE_MUST_USE_OFFICE_ACCOUNT"), { code: "ADVANCE_MUST_USE_OFFICE_ACCOUNT" });
        }

        if (pv.voucherType === "file_to_file_transfer") {
          const targetCaseId = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
          const sourceCaseId = pv.caseId ? Number(pv.caseId) : NaN;
          if (!Number.isFinite(sourceCaseId) || !Number.isFinite(targetCaseId) || sourceCaseId <= 0 || targetCaseId <= 0) return null;
          if (sourceCaseId === targetCaseId) return null;
          const bal = await getClientBalance(sourceCaseId);
          if (bal + 1e-9 < amtNum) {
            throw Object.assign(new Error("INSUFFICIENT_CLIENT_BALANCE"), { code: "INSUFFICIENT_CLIENT_BALANCE", balance: bal });
          }
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: sourceCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "ledger_transfer_voucher",
            accountType: "client",
            debit: amtNum,
            credit: 0,
            description: `Ledger Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: targetCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "ledger_transfer_voucher",
            accountType: "client",
            debit: 0,
            credit: amtNum,
            description: `Ledger Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else if (pv.voucherType === "account_transfer") {
          const sourceId = pv.bankAccountId ? Number(pv.bankAccountId) : NaN;
          const targetId = pv.targetAccountId ? Number(pv.targetAccountId) : NaN;
          if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) return null;
          const [sourceAcct] = await tx
            .select({ accountType: firmBankAccountsTable.accountType })
            .from(firmBankAccountsTable)
            .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, sourceId)))
            .limit(1);
          const [targetAcct] = await tx
            .select({ accountType: firmBankAccountsTable.accountType })
            .from(firmBankAccountsTable)
            .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, targetId)))
            .limit(1);
          const srcType = String(sourceAcct?.accountType ?? "client");
          const tgtType = String(targetAcct?.accountType ?? "office");
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: null,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_transfer",
            accountType: srcType,
            debit: Number(amt),
            credit: 0,
            description: `Account Transfer ${pv.voucherNo} — ${srcType} -> ${tgtType}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: null,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_transfer",
            accountType: tgtType,
            debit: 0,
            credit: Number(amt),
            description: `Account Transfer ${pv.voucherNo} — ${srcType} -> ${tgtType}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else if (pv.voucherType === "file_transfer") {
          const targetCaseId = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
          const sourceCaseId = pv.caseId ? Number(pv.caseId) : NaN;
          if (!Number.isFinite(sourceCaseId) || !Number.isFinite(targetCaseId)) return null;
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: sourceCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_file_transfer",
            accountType,
            debit: Number(amt),
            credit: 0,
            description: `File Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: targetCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_file_transfer",
            accountType,
            debit: 0,
            credit: Number(amt),
            description: `File Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else if (pv.voucherType === "internal_transfer") {
          const caseId = pv.caseId ? Number(pv.caseId) : NaN;
          if (!Number.isFinite(caseId) || caseId <= 0) return null;
          const bal = await getClientBalance(caseId);
          if (bal + 1e-9 < amtNum) {
            throw Object.assign(new Error("INSUFFICIENT_CLIENT_BALANCE"), { code: "INSUFFICIENT_CLIENT_BALANCE", balance: bal });
          }
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "internal_payment_voucher",
            accountType: "client",
            debit: Number(amt),
            credit: 0,
            description: `Internal PV ${pv.voucherNo} — Client -> Office`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "internal_payment_voucher",
            accountType: "office",
            debit: 0,
            credit: Number(amt),
            description: `Internal PV ${pv.voucherNo} — Client -> Office`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else {
          if (accountType === "client") {
            const caseId = pv.caseId ? Number(pv.caseId) : NaN;
            if (!Number.isFinite(caseId) || caseId <= 0) return null;
            const bal = await getClientBalance(caseId);
            if (bal + 1e-9 < amtNum) {
              throw Object.assign(new Error("INSUFFICIENT_CLIENT_BALANCE"), { code: "INSUFFICIENT_CLIENT_BALANCE", balance: bal });
            }
          }
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: pv.caseId ? Number(pv.caseId) : null,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher",
            accountType,
            debit: Number(amt),
            credit: 0,
            description: `Payment Voucher ${pv.voucherNo} — ${pv.payeeName}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        }

        const pvCaseId = pv.caseId ? Number(pv.caseId) : NaN;
        const fundStatus = String(pv.fundStatus ?? "client_paid");
        const entryCategory = fundStatus === "request_advance" ? "office" : "client";
        const entryType = fundStatus === "request_advance" ? "disbursement_paid" : "trust_paid";

        if (pv.voucherType !== "internal_transfer" && pv.voucherType !== "account_transfer" && Number.isFinite(pvCaseId) && pvCaseId > 0) {
          const amtCents = Math.round(parseFloat(String(amt ?? "0")) * 100);
          const evtKey = `PV:${id}:${fundStatus}`;
          const [existing] = await tx
            .select({ id: caseLedgersTable.id })
            .from(caseLedgersTable)
            .where(or(
              and(
                eq(caseLedgersTable.firmId, req.firmId!),
                eq(caseLedgersTable.caseId, pvCaseId),
                eq(caseLedgersTable.sourceType, "payment_voucher"),
                eq(caseLedgersTable.sourceId, id),
              ),
              and(
                eq(caseLedgersTable.firmId, req.firmId!),
                eq(caseLedgersTable.eventKey, evtKey),
              ),
            ))
            .limit(1);
          if (!existing) {
            await tx.insert(caseLedgersTable).values({
              firmId: req.firmId!,
              caseId: pvCaseId,
              transactionDate: now.toISOString().slice(0, 10),
              entryCategory,
              entryType,
              description: `PV ${pv.voucherNo} — ${String(pv.purpose ?? "").trim()}`,
              amount: amt,
              debitCents: 0,
              creditCents: Math.max(0, amtCents),
              sourceType: "payment_voucher",
              sourceId: id,
              sourceReference: pv.voucherNo,
              eventKey: evtKey,
            } as any);
          }
        }

        if (pv.isAdvance && Number.isFinite(pvCaseId) && pvCaseId > 0) {
          const amtCents = Math.round(parseFloat(String(amt ?? "0")) * 100);
          const evtKey = `PV:${id}:ADVANCE`;
          const [existing] = await tx
            .select({ id: caseLedgersTable.id })
            .from(caseLedgersTable)
            .where(or(
              and(
                eq(caseLedgersTable.firmId, req.firmId!),
                eq(caseLedgersTable.caseId, pvCaseId),
                eq(caseLedgersTable.sourceType, "payment_voucher_advance"),
                eq(caseLedgersTable.sourceId, id),
              ),
              and(
                eq(caseLedgersTable.firmId, req.firmId!),
                eq(caseLedgersTable.eventKey, evtKey),
              ),
            ))
            .limit(1);
          if (!existing) {
            await tx.insert(caseLedgersTable).values({
              firmId: req.firmId!,
              caseId: pvCaseId,
              transactionDate: now.toISOString().slice(0, 10),
              entryCategory: "office",
              entryType: "advance_paid",
              description: `Advance PV ${pv.voucherNo} — ${String(pv.purpose ?? "").trim()}`,
              amount: amt,
              debitCents: 0,
              creditCents: Math.max(0, amtCents),
              sourceType: "payment_voucher_advance",
              sourceId: id,
              sourceReference: pv.voucherNo,
              eventKey: evtKey,
            } as any);
          }
        }

        if ((pv.voucherType === "file_transfer" || pv.voucherType === "file_to_file_transfer") && entryType === "trust_paid") {
        const targetCaseId = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
        if (Number.isFinite(targetCaseId) && targetCaseId > 0) {
          const amtCents = Math.round(parseFloat(String(amt ?? "0")) * 100);
          const evtKey = `PV:${id}:FILE_TRANSFER_IN:${targetCaseId}`;
          const [existing] = await tx
            .select({ id: caseLedgersTable.id })
            .from(caseLedgersTable)
            .where(or(
              and(
                eq(caseLedgersTable.firmId, req.firmId!),
                eq(caseLedgersTable.caseId, targetCaseId),
                eq(caseLedgersTable.sourceType, "payment_voucher"),
                eq(caseLedgersTable.sourceId, id),
              ),
              and(
                eq(caseLedgersTable.firmId, req.firmId!),
                eq(caseLedgersTable.eventKey, evtKey),
              ),
            ))
            .limit(1);
          if (!existing) {
            await tx.insert(caseLedgersTable).values({
              firmId: req.firmId!,
              caseId: targetCaseId,
              transactionDate: now.toISOString().slice(0, 10),
              entryCategory,
              entryType: "trust_received",
              description: `PV ${pv.voucherNo} — File Transfer In`,
              amount: amt,
              debitCents: Math.max(0, amtCents),
              creditCents: 0,
              sourceType: "payment_voucher",
              sourceId: id,
              sourceReference: pv.voucherNo,
              eventKey: evtKey,
            } as any);
          }
        }
      }

        if (requiresClerkAction && markPaidData.assignedClerkUserId) {
        const [existingAction] = await tx
          .select({ id: paymentVoucherActionsTable.id })
          .from(paymentVoucherActionsTable)
          .where(and(
            eq(paymentVoucherActionsTable.firmId, req.firmId!),
            eq(paymentVoucherActionsTable.paymentVoucherId, id),
            inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"]),
          ))
          .limit(1);
        if (existingAction) {
          throw Object.assign(new Error("ACTIVE_CLERK_ACTION_EXISTS"), { code: "ACTIVE_CLERK_ACTION_EXISTS" });
        }
        const acknowledgeDueAt = addBusinessHours(now, settings.clerkActionSla.acknowledgeHours, settings);
        const completionDueAt = addBusinessHours(now, settings.clerkActionSla.completionHours, settings);
          const [createdAction] = await tx.insert(paymentVoucherActionsTable).values({
          firmId: req.firmId!,
          paymentVoucherId: id,
          caseId: voucherCaseId,
            assignedUserId: markPaidData.assignedClerkUserId,
            actionType: markPaidData.nextActionType,
            customAction: markPaidData.nextActionCustom ?? null,
          status: "assigned",
          priority: "normal",
          assignedAt: now,
          acknowledgeDueAt,
          completionDueAt,
          createdBy: req.userId!,
        }).returning({ id: paymentVoucherActionsTable.id });
          createdActionId = Number(createdAction.id);
        await createUserNotification({
          tx,
          firmId: req.firmId!,
            userId: markPaidData.assignedClerkUserId,
          sourceType: "payment_voucher_action",
          sourceId: createdAction.id,
          caseId: voucherCaseId,
          notificationType: "payment_voucher.action_assigned",
          title: `Payment completed for ${pv.voucherNo}`,
            message: `Next action required: ${markPaidData.nextActionType}`,
          actorUserId: req.userId!,
            meta: { paymentVoucherId: id, voucherNo: pv.voucherNo, nextActionType: markPaidData.nextActionType },
        });
      }

      const [updated] = await tx
        .update(paymentVouchersTable)
        .set(updateFields)
        .where(and(
          eq(paymentVouchersTable.id, id),
          eq(paymentVouchersTable.firmId, req.firmId!),
          eq(paymentVouchersTable.status, "pending_account"),
        ))
        .returning();
        return updated ? { voucher: updated, createdActionId } : null;
      });
    } catch (err: any) {
      const code = typeof err?.code === "string" ? err.code : "";
      if (code === "INSUFFICIENT_CLIENT_BALANCE") {
        res.status(400).json({ error: "Insufficient Client Account Balance", code: "INSUFFICIENT_CLIENT_BALANCE" });
        return;
      }
      if (code === "ADVANCE_MUST_USE_OFFICE_ACCOUNT") {
        res.status(400).json({ error: "Client Advance must be paid from Office Account", code: "ADVANCE_MUST_USE_OFFICE_ACCOUNT" });
        return;
      }
      if (code === "ACTIVE_CLERK_ACTION_EXISTS") {
        res.status(409).json({ error: "Active clerk action already exists", code: "ACTIVE_CLERK_ACTION_EXISTS" });
        return;
      }
      throw err;
    }
    if (!updatedPv) {
      res.status(400).json({ error: "Missing required accounts/cases, or voucher already transitioned", code: "INVALID_REQUEST" });
      return;
    }
  } else if (parsed.data.action === "mark_complete") {
    if (pv.status !== "paid_pending_collection" && pv.status !== "pending_account") {
      res.status(400).json({ error: "Voucher must be paid pending collection or pending account to complete", code: "INVALID_STATUS" }); return;
    }
    if (pv.status === "paid_pending_collection" && !pv.paidAt) {
      res.status(409).json({ error: "Voucher has not been marked paid yet", code: "NOT_PAID" }); return;
    }
    if (!canMarkPaid && !canReview && roleKind !== "partner" && roleKind !== "lawyer") {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return;
    }
    const completionRemarksRaw = (parsed.data as any).remarks;
    const completionRemarks = typeof completionRemarksRaw === "string" && completionRemarksRaw.trim() ? completionRemarksRaw.trim() : null;
    toStatus = "completed";
    updateFields.status = toStatus;
    updateFields.completedBy = req.userId!;
    updateFields.completedAt = now;
    updateFields.completionRemarks = completionRemarks;
    updateFields.escalationResolvedAt = now;
    updateFields.escalationResolvedBy = req.userId!;
    try {
      updatedPv = await r.transaction(async (tx) => {
        await tx
          .update(userNotificationsTable)
          .set({
            status: "auto_resolved",
            autoResolvedAt: now,
            resolvedAt: now,
            updatedAt: now,
          } as any)
          .where(and(
            eq(userNotificationsTable.firmId, req.firmId!),
            eq(userNotificationsTable.sourceType, "payment_voucher"),
            eq(userNotificationsTable.sourceId, id),
            inArray(userNotificationsTable.status, ["unread", "read", "acknowledged", "escalated"]),
          ));
        const [updated] = await tx
          .update(paymentVouchersTable)
          .set(updateFields)
          .where(and(
            eq(paymentVouchersTable.id, id),
            eq(paymentVouchersTable.firmId, req.firmId!),
            inArray(paymentVouchersTable.status, ["paid_pending_collection", "pending_account"]),
          ))
          .returning();
        return updated ? { voucher: updated[0], createdActionId: null } : null;
      });
    } catch (err) {
      throw err;
    }
    if (!updatedPv) {
      res.status(400).json({ error: "Voucher status changed concurrently", code: "INVALID_REQUEST" });
      return;
    }
  }

  if (!toStatus) { res.status(400).json({ error: "Invalid transition", code: "INVALID_TRANSITION" }); return; }

  const [updated] = updatedPv?.voucher ? [updatedPv.voucher] : await r
    .update(paymentVouchersTable)
    .set(updateFields)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)))
    .returning();
  const auditAction = parsed.data.action === "lawyer_approve"
    ? "payment_voucher.lawyer_approved"
    : parsed.data.action === "partner_approve"
      ? "payment_voucher.partner_approved"
      : parsed.data.action === "approve"
        ? (parsed.data.decision === "approved" ? "payment_voucher.approved" : "payment_voucher.rejected")
        : parsed.data.action === "received_by_accounts"
          ? "payment_voucher.account_received"
          : parsed.data.action === "reassign_account_user"
            ? "payment_voucher.reassigned"
            : parsed.data.action === "override_deadline"
              ? "payment_voucher.deadline_overridden"
              : parsed.data.action === "reject"
                ? "payment_voucher.rejected"
                : parsed.data.action === "mark_paid"
                  ? "payment_voucher.payment_completed"
                  : parsed.data.action === "mark_complete"
                    ? "payment_voucher.completed"
                    : "payment_voucher.transition";
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: auditAction, entityType: "payment_voucher", entityId: id, detail: `action=${parsed.data.action} from=${fromStatus} to=${toStatus}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  if (parsed.data.action === "received_by_accounts" && updated?.assignedAccountUserId) {
    await createUserNotification({
      tx: r,
      firmId: req.firmId!,
      userId: Number(updated.assignedAccountUserId),
      sourceType: "payment_voucher",
      sourceId: id,
      caseId: updated.caseId ? Number(updated.caseId) : null,
      notificationType: "payment_voucher.account_received",
      title: `Voucher received: ${updated.voucherNo}`,
      message: `Payment processing deadline starts now${updated.paymentDueAt ? ` and is due by ${new Date(updated.paymentDueAt).toLocaleString("en-MY")}` : ""}.`,
      actorUserId: req.userId!,
      meta: { paymentVoucherId: id, voucherNo: updated.voucherNo },
    });
  }
  if (parsed.data.action === "reassign_account_user" && updated?.assignedAccountUserId) {
    await createUserNotification({
      tx: r,
      firmId: req.firmId!,
      userId: Number(updated.assignedAccountUserId),
      sourceType: "payment_voucher",
      sourceId: id,
      caseId: updated.caseId ? Number(updated.caseId) : null,
      notificationType: "payment_voucher.reassigned",
      title: `Voucher reassigned: ${updated.voucherNo}`,
      message: "You have been assigned to process this payment voucher.",
      actorUserId: req.userId!,
      meta: { paymentVoucherId: id, voucherNo: updated.voucherNo },
    });
  }
  if (parsed.data.action === "mark_paid" && updatedPv?.createdActionId) {
    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "payment_voucher.action_created",
      entityType: "payment_voucher_action",
      entityId: updatedPv.createdActionId,
      detail: `paymentVoucherId=${id}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
  if (parsed.data.action === "reject") {
    const notifyTargets: Array<{ userId: number; reason: string }> = [];
    if (pv.preparedBy && Number(pv.preparedBy) !== Number(req.userId)) {
      notifyTargets.push({ userId: Number(pv.preparedBy), reason: "Rejection to preparer" });
    }
    if (pv.responsibleLawyerId && Number(pv.responsibleLawyerId) !== Number(req.userId) && !notifyTargets.some(t => t.userId === Number(pv.responsibleLawyerId))) {
      notifyTargets.push({ userId: Number(pv.responsibleLawyerId), reason: "Rejection to responsible lawyer" });
    }
    for (const tgt of notifyTargets) {
      await createUserNotification({
        tx: r,
        firmId: req.firmId!,
        userId: tgt.userId,
        sourceType: "payment_voucher",
        sourceId: id,
        caseId: pv.caseId ? Number(pv.caseId) : null,
        notificationType: "payment_voucher.rejected",
        title: `Voucher rejected: ${String(pv.voucherNo ?? id)}`,
        message: String((parsed.data as any).reason ?? "").slice(0, 500),
        actorUserId: req.userId!,
        meta: { paymentVoucherId: id, voucherNo: pv.voucherNo, rejectedBy: req.userId },
      });
    }
  }
  if (parsed.data.action === "mark_complete") {
    const notifyTargets: Array<{ userId: number; reason: string }> = [];
    if (pv.preparedBy && Number(pv.preparedBy) !== Number(req.userId)) {
      notifyTargets.push({ userId: Number(pv.preparedBy), reason: "Completion notice to preparer" });
    }
    if (pv.assignedAccountUserId && Number(pv.assignedAccountUserId) !== Number(req.userId) && !notifyTargets.some(t => t.userId === Number(pv.assignedAccountUserId))) {
      notifyTargets.push({ userId: Number(pv.assignedAccountUserId), reason: "Completion notice to account handler" });
    }
    if (pv.responsibleLawyerId && Number(pv.responsibleLawyerId) !== Number(req.userId) && !notifyTargets.some(t => t.userId === Number(pv.responsibleLawyerId))) {
      notifyTargets.push({ userId: Number(pv.responsibleLawyerId), reason: "Completion notice to responsible lawyer" });
    }
    for (const tgt of notifyTargets) {
      await createUserNotification({
        tx: r,
        firmId: req.firmId!,
        userId: tgt.userId,
        sourceType: "payment_voucher",
        sourceId: id,
        caseId: pv.caseId ? Number(pv.caseId) : null,
        notificationType: "payment_voucher.completed",
        title: `Voucher completed: ${String(pv.voucherNo ?? id)}`,
        message: "Payment voucher workflow has been completed successfully.",
        actorUserId: req.userId!,
        meta: { paymentVoucherId: id, voucherNo: pv.voucherNo, completedBy: req.userId },
      });
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(updated);
});

// History timeline (audit logs + transitions merged)
router.get("/payment-vouchers/:id(\\d+)/history", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const r = rdb(req);
  const [pv] = await r
    .select({ id: paymentVouchersTable.id, voucherNo: paymentVouchersTable.voucherNo, caseId: paymentVouchersTable.caseId })
    .from(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Payment voucher not found" }); return; }
  const logs = await r
    .select({
      id: auditLogsTable.id,
      createdAt: auditLogsTable.createdAt,
      action: auditLogsTable.action,
      actorId: auditLogsTable.actorId,
      actorType: auditLogsTable.actorType,
      detail: auditLogsTable.detail,
      actorName: usersTable.name,
    })
    .from(auditLogsTable)
    .leftJoin(usersTable, eq(usersTable.id, auditLogsTable.actorId))
    .where(and(
      eq(auditLogsTable.firmId, req.firmId!),
      eq(auditLogsTable.entityType, "payment_voucher"),
      eq(auditLogsTable.entityId, id),
    ))
    .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id));
  const timeline = logs.map((l) => ({
    id: `audit-${l.id}`,
    timestamp: l.createdAt,
    action: l.action,
    actorId: l.actorId,
    actorType: l.actorType,
    actorName: l.actorName ?? (l.actorType === "founder" ? "Founder" : null),
    detail: l.detail ?? null,
  }));
  res.json({
    voucherId: id,
    voucherNo: pv.voucherNo,
    caseId: pv.caseId,
    timeline,
  });
});

// Ledger: view by case and account type
router.get("/ledger", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const accountType = one((req.query as any).accountType);
  const { page, limit, offset } = parsePageLimit(req, { defaultLimit: 30, maxLimit: 200 });
  const conds = [eq(ledgerEntriesTable.firmId, req.firmId!)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(ledgerEntriesTable.caseId, n));
  }
  if (accountType) {
    const normalized = normalizeLedgerAccountType(accountType);
    if (normalized === "client") conds.push(sql`${ledgerEntriesTable.accountType} IN ('client','trust')`);
    else conds.push(eq(ledgerEntriesTable.accountType, normalized));
  }
  const r = rdb(req);
  const conn = req.rlsClient;
  const cond = and(...conds);
  const category: StatementTimeoutCategory = "search";
  try {
    const totalPromise = conn
      ? withDbStatementTimeout(conn, category, () =>
          (r as any).select({ value: count() }).from(ledgerEntriesTable).where(cond),
          category,
        )
      : (r as any).select({ value: count() }).from(ledgerEntriesTable).where(cond);
    const listPromise = conn
      ? withDbStatementTimeout(conn, category, () =>
          r.select().from(ledgerEntriesTable).where(cond).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt).limit(limit).offset(offset),
          category,
        )
      : r.select().from(ledgerEntriesTable).where(cond).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt).limit(limit).offset(offset);
    const [[{ value: totalRaw }], rows] = await Promise.all([totalPromise, listPromise]);
    const totalCount = typeof totalRaw === "number" ? totalRaw : Number(totalRaw ?? 0);
    res.setHeader("X-Total-Count", String(totalCount));
    res.setHeader("X-Page", String(page));
    res.setHeader("X-Limit", String(limit));
    res.json(rows);
  } catch (err) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "ledger.list_failed");
    if (err instanceof Error && (err as any).code === "STATEMENT_TIMEOUT") {
      res.status(504).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: "Failed to load ledger" });
  }
});

router.get("/ledger/summary", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const conds = [eq(ledgerEntriesTable.firmId, req.firmId!)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(ledgerEntriesTable.caseId, n));
  }
  const cond = and(...conds);
  const r = rdb(req);
  const conn = req.rlsClient;
  const category: StatementTimeoutCategory = "aggregate";
  try {
    const accountTypeExpr = sql<string>`CASE WHEN ${ledgerEntriesTable.accountType} = 'trust' THEN 'client' ELSE ${ledgerEntriesTable.accountType} END`;
    const work = () => r.select({
      accountType: accountTypeExpr,
      totalDebit: sql<string>`COALESCE(SUM(debit), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(credit), 0)`,
      balance: sql<string>`COALESCE(SUM(credit - debit), 0)`,
    }).from(ledgerEntriesTable).where(cond).groupBy(accountTypeExpr).orderBy(accountTypeExpr);
    const rows = conn ? await withDbStatementTimeout(conn, category, work, category) : await work();
    res.json(rows);
  } catch (err) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "ledger.summary_failed");
    if (err instanceof Error && (err as any).code === "STATEMENT_TIMEOUT") {
      res.status(504).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: "Failed to load ledger summary" });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
