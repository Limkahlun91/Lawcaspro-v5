import { eq, and, desc } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoiceItemsTable,
  eInvoiceSubmissionsTable,
} from "@workspace/db";
import type { EInvoiceClassification } from "./classification.js";
import { classifyInvoiceLineForEInvoice, resolveHeaderClassification } from "./classification.js";
import {
  buildSubmissionIdempotencyKey,
  isSandboxEnabled,
  sandboxSubmitInvoice,
  sandboxValidateSubmission,
  isTransitionAllowed,
  type EInvoiceStatus,
} from "./sandbox-adapter.js";

export type PrepareResult = {
  invoiceId: number;
  classification: EInvoiceClassification | null;
  lineClassifications: Array<{ lineId: number | null; description: string; classification: EInvoiceClassification }>;
  statusBefore: string;
  statusAfter: EInvoiceStatus;
  eligible: boolean;
  eligibilityReason?: string;
  payloadPreview: Record<string, unknown>;
  idempotencyKey: string;
};

export type SubmitResult = {
  invoiceId: number;
  submissionId: number;
  idempotencyKey: string;
  isNewSubmission: boolean;
  status: EInvoiceStatus;
  externalSubmissionId?: string;
  errorCode?: string;
  errorMessage?: string;
  skippedDueToDuplicateSourceLink?: boolean;
};

export type ConsolidatedSubmitItem = {
  invoiceId: number;
  success: boolean;
  error?: string;
  submissionId?: number;
  status?: string;
};

export type ConsolidatedSubmitResult = {
  successCount: number;
  failCount: number;
  perItem: ConsolidatedSubmitItem[];
};

export type DbConn = typeof db;

export async function prepareInvoiceForEInvoice(
  r: DbConn,
  args: { firmId: number; invoiceId: number },
): Promise<PrepareResult> {
  const [inv] = await r
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, args.invoiceId), eq(invoicesTable.firmId, args.firmId)));
  if (!inv) throw new Error("INVOICE_NOT_FOUND");

  const items = await r
    .select()
    .from(invoiceItemsTable)
    .where(eq(invoiceItemsTable.invoiceId, inv.id))
    .orderBy(invoiceItemsTable.sortOrder);

  const lineClassifications = items.map((i) => ({
    lineId: i.id,
    description: i.description,
    classification: classifyInvoiceLineForEInvoice({
      description: i.description,
      itemType: i.itemType,
      itemCategory: i.itemCategory,
    }),
  }));

  const headerClass = resolveHeaderClassification(items);

  const invStatus = String(inv.status ?? "");
  const eligible =
    (invStatus === "draft" || invStatus === "issued" || invStatus === "partially_paid" || invStatus === "paid") &&
    Number(inv.grandTotal ?? 0) > 0;

  let nextStatus: EInvoiceStatus = String(inv.einvoiceStatus ?? "DRAFT") as EInvoiceStatus;
  if (eligible && (nextStatus === "DRAFT" || nextStatus === "ERROR")) {
    nextStatus = "READY";
  }
  const eligibilityReason = eligible
    ? undefined
    : Number(inv.grandTotal ?? 0) <= 0
      ? "Zero-amount invoices are not eligible"
      : `Invoice status '${invStatus}' not eligible (need draft/issued/paid)`;

  if (nextStatus !== String(inv.einvoiceStatus ?? "DRAFT")) {
    if (isTransitionAllowed(String(inv.einvoiceStatus ?? "DRAFT") as EInvoiceStatus, nextStatus)) {
      await r
        .update(invoicesTable)
        .set({
          einvoiceStatus: nextStatus,
          einvoiceClassification: headerClass,
          updatedAt: new Date(),
        })
        .where(eq(invoicesTable.id, inv.id));
    }
  } else if (headerClass && !inv.einvoiceClassification) {
    await r
      .update(invoicesTable)
      .set({ einvoiceClassification: headerClass, updatedAt: new Date() })
      .where(eq(invoicesTable.id, inv.id));
  }

  const idempotencyKey = buildSubmissionIdempotencyKey(args.firmId, args.invoiceId);

  const payloadPreview = buildMyInvoisPayloadPreview({
    invoice: inv,
    items,
    classification: headerClass ?? "OFFICE_INCOME",
    lineClassifications,
  });

  return {
    invoiceId: inv.id,
    classification: headerClass,
    lineClassifications,
    statusBefore: String(inv.einvoiceStatus ?? "DRAFT"),
    statusAfter: nextStatus,
    eligible,
    eligibilityReason,
    payloadPreview,
    idempotencyKey,
  };
}

export async function submitInvoiceEInvoice(
  r: DbConn,
  args: { firmId: number; invoiceId: number; actorId: number; actorType: string; ipAddress?: string; userAgent?: string },
): Promise<SubmitResult> {
  if (!isSandboxEnabled()) {
    throw new Error("EINVOICE_SANDBOX_DISABLED");
  }

  const [inv] = await r
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, args.invoiceId), eq(invoicesTable.firmId, args.firmId)));
  if (!inv) throw new Error("INVOICE_NOT_FOUND");

  if (inv.einvoiceSourceInvoiceId) {
    const [src] = await r
      .select({ status: invoicesTable.einvoiceStatus })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, Number(inv.einvoiceSourceInvoiceId)));
    if (src && (src.status === "VALID" || src.status === "SUBMITTED")) {
      return {
        invoiceId: inv.id,
        submissionId: 0,
        idempotencyKey: buildSubmissionIdempotencyKey(args.firmId, args.invoiceId),
        isNewSubmission: false,
        status: String(inv.einvoiceStatus ?? "DRAFT") as EInvoiceStatus,
        skippedDueToDuplicateSourceLink: true,
        errorMessage: "Source invoice already has a VALID/SUBMITTED submission — double invoicing prevented.",
        errorCode: "DOUBLE_INVOICE_GUARD",
      };
    }
  }

  const prepared = await prepareInvoiceForEInvoice(r, { firmId: args.firmId, invoiceId: args.invoiceId });
  if (!prepared.eligible) {
    throw new Error(`NOT_ELIGIBLE: ${prepared.eligibilityReason ?? "unknown"}`);
  }

  const idempotencyKey = buildSubmissionIdempotencyKey(args.firmId, args.invoiceId);
  const now = new Date();

  const [existingSub] = await r
    .select()
    .from(eInvoiceSubmissionsTable)
    .where(eq(eInvoiceSubmissionsTable.submissionIdempotencyKey, idempotencyKey))
    .limit(1);

  if (existingSub) {
    return {
      invoiceId: inv.id,
      submissionId: existingSub.id,
      idempotencyKey,
      isNewSubmission: false,
      status: existingSub.status as EInvoiceStatus,
      externalSubmissionId: existingSub.externalSubmissionId ?? undefined,
      errorCode: existingSub.errorCode ?? undefined,
      errorMessage: existingSub.errorMessage ?? undefined,
    };
  }

  await r.update(invoicesTable).set({ einvoiceStatus: "SUBMITTING", updatedAt: now }).where(eq(invoicesTable.id, inv.id));

  const submitRes = await sandboxSubmitInvoice(args.firmId, args.invoiceId, prepared.payloadPreview);

  let finalStatus: EInvoiceStatus = submitRes.status;
  let externalId: string | undefined = submitRes.externalSubmissionId;
  let finalResp = submitRes.responseJson;
  let finalErrorCode: string | undefined = submitRes.errorCode;
  let finalErrorMessage: string | undefined = submitRes.errorMessage;

  if (submitRes.status === "SUBMITTED") {
    const validateRes = await sandboxValidateSubmission(submitRes.externalSubmissionId);
    finalStatus = validateRes.status;
    finalResp = { ...submitRes.responseJson, validation: validateRes.responseJson };
    if (validateRes.status === "INVALID") {
      finalErrorCode = finalErrorCode ?? "SBX_V_INVALID";
      finalErrorMessage = finalErrorMessage ?? "Sandbox validation returned INVALID";
    }
  }

  const [inserted] = await r
    .insert(eInvoiceSubmissionsTable)
    .values({
      firmId: args.firmId,
      invoiceId: inv.id,
      submissionIdempotencyKey: idempotencyKey,
      status: finalStatus,
      externalSubmissionId: externalId ?? null,
      payloadJson: prepared.payloadPreview as any,
      responseJson: finalResp as any,
      submittedAt: now,
      lastCheckedAt: now,
      errorCode: finalErrorCode ?? null,
      errorMessage: finalErrorMessage ?? null,
      retryCount: 0,
      createdAt: now,
    })
    .returning()
    .onConflictDoNothing();

  const submission = inserted ?? existingSub;
  const retryCount = submission?.retryCount ?? 0;

  await r
    .update(invoicesTable)
    .set({
      einvoiceStatus: finalStatus,
      einvoiceExternalSubmissionId: externalId ?? null,
      einvoiceSubmittedAt: now,
      einvoiceLastCheckedAt: now,
      einvoiceErrorCode: finalErrorCode ?? null,
      einvoiceErrorMessage: finalErrorMessage ?? null,
      einvoiceRetryCount: retryCount,
      updatedAt: now,
    })
    .where(eq(invoicesTable.id, inv.id));

  return {
    invoiceId: inv.id,
    submissionId: (submission?.id ?? 0) as number,
    idempotencyKey,
    isNewSubmission: !!inserted,
    status: finalStatus,
    externalSubmissionId: externalId,
    errorCode: finalErrorCode,
    errorMessage: finalErrorMessage,
  };
}

export async function retryInvoiceEInvoice(
  r: DbConn,
  args: { firmId: number; invoiceId: number },
): Promise<SubmitResult> {
  if (!isSandboxEnabled()) throw new Error("EINVOICE_SANDBOX_DISABLED");

  const [inv] = await r
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, args.invoiceId), eq(invoicesTable.firmId, args.firmId)));
  if (!inv) throw new Error("INVOICE_NOT_FOUND");

  const current = String(inv.einvoiceStatus ?? "DRAFT") as EInvoiceStatus;
  if (current !== "ERROR" && current !== "RETRY_PENDING" && current !== "INVALID") {
    throw new Error(`RETRY_NOT_ALLOWED: current status is ${current}`);
  }

  const idempotencyKey = buildSubmissionIdempotencyKey(args.firmId, args.invoiceId, 2);

  const newRetry = (inv.einvoiceRetryCount ?? 0) + 1;
  await r
    .update(invoicesTable)
    .set({ einvoiceStatus: "RETRY_PENDING", einvoiceRetryCount: newRetry, updatedAt: new Date() })
    .where(eq(invoicesTable.id, inv.id));

  const [prevSub] = await r
    .select()
    .from(eInvoiceSubmissionsTable)
    .where(and(eq(eInvoiceSubmissionsTable.invoiceId, inv.id), eq(eInvoiceSubmissionsTable.firmId, args.firmId)))
    .orderBy(desc(eInvoiceSubmissionsTable.createdAt))
    .limit(1);
  if (prevSub) {
    await r
      .update(eInvoiceSubmissionsTable)
      .set({ retryCount: (prevSub.retryCount ?? 0) + 1, lastCheckedAt: new Date() })
      .where(eq(eInvoiceSubmissionsTable.id, prevSub.id));
  }

  return submitInvoiceEInvoice(r, {
    firmId: args.firmId,
    invoiceId: args.invoiceId,
    actorId: 0,
    actorType: "system",
  });
}

export async function getInvoiceEInvoiceStatus(
  r: DbConn,
  args: { firmId: number; invoiceId: number },
) {
  const [inv] = await r
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, args.invoiceId), eq(invoicesTable.firmId, args.firmId)));
  if (!inv) throw new Error("INVOICE_NOT_FOUND");

  const submissions = await r
    .select()
    .from(eInvoiceSubmissionsTable)
    .where(and(eq(eInvoiceSubmissionsTable.invoiceId, inv.id), eq(eInvoiceSubmissionsTable.firmId, args.firmId)))
    .orderBy(desc(eInvoiceSubmissionsTable.createdAt));

  return {
    invoice: {
      id: inv.id,
      einvoiceStatus: inv.einvoiceStatus,
      einvoiceExternalSubmissionId: inv.einvoiceExternalSubmissionId,
      einvoiceSubmittedAt: inv.einvoiceSubmittedAt,
      einvoiceLastCheckedAt: inv.einvoiceLastCheckedAt,
      einvoiceErrorCode: inv.einvoiceErrorCode,
      einvoiceErrorMessage: inv.einvoiceErrorMessage,
      einvoiceRetryCount: inv.einvoiceRetryCount,
      einvoiceClassification: inv.einvoiceClassification,
      einvoiceSourceInvoiceId: inv.einvoiceSourceInvoiceId,
    },
    submissions,
  };
}

export async function submitConsolidatedEInvoices(
  r: DbConn,
  args: { firmId: number; invoiceIds: number[]; actorId: number; actorType: string; ipAddress?: string; userAgent?: string },
): Promise<ConsolidatedSubmitResult> {
  const perItem: ConsolidatedSubmitItem[] = [];
  let successCount = 0;
  let failCount = 0;

  const uniqueIds = Array.from(new Set(args.invoiceIds.filter((n) => Number.isInteger(n) && n > 0)));

  for (const id of uniqueIds) {
    try {
      const res = await submitInvoiceEInvoice(r, { ...args, invoiceId: id });
      const ok = res.status === "SUBMITTED" || res.status === "VALID";
      if (ok) successCount++;
      else failCount++;
      perItem.push({
        invoiceId: id,
        success: ok,
        submissionId: res.submissionId || undefined,
        status: res.status,
        error: res.errorMessage,
      });
    } catch (e: any) {
      failCount++;
      perItem.push({
        invoiceId: id,
        success: false,
        error: e?.message ?? String(e),
      });
    }
  }

  return { successCount, failCount, perItem };
}

export function buildMyInvoisPayloadPreview(args: {
  invoice: any;
  items: any[];
  classification: EInvoiceClassification;
  lineClassifications: Array<{ classification: EInvoiceClassification }>;
}): Record<string, unknown> {
  const { invoice, items, classification, lineClassifications } = args;
  return {
    schemaVersion: "1.0-sandbox",
    documentType: "INVOICE",
    classification,
    issuer: {
      firmId: invoice.firmId,
      tin: "SANDBOX-TIN-FIRM",
      sst: "SANDBOX-SST",
      msic: "69100",
    },
    invoiceReference: {
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.issuedDate ?? new Date().toISOString().slice(0, 10),
    },
    currency: "MYR",
    totals: {
      subtotal: String(invoice.subtotal ?? "0"),
      taxTotal: String(invoice.taxTotal ?? "0"),
      grandTotal: String(invoice.grandTotal ?? "0"),
    },
    lines: items.map((it, i) => ({
      idx: i,
      description: it.description,
      itemType: it.itemType,
      classification: lineClassifications[i]?.classification ?? "OFFICE_INCOME",
      amountExclTax: String(it.amountExclTax ?? "0"),
      taxRate: String(it.taxRate ?? "0"),
      taxAmount: String(it.taxAmount ?? "0"),
      amountInclTax: String(it.amountInclTax ?? "0"),
    })),
  };
}
