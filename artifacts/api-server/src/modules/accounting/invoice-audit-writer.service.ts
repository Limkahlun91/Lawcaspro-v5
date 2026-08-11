import { and, eq, desc, sql } from "drizzle-orm";
import {
  db,
  invoiceAuditTrailTable,
  invoicesTable,
  receiptsTable,
  receiptAllocationsTable,
  caseLedgersTable,
  type AppDb,
  type RlsDb,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";
import type { InvoiceAuditActionType } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { nextReceiptNo } from "./firm-sequence-numbers.js";
import { syncCaseFinancialTotals } from "../../lib/caseFinancialSync.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

export interface AppendInvoiceAuditInput {
  firmId: number;
  invoiceId: number;
  actionType: InvoiceAuditActionType;
  actorUserId?: number | null;
  actorRole?: string | null;
  beforeSnapshot?: Record<string, unknown> | null;
  afterSnapshot?: Record<string, unknown> | null;
  delta?: Record<string, unknown> | null;
  amountChange?: string | number | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  reAuthVerified?: boolean;
  confirmationToken?: string | null;
  clientRequestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryCount?: number;
  receiptId?: number | null;
  paymentMethod?: string | null;
  bankReference?: string | null;
  paidAmount?: string | number | null;
  paidDate?: Date | string | null;
  notes?: string | null;
}

export async function appendInvoiceAuditTrail(
  input: AppendInvoiceAuditInput,
  opts: { tx?: unknown } = {},
): Promise<{ auditId: number }> {
  const conn = pickDbConn(opts.tx);
  const numericStr = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n.toFixed(2) : null;
  };
  const dateObj = (v: unknown): Date | null => {
    if (v instanceof Date) return v;
    if (typeof v === "string" && v) {
      const d = new Date(v);
      return Number.isFinite(d.getTime()) ? d : null;
    }
    return null;
  };
  const rows = await conn
    .insert(invoiceAuditTrailTable as any)
    .values({
      firmId: input.firmId,
      invoiceId: input.invoiceId,
      actionType: input.actionType,
      beforeSnapshot: input.beforeSnapshot ?? null,
      afterSnapshot: input.afterSnapshot ?? null,
      delta: input.delta ?? null,
      amountChange: numericStr(input.amountChange) as any,
      statusBefore: input.statusBefore ?? null,
      statusAfter: input.statusAfter ?? null,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      reAuthVerified: input.reAuthVerified === true,
      confirmationToken: input.confirmationToken ?? null,
      clientRequestId: input.clientRequestId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      retryCount: typeof input.retryCount === "number" ? input.retryCount : 0,
      receiptId: input.receiptId ?? null,
      paymentMethod: input.paymentMethod ?? null,
      bankReference: input.bankReference ?? null,
      paidAmount: numericStr(input.paidAmount) as any,
      paidDate: dateObj(input.paidDate),
      notes: input.notes ?? null,
    } as any)
    .returning({ id: (invoiceAuditTrailTable as any).id });
  const row = rows?.[0];
  if (!row) throw new ApiError({ status: 500, code: "INVOICE_AUDIT_APPEND_FAILED", message: "Audit insert returned no id", retryable: true });
  return { auditId: Number(row.id) };
}

export interface MarkInvoicePaidInput {
  firmId: number;
  invoiceId: number;
  actorUserId: number;
  paidAmount?: string | number | null;
  paidDate?: Date | string | null;
  paymentMethod?: string | null;
  bankReference?: string | null;
  notes?: string | null;
  clientRequestId?: string | null;
  reAuthVerified?: boolean;
}

export async function markInvoicePaid(
  input: MarkInvoicePaidInput,
  opts: { tx?: unknown } = {},
): Promise<{ invoiceId: number; invoice: any; receiptId: number; auditId: number }> {
  const rootConn = pickDbConn(opts.tx);
  const numeric = (v: unknown): string => {
    const n = typeof v === "number" ? v : Number(String(v ?? "0").replace(/,/g, ""));
    return (Number.isFinite(n) ? n : 0).toFixed(2);
  };

  return (rootConn as any).transaction(async (tx: any) => {
    const lockedRows = await tx
      .select({
        id: invoicesTable.id,
        firmId: invoicesTable.firmId,
        caseId: invoicesTable.caseId,
        quotationId: invoicesTable.quotationId,
        invoiceNo: invoicesTable.invoiceNo,
        status: invoicesTable.status,
        subtotal: invoicesTable.subtotal,
        taxTotal: invoicesTable.taxTotal,
        grandTotal: invoicesTable.grandTotal,
        amountPaid: invoicesTable.amountPaid,
        amountDue: invoicesTable.amountDue,
        issuedDate: invoicesTable.issuedDate,
        dueDate: invoicesTable.dueDate,
        notes: invoicesTable.notes,
        version: invoicesTable.version,
        deletedAt: invoicesTable.deletedAt,
        createdBy: invoicesTable.createdBy,
        createdAt: invoicesTable.createdAt,
        updatedAt: invoicesTable.updatedAt,
        einvoiceStatus: invoicesTable.einvoiceStatus,
      })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.firmId, input.firmId), eq(invoicesTable.id, input.invoiceId)))
      .for("update")
      .limit(1);

    const cur = (lockedRows ?? [])[0] as any;
    if (!cur) {
      throw new ApiError({ status: 404, code: "INVOICE_NOT_FOUND", message: "Invoice not found in firm scope [INVOICE_NOT_FOUND]", retryable: false });
    }
    if (cur.deletedAt) {
      throw new ApiError({ status: 409, code: "INVOICE_DELETED", message: "Invoice is soft-deleted; restore first", retryable: false });
    }
    if (cur.status === "void") {
      throw new ApiError({ status: 409, code: "INVOICE_VOID", message: "Void invoices cannot be marked paid", retryable: false });
    }

    const grandTotal = numeric(cur.grandTotal);
    const amountPaidPrev = numeric(cur.amountPaid);
    const payAmount = numeric(input.paidAmount ?? grandTotal);
    const newAmountPaid = (Number(amountPaidPrev) + Number(payAmount)).toFixed(2);
    const newAmountDue = Math.max(0, Number(grandTotal) - Number(newAmountPaid)).toFixed(2);

    const diffGrand = Number(grandTotal) - Number(newAmountPaid);
    const tolerance = 0.009;
    const newStatus: "draft" | "issued" | "paid" | "partial_paid" | "overpaid" | "void" | "pending_payment" =
      Math.abs(diffGrand) <= tolerance
        ? "paid"
        : diffGrand < -tolerance
          ? "overpaid"
          : "partial_paid";

    const paidDateObj = input.paidDate instanceof Date ? input.paidDate : (typeof input.paidDate === "string" && input.paidDate ? new Date(input.paidDate) : new Date());

    const receiptNo = await nextReceiptNo(tx, input.firmId).catch((err) => {
      logger.error({ err, firmId: input.firmId, invoiceId: input.invoiceId }, "invoice_paid.sequence_failed");
      throw new ApiError({ status: 500, code: "INVOICE_PAID_RECEIPT_SEQ_FAILED", message: "Unable to allocate receipt number", retryable: true });
    });

    const receiptRows = await tx
      .insert(receiptsTable as any)
      .values({
        firmId: input.firmId,
        caseId: typeof cur.caseId === "number" ? cur.caseId : null,
        invoiceId: input.invoiceId,
        receiptNo,
        paymentMethod: input.paymentMethod ?? "bank_transfer",
        amount: payAmount as any,
        receivedDate: paidDateObj,
        referenceNo: input.bankReference ?? input.clientRequestId ?? null,
        notes: input.notes ?? null,
        createdBy: input.actorUserId,
      } as any)
      .returning({ id: receiptsTable.id });

    const receiptId = Number(receiptRows?.[0]?.id ?? 0);
    if (!receiptId) {
      throw new ApiError({ status: 500, code: "INVOICE_PAID_RECEIPT_CREATE_FAILED", message: "Receipt insert returned no id; rollback", retryable: true });
    }

    const allocRows = await tx
      .insert(receiptAllocationsTable as any)
      .values({
        receiptId,
        invoiceId: input.invoiceId,
        amount: payAmount as any,
        notes: input.notes ?? null,
      } as any)
      .returning({ id: receiptAllocationsTable.id });
    if (!allocRows?.[0]) {
      throw new ApiError({ status: 500, code: "INVOICE_PAID_ALLOC_CREATE_FAILED", message: "Receipt allocation insert failed; rollback", retryable: true });
    }

    const updatedRows = await tx
      .update(invoicesTable as any)
      .set({
        amountPaid: newAmountPaid as any,
        amountDue: newAmountDue as any,
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(invoicesTable.firmId, input.firmId), eq(invoicesTable.id, input.invoiceId)))
      .returning({
        id: invoicesTable.id,
        firmId: invoicesTable.firmId,
        caseId: invoicesTable.caseId,
        status: invoicesTable.status,
        amountPaid: invoicesTable.amountPaid,
        amountDue: invoicesTable.amountDue,
        grandTotal: invoicesTable.grandTotal,
        deletedAt: invoicesTable.deletedAt,
      });

    const updatedInvoice = updatedRows?.[0] ?? cur;

    if (typeof cur.caseId === "number") {
      const txnDateOnly = new Date(paidDateObj.getFullYear(), paidDateObj.getMonth(), paidDateObj.getDate());
      const eventKey = `INVOICE_PAID:${input.invoiceId}`;
      const description = `Invoice ${cur.invoiceNo ?? `#${cur.id}`} paid (${payAmount}) via ${input.paymentMethod ?? "bank_transfer"}`;
      const amountNum = Number(payAmount);
      const cents = Math.round(amountNum * 100);
      try {
        await tx
          .insert(caseLedgersTable as any)
          .values({
            firmId: input.firmId,
            caseId: cur.caseId,
            transactionDate: txnDateOnly,
            entryCategory: "income",
            entryType: "receipt",
            description,
            amount: payAmount as any,
            debitCents: cents,
            creditCents: 0,
            sourceType: "invoice_paid",
            sourceId: input.invoiceId,
            sourceReference: receiptNo,
            eventKey,
          } as any)
          .onConflictDoNothing({ target: [caseLedgersTable.firmId, caseLedgersTable.eventKey] });
      } catch (ledgerErr) {
        logger.error({ err: ledgerErr, firmId: input.firmId, caseId: cur.caseId, eventKey }, "invoice_paid.case_ledger_upsert_failed");
        throw new ApiError({ status: 500, code: "INVOICE_PAID_LEDGER_FAILED", message: "Case ledger upsert failed; rollback", retryable: true });
      }

      try {
        await syncCaseFinancialTotals(tx as any, { firmId: input.firmId, caseId: cur.caseId });
      } catch (syncErr) {
        logger.error({ err: syncErr, firmId: input.firmId, caseId: cur.caseId, invoiceId: input.invoiceId }, "invoice_paid.case_financial_sync_failed");
        throw new ApiError({ status: 500, code: "INVOICE_PAID_SYNC_FAILED", message: "Case financial totals sync failed; rollback", retryable: true });
      }
    }

    const auditIdRes = await appendInvoiceAuditTrail({
      firmId: input.firmId,
      invoiceId: input.invoiceId,
      actionType: newStatus === "paid" ? "mark_paid" : "mark_partial_paid",
      actorUserId: input.actorUserId,
      beforeSnapshot: {
        status: cur.status,
        amountPaid: amountPaidPrev,
        amountDue: numeric(cur.amountDue),
        grandTotal,
      },
      afterSnapshot: {
        status: newStatus,
        amountPaid: newAmountPaid,
        amountDue: newAmountDue,
      },
      delta: {
        paidAmount: payAmount,
        paymentMethod: input.paymentMethod ?? null,
        bankReference: input.bankReference ?? null,
      },
      amountChange: payAmount,
      statusBefore: cur.status,
      statusAfter: newStatus,
      reAuthVerified: input.reAuthVerified === true,
      clientRequestId: input.clientRequestId ?? null,
      receiptId,
      paymentMethod: input.paymentMethod ?? null,
      bankReference: input.bankReference ?? null,
      paidAmount: payAmount,
      paidDate: paidDateObj,
      notes: input.notes ?? null,
    }, { tx });
    const auditId = auditIdRes.auditId;

    return { invoiceId: input.invoiceId, invoice: updatedInvoice, receiptId, auditId };
  });
}

export interface SoftDeleteInvoiceInput {
  firmId: number;
  invoiceId: number;
  actorUserId: number;
  confirmationReason: string;
  clientRequestId?: string | null;
  reAuthVerified?: boolean;
}

export async function softDeleteInvoice(
  input: SoftDeleteInvoiceInput,
  opts: { tx?: unknown } = {},
): Promise<{ deleted: boolean; auditId: number }> {
  const conn = pickDbConn(opts.tx);

  if (!input.confirmationReason || String(input.confirmationReason).trim().length < 6) {
    throw new ApiError({ status: 400, code: "DELETE_REASON_REQUIRED", message: "Deletion reason must be at least 6 characters (double-confirm audit) [DELETE_REASON_REQUIRED]", retryable: false });
  }

  const currentRow = (await conn
    .select({
      id: invoicesTable.id,
      firmId: invoicesTable.firmId,
      caseId: invoicesTable.caseId,
      invoiceNo: invoicesTable.invoiceNo,
      status: invoicesTable.status,
      grandTotal: invoicesTable.grandTotal,
      amountPaid: invoicesTable.amountPaid,
      amountDue: invoicesTable.amountDue,
      deletedAt: invoicesTable.deletedAt,
    })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.firmId, input.firmId), eq(invoicesTable.id, input.invoiceId)))
    .limit(1))?.[0];
  if (!currentRow) {
    throw new ApiError({ status: 404, code: "INVOICE_NOT_FOUND", message: "Invoice not found in firm scope [INVOICE_NOT_FOUND]", retryable: false });
  }
  const cur = currentRow as any;
  if (cur.deletedAt) {
    return { deleted: true, auditId: 0 };
  }
  if (cur.status === "paid" || cur.status === "partial_paid" || cur.status === "overpaid") {
    throw new ApiError({ status: 409, code: "INVOICE_PAID_DELETE_FORBIDDEN", message: "Paid invoices cannot be deleted. Issue credit note instead [INVOICE_PAID_DELETE_FORBIDDEN]", retryable: false });
  }
  if (input.reAuthVerified !== true) {
    throw new ApiError({ status: 401, code: "DELETE_REAUTH_REQUIRED", message: "Invoice delete requires recent re-auth verification (double-confirm) [DELETE_REAUTH_REQUIRED]", retryable: false });
  }

  await conn
    .update(invoicesTable as any)
    .set({ deletedAt: new Date(), updatedAt: new Date(), status: "void" })
    .where(and(eq(invoicesTable.firmId, input.firmId), eq(invoicesTable.id, input.invoiceId)));

  const auditId = (await appendInvoiceAuditTrail({
    firmId: input.firmId,
    invoiceId: input.invoiceId,
    actionType: "soft_delete",
    actorUserId: input.actorUserId,
    beforeSnapshot: { status: cur.status, deletedAt: null },
    afterSnapshot: { status: "void", deletedAt: new Date().toISOString() },
    delta: { confirmationReason: input.confirmationReason },
    statusBefore: cur.status,
    statusAfter: "void",
    reAuthVerified: true,
    clientRequestId: input.clientRequestId ?? null,
    notes: input.confirmationReason,
  }, { tx: conn })).auditId;

  return { deleted: true, auditId };
}

export interface RetryInvoiceActionInput {
  firmId: number;
  invoiceId: number;
  actionType: InvoiceAuditActionType;
  actorUserId: number;
  clientRequestId?: string | null;
}

export async function retryInvoiceAction(
  input: RetryInvoiceActionInput,
  opts: { tx?: unknown } = {},
): Promise<{ retryable: boolean; auditId: number }> {
  const conn = pickDbConn(opts.tx);

  const lastFailed = (await conn
    .select()
    .from(invoiceAuditTrailTable)
    .where(and(
      eq(invoiceAuditTrailTable.firmId, input.firmId),
      eq(invoiceAuditTrailTable.invoiceId, input.invoiceId),
      eq(invoiceAuditTrailTable.actionType, input.actionType),
    ))
    .orderBy(desc((invoiceAuditTrailTable as any).createdAt))
    .limit(1))?.[0];

  const prevCount = Number((lastFailed as any)?.retryCount ?? 0);
  if (prevCount >= 5) {
    throw new ApiError({ status: 429, code: "INVOICE_RETRY_EXHAUSTED", message: `Max retries (5) reached for ${input.actionType}. Manual intervention required [INVOICE_RETRY_EXHAUSTED].`, retryable: false });
  }

  const auditId = (await appendInvoiceAuditTrail({
    firmId: input.firmId,
    invoiceId: input.invoiceId,
    actionType: input.actionType,
    actorUserId: input.actorUserId,
    retryCount: prevCount + 1,
    clientRequestId: input.clientRequestId ?? null,
    beforeSnapshot: lastFailed ? { previous_error: (lastFailed as any).errorCode, previous_retry: prevCount } : null,
    notes: `Retry attempt ${prevCount + 1} of 5`,
  }, { tx: conn })).auditId;

  return { retryable: prevCount + 1 < 5, auditId };
}
