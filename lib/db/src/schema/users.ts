import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id"),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  userType: text("user_type").notNull().default("firm_user"),
  roleId: integer("role_id"),
  department: text("department"),
  barCouncilNo: text("bar_council_no"),
  nricNo: text("nric_no"),
  status: text("status").notNull().default("active"),
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  totpLastUsedAt: timestamp("totp_last_used_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  emailUnique: uniqueIndex("users_email_key").on(t.email),
  firmIdIdx: index("idx_users_firm").on(t.firmId),
  statusIdx: index("idx_users_status").on(t.status),
}));

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
