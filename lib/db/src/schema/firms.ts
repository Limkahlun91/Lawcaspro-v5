import { pgTable, serial, text, timestamp, integer, boolean, index, uniqueIndex, numeric, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const firmsTable = pgTable("firms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  subscriptionPlan: text("subscription_plan").notNull().default("starter"),
  status: text("status").notNull().default("active"),
  logoUrl: text("logo_url"),
  address: text("address"),
  stNumber: text("st_number"),
  tinNumber: text("tin_number"),
  registrationNo: text("registration_no"),
  sstNo: text("sst_no"),
  phone: text("phone"),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  slugUnique: uniqueIndex("firms_slug_key").on(t.slug),
}));

export const firmBankAccountsTable = pgTable("firm_bank_accounts", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  accountName: text("account_name"),
  bankName: text("bank_name").notNull(),
  accountNo: text("account_no").notNull(),
  accountType: text("account_type").notNull().default("office"),
  glCode: text("gl_code"),
  openingBalance: numeric("opening_balance", { precision: 12, scale: 2 }).notNull().default("0"),
  openingBalanceDate: date("opening_balance_date"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdIdx: index("idx_bank_accounts_firm").on(t.firmId),
}));

export const insertFirmSchema = createInsertSchema(firmsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFirm = z.infer<typeof insertFirmSchema>;
export type Firm = typeof firmsTable.$inferSelect;
