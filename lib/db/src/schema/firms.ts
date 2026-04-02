import { pgTable, serial, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const firmsTable = pgTable("firms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  subscriptionPlan: text("subscription_plan").notNull().default("starter"),
  status: text("status").notNull().default("active"),
  address: text("address"),
  stNumber: text("st_number"),
  tinNumber: text("tin_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  slugUnique: uniqueIndex("firms_slug_key").on(t.slug),
}));

export const firmBankAccountsTable = pgTable("firm_bank_accounts", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  bankName: text("bank_name").notNull(),
  accountNo: text("account_no").notNull(),
  accountType: text("account_type").notNull().default("office"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdIdx: index("idx_bank_accounts_firm").on(t.firmId),
}));

export const insertFirmSchema = createInsertSchema(firmsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFirm = z.infer<typeof insertFirmSchema>;
export type Firm = typeof firmsTable.$inferSelect;
