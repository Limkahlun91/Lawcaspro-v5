import { pgTable, serial, text, integer, boolean, date, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const regulatoryRuleSetsTable = pgTable("regulatory_rule_sets", {
  id:          serial("id").primaryKey(),
  code:        text("code").notNull(),
  name:        text("name").notNull(),
  description: text("description"),
  isActive:    boolean("is_active").notNull().default(true),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUnique: uniqueIndex("regulatory_rule_sets_code_key").on(t.code),
}));

export const regulatoryRuleVersionsTable = pgTable("regulatory_rule_versions", {
  id:            serial("id").primaryKey(),
  ruleSetId:     integer("rule_set_id").notNull(),
  version:       text("version").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo:   date("effective_to"),
  rules:         jsonb("rules").notNull(),
  notes:         text("notes"),
  createdBy:     integer("created_by"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ruleSetVersionUnique: uniqueIndex("regulatory_rule_versions_rule_set_id_version_key").on(t.ruleSetId, t.version),
  ruleSetIdx: index("idx_rule_versions_set").on(t.ruleSetId),
}));
