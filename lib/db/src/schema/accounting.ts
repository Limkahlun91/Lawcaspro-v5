import { pgTable, serial, text, integer, numeric, boolean, timestamp } from "drizzle-orm/pg-core";

export const caseBillingEntriesTable = pgTable("case_billing_entries", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  firmId: integer("firm_id").notNull(),
  category: text("category").notNull().default("disbursement"),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
  isPaid: boolean("is_paid").notNull().default(false),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
