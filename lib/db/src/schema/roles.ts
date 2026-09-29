import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rolesTable = pgTable("roles", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  name: text("name").notNull(),
  isSystemRole: boolean("is_system_role").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdIdx: index("idx_roles_firm").on(t.firmId),
}));

export const permissionsTable = pgTable("permissions", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").notNull(),
  module: text("module").notNull(),
  action: text("action").notNull(),
  allowed: boolean("allowed").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  roleIdIdx: index("idx_permissions_role").on(t.roleId),
  roleModuleActionUnique: uniqueIndex("uq_permissions_role_module_action").on(t.roleId, t.module, t.action),
}));

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  firmId: integer("firm_id"),
  roleId: integer("role_id"),
  userType: text("user_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenHashUnique: uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
  userIdIdx: index("idx_sessions_user").on(t.userId),
  expiresAtIdx: index("idx_sessions_expires").on(t.expiresAt),
  firmIdIdx: index("idx_sessions_firm_id").on(t.firmId),
  roleIdIdx: index("idx_sessions_role_id").on(t.roleId),
}));

export const insertRoleSchema = createInsertSchema(rolesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRole = z.infer<typeof insertRoleSchema>;
export type Role = typeof rolesTable.$inferSelect;

export const insertPermissionSchema = createInsertSchema(permissionsTable).omit({ id: true, createdAt: true });
export type InsertPermission = z.infer<typeof insertPermissionSchema>;
export type Permission = typeof permissionsTable.$inferSelect;
