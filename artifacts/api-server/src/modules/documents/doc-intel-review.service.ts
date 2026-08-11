import { and, eq } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, boolean, index, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  caseKeyDatesTable,
  casesTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

const docIntelExtractionJobsTable = pgTable("doc_intel_extraction_jobs", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id"),
  documentId: integer("document_id"),
  supportingDocumentId: integer("supporting_document_id"),
  sourceObjectPath: text("source_object_path"),
  sourceFileName: text("source_file_name"),
  sourceMimeType: text("source_mime_type"),
  jobType: text("job_type").notNull().default("auto_extract"),
  status: text("status").notNull().default("queued"),
  idempotencyKey: text("idempotency_key"),
  engineProvider: text("engine_provider"),
  engineModel: text("engine_model"),
  requestedByUserId: integer("requested_by_user_id"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costCurrency: text("cost_currency"),
  costAmount: text("cost_amount"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  rawExtractionJson: jsonb("raw_extraction_json"),
  candidateCount: integer("candidate_count").notNull().default(0),
  confirmedCount: integer("confirmed_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_doc_intel_jobs_firm").on(t.firmId),
  uqIdem: uniqueIndex("uq_doc_intel_jobs_idempotency").on(t.firmId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
}));

const docIntelExtractedCandidatesTable = pgTable("doc_intel_extracted_candidates", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  jobId: integer("job_id").notNull(),
  caseId: integer("case_id"),
  targetTable: text("target_table").notNull(),
  targetField: text("target_field").notNull(),
  fieldPath: text("field_path"),
  extractedValueText: text("extracted_value_text"),
  extractedValueJson: jsonb("extracted_value_json"),
  confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }),
  confidenceLevel: text("confidence_level").default("medium"),
  sourcePageNo: integer("source_page_no"),
  sourceBoundingBox: jsonb("source_bounding_box"),
  sourceSnippet: text("source_snippet"),
  candidateRank: integer("candidate_rank").notNull().default(1),
  reviewStatus: text("review_status").notNull().default("pending"),
  reviewedByUserId: integer("reviewed_by_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  appliedToField: boolean("applied_to_field").notNull().default(false),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

const docIntelConfirmationsAuditTable = pgTable("doc_intel_confirmations_audit", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  jobId: integer("job_id").notNull(),
  candidateId: integer("candidate_id"),
  caseId: integer("case_id"),
  targetTable: text("target_table"),
  targetField: text("target_field"),
  actionType: text("action_type").notNull(),
  beforeValueText: text("before_value_text"),
  afterValueText: text("after_value_text"),
  beforeValueJson: jsonb("before_value_json"),
  afterValueJson: jsonb("after_value_json"),
  actorUserId: integer("actor_user_id"),
  actorRole: text("actor_role"),
  confidenceAtDecision: text("confidence_at_decision"),
  idempotencyKey: text("idempotency_key"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdx: index("idx_doc_intel_audit_firm").on(t.firmId),
  uqIdem: uniqueIndex("uq_doc_intel_audit_idempotency").on(t.firmId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
}));

export type DocIntelConfirmAction = "confirm" | "reject" | "review_needed";

export interface CreateExtractionJobInput {
  firmId: number;
  caseId?: number | null;
  documentId?: number | null;
  supportingDocumentId?: number | null;
  sourceObjectPath?: string | null;
  sourceFileName?: string | null;
  sourceMimeType?: string | null;
  jobType?: string;
  engineProvider?: string | null;
  engineModel?: string | null;
  requestedByUserId?: number | null;
  idempotencyKey?: string | null;
}

export async function createExtractionJob(
  input: CreateExtractionJobInput,
  opts: { tx?: unknown } = {},
): Promise<{ jobId: number }> {
  const conn = pickDbConn(opts.tx);

  if (input.idempotencyKey) {
    const existing = (await conn
      .select({ id: docIntelExtractionJobsTable.id })
      .from(docIntelExtractionJobsTable as any)
      .where(and(
        eq(docIntelExtractionJobsTable.firmId, input.firmId),
        eq(docIntelExtractionJobsTable.idempotencyKey as any, input.idempotencyKey),
      ))
      .limit(1))?.[0];
    if (existing) {
      return { jobId: Number((existing as any).id) };
    }
  }

  const rows = await conn
    .insert(docIntelExtractionJobsTable as any)
    .values({
      firmId: input.firmId,
      caseId: typeof input.caseId === "number" ? input.caseId : null,
      documentId: typeof input.documentId === "number" ? input.documentId : null,
      supportingDocumentId: typeof input.supportingDocumentId === "number" ? input.supportingDocumentId : null,
      sourceObjectPath: input.sourceObjectPath ?? null,
      sourceFileName: input.sourceFileName ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      jobType: input.jobType ?? "auto_extract",
      status: "queued",
      idempotencyKey: input.idempotencyKey ?? null,
      engineProvider: input.engineProvider ?? null,
      engineModel: input.engineModel ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      requestedAt: new Date(),
      retryCount: 0,
      candidateCount: 0,
      confirmedCount: 0,
    } as any)
    .returning({ id: docIntelExtractionJobsTable.id });

  const row = rows?.[0];
  if (!row) throw new ApiError({ status: 500, code: "DOC_INTEL_JOB_CREATE_FAILED", message: "Extraction job insert returned no id", retryable: true });
  return { jobId: Number((row as any).id) };
}

export interface InsertExtractedCandidate {
  targetTable: string;
  targetField: string;
  fieldPath?: string | null;
  extractedValueText?: string | null;
  extractedValueJson?: Record<string, unknown> | null;
  confidenceScore?: string | number | null;
  confidenceLevel?: "low" | "medium" | "high" | null;
  sourcePageNo?: number | null;
  sourceBoundingBox?: Record<string, unknown> | null;
  sourceSnippet?: string | null;
  candidateRank?: number;
}

export interface InsertExtractedCandidatesInput {
  firmId: number;
  jobId: number;
  caseId?: number | null;
  candidates: InsertExtractedCandidate[];
}

export async function insertExtractedCandidates(
  input: InsertExtractedCandidatesInput,
  opts: { tx?: unknown } = {},
): Promise<{ insertedCount: number; candidateIds: number[] }> {
  const conn = pickDbConn(opts.tx);

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    return { insertedCount: 0, candidateIds: [] };
  }

  const values = input.candidates.map((c) => ({
    firmId: input.firmId,
    jobId: input.jobId,
    caseId: typeof input.caseId === "number" ? input.caseId : null,
    targetTable: String(c.targetTable ?? "").trim(),
    targetField: String(c.targetField ?? "").trim(),
    fieldPath: c.fieldPath ?? null,
    extractedValueText: c.extractedValueText ?? null,
    extractedValueJson: c.extractedValueJson ?? null,
    confidenceScore: c.confidenceScore != null ? String(c.confidenceScore) : null,
    confidenceLevel: c.confidenceLevel ?? "medium",
    sourcePageNo: c.sourcePageNo ?? null,
    sourceBoundingBox: c.sourceBoundingBox ?? null,
    sourceSnippet: c.sourceSnippet ?? null,
    candidateRank: typeof c.candidateRank === "number" ? c.candidateRank : 1,
    reviewStatus: "pending",
    appliedToField: false,
  }));

  const rows = await conn
    .insert(docIntelExtractedCandidatesTable as any)
    .values(values as any[])
    .returning({ id: docIntelExtractedCandidatesTable.id });

  const candidateIds = (rows ?? []).map((r) => Number((r as any).id));
  const insertedCount = candidateIds.length;

  if (insertedCount > 0) {
    await conn
      .update(docIntelExtractionJobsTable as any)
      .set({
        candidateCount: sql`candidate_count + ${insertedCount}` as any,
        updatedAt: new Date(),
      })
      .where(and(
        eq(docIntelExtractionJobsTable.firmId, input.firmId),
        eq(docIntelExtractionJobsTable.id, input.jobId),
      ));
  }

  return { insertedCount, candidateIds };
}

export interface ConfirmCandidateRejectionInput {
  firmId: number;
  jobId: number;
  candidateId?: number | null;
  caseId?: number | null;
  fieldKey: string;
  confirmAction: DocIntelConfirmAction;
  rejectReason?: string | null;
  actorUserId: number;
  actorRole?: string | null;
  beforeValueText?: string | null;
  afterValueText?: string | null;
  beforeValueJson?: Record<string, unknown> | null;
  afterValueJson?: Record<string, unknown> | null;
  confidenceAtDecision?: string | null;
  idempotencyKey?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function confirmCandidateRejection(
  input: ConfirmCandidateRejectionInput,
  opts: { tx?: unknown } = {},
): Promise<{ auditId: number }> {
  const conn = pickDbConn(opts.tx);

  const actionType = input.confirmAction === "confirm"
    ? "confirm"
    : input.confirmAction === "reject"
      ? "reject"
      : "review_needed";

  const notes = (() => {
    const parts: string[] = [];
    if (input.rejectReason) parts.push(input.rejectReason);
    if (actionType === "reject" && input.beforeValueText != null) {
      parts.push(`rejected_old_value: ${input.beforeValueText}`);
    }
    return parts.length ? parts.join(" | ") : null;
  })();

  const fieldParts = String(input.fieldKey ?? "").split(".");
  const targetTable = fieldParts.length >= 2 ? fieldParts[0] : (input.caseId ? "case_key_dates" : "unknown");
  const targetField = fieldParts.length >= 2 ? fieldParts.slice(1).join(".") : input.fieldKey;

  const rows = await conn
    .insert(docIntelConfirmationsAuditTable as any)
    .values({
      firmId: input.firmId,
      jobId: input.jobId,
      candidateId: typeof input.candidateId === "number" ? input.candidateId : null,
      caseId: typeof input.caseId === "number" ? input.caseId : null,
      targetTable,
      targetField,
      actionType,
      beforeValueText: input.beforeValueText ?? null,
      afterValueText: input.afterValueText ?? null,
      beforeValueJson: input.beforeValueJson ?? null,
      afterValueJson: input.afterValueJson ?? null,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole ?? null,
      confidenceAtDecision: input.confidenceAtDecision ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      notes,
    } as any)
    .returning({ id: docIntelConfirmationsAuditTable.id });

  const row = rows?.[0];
  if (!row) throw new ApiError({ status: 500, code: "DOC_INTEL_AUDIT_APPEND_FAILED", message: "Confirmation audit insert returned no id", retryable: true });

  if (typeof input.candidateId === "number") {
    const reviewStatus = actionType === "confirm" ? "confirmed" : actionType === "reject" ? "rejected" : "review_needed";
    await conn
      .update(docIntelExtractedCandidatesTable as any)
      .set({
        reviewStatus,
        reviewedByUserId: input.actorUserId,
        reviewedAt: new Date(),
        notes: input.rejectReason ?? null,
      } as any)
      .where(and(
        eq(docIntelExtractedCandidatesTable.firmId, input.firmId),
        eq(docIntelExtractedCandidatesTable.id, input.candidateId),
      ));
  }

  if (actionType === "confirm") {
    await conn
      .update(docIntelExtractionJobsTable as any)
      .set({
        confirmedCount: sql`confirmed_count + 1` as any,
        updatedAt: new Date(),
      })
      .where(and(
        eq(docIntelExtractionJobsTable.firmId, input.firmId),
        eq(docIntelExtractionJobsTable.id, input.jobId),
      ));
  }

  return { auditId: Number((row as any).id) };
}
