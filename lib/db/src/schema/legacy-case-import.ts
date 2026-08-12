import { pgTable, bigserial, text, integer, numeric, timestamp, index, uniqueIndex, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { casesTable } from "./cases.js";
import { firmsTable } from "./firms.js";

export const legacyCaseImportMappingTemplatesTable = pgTable("legacy_case_import_mapping_templates", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  firmId: integer("firm_id").notNull().references(() => firmsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  headerFingerprint: text("header_fingerprint"),
  sourceSheetName: text("source_sheet_name"),
  mappingJson: jsonb("mapping_json").notNull(),
  fixedValuesJson: jsonb("fixed_values_json"),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmNameUnique: uniqueIndex("legacy_case_import_mapping_templates_firm_name_key").on(t.firmId, t.name),
  firmHeaderFingerprintIdx: index("idx_legacy_case_import_mapping_tpl_firm_hfp").on(t.firmId, t.headerFingerprint),
}));

export const legacyCaseImportBatchesTable = pgTable("legacy_case_import_batches", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  firmId: integer("firm_id").notNull().references(() => firmsTable.id, { onDelete: "cascade" }),
  createdBy: integer("created_by").notNull(),
  sourceFileName: text("source_file_name").notNull(),
  sourceFileHash: text("source_file_hash").notNull(),
  sourceSheetName: text("source_sheet_name"),
  sourceFormat: text("source_format"),
  mappingTemplateId: integer("mapping_template_id").references(() => legacyCaseImportMappingTemplatesTable.id, { onDelete: "set null" }),
  headerFingerprint: text("header_fingerprint"),
  status: text("status").notNull(),
  optionsJson: jsonb("options_json").$type<Record<string, unknown>>(),
  totalRows: integer("total_rows").notNull().default(0),
  readyRows: integer("ready_rows").notNull().default(0),
  warningRows: integer("warning_rows").notNull().default(0),
  reviewRows: integer("review_rows").notNull().default(0),
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  importedRows: integer("imported_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  firmStatusIdx: index("idx_legacy_case_import_batches_firm_status").on(t.firmId, t.status),
  createdByIdx: index("idx_legacy_case_import_batches_created_by").on(t.createdBy),
  sourceFileHashFirmIdx: index("idx_legacy_case_import_batches_file_hash_firm").on(t.sourceFileHash, t.firmId),
}));

export const legacyCaseImportRowsTable = pgTable("legacy_case_import_rows", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  firmId: integer("firm_id").notNull().references(() => firmsTable.id, { onDelete: "cascade" }),
  batchId: integer("batch_id").notNull().references(() => legacyCaseImportBatchesTable.id, { onDelete: "cascade" }),
  sourceRowNo: integer("source_row_no").notNull(),
  sourceRowHash: text("source_row_hash"),
  sourceReference: text("source_reference"),
  rawRowJson: jsonb("raw_row_json"),
  mappedPayloadJson: jsonb("mapped_payload_json"),
  validationJson: jsonb("validation_json"),
  rowStatus: text("row_status").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  duplicateType: text("duplicate_type"),
  duplicateCaseId: integer("duplicate_case_id").references((): any => casesTable.id, { onDelete: "set null" }),
  duplicateScore: numeric("duplicate_score"),
  createdCaseId: integer("created_case_id").references((): any => casesTable.id, { onDelete: "set null" }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmBatchSourceRowUnique: uniqueIndex("legacy_case_import_rows_firm_batch_source_row_key").on(t.firmId, t.batchId, t.sourceRowNo),
  firmIdempotencyKeyUnique: uniqueIndex("legacy_case_import_rows_firm_idempotency_key_key").on(t.firmId, t.idempotencyKey),
  batchIdIdx: index("idx_legacy_case_import_rows_batch").on(t.batchId),
  rowStatusFirmIdx: index("idx_legacy_case_import_rows_status_firm").on(t.rowStatus, t.firmId),
}));

export const insertLegacyCaseImportBatchSchema = createInsertSchema(legacyCaseImportBatchesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLegacyCaseImportBatch = z.infer<typeof insertLegacyCaseImportBatchSchema>;
export type LegacyCaseImportBatch = typeof legacyCaseImportBatchesTable.$inferSelect;

export const insertLegacyCaseImportRowSchema = createInsertSchema(legacyCaseImportRowsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLegacyCaseImportRow = z.infer<typeof insertLegacyCaseImportRowSchema>;
export type LegacyCaseImportRow = typeof legacyCaseImportRowsTable.$inferSelect;

export const insertLegacyCaseImportMappingTemplateSchema = createInsertSchema(legacyCaseImportMappingTemplatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLegacyCaseImportMappingTemplate = z.infer<typeof insertLegacyCaseImportMappingTemplateSchema>;
export type LegacyCaseImportMappingTemplate = typeof legacyCaseImportMappingTemplatesTable.$inferSelect;
