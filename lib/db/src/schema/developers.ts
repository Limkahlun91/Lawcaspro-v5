import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const developersTable = pgTable("developers", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  name: text("name").notNull(),
  companyRegNo: text("company_reg_no"),
  address: text("address"),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  email: text("email"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertDeveloperSchema = createInsertSchema(developersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDeveloper = z.infer<typeof insertDeveloperSchema>;
export type Developer = typeof developersTable.$inferSelect;
