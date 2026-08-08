#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, "..", "..");
const dbPkgDir = join(rootDir, "lib", "db");
const dbPackageJsonPath = join(dbPkgDir, "package.json");
const dbPkg = require(dbPackageJsonPath);
const mainEntry = join(dbPkgDir, dbPkg.main || "dist/index.js");

let drizzle, pg;
try {
  ({ drizzle } = require(mainEntry));
} catch (e) {
  console.warn("[backfill] @workspace/db dist not built, trying tsx direct...");
}
try {
  pg = require("pg");
} catch (e) {
  console.error("[backfill] pg package missing. Install deps first.");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[backfill] DATABASE_URL env required.");
  process.exit(1);
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
});

const sql = (strs, ...vals) => {
  let out = "";
  const args = [];
  for (let i = 0; i < strs.length; i++) {
    out += strs[i];
    if (i < vals.length) {
      args.push(vals[i]);
      out += "$" + args.length;
    }
  }
  return { text: out, values: args };
};

async function main() {
  const client = await pool.connect();
  try {
    console.log("[backfill] Checking case_reference_history table exists...");
    const chk = await client.query(`
      SELECT to_regclass('public.case_reference_history') AS reg
    `);
    if (!chk.rows[0]?.reg) {
      console.error("[backfill] case_reference_history table missing. Apply migration 0144 first.");
      process.exit(2);
    }

    console.log("[backfill] Selecting cases with proposed_reference_no differing from final and reference_no_changed_at present...");
    const casesRes = await client.query(`
      SELECT
        id,
        firm_id,
        proposed_reference_no,
        reference_no,
        reference_no_changed_by,
        reference_no_changed_at,
        reference_no_change_reason
      FROM cases
      WHERE proposed_reference_no IS NOT NULL
        AND BTRIM(proposed_reference_no) <> COALESCE(BTRIM(reference_no), '')
        AND reference_no_changed_at IS NOT NULL
        AND deleted_at IS NULL
    `);

    const cases = casesRes.rows || [];
    console.log(`[backfill] Found ${cases.length} candidate cases for backfill.`);

    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    for (const c of cases) {
      const previous = (c.proposed_reference_no || "").trim() || null;
      const finalRef = (c.reference_no || "").trim() || null;
      if (!finalRef) { skipped++; continue; }
      const ikey = `case_backfill_${c.id}`;
      try {
        const res = await client.query(sql`
          INSERT INTO case_reference_history (
            firm_id, case_id, previous_reference_no, new_reference_no,
            change_type, actor_user_id, changed_at, reason, source,
            idempotency_key, created_at
          ) VALUES (
            ${c.firm_id}, ${c.id}, ${previous}, ${finalRef},
            'BACKFILLED_FROM_CASE_SNAPSHOT'::text,
            ${c.reference_no_changed_by ?? null},
            ${c.reference_no_changed_at},
            ${c.reference_no_change_reason ?? null},
            'BACKFILL'::text,
            ${ikey},
            NOW()
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `);
        if (res.rows && res.rows.length > 0) {
          inserted++;
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
        console.error(`[backfill] case_id=${c.id} FAILED:`, err.message || String(err));
      }
    }

    console.log(`[backfill] Done. inserted=${inserted} skipped=${skipped} failed=${failed}`);
    process.exit(failed > 0 ? 3 : 0);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[backfill] FATAL:", err);
  process.exit(99);
});
