import { pgTable, serial, text, integer, timestamp, index, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const docIntelExtractionJobsTable = pgTable("doc_intel_extraction_jobs", {
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
  firmStatusIdx: index("idx_doc_intel_jobs_firm_status").on(t.firmId, t.status, t.createdAt),
  firmCaseIdx: index("idx_doc_intel_jobs_firm_case").on(t.firmId, t.caseId),
  firmDocIdx: index("idx_doc_intel_jobs_firm_doc").on(t.firmId, t.documentId),
  firmSupportingDocIdx: index("idx_doc_intel_jobs_firm_sdoc").on(t.firmId, t.supportingDocumentId),
  uqDocIntelJobsIdem: uniqueIndex("uq_doc_intel_jobs_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export const docIntelExtractedCandidatesTable = pgTable("doc_intel_extracted_candidates", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  jobId: integer("job_id").notNull(),
  caseId: integer("case_id"),
  targetTable: text("target_table").notNull(),
  targetField: text("target_field").notNull(),
  fieldPath: text("field_path"),
  extractedValueText: text("extracted_value_text"),
  extractedValueJson: jsonb("extracted_value_json"),
  confidenceScore: text("confidence_score"),
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
}, (t) => ({
  firmIdx: index("idx_doc_intel_candidates_firm").on(t.firmId),
  firmJobIdx: index("idx_doc_intel_candidates_firm_job").on(t.firmId, t.jobId),
  firmCaseIdx: index("idx_doc_intel_candidates_firm_case").on(t.firmId, t.caseId),
  firmTargetIdx: index("idx_doc_intel_candidates_firm_target").on(t.firmId, t.targetTable, t.targetField),
  firmReviewIdx: index("idx_doc_intel_candidates_firm_review").on(t.firmId, t.reviewStatus),
}));

export const docIntelConfirmationsAuditTable = pgTable("doc_intel_confirmations_audit", {
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
  firmJobIdx: index("idx_doc_intel_audit_firm_job").on(t.firmId, t.jobId),
  firmCandidateIdx: index("idx_doc_intel_audit_firm_candidate").on(t.firmId, t.candidateId),
  firmCaseIdx: index("idx_doc_intel_audit_firm_case").on(t.firmId, t.caseId),
  firmActionIdx: index("idx_doc_intel_audit_firm_action").on(t.firmId, t.actionType, t.createdAt),
  uqDocIntelAuditIdem: uniqueIndex("uq_doc_intel_audit_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export type DocIntelExtractionJob = typeof docIntelExtractionJobsTable.$inferSelect;
export type InsertDocIntelExtractionJob = typeof docIntelExtractionJobsTable.$inferInsert;
export type DocIntelExtractedCandidate = typeof docIntelExtractedCandidatesTable.$inferSelect;
export type InsertDocIntelExtractedCandidate = typeof docIntelExtractedCandidatesTable.$inferInsert;
export type DocIntelConfirmationAudit = typeof docIntelConfirmationsAuditTable.$inferSelect;
export type InsertDocIntelConfirmationAudit = typeof docIntelConfirmationsAuditTable.$inferInsert;
