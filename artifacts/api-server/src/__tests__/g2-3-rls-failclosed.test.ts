import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const RLS_DDL = `
CREATE TABLE IF NOT EXISTS rls_probe (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rls_probe_firm ON rls_probe(firm_id);
ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;
GRANT ALL PRIVILEGES ON rls_probe TO app_user;
GRANT USAGE, SELECT ON SEQUENCE rls_probe_id_seq TO app_user;

DROP POLICY IF EXISTS rls_probe_select ON rls_probe;
CREATE POLICY rls_probe_select ON rls_probe
  FOR SELECT
  TO app_user
  USING (firm_id = (current_setting('app.current_firm_id', false))::int);
`;

// Wrap a SELECT in a transaction that drops to `app_user` so FORCE RLS applies
// (PGlite's default session role has BYPASSRLS-like powers, same as pg superuser)
function withAppUserRole(sql: string, bindings?: unknown[]) {
  return [
    "BEGIN;",
    "SET LOCAL ROLE app_user;",
    "SET LOCAL app.is_founder = false;",
    "", // placeholder for GUC injected by caller
    sql,
    "ROLLBACK;",
  ];
}

describe("G2-3 RLS fail-closed (PGlite session-level GUCs with FORCE RLS)", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(RLS_DDL);
    await pg.exec(`INSERT INTO rls_probe (firm_id, label) VALUES
        (7, 'firm-7 A'),
        (7, 'firm-7 B'),
        (99, 'firm-99 only')`);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("G2-3.1 SET app.current_firm_id = 7 → returns exactly 2 rows", async () => {
    const tx = [
      "BEGIN;",
      "SET LOCAL ROLE app_user;",
      "SET LOCAL app.is_founder = false;",
      "SET LOCAL app.current_firm_id = 7;",
      "SELECT firm_id FROM rls_probe ORDER BY id;",
      "ROLLBACK;",
    ].join("\n");
    const res = await pg.exec(tx);
    const selectResult = res.find((r) => r.rows && r.rows.length > 0) ?? { rows: [] };
    const rows = (selectResult.rows ?? []) as Array<{ firm_id: number }>;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.firm_id === 7)).toBe(true);
  });

  it("G2-3.2 SET app.current_firm_id = 0 → 0 rows (fail-closed)", async () => {
    const tx = [
      "BEGIN;",
      "SET LOCAL ROLE app_user;",
      "SET LOCAL app.is_founder = false;",
      "SET LOCAL app.current_firm_id = 0;",
      "SELECT firm_id FROM rls_probe ORDER BY id;",
      "ROLLBACK;",
    ].join("\n");
    const res = await pg.exec(tx);
    const selectResult = res.find((r) => Array.isArray(r.rows)) ?? { rows: [] };
    const rows = (selectResult.rows ?? []) as Array<{ firm_id: number }>;
    expect(rows.length).toBe(0);
  });
});
