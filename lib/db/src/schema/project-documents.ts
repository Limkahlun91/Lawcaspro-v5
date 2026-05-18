import { pgTable, serial, integer, text, boolean, date, timestamp, index } from "drizzle-orm/pg-core";

export const projectDocumentsTable = pgTable("project_documents", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  projectId: integer("project_id").notNull(),
  category: text("category").notNull(),
  documentName: text("document_name").notNull(),
  licenseNumber: text("license_number"),
  bankName: text("bank_name"),
  documentDate: date("document_date"),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  hasExpiry: boolean("has_expiry").notNull().default(false),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmProjectIdx: index("idx_project_documents_firm_project").on(t.firmId, t.projectId),
  firmCategoryIdx: index("idx_project_documents_firm_category").on(t.firmId, t.category),
}));
