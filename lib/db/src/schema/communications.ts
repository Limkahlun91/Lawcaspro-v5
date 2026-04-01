import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const caseCommunicationsTable = pgTable("case_communications", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  firmId: integer("firm_id").notNull(),
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
