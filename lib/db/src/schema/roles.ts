import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rolesTable = pgTable("roles", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  name: text("name").notNull(),
  isSystemRole: boolean("is_system_role").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const permissionsTable = pgTable("permissions", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").notNull(),
  module: text("module").notNull(),
  action: text("action").notNull(),
  allowed: boolean("allowed").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRoleSchema = createInsertSchema(rolesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRole = z.infer<typeof insertRoleSchema>;
export type Role = typeof rolesTable.$inferSelect;

export const insertPermissionSchema = createInsertSchema(permissionsTable).omit({ id: true, createdAt: true });
export type InsertPermission = z.infer<typeof insertPermissionSchema>;
export type Permission = typeof permissionsTable.$inferSelect;
