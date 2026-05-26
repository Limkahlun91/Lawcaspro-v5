import { pgTable, bigserial, bigint, integer, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const documentGenerationLogsTable = pgTable("document_generation_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  firmId: integer("firm_id").notNull(),
  userId: integer("user_id").notNull(),
  caseId: integer("case_id"),
  actionType: text("action_type").notNull(),
  fileNames: jsonb("file_names").notNull().default(sql`'[]'::jsonb`),
  caseIds: jsonb("case_ids").notNull().default(sql`'[]'::jsonb`),
  generatedFiles: jsonb("generated_files").notNull().default(sql`'[]'::jsonb`),
  printCopies: integer("print_copies"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  copiesConfigured: integer("copies_configured"),
  printSettings: jsonb("print_settings"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmCreatedAtIdx: index("idx_document_generation_logs_firm_created_at").on(t.firmId, t.createdAt),
  firmCaseIdx: index("idx_document_generation_logs_firm_case").on(t.firmId, t.caseId),
  firmActionIdx: index("idx_document_generation_logs_firm_action").on(t.firmId, t.actionType),
}));

export const documentGenerationLogCasesTable = pgTable("document_generation_log_cases", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  firmId: integer("firm_id").notNull(),
  logId: bigint("log_id", { mode: "number" }).notNull(),
  caseId: integer("case_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmLogIdx: index("idx_document_generation_log_cases_firm_log").on(t.firmId, t.logId),
  firmCaseIdx: index("idx_document_generation_log_cases_firm_case").on(t.firmId, t.caseId),
  uniqueLogCase: uniqueIndex("document_generation_log_cases_log_case_key").on(t.logId, t.caseId),
}));
