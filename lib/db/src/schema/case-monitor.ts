import { pgTable, text, integer, timestamp, boolean, jsonb, primaryKey, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { firmsTable } from "./firms";
import { casesTable } from "./cases";
import { usersTable } from "./users";
import { paymentVouchersTable } from "./accounting";

export const caseBottleneckSnapshotsTable = pgTable("case_bottleneck_snapshots", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  firmId: integer("firm_id").notNull().references(() => firmsTable.id, { onDelete: "cascade" }),
  caseId: integer("case_id").references(() => casesTable.id, { onDelete: "set null" }),
  paymentVoucherId: integer("payment_voucher_id").references(() => paymentVouchersTable.id, { onDelete: "set null" }),
  monitorKind: text("monitor_kind").notNull().$type<"case_no_movement" | "case_waiting" | "case_on_hold" | "pv_delay" | "urgent" | "approval_waiting">(),
  severity: text("severity").notNull().$type<"attention" | "urgent" | "critical">().default("attention"),
  daysStuck: integer("days_stuck").notNull().default(0),
  responsibleLawyerUserId: integer("responsible_lawyer_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  responsibleManagerUserId: integer("responsible_manager_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  title: text().notNull(),
  detail: text(),
  metadata: jsonb().default({}),
  escalatedToPartner: boolean("escalated_to_partner").notNull().default(false),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: integer("resolved_by").references(() => usersTable.id, { onDelete: "set null" }),
  resolvedNote: text("resolved_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  index("case_bottleneck_firm_open_idx").on(t.firmId, t.resolvedAt, t.severity),
  index("case_bottleneck_case_idx").on(t.caseId, t.resolvedAt),
  index("case_bottleneck_lawyer_idx").on(t.responsibleLawyerUserId, t.resolvedAt),
]);

export const caseMonitorLogsTable = pgTable("case_monitor_logs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  firmId: integer("firm_id").notNull().references(() => firmsTable.id, { onDelete: "cascade" }),
  snapshotId: integer("snapshot_id").references(() => caseBottleneckSnapshotsTable.id, { onDelete: "cascade" }),
  caseId: integer("case_id").references(() => casesTable.id, { onDelete: "set null" }),
  actorUserId: integer("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  action: text().notNull().$type<"detect" | "escalate" | "dismiss" | "resolve" | "reopen" | "note">(),
  notes: text(),
  metadata: jsonb().default({}),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("case_monitor_logs_firm_idx").on(t.firmId, t.createdAt),
  index("case_monitor_logs_snapshot_idx").on(t.snapshotId, t.createdAt),
]);
