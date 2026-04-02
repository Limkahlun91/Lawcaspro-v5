import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const supportSessionsTable = pgTable("support_sessions", {
  id:           serial("id").primaryKey(),
  founderId:    integer("founder_id").notNull(),
  targetFirmId: integer("target_firm_id").notNull(),
  reason:       text("reason").notNull(),
  startedAt:    timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt:      timestamp("ended_at", { withTimezone: true }),
  actionLog:    jsonb("action_log").notNull().default([]),
  ipAddress:    text("ip_address"),
  userAgent:    text("user_agent"),
}, (t) => ({
  founderIdx:   index("idx_support_sessions_founder").on(t.founderId),
  firmIdx:      index("idx_support_sessions_firm").on(t.targetFirmId),
  startedAtIdx: index("idx_support_sessions_started").on(t.startedAt),
}));

export type SupportSession = typeof supportSessionsTable.$inferSelect;
