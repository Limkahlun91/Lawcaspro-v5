import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const documentTemplatesTable = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  name: text("name").notNull(),
  documentType: text("document_type").notNull().default("other"),
  description: text("description"),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const caseDocumentsTable = pgTable("case_documents", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  firmId: integer("firm_id").notNull(),
  templateId: integer("template_id"),
  name: text("name").notNull(),
  documentType: text("document_type").notNull().default("generated"),
  status: text("status").notNull().default("draft"),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size"),
  isUploaded: boolean("is_uploaded").notNull().default(false),
  generatedBy: integer("generated_by"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
