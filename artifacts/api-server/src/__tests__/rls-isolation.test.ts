/**
 * rls-isolation.test.ts
 *
 * Verifies that PostgreSQL Row-Level Security policies correctly isolate
 * tenant data at the database driver level, independent of application
 * route guards.
 *
 * Strategy:
 *   1. Create two firms in the DB directly.
 *   2. Insert a row belonging to firm A.
 *   3. Use a raw pg pool, SET LOCAL ROLE app_user, set app.current_firm_id = firm B.
 *   4. Confirm the row for firm A is invisible.
 *   5. Switch context to firm A — row becomes visible.
 *   6. Switch to founder context (is_founder=true) — row is visible.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";

async function queryAsRole(
  firmId: number | null,
  isFounder: boolean,
  sql: string,
  params?: unknown[],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    if (isFounder) {
      await client.query("SET LOCAL app.is_founder = 'true'");
      await client.query("SET LOCAL app.current_firm_id = ''");
    } else {
      // SET LOCAL does not support $1 parameters — embed the value directly.
      // firmId is always an integer (safe, no injection risk).
      const fid = firmId != null ? String(parseInt(String(firmId), 10)) : "";
      await client.query(`SET LOCAL app.is_founder = 'false'`);
      await client.query(`SET LOCAL "app.current_firm_id" = '${fid}'`);
    }
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function rawQuery(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

describe("PostgreSQL RLS — tenant isolation at DB level", () => {
  let firmAId: number;
  let firmBId: number;
  let testClientId: number;

  beforeAll(async () => {
    const ts = Date.now();

    // Create two test firms
    const fA = await rawQuery(
      `INSERT INTO firms (name, slug, subscription_plan, status, created_at, updated_at)
       VALUES ('RLS Test Firm A', $1, 'starter', 'active', NOW(), NOW())
       RETURNING id`,
      [`rls-test-a-${ts}`],
    );
    firmAId = fA.rows[0].id;

    const fB = await rawQuery(
      `INSERT INTO firms (name, slug, subscription_plan, status, created_at, updated_at)
       VALUES ('RLS Test Firm B', $1, 'starter', 'active', NOW(), NOW())
       RETURNING id`,
      [`rls-test-b-${ts}`],
    );
    firmBId = fB.rows[0].id;

    // Insert a client belonging to firm A
    const c = await rawQuery(
      `INSERT INTO clients (firm_id, name, email, created_at, updated_at)
       VALUES ($1, 'RLS Test Client', 'rls@test.com', NOW(), NOW())
       RETURNING id`,
      [firmAId],
    );
    testClientId = c.rows[0].id;
  });

  afterAll(async () => {
    await rawQuery("DELETE FROM clients WHERE id = $1", [testClientId]);
    await rawQuery("DELETE FROM firms WHERE id = $1 OR id = $2", [firmAId, firmBId]);
  });

  it("app_user with firm B context cannot see firm A clients", async () => {
    const result = await queryAsRole(
      firmBId,
      false,
      "SELECT id FROM clients WHERE id = $1",
      [testClientId],
    );
    expect(result.rows).toHaveLength(0);
  });

  it("app_user with firm A context can see firm A clients", async () => {
    const result = await queryAsRole(
      firmAId,
      false,
      "SELECT id FROM clients WHERE id = $1",
      [testClientId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(testClientId);
  });

  it("app_user with founder context sees any firm's clients", async () => {
    const result = await queryAsRole(
      null,
      true,
      "SELECT id FROM clients WHERE id = $1",
      [testClientId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(testClientId);
  });

  it("superuser (postgres / BYPASSRLS) can always see all clients", async () => {
    const result = await rawQuery(
      "SELECT id FROM clients WHERE id = $1",
      [testClientId],
    );
    expect(result.rows).toHaveLength(1);
  });

  it("app_user with empty firm_id context sees no client rows", async () => {
    const result = await queryAsRole(
      null,
      false,
      "SELECT id FROM clients WHERE id = $1",
      [testClientId],
    );
    expect(result.rows).toHaveLength(0);
  });
});
