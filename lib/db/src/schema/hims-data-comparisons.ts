import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type HimsComparisonStatus = "match" | "mismatch" | "missing";

export const himsDataComparisonsTable = pgTable("hims_data_comparisons", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id"),
  statusCheckId: integer("status_check_id"),
  fieldGroupName: text("field_group_name"),
  field: text("field").notNull(),
  fieldLabel: text("field_label"),
  lawcasproValue: text("lawcaspro_value"),
  himsValue: text("hims_value"),
  ekycValue: text("ekyc_value"),
  status: text("status").notNull().$type<HimsComparisonStatus>(),
  mismatchSeverity: text("mismatch_severity").default("warning"),
  resolutionStatus: text("resolution_status").default("unresolved"),
  resolvedByUserId: integer("resolved_by_user_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  idempotencyKey: text("idempotency_key"),
  comparedByUserId: integer("compared_by_user_id"),
  comparedAt: timestamp("compared_at", { withTimezone: true }),
  comparisonRunId: text("comparison_run_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_hims_comp_firm").on(t.firmId),
  firmCaseIdx: index("idx_hims_comp_firm_case").on(t.firmId, t.caseId),
  firmStatusIdx: index("idx_hims_comp_firm_status").on(t.firmId, t.status),
  firmResolutionIdx: index("idx_hims_comp_firm_resolution").on(t.firmId, t.resolutionStatus),
  firmFieldIdx: index("idx_hims_comp_firm_field").on(t.firmId, t.field),
  firmRunIdx: index("idx_hims_comp_firm_run").on(t.firmId, t.comparisonRunId),
  firmStatusCheckIdx: index("idx_hims_comp_firm_scheck").on(t.firmId, t.statusCheckId),
  uqHimsCompIdem: uniqueIndex("uq_hims_comp_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export type HimsDataComparison = typeof himsDataComparisonsTable.$inferSelect;
export type InsertHimsDataComparison = typeof himsDataComparisonsTable.$inferInsert;
