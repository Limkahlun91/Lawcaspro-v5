import { pgTable, serial, text, integer, timestamp, index, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const bankExportAdaptersTable = pgTable("bank_export_adapters", {
  id: serial("id").primaryKey(),
  adapterCode: text("adapter_code").notNull(),
  bankName: text("bank_name").notNull(),
  bankShortCode: text("bank_short_code"),
  status: text("status").notNull().default("Upcoming"),
  adapterType: text("adapter_type").notNull().default("statement_csv"),
  version: text("version").notNull().default("1.0.0"),
  description: text("description"),
  supportedFileTypes: jsonb("supported_file_types").$type<string[]>().notNull().default([]),
  parserConfigJson: jsonb("parser_config_json"),
  columnMappingJson: jsonb("column_mapping_json"),
  dateFormat: text("date_format"),
  amountFormat: text("amount_format"),
  encoding: text("encoding").default("utf-8"),
  hasHeaderRow: boolean("has_header_row").notNull().default(true),
  headerRowCount: integer("header_row_count").notNull().default(1),
  skipFooterRows: integer("skip_footer_rows").notNull().default(0),
  delimiter: text("delimiter"),
  requiresBalanceColumn: boolean("requires_balance_column").notNull().default(false),
  autoDetectEnabled: boolean("auto_detect_enabled").notNull().default(false),
  validationRulesJson: jsonb("validation_rules_json"),
  transformPipelineJson: jsonb("transform_pipeline_json"),
  documentationUrl: text("documentation_url"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
  successorAdapterId: integer("successor_adapter_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  isVisible: boolean("is_visible").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uqBankAdapterCode: uniqueIndex("uq_bank_export_adapters_code").on(t.adapterCode),
  statusIdx: index("idx_bank_export_adapters_status").on(t.status),
  visibleIdx: index("idx_bank_export_adapters_visible").on(t.isVisible, t.sortOrder),
}));

export type BankExportAdapter = typeof bankExportAdaptersTable.$inferSelect;
export type InsertBankExportAdapter = typeof bankExportAdaptersTable.$inferInsert;
