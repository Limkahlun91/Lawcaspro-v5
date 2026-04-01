import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const casesTable = pgTable("cases", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  projectId: integer("project_id").notNull(),
  developerId: integer("developer_id").notNull(),
  referenceNo: text("reference_no").notNull(),
  purchaseMode: text("purchase_mode").notNull().default("cash"),
  titleType: text("title_type").notNull().default("master"),
  spaPrice: numeric("spa_price", { precision: 15, scale: 2 }),
  status: text("status").notNull().default("File Opened / SPA Pending Signing"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const casePurchasersTable = pgTable("case_purchasers", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  clientId: integer("client_id").notNull(),
  role: text("role").notNull().default("main"),
  orderNo: integer("order_no").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const caseAssignmentsTable = pgTable("case_assignments", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  userId: integer("user_id").notNull(),
  roleInCase: text("role_in_case").notNull().default("lawyer"),
  assignedBy: integer("assigned_by"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
});

export const caseWorkflowStepsTable = pgTable("case_workflow_steps", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  stepKey: text("step_key").notNull(),
  stepName: text("step_name").notNull(),
  stepOrder: integer("step_order").notNull(),
  status: text("status").notNull().default("pending"),
  pathType: text("path_type").notNull().default("common"),
  completedBy: integer("completed_by"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const caseNotesTable = pgTable("case_notes", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  authorId: integer("author_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id"),
  actorId: integer("actor_id"),
  actorType: text("actor_type").notNull().default("firm_user"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: integer("entity_id"),
  detail: text("detail"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCaseSchema = createInsertSchema(casesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCase = z.infer<typeof insertCaseSchema>;
export type Case = typeof casesTable.$inferSelect;
