import { pgTable, serial, integer, text, timestamp, jsonb, numeric, index } from "drizzle-orm/pg-core";

export const documentExtractionJobsTable = pgTable("document_extraction_jobs", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  caseDocumentId: integer("case_document_id").notNull(),
  status: text("status").notNull().default("queued"),
  extractionMethod: text("extraction_method"),
  documentTypeGuess: text("document_type_guess"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedBy: integer("archived_by"),
  archivedReason: text("archived_reason"),
}, (t) => ({
  caseIdx: index("idx_document_extraction_jobs_case").on(t.firmId, t.caseId, t.caseDocumentId, t.createdAt),
  archivedAtIdx: index("idx_document_extraction_jobs_archived").on(t.firmId, t.archivedAt),
}));

export const documentExtractionResultsTable = pgTable("document_extraction_results", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  rawText: text("raw_text"),
  structuredResultJson: jsonb("structured_result_json"),
  warnings: jsonb("warnings"),
  confidenceSummary: jsonb("confidence_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  jobIdx: index("idx_document_extraction_results_job").on(t.jobId),
}));

export const documentExtractionSuggestionsTable = pgTable("document_extraction_suggestions", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  fieldKey: text("field_key").notNull(),
  suggestedValue: text("suggested_value"),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  sourcePage: integer("source_page"),
  sourceSnippet: text("source_snippet"),
  documentTypeGuess: text("document_type_guess"),
  targetEntityType: text("target_entity_type"),
  targetEntityId: integer("target_entity_id"),
  targetEntityPath: text("target_entity_path"),
  suggestedTargetCandidates: jsonb("suggested_target_candidates"),
  chosenTargetCandidate: jsonb("chosen_target_candidate"),
  acceptedBy: integer("accepted_by"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  rejectedBy: integer("rejected_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  jobIdx: index("idx_document_extraction_suggestions_job").on(t.jobId),
}));
