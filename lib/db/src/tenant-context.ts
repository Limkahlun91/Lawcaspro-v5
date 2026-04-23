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

function isSetRoleFallbackSafeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("must be member of role") ||
    m.includes("permission denied") ||
    m.includes("role \"app_user\" does not exist") ||
    m.includes("set role") ||
    m.includes("cannot set role")
  );
}

async function trySetRoleAppUser(client: PoolClient, context: "firm" | "founder" | "auth"): Promise<void> {
  try {
    await client.query("SET ROLE app_user");
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (isSetRoleFallbackSafeError(message)) {
      return;
    }
    throw new Error(`Cannot enforce RLS safely: failed to SET ROLE app_user (${message})`);
  }
}

export async function assertSafeRlsRole(
  client: PoolClient,
  context: "firm" | "founder" | "auth"
): Promise<void> {
  const res = await client.query<{
    rolbypassrls: boolean;
    rolsuper: boolean;
    rolname: string;
  }>(
    "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user"
  );
  const role = res.rows[0];
  if (role?.rolbypassrls || role?.rolsuper) {
    throw new Error(
      `Cannot enforce RLS safely: database connection is using BYPASSRLS or superuser role (role=${role?.rolname ?? "unknown"}). Current DATABASE_URL is not safe for ${context}-scoped RLS requests.`
    );
  }
}

/**
 * Session-level tenant context (no transaction required).
 * Settings persist for the life of the connection — always call
 * clearTenantContext() before releasing the client back to the pool.
 */
export async function setTenantContextSession(
  client: PoolClient,
  firmId: number,
  userId?: number
): Promise<void> {
  await trySetRoleAppUser(client, "firm");
  await assertSafeRlsRole(client, "firm");

  await client.query(`SET app.current_firm_id = '${firmId}'`);
  await client.query("SET app.is_founder = 'false'");
  if (userId !== undefined) {
    await client.query(`SET app.current_user_id = '${userId}'`);
  } else {
    await client.query("RESET app.current_user_id");
  }
}

/**
 * Transaction-scoped tenant context.
 * Must be called inside a transaction (after BEGIN).
 * Settings are automatically discarded on ROLLBACK.
 */
export async function setTenantContext(
  client: PoolClient,
  firmId: number,
  userId?: number
): Promise<void> {
  await trySetRoleAppUser(client, "firm");
  await assertSafeRlsRole(client, "firm");

  await client.query(`SET LOCAL app.current_firm_id = '${firmId}'`);
  await client.query("SET LOCAL app.is_founder = 'false'");
  if (userId !== undefined) {
    await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
  }
}

export async function setFounderContext(client: PoolClient): Promise<void> {
  await trySetRoleAppUser(client, "founder");
  await assertSafeRlsRole(client, "founder");
  await client.query("SET LOCAL app.is_founder = 'true'");
  await client.query("SET LOCAL app.current_firm_id = '0'");
  await client.query("SET LOCAL app.current_user_id = '0'");
}

/**
 * Session-level founder context — cross-tenant visibility.
 * Always call clearTenantContext() before releasing the client.
 */
export async function setFounderContextSession(
  client: PoolClient
): Promise<void> {
  await trySetRoleAppUser(client, "founder");
  await assertSafeRlsRole(client, "founder");

  await client.query("SET app.is_founder = 'true'");
  await client.query("SET app.current_firm_id = '0'");
  await client.query("SET app.current_user_id = '0'");
}

/**
 * Reset all tenant context settings and role.
 * Must be called before releasing a session-level context client to the pool.
 */
export async function clearTenantContext(client: PoolClient): Promise<void> {
  // Note: no SET ROLE is performed here. Keep reset limited to GUCs.
  await client.query("SET app.current_firm_id = '0'");
  await client.query("SET app.is_founder = 'false'");
  await client.query("SET app.current_user_id = '0'");
  try {
    await client.query("RESET ROLE");
  } catch {
  }
}

/**
 * Build a Drizzle instance bound to a specific PoolClient.
 * All queries run on the same connection (with the tenant context already set).
 */
export function makeRlsDb(client: PoolClient) {
  return drizzle(client, { schema });
}

export type RlsDb = ReturnType<typeof makeRlsDb>;
