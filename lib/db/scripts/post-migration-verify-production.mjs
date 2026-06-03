import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const lowered = databaseUrl.toLowerCase();
const shouldUseSsl =
  lowered.includes("pooler.supabase.com") ||
  lowered.includes("supabase.co") ||
  lowered.includes("supabase.com");

const { Client } = pg;

async function queryRows(client, text, params) {
  const r = await client.query(text, params);
  return r.rows;
}

const getTableColumns = async (client, tableName) => {
  const rows = await queryRows(
    client,
    `
    select
      column_name,
      is_nullable,
      column_default,
      is_identity
    from information_schema.columns
    where table_schema='public'
      and table_name=$1
    order by ordinal_position asc
  `,
    [tableName],
  );
  const byName = new Map();
  for (const r of rows) byName.set(String(r.column_name), r);
  return byName;
};

const tryExec = async (client, sql) => {
  try {
    await client.query(sql);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: err?.code ? String(err.code) : null,
        message: err?.message ? String(err.message) : String(err),
      },
    };
  }
};

let savepointSeq = 0;
const attemptWriteWithSavepoint = async (client, label, fn) => {
  savepointSeq += 1;
  const sp = `sp_${String(label || "write")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 40)}_${savepointSeq}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const res = await fn();
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return { ok: true, rowCount: typeof res?.rowCount === "number" ? res.rowCount : null };
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    const e = err && typeof err === "object" ? err : null;
    return {
      ok: false,
      rowCount: 0,
      error: {
        code: typeof e?.code === "string" ? e.code : null,
        message: typeof e?.message === "string" ? e.message : String(err),
        table: typeof e?.table === "string" ? e.table : null,
        constraint: typeof e?.constraint === "string" ? e.constraint : null,
      },
    };
  }
};

const getSessionDiagnostics = async (client) => {
  const rows = await queryRows(
    client,
    `
    select
      current_user,
      current_role,
      session_user,
      current_setting('app.current_firm_id', true) as current_firm_id,
      current_setting('app.is_founder', true) as is_founder,
      current_setting('row_security', true) as row_security
  `,
  );
  return rows[0] ?? null;
};

const setSession = async (client, opts) => {
  await client.query("reset role");
  const setRoleAttempt = await tryExec(client, "set role app_user");
  await client.query("set row_security = on");
  await client.query(
    `
    select
      set_config('app.current_firm_id', $1, false),
      set_config('app.is_founder', $2, false)
  `,
    [
      opts.currentFirmId == null ? "" : String(opts.currentFirmId),
      opts.isFounder ? "true" : "false",
    ],
  );
  return { setRoleAttempt };
};

const clearSession = async (client) => {
  await client.query(
    `
    select
      set_config('app.current_firm_id', '', false),
      set_config('app.is_founder', 'false', false)
  `,
  );
  await client.query("reset row_security");
  await client.query("reset role");
};

const withSession = async (client, opts, fn) => {
  let setRoleAttempt = null;
  try {
    const s = await setSession(client, opts);
    setRoleAttempt = s?.setRoleAttempt ?? null;
    const diag = await getSessionDiagnostics(client);
    const value = await fn(diag);
    await clearSession(client);
    return { ok: true, diag: { ...diag, setRoleAttempt }, value };
  } catch (err) {
    try {
      await clearSession(client);
    } catch {}
    throw err;
  }
};

const getCheckConstraintDef = async (client, tableName, constraintName) => {
  const rows = await queryRows(
    client,
    `
    select conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = ('public.' || $1)::regclass
      and conname = $2
    limit 1
  `,
    [tableName, constraintName],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    conname: String(row.conname),
    definition: typeof row.definition === "string" ? row.definition : String(row.definition ?? ""),
  };
};

const parseAllowedLiteralsFromConstraint = (def) => {
  if (!def || typeof def !== "string") return [];
  const out = [];
  const re = /'([^']+)'/g;
  let m;
  while ((m = re.exec(def))) out.push(m[1]);
  return out;
};

const getExistingColumnValue = async (client, tableName, columnName) => {
  try {
    const rows = await queryRows(
      client,
      `select ${columnName} as v from ${tableName} where ${columnName} is not null limit 1`,
    );
    if (!rows[0]) return null;
    return rows[0].v ?? null;
  } catch {
    return null;
  }
};

const getAllowedCheckValue = async (
  client,
  tableName,
  columnName,
  constraintName,
  preferredValues,
) => {
  const existing = await getExistingColumnValue(client, tableName, columnName);
  if (existing != null) return String(existing);

  const def = await getCheckConstraintDef(client, tableName, constraintName);
  const allowed = def ? parseAllowedLiteralsFromConstraint(def.definition) : [];
  const preferred = Array.isArray(preferredValues) ? preferredValues.map(String) : [];
  for (const v of preferred) if (allowed.includes(v)) return v;
  if (allowed[0]) return allowed[0];
  if (preferred[0]) return preferred[0];
  return null;
};

const insertRow = async (client, tableName, data) => {
  const cols = await getTableColumns(client, tableName);
  const entries = Object.entries(data || {}).filter(
    ([k, v]) => cols.has(k) && v !== undefined,
  );
  if (entries.length === 0) throw new Error(`insertRow(${tableName}) has no columns to insert`);

  const insertCols = [];
  const placeholders = [];
  const values = [];
  for (const [k, v] of entries) {
    insertCols.push(k);
    values.push(v);
    placeholders.push(`$${values.length}`);
  }

  const idMeta = cols.get("id");
  const isIdentity = String(idMeta?.is_identity ?? "") === "YES";
  const overriding =
    isIdentity && insertCols.includes("id") ? " OVERRIDING SYSTEM VALUE" : "";

  const sql = `insert into ${tableName}(${insertCols.join(", ")})${overriding} values (${placeholders.join(", ")}) returning *`;
  const rows = await queryRows(client, sql, values);
  return rows[0] ?? null;
};

const insertFirm = async (client, args) => {
  const cols = await getTableColumns(client, "firms");
  const insert = {
    id: args.id,
    name: args.name,
    slug: args.slug,
  };

  if (cols.has("status")) insert.status = "active";
  if (cols.has("created_at")) insert.created_at = new Date();
  if (cols.has("updated_at")) insert.updated_at = new Date();

  if (cols.has("subscription_plan_id")) {
    const plan = await queryRows(
      client,
      "select id from subscription_plans order by id asc limit 1",
    );
    if (plan[0]?.id == null) throw new Error("No subscription_plans row found");
    insert.subscription_plan_id = Number(plan[0].id);
  }
  if (cols.has("subscription_status")) insert.subscription_status = "active";
  if (cols.has("is_custom_plan")) insert.is_custom_plan = false;
  if (cols.has("show_master_documents")) insert.show_master_documents = true;

  return await insertRow(client, "firms", insert);
};

const insertFirmSettings = async (client, args) => {
  const cols = await getTableColumns(client, "firm_settings");
  if (!cols.has("firm_id")) throw new Error("firm_settings.firm_id missing");

  const insert = {
    firm_id: args.firmId,
  };
  if (cols.has("use_master_documents")) insert.use_master_documents = args.useMaster;
  if (cols.has("created_at")) insert.created_at = new Date();
  if (cols.has("updated_at")) insert.updated_at = new Date();

  await client.query(
    `
    insert into firm_settings(firm_id, use_master_documents)
    values ($1, $2)
    on conflict (firm_id) do update set use_master_documents = excluded.use_master_documents
  `,
    [args.firmId, args.useMaster],
  );
  return null;
};

const insertTemplate = async (client, args) => {
  const cols = await getTableColumns(client, "templates");
  const insert = {
    id: args.id,
    firm_id: args.firmId,
    name: args.name,
  };
  if (cols.has("file_type")) insert.file_type = "pdf";
  if (cols.has("storage_path")) insert.storage_path = "/objects/templates/verify/test.pdf";
  if (cols.has("is_active")) insert.is_active = true;
  if (cols.has("created_at")) insert.created_at = new Date();
  if (cols.has("updated_at")) insert.updated_at = new Date();
  return await insertRow(client, "templates", insert);
};

const getTemplateByName = async (client, name) => {
  const rows = await queryRows(
    client,
    `
    select id, firm_id, name
    from templates
    where name = $1
    limit 1
  `,
    [name],
  );
  return rows[0] ?? null;
};

const main = async () => {
  const client = new Client({
    connectionString: databaseUrl,
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  await client.connect();

  const result = {
    ok: true,
    mode: "production-safe",
    manualMigrations: null,
    casesSchema: null,
    backfillCheck: null,
    checklistKeyColumn: null,
    policies: null,
    roleSetAttempt: null,
    rls: null,
    pendingApprovalInsert: null,
    residueCheck: null,
  };

  const prefix = `prod_safe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const baseId = -Math.floor(100000000 + Math.random() * 900000000);
  const firmAId = baseId;
  const firmBId = baseId - 1;
  const globalTemplateId = baseId - 101;
  const aTemplateId = baseId - 102;
  const bTemplateId = baseId - 103;
  const deniedInsertTemplateId = baseId - 201;
  const pendingCaseId = baseId - 301;
  const firmASlug = `${prefix}_firm_a`;
  const firmBSlug = `${prefix}_firm_b`;
  const globalTemplateName = `${prefix}_GLOBAL_TEMPLATE`;
  const aTemplateName = `${prefix}_A_TEMPLATE`;
  const bTemplateName = `${prefix}_B_TEMPLATE`;

  let didBegin = false;
  try {
    result.manualMigrations = await queryRows(
      client,
      `
      select tag, applied_at
      from public.lawcaspro_manual_migrations
      where tag like '0100_%'
         or tag like '0101_%'
         or tag like '0102_%'
         or tag like '0103_%'
         or tag like '0104_%'
         or tag like '0105_%'
      order by tag asc
    `,
    );

    result.casesSchema = await queryRows(
      client,
      `
      select
        c.column_name,
        c.is_nullable,
        c.data_type
      from information_schema.columns c
      where c.table_schema='public'
        and c.table_name='cases'
        and c.column_name in (
          'reference_no','project_id','developer_id',
          'approval_status','approved_by','approved_at','approval_note',
          'acting_for','perfection_type'
        )
      order by c.column_name asc
    `,
    );

    const backfillBad = await queryRows(
      client,
      `
      select id, firm_id, reference_no, approval_status, approved_at
      from cases
      where reference_no is not null
        and approval_status = 'pending_approval'
      order by id asc
      limit 50
    `,
    );
    result.backfillCheck = {
      badRowsSample: backfillBad,
      badCount: backfillBad.length,
    };

    result.checklistKeyColumn = await queryRows(
      client,
      `
      select column_name, is_nullable, data_type
      from information_schema.columns
      where table_schema='public'
        and table_name='case_documents'
        and column_name='checklist_key'
    `,
    );

    result.policies = await queryRows(
      client,
      `
      select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies
      where schemaname='public'
        and tablename in (
          'templates',
          'platform_documents',
          'case_documents',
          'document_generation_jobs',
          'document_generation_job_items',
          'document_generation_logs',
          'bank_transactions',
          'case_ledgers'
        )
      order by tablename asc, policyname asc
    `,
    );

    result.roleSetAttempt = await tryExec(client, "reset role; set role app_user; reset role;");
    if (!result.roleSetAttempt.ok) throw new Error("Cannot SET ROLE app_user");

    await client.query("begin");
    didBegin = true;

    const firmA = await insertFirm(client, {
      id: firmAId,
      slug: firmASlug,
      name: `${prefix} Firm A`,
    });
    const firmB = await insertFirm(client, {
      id: firmBId,
      slug: firmBSlug,
      name: `${prefix} Firm B`,
    });
    if (!firmA?.id || !firmB?.id) throw new Error("Failed to insert test firms");

    await insertFirmSettings(client, { firmId: Number(firmA.id), useMaster: true });
    await insertFirmSettings(client, { firmId: Number(firmB.id), useMaster: false });

    await insertTemplate(client, { id: globalTemplateId, firmId: null, name: globalTemplateName });
    await insertTemplate(client, { id: aTemplateId, firmId: Number(firmA.id), name: aTemplateName });
    await insertTemplate(client, { id: bTemplateId, firmId: Number(firmB.id), name: bTemplateName });

    const templatesCols = await getTableColumns(client, "templates");
    const templatesIdMeta = templatesCols.get("id");
    const templatesIdIsIdentity = String(templatesIdMeta?.is_identity ?? "") === "YES";

    const templateNames = [globalTemplateName, aTemplateName, bTemplateName];

    const firmAView = await withSession(
      client,
      { currentFirmId: Number(firmA.id), isFounder: false },
      async () =>
        queryRows(
          client,
          `
          select id, firm_id, name
          from templates
          where name = any($1::text[])
          order by name asc
        `,
          [templateNames],
        ),
    );

    const firmBView = await withSession(
      client,
      { currentFirmId: Number(firmB.id), isFounder: false },
      async () =>
        queryRows(
          client,
          `
          select id, firm_id, name
          from templates
          where name = any($1::text[])
          order by name asc
        `,
          [templateNames],
        ),
    );

    const founderView = await withSession(
      client,
      { currentFirmId: null, isFounder: true },
      async () =>
        queryRows(
          client,
          `
          select id, firm_id, name
          from templates
          where name = any($1::text[])
          order by name asc
        `,
          [templateNames],
        ),
    );

    const globalWriteAttempts = await withSession(
      client,
      { currentFirmId: Number(firmA.id), isFounder: false },
      async () => {
        const beforeGlobalRow = await getTemplateByName(client, globalTemplateName);

        const insertAttempt = await attemptWriteWithSavepoint(client, "global_insert", () =>
          client.query(
            `
            insert into templates(id, firm_id, name, file_type, storage_path, is_active)${
              templatesIdIsIdentity ? " OVERRIDING SYSTEM VALUE" : ""
            }
            values ($2, null, $1, 'pdf', '/objects/templates/verify/test.pdf', true)
          `,
            [`${prefix}_FIRM_GLOBAL_WRITE`, deniedInsertTemplateId],
          ),
        );

        const afterInsertGlobalRow = await getTemplateByName(client, globalTemplateName);

        const updateAttempt = await attemptWriteWithSavepoint(client, "global_update", () =>
          client.query(
            `
            update templates
            set name = $2
            where firm_id is null and name = $1
          `,
            [globalTemplateName, `${globalTemplateName}_SHOULD_NOT_CHANGE`],
          ),
        );

        const afterUpdateGlobalRow = await getTemplateByName(client, globalTemplateName);

        const deleteAttempt = await attemptWriteWithSavepoint(client, "global_delete", () =>
          client.query(
            `
            delete from templates
            where firm_id is null and name = $1
          `,
            [globalTemplateName],
          ),
        );

        const afterDeleteGlobalRow = await getTemplateByName(client, globalTemplateName);

        return {
          beforeGlobalRow,
          insertAttempt,
          afterInsertGlobalRow,
          updateAttempt,
          afterUpdateGlobalRow,
          deleteAttempt,
          afterDeleteGlobalRow,
        };
      },
    );

    const pendingApprovalInsert = await withSession(
      client,
      { currentFirmId: Number(firmA.id), isFounder: false },
      async () => {
        const casesCols = await getTableColumns(client, "cases");
        if (!casesCols.has("firm_id")) throw new Error("cases.firm_id missing");

        const insertCols = [];
        const placeholders = [];
        const values = [];
        const add = (col, val) => {
          if (!casesCols.has(col)) return;
          insertCols.push(col);
          values.push(val);
          placeholders.push(`$${values.length}`);
        };

        const idMeta = casesCols.get("id");
        const isIdentity = String(idMeta?.is_identity ?? "") === "YES";

        add("id", pendingCaseId);
        add("firm_id", Number(firmA.id));

        if (casesCols.has("reference_no")) {
          const meta = casesCols.get("reference_no");
          const nullable = String(meta?.is_nullable ?? "") === "YES";
          if (nullable) add("reference_no", null);
        }

        if (casesCols.has("project_id")) {
          const meta = casesCols.get("project_id");
          const nullable = String(meta?.is_nullable ?? "") === "YES";
          const hasDefault = Boolean(meta?.column_default);
          if (!nullable && !hasDefault) {
            const existing = await getExistingColumnValue(client, "cases", "project_id");
            add("project_id", existing != null ? Number(existing) : 1);
          }
        }

        if (casesCols.has("developer_id")) {
          const meta = casesCols.get("developer_id");
          const nullable = String(meta?.is_nullable ?? "") === "YES";
          const hasDefault = Boolean(meta?.column_default);
          if (!nullable && !hasDefault) {
            const existing = await getExistingColumnValue(client, "cases", "developer_id");
            add("developer_id", existing != null ? Number(existing) : 1);
          }
        }

        if (casesCols.has("title_type")) {
          const meta = casesCols.get("title_type");
          const nullable = String(meta?.is_nullable ?? "") === "YES";
          const hasDefault = Boolean(meta?.column_default);
          if (!nullable && !hasDefault) {
            const picked = await getAllowedCheckValue(
              client,
              "cases",
              "title_type",
              "cases_title_type_check",
              ["individual", "individual_title", "strata", "strata_title", "master", "master_title"],
            );
            if (picked) add("title_type", picked);
          }
        }

        const overriding =
          isIdentity && insertCols.includes("id") ? " OVERRIDING SYSTEM VALUE" : "";
        const sql = `
          insert into cases(${insertCols.join(", ")})${overriding}
          values (${placeholders.join(", ")})
          returning id, reference_no, approval_status
        `;
        const inserted = await queryRows(client, sql, values);
        return inserted[0] ?? null;
      },
    );

    result.pendingApprovalInsert = pendingApprovalInsert.value;

    result.rls = {
      testData: {
        prefix,
        ids: {
          firmAId,
          firmBId,
          globalTemplateId,
          aTemplateId,
          bTemplateId,
          deniedInsertTemplateId,
          pendingCaseId,
        },
        firmA: Number(firmA.id),
        firmB: Number(firmB.id),
        names: { globalTemplateName, aTemplateName, bTemplateName },
      },
      templates: {
        firmA: { count: firmAView.value.length, rows: firmAView.value, diag: firmAView.diag },
        firmB: { count: firmBView.value.length, rows: firmBView.value, diag: firmBView.diag },
        founder: { count: founderView.value.length, rows: founderView.value, diag: founderView.diag },
        expectedCountsForTestDataOnly: { firmA: 2, firmB: 1, founder: 3 },
        firmBSeesGlobalTemplate: firmBView.value.some((r) => r?.name === globalTemplateName),
      },
      globalWriteAttempts: {
        ...globalWriteAttempts.value,
        diag: globalWriteAttempts.diag,
      },
    };
  } catch (err) {
    result.ok = false;
    const e = err && typeof err === "object" ? err : null;
    result.error = {
      code: typeof e?.code === "string" ? e.code : null,
      message: typeof e?.message === "string" ? e.message : String(err),
      table: typeof e?.table === "string" ? e.table : null,
      constraint: typeof e?.constraint === "string" ? e.constraint : null,
    };
  } finally {
    if (didBegin) {
      try {
        await client.query("rollback");
      } catch {}
    }
    try {
      const firmsCount = await queryRows(
        client,
        `select count(*)::int as c from firms where slug like $1`,
        [`${prefix}%`],
      );
      const templatesCount = await queryRows(
        client,
        `select count(*)::int as c from templates where name like $1`,
        [`${prefix}%`],
      );
      const casesCount = await queryRows(
        client,
        `select count(*)::int as c from cases where id = $1`,
        [pendingCaseId],
      );
      result.residueCheck = {
        firms: Number(firmsCount[0]?.c ?? 0),
        templates: Number(templatesCount[0]?.c ?? 0),
        cases: Number(casesCount[0]?.c ?? 0),
      };
    } catch (err) {
      result.residueCheck = { ok: false, message: String(err) };
    }
    await client.end();
  }

  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write("\n");
};

await main();
