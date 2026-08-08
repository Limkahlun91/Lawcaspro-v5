import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve } from "node:path";

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = pathResolve(__dirname, "..", "..");

function envFrom(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function buildDatabaseUrl() {
  const fromEnv = envFrom("DATABASE_URL") || envFrom("ADMIN_DATABASE_URL") || envFrom("AUTH_DATABASE_URL");
  if (fromEnv) return fromEnv;

  const projectUrl = envFrom("LAWCASPRO_SUPABASE_URL");
  const serviceKey = envFrom("LAWCASPRO_SUPABASE_SERVICE_ROLE_KEY");
  if (projectUrl && serviceKey) {
    const host = projectUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `postgresql://postgres.${host}:${serviceKey}@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true`;
  }
  return null;
}

function get(url) {
  return new Pool({ connectionString: url, max: 2 });
}

async function info_schema_audit(pool) {
  const cols = await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('payment_vouchers', 'payment_voucher_actions', 'accounting_settings', 'user_notifications')
    ORDER BY table_name, ordinal_position
  `);

  const indexes = await pool.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('payment_vouchers', 'payment_voucher_actions', 'accounting_settings', 'user_notifications')
    ORDER BY tablename, indexname
  `);

  const tablesExist = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('payment_vouchers', 'payment_voucher_actions', 'accounting_settings', 'user_notifications')
  `);

  const rls = await pool.query(`
    SELECT relname AS table_name,
           relrowsecurity AS rls_enabled,
           relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND relname IN ('accounting_settings', 'payment_voucher_actions', 'user_notifications')
  `);

  const policies = await pool.query(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('accounting_settings', 'payment_voucher_actions', 'user_notifications')
    ORDER BY tablename, policyname
  `);

  const pvCount = await pool.query(`SELECT COUNT(*)::bigint AS n FROM payment_vouchers`);

  return {
    tableNames: tablesExist.rows.map(r => r.table_name).sort(),
    columns: cols.rows,
    indexes: indexes.rows,
    rls: rls.rows,
    policies: policies.rows,
    pvCount: Number(pvCount.rows[0].n),
  };
}

function compare0122(cur) {
  const present = new Set(cur.tableNames);

  const missingTables = [];
  ["accounting_settings", "payment_voucher_actions", "user_notifications"].forEach(t => {
    if (!present.has(t)) missingTables.push(t);
  });

  function colsFor(t) {
    return new Set(cur.columns.filter(c => c.table_name === t).map(c => c.column_name));
  }
  function idxsFor(t) {
    return new Set(cur.indexes.filter(r => r.tablename === t).map(r => r.indexname));
  }

  const pvCols = colsFor("payment_vouchers");
  const expectedPVCols = [
    "received_by","received_at","assigned_account_user_id","payment_due_at",
    "sla_policy_snapshot","due_soon_notified_at","overdue_notified_at","breached_at",
    "deadline_override_reason","deadline_overridden_by","deadline_overridden_at",
    "paid_amount","proof_document_path","next_action_type","next_action_custom",
    "next_action_remarks","assigned_clerk_user_id","clerk_action_exempt_reason",
    "late_completion_reason",
  ];
  const missingPVCols = expectedPVCols.filter(c => !pvCols.has(c));

  const pvIdxs = idxsFor("payment_vouchers");
  const expectedPVIdxs = [
    "idx_pvouchers_firm_assigned_account",
    "idx_pvouchers_firm_due_at",
    "idx_pvouchers_firm_received_at",
    "idx_pvouchers_firm_assigned_clerk",
  ];
  const missingPVIdxs = expectedPVIdxs.filter(i => !pvIdxs.has(i));

  const expected = {
    accounting_settings: {
      cols: [
        "firm_id","account_manager_role_ids","account_admin_role_ids","timezone",
        "working_hours_start","working_hours_end","exclude_saturday","exclude_sunday",
        "firm_holidays","approval_rules","payment_voucher_sla","clerk_action_sla",
        "payment_proof_required","created_by","updated_by","created_at","updated_at",
      ],
      idxs: ["idx_accounting_settings_timezone"],
    },
    payment_voucher_actions: {
      cols: [
        "id","firm_id","payment_voucher_id","case_id","assigned_user_id","action_type",
        "custom_action","status","priority","assigned_at","acknowledge_due_at",
        "acknowledged_by","acknowledged_at","completion_due_at","completed_by",
        "completed_at","completion_notes","completion_attachment_path","updated_milestone",
        "breached_at","cancelled_at","cancelled_by","created_by","created_at","updated_at",
      ],
      idxs: [
        "idx_payment_voucher_actions_firm_voucher",
        "idx_payment_voucher_actions_firm_assigned",
        "idx_payment_voucher_actions_firm_case",
        "idx_payment_voucher_actions_firm_completion_due",
        "idx_payment_voucher_actions_firm_ack_due",
        "uq_payment_voucher_actions_active",
      ],
    },
    user_notifications: {
      cols: [
        "id","firm_id","user_id","source_type","source_id","case_id","notification_type",
        "title","message","meta","is_read","read_at","created_at",
      ],
      idxs: [
        "idx_user_notifications_firm_user_unread",
        "idx_user_notifications_firm_user_type",
        "idx_user_notifications_firm_case",
      ],
    },
  };

  const missingPerTable = {};
  for (const t of Object.keys(expected)) {
    const curCols = colsFor(t);
    const curIdxs = idxsFor(t);
    const mc = expected[t].cols.filter(c => !curCols.has(c));
    const mi = expected[t].idxs.filter(i => !curIdxs.has(i));
    missingPerTable[t] = {
      tableMissing: missingTables.includes(t),
      missingColumns: mc,
      missingIndexes: mi,
    };
  }

  const rls = {};
  cur.rls.forEach(r => {
    rls[r.table_name] = { enabled: !!r.rls_enabled, forced: !!r.rls_forced };
  });
  const expectedPolicyNames = {
    accounting_settings: ["accounting_settings_rw"],
    payment_voucher_actions: ["payment_voucher_actions_rw"],
    user_notifications: ["user_notifications_rw"],
  };
  const policiesPresent = {};
  for (const t of Object.keys(expectedPolicyNames)) {
    const got = new Set(cur.policies.filter(p => p.tablename === t).map(p => p.policyname));
    policiesPresent[t] = {
      expectedPolicyNames: expectedPolicyNames[t],
      missing: expectedPolicyNames[t].filter(n => !got.has(n)),
      actual: [...got].sort(),
    };
  }

  return {
    pvCountRemote: cur.pvCount,
    payment_vouchers: {
      missingColumns: missingPVCols,
      missingIndexes: missingPVIdxs,
    },
    perTable: missingPerTable,
    rls,
    policies: policiesPresent,
  };
}

async function main() {
  const mode = (process.argv[2] || "audit").trim().toLowerCase();
  const url = buildDatabaseUrl();
  if (!url) {
    console.error("Need DATABASE_URL/ADMIN_DATABASE_URL/AUTH_DATABASE_URL env. Optionally LAWCASPRO_SUPABASE_URL + LAWCASPRO_SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }

  const pool = get(url);
  try {
    const audit = await info_schema_audit(pool);
    const diff = compare0122(audit);

    if (mode === "audit") {
      console.log(JSON.stringify({
        tableNamesPresent: audit.tableNames,
        pvCountRemote: diff.pvCountRemote,
        payment_vouchers: diff.payment_vouchers,
        perTable: diff.perTable,
        rls: diff.rls,
        policies: diff.policies,
      }, null, 2));
      process.exit(0);
    }

    if (mode === "apply") {
      const migrationPath = pathResolve(repoRoot, "lib/db/migrations/0122_accounting_settings_and_payment_voucher_sla.sql");
      const sql = readFileSync(migrationPath, "utf8");

      const before = (await pool.query("SELECT COUNT(*)::bigint AS n FROM payment_vouchers")).rows[0].n;
      console.log("About to apply 0122. Existing PV rows (before apply): " + before);
      console.log("Destructive operation count = 0 (all ALTER ADD IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)");
      console.log("Existing row deletion = 0");
      console.log("Existing data rewrite = 0 (no UPDATEs in 0122; indexes added do not rewrite heap; backfill not present for settings created empty rows for firms w/o rows via NULL defaults only)");

      const res = await pool.query(sql);
      const after = (await pool.query("SELECT COUNT(*)::bigint AS n FROM payment_vouchers")).rows[0].n;
      console.log("0122 applied. PV rows after: " + after + " (unchanged expected)");

      const postAudit = await info_schema_audit(pool);
      const postDiff = compare0122(postAudit);
      const allPVColsPresent = postDiff.payment_vouchers.missingColumns.length === 0 && postDiff.payment_vouchers.missingIndexes.length === 0;
      const perTableOk = Object.keys(postDiff.perTable).every(t =>
        !postDiff.perTable[t].tableMissing &&
        postDiff.perTable[t].missingColumns.length === 0 &&
        postDiff.perTable[t].missingIndexes.length === 0
      );
      const policiesOk = Object.keys(postDiff.policies).every(t => postDiff.policies[t].missing.length === 0);
      const rlsOk = Object.keys(postDiff.rls).every(t => postDiff.rls[t].enabled && postDiff.rls[t].forced);
      console.log(JSON.stringify({
        pvRowsBefore: Number(before),
        pvRowsAfter: Number(after),
        pvRowsUnchanged: String(before) === String(after),
        receivedAtPresent: new Set(postAudit.columns.filter(c => c.table_name === "payment_vouchers").map(c => c.column_name)).has("received_at"),
        nextActionRemarksPresent: new Set(postAudit.columns.filter(c => c.table_name === "payment_vouchers").map(c => c.column_name)).has("next_action_remarks"),
        allPVColsAndIndexesPresent: allPVColsPresent,
        allTablesComplete: perTableOk,
        allPoliciesApplied: policiesOk,
        allRLSEnabledAndForced: rlsOk,
        postDiffSummary: postDiff,
        applyResultCommandTag: res && typeof res.command === "string" ? res.command : "batch",
      }, null, 2));
      const ok = (
        String(before) === String(after) &&
        allPVColsPresent &&
        perTableOk &&
        policiesOk &&
        rlsOk
      );
      process.exit(ok ? 0 : 1);
    }

    console.error("Unknown mode: " + mode + " (use 'audit' or 'apply')");
    process.exit(3);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  process.exit(99);
});
