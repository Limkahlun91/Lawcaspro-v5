import { pgTable, serial, text, integer, timestamp, index, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type EinvoiceIntegrationStatus = "active" | "not_configured" | "needs_attention";

export const einvoiceIntegrationsTable = pgTable("einvoice_integrations", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  provider: text("provider").notNull().default("lhdn_myinvois"),
  status: text("status").notNull().$type<EinvoiceIntegrationStatus>().default("not_configured"),
  displayName: text("display_name").notNull().default("MyInvois (LHDN)"),
  baseUrl: text("base_url"),
  apiVersion: text("api_version").default("v2024-06-01"),
  tin: text("tin"),
  sellerIdType: text("seller_id_type"),
  sellerIdValue: text("seller_id_value"),
  firmMsicCode: text("firm_msic_code"),
  encryptedCredentials: text("encrypted_credentials"),
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  enableAutoSubmit: boolean("enable_auto_submit").notNull().default(false),
  enableAutoCancel: boolean("enable_auto_cancel").notNull().default(false),
  enableAutoValidation: boolean("enable_auto_validation").notNull().default(true),
  enableWebhooksEnabled: boolean("enable_webhooks_enabled").notNull().default(false),
  webhookSecretHash: text("webhook_secret_hash"),
  autoSubmitCutoffMinutes: integer("auto_submit_cutoff_minutes").notNull().default(1440),
  retryMaxAttempts: integer("retry_max_attempts").notNull().default(5),
  retryBackoffSeconds: integer("retry_backoff_seconds").notNull().default(60),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestResult: text("last_test_result"),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key"),
  configuredByUserId: integer("configured_by_user_id"),
  configuredAt: timestamp("configured_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  notes: text("notes"),
}, (t) => ({
  firmIdx: index("idx_einvoice_int_firm").on(t.firmId),
  firmProviderIdx: uniqueIndex("uq_einvoice_int_firm_provider").on(t.firmId, t.provider),
  firmStatusIdx: index("idx_einvoice_int_firm_status").on(t.firmId, t.status),
  uqEinvoiceIntIdem: uniqueIndex("uq_einvoice_int_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export type EinvoiceIntegration = typeof einvoiceIntegrationsTable.$inferSelect;
export type InsertEinvoiceIntegration = typeof einvoiceIntegrationsTable.$inferInsert;
