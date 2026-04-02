import { pgTable, serial, text, integer, numeric, boolean, date, timestamp } from "drizzle-orm/pg-core";

export const timeEntriesTable = pgTable("time_entries", {
  id:           serial("id").primaryKey(),
  firmId:       integer("firm_id").notNull(),
  caseId:       integer("case_id").notNull(),
  userId:       integer("user_id").notNull(),
  entryDate:    date("entry_date").notNull(),
  description:  text("description").notNull(),
  hours:        numeric("hours", { precision: 6, scale: 2 }).notNull(),
  ratePerHour:  numeric("rate_per_hour", { precision: 10, scale: 2 }).notNull().default("0"),
  isBillable:   boolean("is_billable").notNull().default(true),
  isBilled:     boolean("is_billed").notNull().default(false),
  invoiceId:    integer("invoice_id"),
  createdBy:    integer("created_by"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const caseTasksTable = pgTable("case_tasks", {
  id:           serial("id").primaryKey(),
  firmId:       integer("firm_id").notNull(),
  caseId:       integer("case_id").notNull(),
  title:        text("title").notNull(),
  description:  text("description"),
  assignedTo:   integer("assigned_to"),
  dueDate:      date("due_date"),
  priority:     text("priority").notNull().default("normal"),
  status:       text("status").notNull().default("open"),
  completedAt:  timestamp("completed_at", { withTimezone: true }),
  completedBy:  integer("completed_by"),
  createdBy:    integer("created_by"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
