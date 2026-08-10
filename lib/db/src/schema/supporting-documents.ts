import { pgTable, serial, text, integer, timestamp, index, date, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type SupportingDocumentScope = "case" | "project";
export type SupportingDocumentStatus = "active" | "superseded" | "archived";

export const supportingDocumentsTable = pgTable("supporting_documents", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),

  scope: text("scope").notNull().$type<SupportingDocumentScope>(),

  caseId: integer("case_id"),
  developerId: integer("developer_id"),
  projectId: integer("project_id"),
  phase: text("phase"),

  documentType: text("document_type").notNull().default("other"),
  documentName: text("document_name").notNull(),
  originalFilename: text("original_filename"),

  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),

  versionLabel: text("version_label"),
  versionNo: integer("version_no").notNull().default(1),

  status: text("status").notNull().$type<SupportingDocumentStatus>().default("active"),

  uploadedBy: integer("uploaded_by"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),

  remarks: text("remarks"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),

  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: integer("deleted_by"),
}, (t) => ({
  firmIdx: index("idx_supporting_docs_firm").on(t.firmId),
  firmScopeIdx: index("idx_supporting_docs_firm_scope").on(t.firmId, t.scope),
  firmCaseIdx: index("idx_supporting_docs_firm_case").on(t.firmId, t.caseId),
  firmProjectIdx: index("idx_supporting_docs_firm_project").on(t.firmId, t.projectId),
  firmDeveloperIdx: index("idx_supporting_docs_firm_developer").on(t.firmId, t.developerId),
  firmStatusIdx: index("idx_supporting_docs_firm_status").on(t.firmId, t.status),
  firmProjectPhaseIdx: index("idx_supporting_docs_firm_project_phase").on(t.firmId, t.projectId, t.phase),
  scopeCaseIdCheck: uniqueIndex("uq_supporting_docs_scope_case_check").on(
    t.id,
  ),
}));

export const insertSupportingDocumentSchema = createInsertSchema(supportingDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  uploadedAt: true,
});
export type InsertSupportingDocument = z.infer<typeof insertSupportingDocumentSchema>;
export type SupportingDocument = typeof supportingDocumentsTable.$inferSelect;
