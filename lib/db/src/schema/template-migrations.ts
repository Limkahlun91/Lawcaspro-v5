import { pgTable, serial, text, integer, timestamp, index, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const docTemplateMigrationRunsTable = pgTable("doc_template_migration_runs", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  runType: text("run_type").notNull().default("bulk_field_migration"),
  sourceTemplateVersion: text("source_template_version"),
  targetTemplateVersion: text("target_template_version"),
  scopeFilterJson: jsonb("scope_filter_json"),
  status: text("status").notNull().default("queued"),
  idempotencyKey: text("idempotency_key"),
  requestedByUserId: integer("requested_by_user_id"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  totalTemplatesCount: integer("total_templates_count").notNull().default(0),
  templatesScannedCount: integer("templates_scanned_count").notNull().default(0),
  proposalsGeneratedCount: integer("proposals_generated_count").notNull().default(0),
  proposalsAcceptedCount: integer("proposals_accepted_count").notNull().default(0),
  proposalsRejectedCount: integer("proposals_rejected_count").notNull().default(0),
  proposalsAppliedCount: integer("proposals_applied_count").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  dryRun: boolean("dry_run").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_doc_tpl_mig_runs_firm").on(t.firmId),
  firmStatusIdx: index("idx_doc_tpl_mig_runs_firm_status").on(t.firmId, t.status, t.createdAt),
  firmTypeIdx: index("idx_doc_tpl_mig_runs_firm_type").on(t.firmId, t.runType, t.createdAt),
  uqDocTplMigRunsIdem: uniqueIndex("uq_doc_tpl_mig_runs_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export const docTemplateFieldMappingProposalsTable = pgTable("doc_template_field_mapping_proposals", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  migrationRunId: integer("migration_run_id").notNull(),
  templateId: integer("template_id"),
  templateName: text("template_name"),
  sourceFieldKey: text("source_field_key").notNull(),
  sourceFieldLabel: text("source_field_label"),
  sourceFieldType: text("source_field_type"),
  targetCaseField: text("target_case_field"),
  targetVariableKey: text("target_variable_key"),
  mappingStrategy: text("mapping_strategy").default("auto_suggest"),
  confidenceScore: text("confidence_score"),
  confidenceLevel: text("confidence_level").default("medium"),
  sampleValues: jsonb("sample_values"),
  transformRuleJson: jsonb("transform_rule_json"),
  reviewStatus: text("review_status").notNull().default("pending"),
  reviewedByUserId: integer("reviewed_by_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  applied: boolean("applied").notNull().default(false),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  appliedByUserId: integer("applied_by_user_id"),
  idempotencyKey: text("idempotency_key"),
  rejectionReason: text("rejection_reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_doc_tpl_map_prop_firm").on(t.firmId),
  firmRunIdx: index("idx_doc_tpl_map_prop_firm_run").on(t.firmId, t.migrationRunId),
  firmTplIdx: index("idx_doc_tpl_map_prop_firm_tpl").on(t.firmId, t.templateId),
  firmReviewIdx: index("idx_doc_tpl_map_prop_firm_review").on(t.firmId, t.reviewStatus),
  firmTargetIdx: index("idx_doc_tpl_map_prop_firm_target").on(t.firmId, t.targetCaseField),
  uqDocTplMapPropIdem: uniqueIndex("uq_doc_tpl_map_prop_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export type DocTemplateMigrationRun = typeof docTemplateMigrationRunsTable.$inferSelect;
export type InsertDocTemplateMigrationRun = typeof docTemplateMigrationRunsTable.$inferInsert;
export type DocTemplateFieldMappingProposal = typeof docTemplateFieldMappingProposalsTable.$inferSelect;
export type InsertDocTemplateFieldMappingProposal = typeof docTemplateFieldMappingProposalsTable.$inferInsert;
