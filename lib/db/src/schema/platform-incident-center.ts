import { pgTable, text, integer, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";

export const platformIncidentsTable = pgTable("platform_incidents", {
  id: uuid("id").primaryKey(),
  incidentCode: text("incident_code").notNull(),
  title: text("title").notNull(),
  incidentType: text("incident_type").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("open"),

  sourceEventId: text("source_event_id"),
  sourceOperationId: uuid("source_operation_id"),

  firmId: integer("firm_id").notNull(),
  moduleCode: text("module_code"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  snapshotId: uuid("snapshot_id"),
  relatedRequestId: uuid("related_request_id"),

  summary: text("summary"),
  technicalSummary: text("technical_summary"),
  userImpactSummary: text("user_impact_summary"),
  suggestedActionCode: text("suggested_action_code"),
  suggestedSnapshotId: uuid("suggested_snapshot_id"),

  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: integer("acknowledged_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: integer("resolved_by"),
  resolutionNote: text("resolution_note"),

  aggregationKey: text("aggregation_key").notNull(),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  eventCount: integer("event_count").notNull().default(1),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  codeUq: uniqueIndex("uq_platform_incidents_code").on(t.incidentCode),
  firmStatusIdx: index("idx_platform_incidents_firm_status").on(t.firmId, t.status, t.detectedAt),
  statusSeverityIdx: index("idx_platform_incidents_status_severity").on(t.status, t.severity, t.detectedAt),
  moduleIdx: index("idx_platform_incidents_module").on(t.moduleCode, t.detectedAt),
  aggregationIdx: index("idx_platform_incidents_aggregation").on(t.aggregationKey),
}));

export const platformIncidentNotesTable = pgTable("platform_incident_notes", {
  id: uuid("id").primaryKey(),
  incidentId: uuid("incident_id").notNull(),
  authorUserId: integer("author_user_id").notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  incidentIdx: index("idx_platform_incident_notes_incident").on(t.incidentId, t.createdAt),
}));
