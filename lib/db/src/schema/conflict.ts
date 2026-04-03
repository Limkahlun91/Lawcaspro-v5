import {
  pgTable, serial, text, integer, timestamp, index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// conflict_checks
// One check run per case intake. Records the overall outcome.
// ---------------------------------------------------------------------------
export const conflictChecksTable = pgTable("conflict_checks", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  // pending | running | completed | failed
  status: text("status").notNull().default("pending"),
  runBy: integer("run_by"),
  runAt: timestamp("run_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // no_match | warning | blocked_pending_partner_override
  overallResult: text("overall_result"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdx: index("idx_conflict_checks_firm").on(t.firmId),
  caseIdx: index("idx_conflict_checks_case").on(t.caseId),
  statusIdx: index("idx_conflict_checks_status").on(t.status),
}));

// ---------------------------------------------------------------------------
// conflict_matches
// Individual match results produced by a conflict check run.
// ---------------------------------------------------------------------------
export const conflictMatchesTable = pgTable("conflict_matches", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  conflictCheckId: integer("conflict_check_id").notNull(),
  // The party being checked
  partyName: text("party_name").notNull(),
  partyIdentifier: text("party_identifier"),          // NRIC / passport / company reg
  identifierType: text("identifier_type"),            // nric | passport | company_reg | none
  // The existing party/case that was matched against
  matchedCaseId: integer("matched_case_id"),
  matchedCaseRef: text("matched_case_ref"),
  matchedPartyRole: text("matched_party_role"),
  matchedPartyName: text("matched_party_name"),
  // Match mechanics
  // name_exact | name_fuzzy | nric | passport | company_reg
  matchType: text("match_type").notNull().default("name_exact"),
  matchScore: integer("match_score").notNull().default(100),  // 0-100
  // no_match | warning | blocked
  result: text("result").notNull().default("warning"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  checkIdx: index("idx_conflict_matches_check").on(t.conflictCheckId),
  firmIdx: index("idx_conflict_matches_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// conflict_overrides
// Partner-authorized overrides of blocked conflict matches.
// Requires requireReAuth and partner-level role.
// ---------------------------------------------------------------------------
export const conflictOverridesTable = pgTable("conflict_overrides", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  conflictCheckId: integer("conflict_check_id").notNull(),
  conflictMatchId: integer("conflict_match_id").notNull(),
  overriddenBy: integer("overridden_by").notNull(),
  overrideReason: text("override_reason").notNull(),
  overrideAt: timestamp("override_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  checkIdx: index("idx_conflict_overrides_check").on(t.conflictCheckId),
  firmIdx: index("idx_conflict_overrides_firm").on(t.firmId),
}));

export type ConflictCheck = typeof conflictChecksTable.$inferSelect;
export type ConflictMatch = typeof conflictMatchesTable.$inferSelect;
export type ConflictOverride = typeof conflictOverridesTable.$inferSelect;
