/**
 * tenant-context.ts
 *
 * Helpers for setting PostgreSQL session variables that drive the
 * tenant_isolation RLS policies applied to the app_user role.
 *
 * Usage (within a transaction or single-request scoped connection):
 *
 *   const client = await pool.connect();
 *   try {
 *     await setTenantContext(client, firmId);      // enforce RLS for firmId
 *     // ... run queries as app_user for this firm ...
 *   } finally {
 *     client.release();
 *   }
 *
 *   // For founder/platform access (bypasses firm_id filter):
 *   await setFounderContext(client);
 */

import type { PoolClient } from "pg";

/**
 * Set the tenant context for the connection so RLS policies allow access
 * only to rows belonging to the specified firm.
 *
 * The app connects as `postgres` (superuser, bypasses RLS by default).
 * Calling SET ROLE app_user switches to the limited role so RLS IS enforced.
 */
export async function setTenantContext(
  client: PoolClient,
  firmId: number
): Promise<void> {
  await client.query("SET LOCAL ROLE app_user");
  await client.query("SET LOCAL app.current_firm_id = $1", [String(firmId)]);
  await client.query("SET LOCAL app.is_founder = 'false'");
}

/**
 * Set the founder context — grants cross-tenant visibility for platform/admin
 * operations while still flowing through RLS (is_founder bypass clause).
 */
export async function setFounderContext(client: PoolClient): Promise<void> {
  await client.query("SET LOCAL ROLE app_user");
  await client.query("SET LOCAL app.is_founder = 'true'");
  await client.query("SET LOCAL app.current_firm_id = ''");
}

/**
 * Reset the tenant context — call after leaving the scoped block.
 * (Usually not needed if you release the pool client, but explicit here.)
 */
export async function clearTenantContext(client: PoolClient): Promise<void> {
  await client.query("RESET ROLE");
  await client.query("RESET app.current_firm_id");
  await client.query("RESET app.is_founder");
}
