import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const lowered = databaseUrl.toLowerCase();
const shouldUseSsl =
  lowered.includes("pooler.supabase.com") ||
  lowered.includes("supabase.co") ||
  lowered.includes("supabase.com");

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, "../migrations");

const files = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isFile() && /^\d{4}_.+\.sql$/.test(d.name))
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b));

const fromPrefix = process.env.MIGRATE_FROM_PREFIX ?? "0000";
const toPrefix = process.env.MIGRATE_TO_PREFIX ?? "0104";

const parsePrefix = (name) => name.slice(0, 4);

const startIdx = files.findIndex((f) => f.startsWith(`${fromPrefix}_`));
if (startIdx < 0) throw new Error(`MIGRATE_FROM_PREFIX not found: ${fromPrefix}`);
const endIdx = (() => {
  const i = files
    .map((f, idx) => ({ f, idx }))
    .filter((x) => parsePrefix(x.f) <= toPrefix)
    .map((x) => x.idx)
    .pop();
  return typeof i === "number" ? i : files.length - 1;
})();

const isSkippableAlreadyAppliedError = (err) => {
  const code = err?.code ? String(err.code) : "";
  const msg = err?.message ? String(err.message) : "";
  if (code === "42P07") return true;
  if (code === "42710") return true;
  if (code === "42701") return true;
  if (code === "23505" && msg.includes("lawcaspro_manual_migrations_pkey")) return true;
  return false;
};

const ensureManualMigrationsTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.lawcaspro_manual_migrations (
      tag text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

const markApplied = async (client, tag) => {
  await client.query(
    "insert into public.lawcaspro_manual_migrations(tag) values ($1) on conflict do nothing",
    [tag],
  );
};

const wasApplied = async (client, tag) => {
  const r = await client.query(
    "select tag from public.lawcaspro_manual_migrations where tag = $1 limit 1",
    [tag],
  );
  return Boolean(r.rowCount && r.rowCount > 0);
};

const resetPublicSchema = async (client) => {
  await client.query("begin");
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("create schema public");
    await client.query("grant usage on schema public to public");
    await client.query("grant all on schema public to postgres");
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
};

const execFile = async (client, fileName) => {
  const tag = fileName.replace(/\.sql$/, "");
  const sqlFile = path.join(MIGRATIONS_DIR, fileName);
  const sqlText = fs.readFileSync(sqlFile, "utf8");
  await client.query("begin");
  try {
    await client.query(sqlText);
    await markApplied(client, tag);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    if (isSkippableAlreadyAppliedError(err)) {
      await markApplied(client, tag);
      return { tag, status: "skip_already_applied" };
    }
    throw Object.assign(new Error(`migration failed: ${tag}`), {
      cause: err,
      tag,
      fileName,
    });
  }
  return { tag, status: "applied" };
};

const queryValue = async (client, text, params) => {
  const r = await client.query(text, params);
  const row = r.rows[0];
  if (!row) return null;
  const k = Object.keys(row)[0];
  return row[k];
};

const ensureSeedFirm = async (client, name) => {
  const id = await queryValue(
    client,
    "insert into firms(name) values ($1) returning id",
    [name],
  );
  return Number(id);
};

const ensureFirmSettings = async (client, firmId, useMaster) => {
  await client.query(
    `
    insert into firm_settings(firm_id, use_master_documents)
    values ($1, $2)
    on conflict (firm_id) do update set use_master_documents = excluded.use_master_documents
  `,
    [firmId, useMaster],
  );
};

const insertTemplate = async (client, firmIdOrNull, name) => {
  const id = await queryValue(
    client,
    "insert into templates(firm_id, name, file_type, storage_path, is_active) values ($1, $2, 'pdf', '/objects/templates/global/test.pdf', true) returning id",
    [firmIdOrNull, name],
  );
  return Number(id);
};

const canSetRole = async (client, roleName) => {
  try {
    await client.query(`set local role ${roleName}`);
    return true;
  } catch {
    return false;
  }
};

const runRlsChecks = async (client) => {
  const out = [];
  await client.query("set row_security = on");

  const firmA = await ensureSeedFirm(client, "Firm A");
  const firmB = await ensureSeedFirm(client, "Firm B");

  await ensureFirmSettings(client, firmA, true);
  await ensureFirmSettings(client, firmB, false);

  await insertTemplate(client, null, "GLOBAL");
  await insertTemplate(client, firmA, "A_ONLY");
  await insertTemplate(client, firmB, "B_ONLY");

  const roleOk = await canSetRole(client, "app_user");
  out.push({ check: "set_role_app_user", ok: roleOk });

  const runAs = async (firmId, isFounder, fn) => {
    await client.query("begin");
    try {
      await client.query("set local row_security = on");
      await client.query(
        "set local app.current_firm_id = $1",
        [firmId == null ? "" : String(firmId)],
      );
      await client.query(
        "set local app.is_founder = $1",
        [isFounder ? "true" : "false"],
      );
      const result = await fn();
      await client.query("rollback");
      return result;
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  };

  const listTemplates = async () => {
    const r = await client.query("select id, firm_id, name from templates order by id asc");
    return r.rows.map((x) => ({
      id: x.id,
      firm_id: x.firm_id,
      name: x.name,
    }));
  };

  const tA = await runAs(firmA, false, listTemplates);
  const tB = await runAs(firmB, false, listTemplates);
  const tFounder = await runAs(null, true, listTemplates);

  out.push({ check: "templates_firmA_visible", rows: tA });
  out.push({ check: "templates_firmB_visible", rows: tB });
  out.push({ check: "templates_founder_visible", rows: tFounder });

  const platformPolicy = await client.query(
    `
    select policyname, qual
    from pg_policies
    where schemaname='public' and tablename='platform_documents' and policyname='platform_documents_read'
  `,
  );
  out.push({
    check: "platform_documents_read_policy",
    rows: platformPolicy.rows,
  });

  return out;
};

const insertCasesPre0078 = async (client) => {
  const firmId = await ensureSeedFirm(client, "Case Firm");
  const caseId1 = await queryValue(
    client,
    `
    insert into cases(firm_id, case_type, status, title_type, purchase_mode, reference_no, property_details, loan_details)
    values ($1, 'conveyancing', 'open', 'title', 'subsale', 'CON/001', $2, $3)
    returning id
  `,
    [firmId, "M Legasi Phase 3 Unit PT21085", "Maybank Loan RM500000"],
  );

  const caseId2 = await queryValue(
    client,
    `
    insert into cases(firm_id, case_type, status, title_type, purchase_mode, reference_no, property_details, loan_details)
    values ($1, 'conveyancing', 'open', 'title', 'subsale', 'CON/002', $2, $3)
    returning id
  `,
    [firmId, `{"foo":"bar"}`, `{"loan":"RM500000"}`],
  );

  return { firmId, caseId1: Number(caseId1), caseId2: Number(caseId2) };
};

const verify0078After = async (client, ids) => {
  const rows = await client.query(
    "select id, property_details, loan_details from cases where id = any($1::int[]) order by id asc",
    [[ids.caseId1, ids.caseId2]],
  );
  return rows.rows;
};

const insertCasesPre0101 = async (client) => {
  const firmId = await ensureSeedFirm(client, "Approval Firm");
  const oldId = await queryValue(
    client,
    `
    insert into cases(firm_id, case_type, status, title_type, purchase_mode, reference_no)
    values ($1, 'conveyancing', 'open', 'title', 'subsale', 'CON/OLD')
    returning id
  `,
    [firmId],
  );
  const newId = await queryValue(
    client,
    `
    insert into cases(firm_id, case_type, status, title_type, purchase_mode, reference_no)
    values ($1, 'conveyancing', 'open', 'title', 'subsale', null)
    returning id
  `,
    [firmId],
  );
  return { firmId, oldId: Number(oldId), newId: Number(newId) };
};

const verify0101After = async (client, ids) => {
  const rows = await client.query(
    "select id, reference_no, approval_status, approved_at from cases where id = any($1::int[]) order by id asc",
    [[ids.oldId, ids.newId]],
  );
  return rows.rows;
};

const main = async () => {
  const client = new Client({
    connectionString: databaseUrl,
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  await client.connect();
  try {
    const reset = process.env.RESET_PUBLIC_SCHEMA === "1";
    if (reset) await resetPublicSchema(client);

    await ensureManualMigrationsTable(client);

    const summary = [];

    let pre0078CaseIds = null;
    let pre0101CaseIds = null;

    for (let i = startIdx; i <= endIdx; i++) {
      const fileName = files[i];
      if (!fileName) continue;
      const tag = fileName.replace(/\.sql$/, "");
      const already = await wasApplied(client, tag);
      if (already) continue;

      if (fileName.startsWith("0078_")) {
        pre0078CaseIds = await insertCasesPre0078(client);
      }
      if (fileName.startsWith("0101_")) {
        pre0101CaseIds = await insertCasesPre0101(client);
      }

      const r = await execFile(client, fileName);
      summary.push(r);

      if (fileName.startsWith("0078_") && pre0078CaseIds) {
        const rows = await verify0078After(client, pre0078CaseIds);
        summary.push({ tag: "verify_0078", rows });
      }
      if (fileName.startsWith("0101_") && pre0101CaseIds) {
        const rows = await verify0101After(client, pre0101CaseIds);
        summary.push({ tag: "verify_0101", rows });
      }
    }

    if (parsePrefix(files[endIdx]) === "0104") {
      const rls = await runRlsChecks(client);
      summary.push({ tag: "verify_rls", rls });
    }

    process.stdout.write(JSON.stringify({ ok: true, summary }, null, 2));
    process.stdout.write("\n");
  } finally {
    await client.end();
  }
};

await main();

