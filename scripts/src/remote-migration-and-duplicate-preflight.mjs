import pg from "pg";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = pathResolve(__dirname, "..", "..");

function envFrom(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function buildDatabaseConfigs() {
  const direct = envFrom("DATABASE_URL") || envFrom("ADMIN_DATABASE_URL") || envFrom("AUTH_DATABASE_URL");
  if (direct) {
    const isPooler = direct.toLowerCase().includes("pooler.supabase.com");
    const shouldSsl = isPooler || direct.toLowerCase().includes("supabase.co") || direct.toLowerCase().includes("supabase.com");
    return [{
      connectionString: direct,
      connectionTimeoutMillis: 10000,
      ...(shouldSsl ? (isPooler ? { ssl: { rejectUnauthorized: false } } : { ssl: true }) : {}),
    }];
  }

  const projectUrl = envFrom("LAWCASPRO_SUPABASE_URL");
  const serviceKey = envFrom("LAWCASPRO_SUPABASE_SERVICE_ROLE_KEY");
  if (!projectUrl || !serviceKey) return [];

  const host = projectUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const projectRef = host.split(".")[0];

  const sslPooler = { ssl: { rejectUnauthorized: false } };
  const sslDirect = { ssl: true };
  const sniPooler = { ssl: { rejectUnauthorized: false, servername: `${projectRef}.pooler.supabase.com` } };
  const optsProject = { options: `project=${projectRef}` };

  return [
    { user: `postgres.${projectRef}`, password: serviceKey, host: "aws-0-ap-southeast-1.pooler.supabase.com", port: 5432, database: "postgres", connectionTimeoutMillis: 10000, ...sslPooler, ...optsProject },
    { user: `${projectRef}`, password: serviceKey, host: "aws-0-ap-southeast-1.pooler.supabase.com", port: 5432, database: "postgres", connectionTimeoutMillis: 10000, ...sslPooler },
    { user: `postgres`, password: serviceKey, host: "aws-0-ap-southeast-1.pooler.supabase.com", port: 5432, database: "postgres", connectionTimeoutMillis: 10000, ...sslPooler, ...optsProject, query_timeout: 5000, statement_timeout: 5000, parameters: { external_id: projectRef } },
    { connectionString: `postgresql://${encodeURIComponent(projectRef)}:${encodeURIComponent(serviceKey)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`, ...sslPooler, connectionTimeoutMillis: 10000 },
    { connectionString: `postgresql://postgres:${encodeURIComponent(serviceKey)}@bepixycuulklorcbadww.supabase.co:5432/postgres?sslmode=require`, ...sslDirect, connectionTimeoutMillis: 10000 },
    { connectionString: `postgresql://postgres.${encodeURIComponent(projectRef)}:${encodeURIComponent(serviceKey)}@bepixycuulklorcbadww.supabase.co:5432/postgres?sslmode=require`, ...sslDirect, connectionTimeoutMillis: 10000 },
  ];
}

async function connectFirstWorking(configs) {
  let lastErr = null;
  for (const cfg of configs) {
    const label = cfg.connectionString
      ? cfg.connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@")
      : `{user=${cfg.user},host=${cfg.host},port=${cfg.port}}`;
    try {
      const pool = new Pool({ ...cfg, max: 2 });
      await pool.query("SELECT 1 AS ok");
      console.log("Connected using DB config:", label);
      return pool;
    } catch (e) {
      lastErr = e;
      console.log("DB config failed " + label + " -> " + (e.message || String(e)).slice(0, 160));
    }
  }
  throw lastErr || new Error("No connection configs available");
}

function consoleTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows || rows.length === 0) {
    console.log("(empty)");
    return;
  }
  console.table(rows);
}

async function querySchemaMigrations(pool) {
  const candidates = [
    { schema: "public", table: "schema_migrations" },
    { schema: "supabase_migrations", table: "schema_migrations" },
  ];

  const results = [];
  for (const c of candidates) {
    try {
      const exists = await pool.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = $2
        ) AS exists
      `, [c.schema, c.table]);
      if (exists.rows[0].exists) {
        const rows = await pool.query(`
          SELECT * FROM "${c.schema}"."${c.table}" ORDER BY version
        `);
        results.push({
          schema: c.schema,
          table: c.table,
          found: true,
          rows: rows.rows,
          count: rows.rows.length,
        });
      } else {
        results.push({
          schema: c.schema,
          table: c.table,
          found: false,
          rows: [],
          count: 0,
        });
      }
    } catch (e) {
      results.push({
        schema: c.schema,
        table: c.table,
        found: false,
        error: String(e.message || e),
        rows: [],
        count: 0,
      });
    }
  }
  return results;
}

async function queryDuplicates(pool) {
  const invoiceDups = await pool.query(`
    SELECT firm_id, invoice_no, COUNT(*)
    FROM invoices
    WHERE invoice_no IS NOT NULL
    GROUP BY firm_id, invoice_no
    HAVING COUNT(*) > 1
  `);

  const receiptDups = await pool.query(`
    SELECT firm_id, receipt_no, COUNT(*)
    FROM receipts
    WHERE receipt_no IS NOT NULL
    GROUP BY firm_id, receipt_no
    HAVING COUNT(*) > 1
  `);

  const permissionDups = await pool.query(`
    SELECT role_id, module, action, COUNT(*)
    FROM permissions
    GROUP BY role_id, module, action
    HAVING COUNT(*) > 1
  `);

  return {
    invoices: invoiceDups.rows,
    receipts: receiptDups.rows,
    permissions: permissionDups.rows,
  };
}

async function queryUniqueIndexes(pool) {
  const targetIndexes = [
    "uq_invoices_firm_invoice_no",
    "uq_receipts_firm_receipt_no",
    "uq_permissions_role_module_action",
  ];

  const pgIndexes = await pool.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY($1::text[])
    ORDER BY indexname
  `, [targetIndexes]);

  const pgConstraints = await pool.query(`
    SELECT
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public'
      AND tc.constraint_name = ANY($1::text[])
    ORDER BY tc.constraint_name
  `, [targetIndexes]);

  return {
    pgIndexes: pgIndexes.rows,
    pgConstraints: pgConstraints.rows,
    targetIndexes,
  };
}

async function queryDuplicateRowDetails(pool, dups) {
  const details = { invoices: [], receipts: [], permissions: [] };

  for (const d of dups.invoices) {
    const rows = await pool.query(`
      SELECT id, firm_id, invoice_no, created_at
      FROM invoices
      WHERE firm_id = $1 AND invoice_no = $2
      ORDER BY id
    `, [d.firm_id, d.invoice_no]);
    details.invoices.push({
      firm_id: d.firm_id,
      invoice_no: d.invoice_no,
      count: d.count,
      row_ids: rows.rows.map(r => r.id),
      created_at_first: rows.rows[0]?.created_at,
      created_at_last: rows.rows[rows.rows.length - 1]?.created_at,
      rows: rows.rows,
    });
  }

  for (const d of dups.receipts) {
    const rows = await pool.query(`
      SELECT id, firm_id, receipt_no, created_at
      FROM receipts
      WHERE firm_id = $1 AND receipt_no = $2
      ORDER BY id
    `, [d.firm_id, d.receipt_no]);
    details.receipts.push({
      firm_id: d.firm_id,
      receipt_no: d.receipt_no,
      count: d.count,
      row_ids: rows.rows.map(r => r.id),
      created_at_first: rows.rows[0]?.created_at,
      created_at_last: rows.rows[rows.rows.length - 1]?.created_at,
      rows: rows.rows,
    });
  }

  for (const d of dups.permissions) {
    const rows = await pool.query(`
      SELECT id, role_id, module, action, allowed, created_at
      FROM permissions
      WHERE role_id = $1 AND module = $2 AND action = $3
      ORDER BY id
    `, [d.role_id, d.module, d.action]);
    details.permissions.push({
      role_id: d.role_id,
      module: d.module,
      action: d.action,
      count: d.count,
      row_ids: rows.rows.map(r => r.id),
      created_at_first: rows.rows[0]?.created_at,
      created_at_last: rows.rows[rows.rows.length - 1]?.created_at,
      allowed_values: [...new Set(rows.rows.map(r => r.allowed))],
      rows: rows.rows,
    });
  }

  return details;
}

async function main() {
  const configs = buildDatabaseConfigs();
  if (configs.length === 0) {
    console.error("Need DATABASE_URL/ADMIN_DATABASE_URL/AUTH_DATABASE_URL env. Optionally LAWCASPRO_SUPABASE_URL + LAWCASPRO_SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }

  const pool = await connectFirstWorking(configs);
  try {
    console.log("=== Lawcaspro Remote DB: Migration + Duplicate Preflight Audit (READ-ONLY) ===");
    console.log("Date:", new Date().toISOString());
    console.log("Mode: READ-ONLY (no INSERT/UPDATE/DELETE/DDL executed)");
    console.log("Repo root:", repoRoot);

    const schemaMigrations = await querySchemaMigrations(pool);
    const dups = await queryDuplicates(pool);
    const dupDetails = await queryDuplicateRowDetails(pool, dups);
    const indexes = await queryUniqueIndexes(pool);

    const version0120_0142 = {};
    for (const sm of schemaMigrations) {
      if (sm.found && sm.rows.length > 0) {
        for (let v = 120; v <= 142; v++) {
          const vs = String(v).padStart(4, "0");
          const present = sm.rows.some(r => {
            const rv = String(r.version || "").replace(/\.sql$/, "").replace(/^0+/, "");
            const ev = vs.replace(/^0+/, "");
            return rv === ev || String(r.version) === vs || String(r.version).startsWith(vs);
          });
          version0120_0142[`${sm.schema}.${sm.table}#${vs}`] = present;
        }
      }
    }

    const foundMigrations = schemaMigrations.find(s => s.found);
    const allVersions = foundMigrations ? foundMigrations.rows.map(r => String(r.version)) : [];
    const versionsIn0120_0142 = allVersions.filter(v => {
      const n = parseInt(v.replace(/\.sql$/, ""), 10);
      return !isNaN(n) && n >= 120 && n <= 142;
    }).sort();

    const indexStatus = {};
    for (const name of indexes.targetIndexes) {
      const inPgIndexes = indexes.pgIndexes.some(i => i.indexname === name);
      const inConstraints = indexes.pgConstraints.some(c => c.constraint_name === name);
      indexStatus[name] = {
        present_as_index: inPgIndexes,
        present_as_constraint: inConstraints,
        present: inPgIndexes || inConstraints,
      };
    }

    const summary = {
      audit_date: new Date().toISOString(),
      mode: "READ-ONLY",
      schema_migrations: schemaMigrations.map(s => ({
        schema: s.schema,
        table: s.table,
        found: s.found,
        count: s.count,
        error: s.error || null,
        all_versions: s.found ? s.rows.map(r => String(r.version)) : [],
      })),
      versions_0120_to_0142: {
        present: versionsIn0120_0142,
        count: versionsIn0120_0142.length,
        per_version_matrix: version0120_0142,
      },
      duplicates: {
        invoices: {
          count_groups: dups.invoices.length,
          groups: dupDetails.invoices,
        },
        receipts: {
          count_groups: dups.receipts.length,
          groups: dupDetails.receipts,
        },
        permissions: {
          count_groups: dups.permissions.length,
          groups: dupDetails.permissions,
        },
      },
      unique_indexes: {
        target: indexes.targetIndexes,
        pg_indexes_rows: indexes.pgIndexes,
        pg_constraint_rows: indexes.pgConstraints,
        status: indexStatus,
      },
    };

    for (const sm of schemaMigrations) {
      if (sm.found) {
        consoleTable(
          `schema_migrations: ${sm.schema}.${sm.table} (${sm.count} rows, all versions)`,
          sm.rows.slice(0, 5).concat(sm.rows.length > 5 ? [{ "--- truncated": `... ${sm.rows.length - 5} more rows` }] : [])
        );
      } else {
        console.log(`\n=== schema_migrations: ${sm.schema}.${sm.table} ===`);
        console.log("NOT FOUND" + (sm.error ? ` (error: ${sm.error})` : ""));
      }
    }

    consoleTable("schema_migrations: versions in 0120–0142 range",
      versionsIn0120_0142.length > 0
        ? versionsIn0120_0142.map(v => ({ version: v }))
        : [{ version: "(NONE in 0120–0142 range present)" }]
    );

    consoleTable("Duplicates: invoices (firm_id, invoice_no)", dupDetails.invoices.map(d => ({
      firm_id: d.firm_id,
      invoice_no: d.invoice_no,
      count: d.count,
      row_ids: JSON.stringify(d.row_ids),
      created_first: d.created_at_first,
      created_last: d.created_at_last,
    })));

    consoleTable("Duplicates: receipts (firm_id, receipt_no)", dupDetails.receipts.map(d => ({
      firm_id: d.firm_id,
      receipt_no: d.receipt_no,
      count: d.count,
      row_ids: JSON.stringify(d.row_ids),
      created_first: d.created_at_first,
      created_last: d.created_at_last,
    })));

    consoleTable("Duplicates: permissions (role_id, module, action)", dupDetails.permissions.map(d => ({
      role_id: d.role_id,
      module: d.module,
      action: d.action,
      count: d.count,
      row_ids: JSON.stringify(d.row_ids),
      allowed_values: JSON.stringify(d.allowed_values),
      created_first: d.created_at_first,
      created_last: d.created_at_last,
    })));

    consoleTable("pg_indexes rows (target UNIQUE indexes)", indexes.pgIndexes);
    consoleTable("pg_constraint rows (target UNIQUE constraints)", indexes.pgConstraints);

    console.log("\n=== Target UNIQUE Index Status ===");
    for (const [name, s] of Object.entries(indexStatus)) {
      console.log(`  ${name}: present=${s.present} (as_index=${s.present_as_index}, as_constraint=${s.present_as_constraint})`);
    }

    console.log("\n=== Duplicate Count Summary ===");
    console.log(`  invoices duplicate groups: ${dups.invoices.length} (ZERO=${dups.invoices.length === 0})`);
    console.log(`  receipts duplicate groups: ${dups.receipts.length} (ZERO=${dups.receipts.length === 0})`);
    console.log(`  permissions duplicate groups: ${dups.permissions.length} (ZERO=${dups.permissions.length === 0})`);
    const totalDups = dups.invoices.length + dups.receipts.length + dups.permissions.length;
    console.log(`  TOTAL duplicate groups: ${totalDups} -- ${totalDups === 0 ? "ZERO DUPLICATE ROWS DETECTED" : "DUPLICATES DETECTED -- remediation required before UNIQUE index creation"}`);

    console.log("\n=== JSON OUTPUT (BEGIN) ===");
    console.log(JSON.stringify(summary, null, 2));
    console.log("=== JSON OUTPUT (END) ===");

    process.exit(0);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch(err => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  process.exit(99);
});
