import { pgTable, serial, integer, text, boolean, date, timestamp, index } from "drizzle-orm/pg-core";

export const developerDocumentsTable = pgTable("developer_documents", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  developerId: integer("developer_id").notNull(),
  documentName: text("document_name").notNull(),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  hasExpiry: boolean("has_expiry").notNull().default(false),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmDevIdx: index("idx_developer_documents_firm_developer").on(t.firmId, t.developerId),
  firmValidToIdx: index("idx_developer_documents_firm_valid_to").on(t.firmId, t.validTo),
}));

