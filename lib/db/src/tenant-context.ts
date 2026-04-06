/**
 * tenant-context.ts
 *
 * Helpers for setting PostgreSQL session variables that drive the
 * tenant_isolation RLS policies.
 *
 * Security model:
 *   All policies are TO PUBLIC — the tenant check lives entirely inside
 *   USING/WITH CHECK expressions via current_setting('app.current_firm_id').
 *   The connecting role must NOT have BYPASSRLS, so we switch to app_user
 *   (NOLOGIN, no BYPASSRLS) for every firm-scoped request.
 *
 * Two usage patterns are supported:
 *
 * A) Per-request session-level (requireFirmUser middleware):
 *    Uses SET (not SET LOCAL) so settings persist across multiple queries in
 *    the same request without needing an explicit transaction. Settings are
 *    reset before the connection is returned to the pool.
 *
 *    const client = await pool.connect();
 *    await setTenantContextSession(client, firmId);
 *    const rlsDb = makeRlsDb(client);
 *    // ... queries ...
 *    await clearTenantContext(client);
 *    client.release();
 *
 * B) Transaction-scoped (explicit DB transactions):
 *    Uses SET LOCAL so settings are automatically rolled back on ROLLBACK.
 *
 *    await client.query('BEGIN');
 *    await setTenantContext(client, firmId);  // SET LOCAL
 *    // ... queries ...
 *    await client.query('COMMIT');
 *    client.release();
 */

import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "./schema";

/**
 * Session-level tenant context (no transaction required).
 * Settings persist for the life of the connection — always call
 * clearTenantContext() before releasing the client back to the pool.
 */
export async function setTenantContextSession(
  client: PoolClient,
  firmId: number
): Promise<void> {
  await client.query("SET ROLE app_user");
  await client.query(`SET app.current_firm_id = '${firmId}'`);
  await client.query("SET app.is_founder = 'false'");
}

/**
 * Transaction-scoped tenant context.
 * Must be called inside a transaction (after BEGIN).
 * Settings are automatically discarded on ROLLBACK.
 */
export async function setTenantContext(
  client: PoolClient,
  firmId: number
): Promise<void> {
  await client.query("SET LOCAL ROLE app_user");
  await client.query(`SET LOCAL app.current_firm_id = '${firmId}'`);
  await client.query("SET LOCAL app.is_founder = 'false'");
}

/**
 * Session-level founder context — cross-tenant visibility.
 * Always call clearTenantContext() before releasing the client.
 */
export async function setFounderContextSession(
  client: PoolClient
): Promise<void> {
  await client.query("SET ROLE app_user");
  await client.query("SET app.is_founder = 'true'");
  await client.query("SET app.current_firm_id = ''");
}

/**
 * Reset all tenant context settings and role.
 * Must be called before releasing a session-level context client to the pool.
 */
export async function clearTenantContext(client: PoolClient): Promise<void> {
  await client.query("RESET ROLE");
  await client.query("RESET app.current_firm_id");
  await client.query("RESET app.is_founder");
}

/**
 * Build a Drizzle instance bound to a specific PoolClient.
 * All queries run on the same connection (with the tenant context already set).
 */
export function makeRlsDb(client: PoolClient) {
  return drizzle(client, { schema });
}

export type RlsDb = ReturnType<typeof makeRlsDb>;
