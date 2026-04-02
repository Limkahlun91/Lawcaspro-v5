import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const communicationThreadsTable = pgTable("communication_threads", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  firmId: integer("firm_id").notNull(),
  subject: text("subject").notNull(),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const caseCommunicationsTable = pgTable("case_communications", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  firmId: integer("firm_id").notNull(),
  threadId: integer("thread_id"),
  type: text("type").notNull().default("email"),
  direction: text("direction").notNull().default("outgoing"),
  recipientName: text("recipient_name"),
  recipientContact: text("recipient_contact"),
  subject: text("subject"),
  notes: text("notes"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  loggedBy: integer("logged_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const communicationReadStatusTable = pgTable("communication_read_status", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").notNull(),
  userId: integer("user_id").notNull(),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
});
