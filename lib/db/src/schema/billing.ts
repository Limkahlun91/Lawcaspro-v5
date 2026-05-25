import { pgTable, serial, varchar, integer, boolean, numeric, jsonb, timestamp, index, uniqueIndex, text } from "drizzle-orm/pg-core";

export const subscriptionPlansTable = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  priceMonthly: numeric("price_monthly", { precision: 12, scale: 2 }).notNull(),
  maxUsers: integer("max_users"),
  maxCasesPerMonth: integer("max_cases_per_month"),
  features: jsonb("features").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  nameUq: uniqueIndex("subscription_plans_name_key").on(t.name),
}));

export const firmInvoicesTable = pgTable("firm_invoices", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  billingMonth: varchar("billing_month", { length: 7 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("unpaid"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paymentMethod: varchar("payment_method", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmMonthUq: uniqueIndex("firm_invoices_firm_month_key").on(t.firmId, t.billingMonth),
  firmIdx: index("idx_firm_invoices_firm").on(t.firmId),
}));

