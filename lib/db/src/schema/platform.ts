import { sql } from "drizzle-orm";
import { pgTable, serial, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const systemFoldersTable = pgTable("system_folders", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  parentId: integer("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  isDisabled: boolean("is_disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformDocumentsTable = pgTable("platform_documents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("general"),
  isActive: boolean("is_active").notNull().default(true),
  fileNamingRule: text("file_naming_rule"),
  clauseInsertionMode: text("clause_insertion_mode"),
  applicabilityMode: text("applicability_mode"),
  applicabilityRules: jsonb("applicability_rules"),
  checklistMode: text("checklist_mode"),
  checklistItems: jsonb("checklist_items"),
  appliesToPurchaseMode: text("applies_to_purchase_mode"),
  appliesToTitleType: text("applies_to_title_type").notNull().default("any"),
  appliesToCaseType: text("applies_to_case_type"),
  documentGroup: text("document_group").notNull().default("Others"),
  sortOrder: integer("sort_order").notNull().default(0),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size"),
  objectPath: text("object_path").notNull(),
  firmId: integer("firm_id"),
  folderId: integer("folder_id"),
  pdfMappings: jsonb("pdf_mappings"),
  uploadedBy: integer("uploaded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformMessagesTable = pgTable("platform_messages", {
  id: serial("id").primaryKey(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  fromFirmId: integer("from_firm_id"),
  fromUserId: integer("from_user_id").notNull(),
  toFirmId: integer("to_firm_id"),
  parentId: integer("parent_id"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformMessageAttachmentsTable = pgTable("platform_message_attachments", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull(),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size"),
  objectPath: text("object_path").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformClausesTable = pgTable("platform_clauses", {
  id: serial("id").primaryKey(),
  clauseCode: text("clause_code").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull().default("General"),
  language: text("language").notNull().default("en"),
  body: text("body").notNull(),
  notes: text("notes"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").notNull().default("draft"),
  isSystem: boolean("is_system").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  applicability: jsonb("applicability"),
  createdBy: integer("created_by"),
  updatedBy: integer("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  codeUq: uniqueIndex("uq_platform_clauses_code").on(t.clauseCode),
  statusIdx: index("idx_platform_clauses_status").on(t.status),
  categoryIdx: index("idx_platform_clauses_category").on(t.category),
  languageIdx: index("idx_platform_clauses_language").on(t.language),
  tagsIdx: index("idx_platform_clauses_tags").using("gin", t.tags),
}));
