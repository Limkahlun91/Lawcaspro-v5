import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const quotationsTable = pgTable("quotations", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id"),
  referenceNo: text("reference_no").notNull(),
  stNo: text("st_no"),
  clientName: text("client_name").notNull(),
  propertyDescription: text("property_description"),
  purchasePrice: numeric("purchase_price", { precision: 18, scale: 2 }),
  bankName: text("bank_name"),
  loanAmount: text("loan_amount"),
  status: text("status").notNull().default("draft"),
  notes: text("notes"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const quotationItemsTable = pgTable("quotation_items", {
  id: serial("id").primaryKey(),
  quotationId: integer("quotation_id").notNull(),
  section: text("section").notNull(),
  category: text("category"),
  itemNo: text("item_no"),
  subItemNo: text("sub_item_no"),
  description: text("description").notNull(),
  taxCode: text("tax_code").notNull().default("T"),
  amountExclTax: numeric("amount_excl_tax", { precision: 18, scale: 2 }).notNull().default("0"),
  taxRate: numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("8"),
  taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  amountInclTax: numeric("amount_incl_tax", { precision: 18, scale: 2 }).notNull().default("0"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertQuotationSchema = createInsertSchema(quotationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertQuotation = z.infer<typeof insertQuotationSchema>;
export type Quotation = typeof quotationsTable.$inferSelect;

export const insertQuotationItemSchema = createInsertSchema(quotationItemsTable).omit({ id: true, createdAt: true });
export type InsertQuotationItem = z.infer<typeof insertQuotationItemSchema>;
export type QuotationItem = typeof quotationItemsTable.$inferSelect;
