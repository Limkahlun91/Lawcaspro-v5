import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const firmDocumentFoldersTable = pgTable("firm_document_folders", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  name: text("name").notNull(),
  parentId: integer("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_firm_doc_folders_firm").on(t.firmId),
  parentIdx: index("idx_firm_doc_folders_parent").on(t.firmId, t.parentId),
  nameUnique: uniqueIndex("uq_firm_doc_folders_name").on(t.firmId, t.parentId, t.name),
}));

export const firmLetterheadsTable = pgTable("firm_letterheads", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isDefault: boolean("is_default").notNull().default(false),
  status: text("status").notNull().default("active"),
  footerMode: text("footer_mode").notNull().default("every_page"),
  firstPageObjectPath: text("first_page_object_path").notNull(),
  firstPageFileName: text("first_page_file_name").notNull(),
  firstPageMimeType: text("first_page_mime_type").notNull(),
  firstPageExtension: text("first_page_extension").notNull(),
  firstPageFileSize: integer("first_page_file_size"),
  continuationHeaderObjectPath: text("continuation_header_object_path").notNull(),
  continuationHeaderFileName: text("continuation_header_file_name").notNull(),
  continuationHeaderMimeType: text("continuation_header_mime_type").notNull(),
  continuationHeaderExtension: text("continuation_header_extension").notNull(),
  continuationHeaderFileSize: integer("continuation_header_file_size"),
  footerObjectPath: text("footer_object_path"),
  footerFileName: text("footer_file_name"),
  footerMimeType: text("footer_mime_type"),
  footerExtension: text("footer_extension"),
  footerFileSize: integer("footer_file_size"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_firm_letterheads_firm").on(t.firmId),
  defaultIdx: index("idx_firm_letterheads_default").on(t.firmId, t.isDefault),
}));

export const insertFirmDocumentFolderSchema = createInsertSchema(firmDocumentFoldersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFirmDocumentFolder = z.infer<typeof insertFirmDocumentFolderSchema>;
export type FirmDocumentFolder = typeof firmDocumentFoldersTable.$inferSelect;

export const insertFirmLetterheadSchema = createInsertSchema(firmLetterheadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFirmLetterhead = z.infer<typeof insertFirmLetterheadSchema>;
export type FirmLetterhead = typeof firmLetterheadsTable.$inferSelect;

