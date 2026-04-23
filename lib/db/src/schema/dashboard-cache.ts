import { pgTable, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const firmDashboardStatsCacheTable = pgTable("firm_dashboard_stats_cache", {
  firmId: integer("firm_id").primaryKey(),
  payloadJson: jsonb("payload_json").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
}, (t) => ({
  expiresIdx: index("idx_firm_dashboard_stats_cache_expires").on(t.expiresAt),
}));

