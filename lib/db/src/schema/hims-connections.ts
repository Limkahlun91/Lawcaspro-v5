import { pgTable, serial, text, integer, timestamp, index, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type HimsCredentialType = "developer" | "lawyer";
export type HimsConnectionStatus = "active" | "disabled" | "needs_attention";

export const himsConnectionsTable = pgTable("hims_connections", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  developerId: integer("developer_id"),
  projectId: integer("project_id"),
  displayName: text("display_name").notNull(),
  credentialType: text("credential_type").notNull().$type<HimsCredentialType>(),
  status: text("status").notNull().$type<HimsConnectionStatus>().default("needs_attention"),
  himsBaseUrl: text("hims_base_url"),
  himsTenantCode: text("hims_tenant_code"),
  himsApiClientId: text("hims_api_client_id"),
  encryptedHimsApiClientSecret: text("encrypted_hims_api_client_secret"),
  encryptedHimsUsername: text("encrypted_hims_username"),
  encryptedHimsPassword: text("encrypted_hims_password"),
  encryptedConfigJsonb: text("encrypted_config_jsonb"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestResult: text("last_test_result"),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key"),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledByUserId: integer("disabled_by_user_id"),
  notes: text("notes"),
}, (t) => ({
  firmIdx: index("idx_hims_connections_firm").on(t.firmId),
  firmStatusIdx: index("idx_hims_connections_firm_status").on(t.firmId, t.status),
  firmDeveloperIdx: index("idx_hims_connections_firm_developer").on(t.firmId, t.developerId),
  firmProjectIdx: index("idx_hims_connections_firm_project").on(t.firmId, t.projectId),
  firmCredTypeIdx: index("idx_hims_connections_firm_ctype").on(t.firmId, t.credentialType),
  uqHimsConnectionsIdem: uniqueIndex("uq_hims_connections_idempotency")
    .on(t.firmId, t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export type HimsConnection = typeof himsConnectionsTable.$inferSelect;
export type InsertHimsConnection = typeof himsConnectionsTable.$inferInsert;
