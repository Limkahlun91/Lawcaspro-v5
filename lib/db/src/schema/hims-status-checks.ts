import { pgTable, serial, text, integer, timestamp, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const himsStatusChecksTable = pgTable("hims_status_checks", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id"),
  developerId: integer("developer_id"),
  projectId: integer("project_id"),
  phase: text("phase"),
  unitLot: text("unit_lot"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  lastStatusCode: text("last_status_code"),
  lastStatusDescription: text("last_status_description"),
  sourceSnapshotHash: text("source_snapshot_hash"),
  sourceSnapshotJson: jsonb("source_snapshot_json"),
  checkInitiator: text("check_initiator").default("scheduled"),
  connectionId: integer("connection_id"),
  idempotencyKey: text("idempotency_key"),
  checkDurationMs: integer("check_duration_ms"),
  attempts: integer("attempts").notNull().default(1),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  nextScheduledCheckAt: timestamp("next_scheduled_check_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_hims_checks_firm").on(t.firmId),
  firmCaseIdx: index("idx_hims_checks_firm_case").on(t.firmId, t.caseId, t.lastCheckedAt),
  firmDeveloperIdx: index("idx_hims_checks_firm_dev").on(t.firmId, t.developerId),
  firmProjectIdx: index("idx_hims_checks_firm_project").on(t.firmId, t.projectId, t.phase, t.unitLot),
  firmStatusIdx: index("idx_hims_checks_firm_status").on(t.firmId, t.lastStatus),
  firmNextCheckIdx: index("idx_hims_checks_next_scheduled")
    .on(t.firmId, t.nextScheduledCheckAt)
    .where(sql`next_scheduled_check_at IS NOT NULL`),
  uqHimsChecksIdem: uniqueIndex("uq_hims_checks_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export type HimsStatusCheck = typeof himsStatusChecksTable.$inferSelect;
export type InsertHimsStatusCheck = typeof himsStatusChecksTable.$inferInsert;
