import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  bigserial,
  text,
  integer,
  boolean,
  numeric,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// -----------------------------------------------------------------------------
// platform_features — feature catalog
// -----------------------------------------------------------------------------

export const platformFeaturesTable = pgTable(
  "platform_features",
  {
    id: serial("id").primaryKey(),
    featureKey: text("feature_key").notNull(),
    name: text("name").notNull(),
    module: text("module").notNull().default("general"),
    parentFeatureKey: text("parent_feature_key"),
    valueType: text("value_type")
      .notNull()
      .default("boolean"),
    defaultValue: jsonb("default_value").notNull().default(sql`'false'::jsonb`),
    configurable: boolean("configurable").notNull().default(true),
    founderOnly: boolean("founder_only").notNull().default(false),
    dependencyJson: jsonb("dependency_json").notNull().default(sql`'[]'::jsonb`),
    routeHint: text("route_hint"),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    featureKeyUq: uniqueIndex("uq_platform_features_feature_key").on(t.featureKey),
    moduleIdx: index("idx_platform_features_module").on(t.module),
    statusIdx: index("idx_platform_features_status").on(t.status),
    parentIdx: index("idx_platform_features_parent").on(t.parentFeatureKey),
  }),
);

export type PlatformFeature = typeof platformFeaturesTable.$inferSelect;
export type InsertPlatformFeature = typeof platformFeaturesTable.$inferInsert;

// -----------------------------------------------------------------------------
// plan_entitlements — base plan entitlements (layer 4)
// -----------------------------------------------------------------------------

export const planEntitlementsTable = pgTable(
  "plan_entitlements",
  {
    id: serial("id").primaryKey(),
    planId: integer("plan_id").notNull().references(() => subscriptionPlansRef.id, {
      onDelete: "cascade",
    }),
    featureKey: text("feature_key").notNull(),
    valueJson: jsonb("value_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    planFeatureUq: uniqueIndex("uq_plan_entitlements_plan_feature").on(t.planId, t.featureKey),
    planIdx: index("idx_plan_entitlements_plan").on(t.planId),
    featureIdx: index("idx_plan_entitlements_feature").on(t.featureKey),
  }),
);

export type PlanEntitlement = typeof planEntitlementsTable.$inferSelect;
export type InsertPlanEntitlement = typeof planEntitlementsTable.$inferInsert;

// -----------------------------------------------------------------------------
// firm_entitlement_overrides — permanent / temporary per-firm overrides
// -----------------------------------------------------------------------------

export const firmEntitlementOverridesTable = pgTable(
  "firm_entitlement_overrides",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull().references(() => firmsRef.id, { onDelete: "cascade" }),
    featureKey: text("feature_key").notNull(),
    overrideKind: text("override_kind").notNull().default("temporary"),
    overrideMode: text("override_mode").notNull().default("custom"),
    valueJson: jsonb("value_json"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    billingType: text("billing_type").notNull().default("included"),
    priceOverride: numeric("price_override", { precision: 12, scale: 2 }),
    reason: text("reason"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    firmIdx: index("idx_firm_entitlement_firm").on(t.firmId),
    featureIdx: index("idx_firm_entitlement_feature").on(t.featureKey),
    effectiveIdx: index("idx_firm_entitlement_effective").on(
      t.firmId,
      t.featureKey,
      t.effectiveFrom,
      t.expiresAt,
    ),
    billingTypeIdx: index("idx_firm_entitlement_billing_type").on(t.firmId, t.billingType),
    kindIdx: index("idx_firm_entitlement_kind").on(t.firmId, t.overrideKind),
    permanentUnique: uniqueIndex("uq_firm_entitlement_permanent")
      .on(t.firmId, t.featureKey)
      .where(sql`${t.overrideKind} = 'permanent'`),
  }),
);

export type FirmEntitlementOverride = typeof firmEntitlementOverridesTable.$inferSelect;
export type InsertFirmEntitlementOverride = typeof firmEntitlementOverridesTable.$inferInsert;

// -----------------------------------------------------------------------------
// subscription_history — immutable log of plan/status changes per firm
// -----------------------------------------------------------------------------

export const subscriptionHistoryTable = pgTable(
  "subscription_history",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull().references(() => firmsRef.id, { onDelete: "cascade" }),
    oldPlanId: integer("old_plan_id").references(() => subscriptionPlansRef.id),
    newPlanId: integer("new_plan_id").references(() => subscriptionPlansRef.id),
    oldStatus: text("old_status"),
    newStatus: text("new_status").notNull(),
    priceSnapshot: numeric("price_snapshot", { precision: 12, scale: 2 }),
    changedBy: integer("changed_by"),
    reason: text("reason"),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index("idx_subscription_history_firm").on(t.firmId),
    createdIdx: index("idx_subscription_history_created").on(t.firmId, t.createdAt),
  }),
);

export type SubscriptionHistory = typeof subscriptionHistoryTable.$inferSelect;
export type InsertSubscriptionHistory = typeof subscriptionHistoryTable.$inferInsert;

// -----------------------------------------------------------------------------
// billing_ledger — APPEND-ONLY platform billing ledger per firm
// -----------------------------------------------------------------------------

export const billingLedgerTable = pgTable(
  "billing_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    firmId: integer("firm_id").notNull().references(() => firmsRef.id, { onDelete: "restrict" }),
    subscriptionId: integer("subscription_id"),
    invoiceId: integer("invoice_id").references(() => firmInvoicesRef.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    entryType: text("entry_type").notNull(),
    description: text("description").notNull(),
    billingPeriodStart: date("billing_period_start"),
    billingPeriodEnd: date("billing_period_end"),
    debit: numeric("debit", { precision: 18, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 18, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("MYR"),
    referenceNo: text("reference_no"),
    correlationId: text("correlation_id"),
    sourceType: text("source_type"),
    sourceId: integer("source_id"),
    dueDate: date("due_date"),
    paidDate: date("paid_date"),
    status: text("status").notNull().default("posted"),
    paymentReference: text("payment_reference"),
    paymentMethod: text("payment_method"),
    runningBalance: numeric("running_balance", { precision: 18, scale: 2 }).notNull().default("0"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index("idx_billing_ledger_firm").on(t.firmId),
    firmCreatedIdx: index("idx_billing_ledger_firm_created").on(t.firmId, t.createdAt),
    invoiceIdx: index("idx_billing_ledger_invoice").on(t.invoiceId),
    periodIdx: index("idx_billing_ledger_period").on(t.firmId, t.billingPeriodStart, t.billingPeriodEnd),
    entryTypeIdx: index("idx_billing_ledger_entry_type").on(t.firmId, t.entryType),
    statusIdx: index("idx_billing_ledger_status").on(t.status),
    idempotencyUq: uniqueIndex("uq_billing_ledger_idempotency")
      .on(t.firmId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  }),
);

export type BillingLedgerEntry = typeof billingLedgerTable.$inferSelect;
export type InsertBillingLedgerEntry = typeof billingLedgerTable.$inferInsert;

// -----------------------------------------------------------------------------
// usage_counters — unified usage meter per firm + metric + period
// -----------------------------------------------------------------------------

export const usageCountersTable = pgTable(
  "usage_counters",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    firmId: integer("firm_id").notNull().references(() => firmsRef.id, { onDelete: "cascade" }),
    metricKey: text("metric_key").notNull(),
    periodKey: text("period_key").notNull(),
    counter: numeric("counter", { precision: 18, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    firmMetricPeriodUq: uniqueIndex("uq_usage_counters_firm_metric_period").on(
      t.firmId,
      t.metricKey,
      t.periodKey,
    ),
    firmIdx: index("idx_usage_counters_firm").on(t.firmId),
    periodIdx: index("idx_usage_counters_period").on(t.firmId, t.periodKey),
  }),
);

export type UsageCounter = typeof usageCountersTable.$inferSelect;
export type InsertUsageCounter = typeof usageCountersTable.$inferInsert;

// -----------------------------------------------------------------------------
// Forward refs — imported at bottom to avoid circular init
// -----------------------------------------------------------------------------
import { firmsTable as firmsRef } from "./firms";
import { subscriptionPlansTable as subscriptionPlansRef, firmInvoicesTable as firmInvoicesRef } from "./billing";
