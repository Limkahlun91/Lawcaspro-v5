import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const supportSessionsTable = pgTable("support_sessions", {
  id:           serial("id").primaryKey(),
  founderId:    integer("founder_id").notNull(),
  targetFirmId: integer("target_firm_id").notNull(),
  reason:       text("reason").notNull(),
  status:       text("status").notNull().default("requested"),
  startedAt:    timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt:      timestamp("ended_at", { withTimezone: true }),
  approvedByUserId: integer("approved_by_user_id"),
  approvedAt:   timestamp("approved_at", { withTimezone: true }),
  rejectedByUserId: integer("rejected_by_user_id"),
  rejectedAt:   timestamp("rejected_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  expiresAt:    timestamp("expires_at", { withTimezone: true }),
  actionLog:    jsonb("action_log").notNull().default([]),
  ipAddress:    text("ip_address"),
  userAgent:    text("user_agent"),
}, (t) => ({
  founderIdx:   index("idx_support_sessions_founder").on(t.founderId),
  firmIdx:      index("idx_support_sessions_firm").on(t.targetFirmId),
  startedAtIdx: index("idx_support_sessions_started").on(t.startedAt),
  firmStatusStartedIdx: index("idx_support_sessions_firm_status_started").on(t.targetFirmId, t.status, t.startedAt),
  expiresAtIdx: index("idx_support_sessions_expires_at").on(t.expiresAt),
}));

export type SupportSession = typeof supportSessionsTable.$inferSelect;
