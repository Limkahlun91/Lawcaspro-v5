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

async function trySetRoleAppUserLocal(client: PoolClient, context: "firm" | "founder" | "auth"): Promise<void> {
  try {
    await client.query("SET LOCAL ROLE app_user");
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (isSetRoleFallbackSafeError(message)) {
      return;
    }
    throw new Error(`Cannot enforce RLS safely: failed to SET ROLE app_user (${message})`);
  }
}

async function trySetRoleAppUserSession(client: PoolClient, context: "firm" | "founder" | "auth"): Promise<void> {
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
  await trySetRoleAppUserSession(client, "firm");
  await assertSafeRlsRole(client, "firm");
  const firmIdStr = String(firmId);
  const userIdStr = String(userId ?? 0);
  await client.query(
    "SELECT set_config('app.current_firm_id', $1, false), set_config('app.firm_id', $1, false), set_config('app.is_founder', 'false', false), set_config('app.current_user_id', $2, false)",
    [firmIdStr, userIdStr],
  );
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
  await trySetRoleAppUserLocal(client, "firm");
  await assertSafeRlsRole(client, "firm");
  const firmIdStr = String(firmId);
  const userIdStr = String(userId ?? 0);
  await client.query(
    "SELECT set_config('app.current_firm_id', $1, true), set_config('app.firm_id', $1, true), set_config('app.is_founder', 'false', true), set_config('app.current_user_id', $2, true)",
    [firmIdStr, userIdStr],
  );
}

export async function setFounderContext(client: PoolClient): Promise<void> {
  await trySetRoleAppUserLocal(client, "founder");
  await assertSafeRlsRole(client, "founder");
  await client.query(
    "SELECT set_config('app.is_founder', 'true', true), set_config('app.current_firm_id', '0', true), set_config('app.firm_id', '0', true), set_config('app.current_user_id', '0', true)",
  );
}

/**
 * Session-level founder context — cross-tenant visibility.
 * Always call clearTenantContext() before releasing the client.
 */
export async function setFounderContextSession(
  client: PoolClient
): Promise<void> {
  await trySetRoleAppUserSession(client, "founder");
  await assertSafeRlsRole(client, "founder");
  await client.query(
    "SELECT set_config('app.is_founder', 'true', false), set_config('app.current_firm_id', '0', false), set_config('app.firm_id', '0', false), set_config('app.current_user_id', '0', false)",
  );
}

/**
 * Reset all tenant context settings and role.
 * Must be called before releasing a session-level context client to the pool.
 */
export async function clearTenantContext(client: PoolClient): Promise<void> {
  // Note: no SET ROLE is performed here. Keep reset limited to GUCs.
  await client.query(
    "SELECT set_config('app.current_firm_id', '0', false), set_config('app.firm_id', '0', false), set_config('app.is_founder', 'false', false), set_config('app.current_user_id', '0', false)",
  );
  try {
    await client.query("RESET ROLE");
  } catch {
  }
}

/**
 * STRICT tenant context cleanup for financial routes.
 *
 * Guarantees:
 *   1. Attempts ALL cleanup steps (no early-exit on first failure).
 *   2. Throws an aggregate error if ANY step fails.
 *   3. Callers MUST treat any thrown error as a "destroy the pooled connection"
 *      signal to avoid tenant-state leakage between requests.
 *
 * This is intentionally more aggressive than clearTenantContext() because
 * financial routes modify session-level GUCs (statement_timeout) and we
 * must never return a connection with partially-cleaned state to the pool.
 */
export async function clearTenantContextStrict(
  client: PoolClient,
): Promise<void> {
  const failures: Array<{
    step: string;
    message: string;
    code?: string | null;
  }> = [];

  const attempt = async (
    step: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await fn();
    } catch (err: any) {
      failures.push({
        step,
        message:
          err instanceof Error
            ? err.message
            : String(err ?? "unknown error"),
        code:
          typeof err?.code === "string"
            ? err.code
            : null,
      });
    }
  };

  await attempt("tenant_guc_reset", async () => {
    await client.query(
      "SELECT " +
        "set_config('app.current_firm_id', '0', false), " +
        "set_config('app.firm_id', '0', false), " +
        "set_config('app.is_founder', 'false', false), " +
        "set_config('app.current_user_id', '0', false)",
    );
  });

  await attempt("statement_timeout_reset", async () => {
    await client.query("RESET statement_timeout");
  });

  await attempt("lock_timeout_reset", async () => {
    await client.query("RESET lock_timeout");
  });

  await attempt("role_reset", async () => {
    await client.query("RESET ROLE");
  });

  if (failures.length > 0) {
    const error = new Error(
      `STRICT_TENANT_CLEANUP_FAILED: ${failures
        .map((x) => `${x.step}:${x.code ?? "NO_CODE"}`)
        .join(",")}`,
    );

    (error as any).code = "STRICT_TENANT_CLEANUP_FAILED";
    (error as any).cleanupFailures = failures;

    throw error;
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
