import { and, eq, desc } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, boolean, index, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  invoicesTable,
  einvoiceIntegrationsTable,
  type EinvoiceIntegrationStatus,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";
import { appendInvoiceAuditTrail } from "./invoice-audit-writer.service.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

const einvoiceSubmissionAuditTable = pgTable("einvoice_submission_audit", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  invoiceId: integer("invoice_id").notNull(),
  integrationId: integer("integration_id"),
  actionType: text("action_type").notNull().default("SUBMIT"),
  submissionStatus: text("submission_status").notNull().default("BOUNDARY_CHECK"),
  boundaryPassed: boolean("boundary_passed").notNull().default(false),
  boundaryErrorCode: text("boundary_error_code"),
  boundaryErrorMessage: text("boundary_error_message"),
  provider: text("provider"),
  einvoiceIntegrationStatus: text("einvoice_integration_status"),
  idempotencyKey: text("idempotency_key"),
  submissionRequestJson: jsonb("submission_request_json"),
  submissionResponseJson: jsonb("submission_response_json"),
  externalSubmissionUid: text("external_submission_uid"),
  externalEinvoiceUuid: text("external_einvoice_uuid"),
  externalStatusUrl: text("external_status_url"),
  externalQrCodeData: text("external_qr_code_data"),
  requestSentAt: timestamp("request_sent_at", { withTimezone: true }),
  responseReceivedAt: timestamp("response_received_at", { withTimezone: true }),
  retryAttempt: integer("retry_attempt").notNull().default(0),
  scheduledRetryAt: timestamp("scheduled_retry_at", { withTimezone: true }),
  actorUserId: integer("actor_user_id"),
  actorRole: text("actor_role"),
  clientRequestId: text("client_request_id"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  invoiceNoSnapshot: text("invoice_no_snapshot"),
  grandTotalSnapshot: numeric("grand_total_snapshot", { precision: 20, scale: 2 }),
  invoiceStatusSnapshot: text("invoice_status_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_einvoice_sub_audit_firm").on(t.firmId),
  firmInvoiceIdx: index("idx_einvoice_sub_audit_firm_invoice").on(t.firmId, t.invoiceId),
  firmStatusIdx: index("idx_einvoice_sub_audit_firm_status").on(t.firmId, t.submissionStatus, t.createdAt),
  uqIdem: uniqueIndex("uq_einvoice_sub_audit_idem").on(t.firmId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
}));

export type EinvoiceAdapterAction = "SUBMIT" | "CANCEL" | "VALIDATE" | "DOWNLOAD_PDF" | "DOWNLOAD_XML" | "CHECK_STATUS" | "RETRY";
export type EinvoiceSubmissionStatus =
  | "BOUNDARY_CHECK"
  | "INTEGRATION_NOT_CONFIGURED"
  | "INTEGRATION_DISABLED"
  | "INTEGRATION_ERROR"
  | "QUEUED"
  | "VALIDATING"
  | "SUBMITTING"
  | "SUBMITTED"
  | "PARTIALLY_SUBMITTED"
  | "VALIDATION_FAILED"
  | "SUBMISSION_FAILED"
  | "ACCEPTED_BY_PROVIDER"
  | "REJECTED_BY_PROVIDER"
  | "CANCELLED"
  | "EXPIRED";

export interface SubmitEinvoiceInput {
  firmId: number;
  invoiceId: number;
  actorUserId?: number | null;
  actorRole?: string | null;
  clientRequestId?: string | null;
  idempotencyKey?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestedAt?: Date | null;
}

export interface SubmitEinvoiceBoundaryResult {
  auditId: number;
  boundaryPassed: boolean;
  boundaryErrorCode: string | null;
  boundaryErrorMessage: string | null;
  integrationId: number | null;
  integrationStatus: EinvoiceIntegrationStatus | null;
  integrationProvider: string | null;
  invoiceId: number;
  firmId: number;
  einvoiceStatusSnapshot: string | null;
  invoiceStatusSnapshot: string | null;
  idempotencyKey: string | null;
  canProceedToProvider: boolean;
  providerSubmitQueued: boolean;
  queueToken: string | null;
}

export async function submitEinvoice(
  input: SubmitEinvoiceInput,
  opts: { tx?: unknown } = {},
): Promise<SubmitEinvoiceBoundaryResult> {
  const conn = pickDbConn(opts.tx);

  if (!input.invoiceId || typeof input.invoiceId !== "number") {
    throw new ApiError({ status: 400, code: "EINVOICE_INVOICE_REQUIRED", message: "Invoice id is required for eInvoice submission", retryable: false });
  }

  const now = new Date();
  const idemKey = input.idempotencyKey ?? `EINVOICE_SUBMIT:${input.firmId}:${input.invoiceId}:${Date.now()}`;

  let integrationId: number | null = null;
  let integrationStatus: EinvoiceIntegrationStatus | null = null;
  let integrationProvider: string | null = null;
  let enableAutoSubmit: boolean = false;

  const existingIdemAudit = (await conn
    .select({ id: einvoiceSubmissionAuditTable.id })
    .from(einvoiceSubmissionAuditTable as any)
    .where(and(
      eq(einvoiceSubmissionAuditTable.firmId, input.firmId),
      eq(einvoiceSubmissionAuditTable.idempotencyKey, idemKey),
    ))
    .limit(1))?.[0] as any;

  if (existingIdemAudit) {
    const prior = (await conn
      .select()
      .from(einvoiceSubmissionAuditTable as any)
      .where(eq(einvoiceSubmissionAuditTable.id, Number(existingIdemAudit.id)))
      .limit(1))?.[0] as any;

    if (prior) {
      return {
        auditId: Number(prior.id),
        boundaryPassed: Boolean(prior.boundaryPassed),
        boundaryErrorCode: prior.boundaryErrorCode ?? null,
        boundaryErrorMessage: prior.boundaryErrorMessage ?? null,
        integrationId: typeof prior.integrationId === "number" ? prior.integrationId : null,
        integrationStatus: (prior.einvoiceIntegrationStatus as EinvoiceIntegrationStatus) ?? null,
        integrationProvider: prior.provider ?? null,
        invoiceId: Number(prior.invoiceId),
        firmId: Number(prior.firmId),
        einvoiceStatusSnapshot: null,
        invoiceStatusSnapshot: prior.invoiceStatusSnapshot ?? null,
        idempotencyKey: prior.idempotencyKey ?? null,
        canProceedToProvider: false,
        providerSubmitQueued: false,
        queueToken: null,
      };
    }
  }

  try {
    const integrationRow = (await conn
      .select()
      .from(einvoiceIntegrationsTable as any)
      .where(and(
        eq(einvoiceIntegrationsTable.firmId, input.firmId),
        eq(einvoiceIntegrationsTable.status, "active"),
      ))
      .limit(1))?.[0] as any;

    if (!integrationRow) {
      const fallbackAny = (await conn
        .select()
        .from(einvoiceIntegrationsTable as any)
        .where(eq(einvoiceIntegrationsTable.firmId, input.firmId))
        .orderBy(desc(einvoiceIntegrationsTable.updatedAt))
        .limit(1))?.[0] as any;

      if (fallbackAny) {
        integrationId = Number(fallbackAny.id);
        integrationStatus = (fallbackAny.status as EinvoiceIntegrationStatus) ?? "not_configured";
        integrationProvider = fallbackAny.provider ?? null;
        enableAutoSubmit = Boolean(fallbackAny.enableAutoSubmit);
      }
    } else {
      integrationId = Number(integrationRow.id);
      integrationStatus = (integrationRow.status as EinvoiceIntegrationStatus) ?? "active";
      integrationProvider = integrationRow.provider ?? null;
      enableAutoSubmit = Boolean(integrationRow.enableAutoSubmit);
    }
  } catch {
    integrationId = null;
    integrationStatus = null;
    integrationProvider = null;
  }

  if (integrationId == null || !integrationStatus || integrationStatus !== "active") {
    const noConfigErrorCode = "EINVOICE_INTEGRATION_NOT_CONFIGURED";
    const noConfigErrorMessage = "Integration Not Configured";

    try {
      const auditRows = await conn
        .insert(einvoiceSubmissionAuditTable as any)
        .values({
          firmId: input.firmId,
          invoiceId: input.invoiceId,
          integrationId,
          actionType: "SUBMIT",
          submissionStatus: "INTEGRATION_NOT_CONFIGURED",
          boundaryPassed: false,
          boundaryErrorCode: noConfigErrorCode,
          boundaryErrorMessage: noConfigErrorMessage,
          provider: integrationProvider,
          einvoiceIntegrationStatus: integrationStatus ?? "not_configured",
          idempotencyKey: idemKey,
          submissionRequestJson: null,
          submissionResponseJson: null,
          externalSubmissionUid: null,
          externalEinvoiceUuid: null,
          externalStatusUrl: null,
          externalQrCodeData: null,
          requestSentAt: null,
          responseReceivedAt: now,
          retryAttempt: 0,
          scheduledRetryAt: null,
          actorUserId: typeof input.actorUserId === "number" ? input.actorUserId : null,
          actorRole: input.actorRole ?? null,
          clientRequestId: input.clientRequestId ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          invoiceNoSnapshot: null,
          grandTotalSnapshot: null,
          invoiceStatusSnapshot: null,
          createdAt: now,
          updatedAt: now,
        } as any)
        .returning({ id: einvoiceSubmissionAuditTable.id });
    } catch {
      // best-effort audit
    }

    try {
      await appendInvoiceAuditTrail({
        firmId: input.firmId,
        invoiceId: input.invoiceId,
        actionType: "einvoice_submit_failed",
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole ?? null,
        errorCode: noConfigErrorCode,
        errorMessage: noConfigErrorMessage,
        clientRequestId: input.clientRequestId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        statusBefore: null,
        statusAfter: null,
      }, { tx: conn }).catch(() => undefined);
    } catch {
      // non-fatal
    }

    throw new ApiError({
      status: 400,
      code: noConfigErrorCode,
      message: noConfigErrorMessage,
      retryable: false,
    });
  }

  const invoiceCols: any = {
    id: invoicesTable.id,
    firmId: invoicesTable.firmId,
    status: invoicesTable.status,
    invoiceNo: invoicesTable.invoiceNo,
    grandTotal: invoicesTable.grandTotal,
    einvoiceStatus: (invoicesTable as any).einvoiceStatus ?? (invoicesTable as any).einvoice_submission_status,
    deletedAt: invoicesTable.deletedAt,
    version: invoicesTable.version,
    issuedDate: invoicesTable.issuedDate,
    dueDate: invoicesTable.dueDate,
  };

  const invoiceRow = (await conn
    .select(invoiceCols)
    .from(invoicesTable as any)
    .where(and(
      eq(invoicesTable.firmId, input.firmId),
      eq(invoicesTable.id, input.invoiceId),
    ))
    .limit(1))?.[0] as any;

  if (!invoiceRow) {
    try {
      await conn
        .insert(einvoiceSubmissionAuditTable as any)
        .values({
          firmId: input.firmId,
          invoiceId: input.invoiceId,
          integrationId,
          actionType: "SUBMIT",
          submissionStatus: "BOUNDARY_CHECK",
          boundaryPassed: false,
          boundaryErrorCode: "INVOICE_NOT_FOUND",
          boundaryErrorMessage: "Invoice not found in firm scope",
          provider: integrationProvider,
          einvoiceIntegrationStatus: integrationStatus ?? "active",
          idempotencyKey: idemKey,
          retryAttempt: 0,
          responseReceivedAt: now,
          actorUserId: typeof input.actorUserId === "number" ? input.actorUserId : null,
          actorRole: input.actorRole ?? null,
          clientRequestId: input.clientRequestId ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          createdAt: now,
          updatedAt: now,
        } as any)
        .onConflictDoNothing();
    } catch {
      // non-fatal
    }

    throw new ApiError({
      status: 404,
      code: "INVOICE_NOT_FOUND",
      message: "Invoice not found in firm scope",
      retryable: false,
    });
  }

  const einvoiceStatusSnapshot = typeof invoiceRow.einvoiceStatus === "string" ? invoiceRow.einvoiceStatus : null;
  const invoiceStatusSnapshot = typeof invoiceRow.status === "string" ? invoiceRow.status : null;
  const invoiceNoSnapshot = typeof invoiceRow.invoiceNo === "string" ? invoiceRow.invoiceNo : null;
  const grandTotalSnapshot = invoiceRow.grandTotal != null ? String(invoiceRow.grandTotal) : null;

  if (invoiceRow.deletedAt) {
    try {
      await conn
        .insert(einvoiceSubmissionAuditTable as any)
        .values({
          firmId: input.firmId,
          invoiceId: input.invoiceId,
          integrationId,
          actionType: "SUBMIT",
          submissionStatus: "BOUNDARY_CHECK",
          boundaryPassed: false,
          boundaryErrorCode: "EINVOICE_INVOICE_DELETED",
          boundaryErrorMessage: "Deleted invoices cannot be submitted for eInvoice",
          provider: integrationProvider,
          einvoiceIntegrationStatus: integrationStatus ?? "active",
          idempotencyKey: idemKey,
          retryAttempt: 0,
          responseReceivedAt: now,
          actorUserId: typeof input.actorUserId === "number" ? input.actorUserId : null,
          actorRole: input.actorRole ?? null,
          clientRequestId: input.clientRequestId ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          invoiceNoSnapshot,
          grandTotalSnapshot: grandTotalSnapshot as any,
          invoiceStatusSnapshot,
          createdAt: now,
          updatedAt: now,
        } as any)
        .onConflictDoNothing();
    } catch {
      // non-fatal
    }

    throw new ApiError({
      status: 409,
      code: "EINVOICE_INVOICE_DELETED",
      message: "Deleted invoices cannot be submitted for eInvoice",
      retryable: false,
    });
  }

  let auditId: number | null = null;
  try {
    const auditRows = await conn
      .insert(einvoiceSubmissionAuditTable as any)
      .values({
        firmId: input.firmId,
        invoiceId: input.invoiceId,
        integrationId,
        actionType: "SUBMIT",
        submissionStatus: "QUEUED",
        boundaryPassed: true,
        boundaryErrorCode: null,
        boundaryErrorMessage: null,
        provider: integrationProvider,
        einvoiceIntegrationStatus: integrationStatus ?? "active",
        idempotencyKey: idemKey,
        submissionRequestJson: {
          boundaryCheck: {
            integrationFound: true,
            integrationActive: true,
            invoiceFound: true,
            invoiceNotDeleted: !invoiceRow.deletedAt,
            enableAutoSubmit,
          },
          invoiceSnapshot: {
            invoiceNo: invoiceNoSnapshot,
            grandTotal: grandTotalSnapshot,
            invoiceStatus: invoiceStatusSnapshot,
            einvoiceStatus: einvoiceStatusSnapshot,
            version: invoiceRow.version,
          },
        } as any,
        submissionResponseJson: {
          boundaryResult: "PASSED",
          next: "QUEUED_FOR_PROVIDER_SUBMISSION",
        } as any,
        externalSubmissionUid: null,
        externalEinvoiceUuid: null,
        externalStatusUrl: null,
        externalQrCodeData: null,
        requestSentAt: null,
        responseReceivedAt: now,
        retryAttempt: 0,
        scheduledRetryAt: null,
        actorUserId: typeof input.actorUserId === "number" ? input.actorUserId : null,
        actorRole: input.actorRole ?? null,
        clientRequestId: input.clientRequestId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        invoiceNoSnapshot,
        grandTotalSnapshot: grandTotalSnapshot as any,
        invoiceStatusSnapshot,
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning({ id: einvoiceSubmissionAuditTable.id });

    if (auditRows?.[0]) {
      auditId = Number((auditRows[0] as any).id);
    }
  } catch {
    // non-fatal; try fallback lookup
    const fallback = (await conn
      .select({ id: einvoiceSubmissionAuditTable.id })
      .from(einvoiceSubmissionAuditTable as any)
      .where(and(
        eq(einvoiceSubmissionAuditTable.firmId, input.firmId),
        eq(einvoiceSubmissionAuditTable.idempotencyKey, idemKey),
      ))
      .limit(1))?.[0] as any;
    if (fallback) auditId = Number(fallback.id);
  }

  try {
    await appendInvoiceAuditTrail({
      firmId: input.firmId,
      invoiceId: input.invoiceId,
      actionType: "einvoice_submit_initiated",
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      statusBefore: einvoiceStatusSnapshot ?? invoiceStatusSnapshot ?? null,
      statusAfter: "QUEUED",
      delta: {
        integrationId,
        integrationProvider,
        idempotencyKey: idemKey,
        boundaryPassed: true,
      },
      clientRequestId: input.clientRequestId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      notes: "eInvoice boundary check passed; queued for provider submission",
    }, { tx: conn }).catch(() => undefined);
  } catch {
    // non-fatal
  }

  const queueToken = auditId ? `EINV_Q:${input.firmId}:${input.invoiceId}:${auditId}` : null;

  if (auditId == null) {
    auditId = 0;
  }

  return {
    auditId,
    boundaryPassed: true,
    boundaryErrorCode: null,
    boundaryErrorMessage: null,
    integrationId,
    integrationStatus: integrationStatus ?? "active",
    integrationProvider,
    invoiceId: input.invoiceId,
    firmId: input.firmId,
    einvoiceStatusSnapshot,
    invoiceStatusSnapshot,
    idempotencyKey: idemKey,
    canProceedToProvider: true,
    providerSubmitQueued: true,
    queueToken,
  };
}

export interface CheckEinvoiceIntegrationInput {
  firmId: number;
  provider?: string | null;
}

export interface CheckEinvoiceIntegrationResult {
  isConfigured: boolean;
  integrationId: number | null;
  integrationStatus: EinvoiceIntegrationStatus | null;
  provider: string | null;
  displayName: string | null;
  enableAutoSubmit: boolean;
  enableAutoCancel: boolean;
  enableAutoValidation: boolean;
  tin: string | null;
  firmMsicCode: string | null;
  lastConnectedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  configuredAt: Date | null;
}

export async function checkEinvoiceIntegration(
  input: CheckEinvoiceIntegrationInput,
  opts: { tx?: unknown } = {},
): Promise<CheckEinvoiceIntegrationResult> {
  const conn = pickDbConn(opts.tx);

  const providerFilter = input.provider && String(input.provider).trim() ? String(input.provider).trim() : null;

  const whereParts: any[] = [eq(einvoiceIntegrationsTable.firmId, input.firmId)];
  if (providerFilter) {
    whereParts.push(eq(einvoiceIntegrationsTable.provider, providerFilter));
  }

  const row = (await conn
    .select()
    .from(einvoiceIntegrationsTable as any)
    .where(and(...whereParts))
    .orderBy(desc(einvoiceIntegrationsTable.updatedAt))
    .limit(1))?.[0] as any;

  if (!row) {
    return {
      isConfigured: false,
      integrationId: null,
      integrationStatus: null,
      provider: providerFilter ?? null,
      displayName: null,
      enableAutoSubmit: false,
      enableAutoCancel: false,
      enableAutoValidation: false,
      tin: null,
      firmMsicCode: null,
      lastConnectedAt: null,
      lastError: null,
      lastErrorAt: null,
      configuredAt: null,
    };
  }

  const status = (row.status as EinvoiceIntegrationStatus) ?? "not_configured";
  const isConfigured = status === "active";

  return {
    isConfigured,
    integrationId: Number(row.id),
    integrationStatus: status,
    provider: row.provider ?? null,
    displayName: row.displayName ?? null,
    enableAutoSubmit: Boolean(row.enableAutoSubmit),
    enableAutoCancel: Boolean(row.enableAutoCancel),
    enableAutoValidation: Boolean(row.enableAutoValidation),
    tin: row.tin ?? null,
    firmMsicCode: row.firmMsicCode ?? null,
    lastConnectedAt: row.lastConnectedAt ?? null,
    lastError: row.lastError ?? null,
    lastErrorAt: row.lastErrorAt ?? null,
    configuredAt: row.configuredAt ?? null,
  };
}
