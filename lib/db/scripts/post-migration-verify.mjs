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
      column_default
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

const pickSubscriptionPlanId = async (client) => {
  const starter = await queryRows(
    client,
    "select id from subscription_plans where lower(name)='starter' limit 1",
  );
  if (starter[0]?.id != null) return Number(starter[0].id);
  const anyActive = await queryRows(
    client,
    "select id from subscription_plans where is_active = true order by id asc limit 1",
  );
  if (anyActive[0]?.id != null) return Number(anyActive[0].id);
  const created = await queryRows(
    client,
    "insert into subscription_plans(name, price_monthly, is_active) values ('starter', 0, true) returning id",
  );
  return Number(created[0]?.id);
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

const tryExecWithRowCount = async (client, sql, params) => {
  try {
    const res = await client.query(sql, params);
    return { ok: true, rowCount: typeof res.rowCount === "number" ? res.rowCount : null };
  } catch (err) {
    const e = err && typeof err === "object" ? err : null;
    return {
      ok: false,
      rowCount: null,
      code: typeof e?.code === "string" ? e.code : null,
      message: typeof e?.message === "string" ? e.message : String(err),
      detail: typeof e?.detail === "string" ? e.detail : null,
      table: typeof e?.table === "string" ? e.table : null,
      column: typeof e?.column === "string" ? e.column : null,
      constraint: typeof e?.constraint === "string" ? e.constraint : null,
      schema: typeof e?.schema === "string" ? e.schema : null,
      position: typeof e?.position === "string" ? e.position : null,
    };
  }
};

const attemptWriteWithSavepoint = async (client, label, fn) => {
  const sp = `sp_${String(label || "write").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 50)}`;
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

const getGlobalTemplateRow = async (client) => {
  const rows = await queryRows(
    client,
    `
    select id, firm_id, name
    from templates
    where firm_id is null and name='GLOBAL_TEMPLATE'
    limit 1
  `,
  );
  return rows[0] ?? null;
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

const getRoleAttributes = async (client) => {
  const rows = await queryRows(
    client,
    `
    select rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
    from pg_roles
    where rolname in ('app_user', current_user, session_user)
    order by rolname asc
  `,
  );
  return rows;
};

const getPoliciesForTables = async (client, tables) => {
  const t = Array.isArray(tables) ? tables.map(String).filter(Boolean) : [];
  if (t.length === 0) return [];
  const rows = await queryRows(
    client,
    `
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies
    where schemaname='public'
      and tablename = any($1::text[])
    order by tablename asc, policyname asc
  `,
    [t],
  );
  return rows;
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

const ensureTestFirm = async (client) => {
  throw new Error("ensureTestFirm requires slug; use ensureFirm()");
};

const ensureFirm = async (client, args) => {
  const slug = String(args.slug || "").trim();
  if (!slug) throw new Error("ensureFirm requires slug");
  const name = String(args.name || slug).trim() || slug;

  const existing = await queryRows(
    client,
    "select id from firms where slug = $1 limit 1",
    [slug],
  );
  if (existing[0]?.id != null) return Number(existing[0].id);

  const cols = await getTableColumns(client, "firms");

  const insertCols = [];
  const placeholders = [];
  const values = [];
  const add = (col, val) => {
    if (!cols.has(col)) return;
    insertCols.push(col);
    values.push(val);
    placeholders.push(`$${values.length}`);
  };

  add("name", name);
  add("slug", slug);

  if (cols.has("status")) add("status", "active");
  if (cols.has("created_at")) add("created_at", new Date());
  if (cols.has("updated_at")) add("updated_at", new Date());

  if (cols.has("subscription_plan_id")) {
    const planId = await pickSubscriptionPlanId(client);
    add("subscription_plan_id", planId);
  }
  if (cols.has("subscription_status")) add("subscription_status", "active");
  if (cols.has("is_custom_plan")) add("is_custom_plan", false);
  if (cols.has("show_master_documents")) add("show_master_documents", true);

  const sql = `insert into firms(${insertCols.join(", ")}) values (${placeholders.join(", ")}) returning id`;
  const rows = await queryRows(client, sql, values);
  return Number(rows[0]?.id);
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

const ensureTemplate = async (client, firmIdOrNull, name) => {
  const existing = await queryRows(
    client,
    "select id from templates where firm_id is not distinct from $1 and name = $2 limit 1",
    [firmIdOrNull, name],
  );
  if (existing[0]?.id != null) return Number(existing[0].id);
  const rows = await queryRows(
    client,
    `
    insert into templates(firm_id, name, file_type, storage_path, is_active)
    values ($1, $2, 'pdf', '/objects/templates/global/test.pdf', true)
    returning id
  `,
    [firmIdOrNull, name],
  );
  return Number(rows[0]?.id);
};

const ensurePlatformDocument = async (client, firmIdOrNull, name) => {
  const cols = await getTableColumns(client, "platform_documents");

  const firmCol = cols.has("firm_id") ? "firm_id" : cols.has("firmId") ? "firmId" : null;
  const nameCol = cols.has("name") ? "name" : null;
  const fileNameCol = cols.has("file_name") ? "file_name" : null;
  const fileTypeCol = cols.has("file_type") ? "file_type" : null;
  const objectPathCol = cols.has("object_path") ? "object_path" : null;
  const uploadedByCol = cols.has("uploaded_by") ? "uploaded_by" : null;
  const isActiveCol = cols.has("is_active") ? "is_active" : null;

  if (!nameCol) throw new Error("platform_documents.name column missing");
  if (!fileNameCol || !fileTypeCol || !objectPathCol)
    throw new Error("platform_documents missing required file_* columns");

  const existing = await queryRows(
    client,
    `select id from platform_documents where ${firmCol ? `${firmCol} is not distinct from $1 and` : ""} ${nameCol} = $2 limit 1`,
    firmCol ? [firmIdOrNull, name] : [name],
  );
  if (existing[0]?.id != null) return Number(existing[0].id);

  const insertCols = [];
  const placeholders = [];
  const values = [];
  const add = (col, val) => {
    if (!col) return;
    insertCols.push(col);
    values.push(val);
    placeholders.push(`$${values.length}`);
  };

  if (firmCol) add(firmCol, firmIdOrNull);
  add(nameCol, name);
  add(fileNameCol, `${name}.pdf`);
  add(fileTypeCol, "pdf");
  add(objectPathCol, "/objects/platform-documents/test.pdf");
  if (isActiveCol) add(isActiveCol, true);

  if (uploadedByCol) add(uploadedByCol, 1);

  const sql = `insert into platform_documents(${insertCols.join(", ")}) values (${placeholders.join(", ")}) returning id`;
  const rows = await queryRows(client, sql, values);
  return Number(rows[0]?.id);
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

const runWithSession = async (client, opts, fn) => {
  await client.query("begin");
  let setRoleAttempt = null;
  try {
    const s = await setSession(client, opts);
    setRoleAttempt = s?.setRoleAttempt ?? null;
    const diag = await getSessionDiagnostics(client);
    const out = await fn(diag);
    try {
      await client.query("rollback");
    } finally {
      await clearSession(client);
    }
    return { ok: true, diag: { ...diag, setRoleAttempt }, value: out };
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {}
    try {
      await clearSession(client);
    } catch {}
    throw err;
  }
};

const countRows = async (client, table) => {
  const rows = await queryRows(client, `select count(*)::int as c from ${table}`);
  return Number(rows[0]?.c ?? 0);
};

const main = async () => {
  const client = new Client({
    connectionString: databaseUrl,
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  await client.connect();
  try {
    const result = {
      ok: true,
      manualMigrations: null,
      casesSchema: null,
      backfillCheck: null,
      pendingApprovalInsert: null,
      rls: null,
      templatesMasterVisibility: null,
      platformDocumentsPolicy: null,
      checklistKeyColumn: null,
      roleAttributes: null,
      policies: null,
    };

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

    const testFirmId = await ensureFirm(client, {
      slug: "rls-test-firm",
      name: "RLS Test Firm",
    });
    const casesCols = await getTableColumns(client, "cases");
    const insertCols = [];
    const placeholders = [];
    const values = [];
    const add = (col, val) => {
      if (!casesCols.has(col)) return;
      insertCols.push(col);
      values.push(val);
      placeholders.push(`$${values.length}`);
    };

    add("firm_id", testFirmId);

    if (casesCols.has("reference_no")) {
      const meta = casesCols.get("reference_no");
      const nullable = String(meta?.is_nullable ?? "") === "YES";
      if (nullable) {
        add("reference_no", null);
      } else {
        add("reference_no", "VERIFY/PENDING");
      }
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

    const sql = `
      insert into cases(${insertCols.join(", ")})
      values (${placeholders.join(", ")})
      returning id, reference_no, approval_status
    `;
    const inserted = await queryRows(client, sql, values);
    result.pendingApprovalInsert = inserted[0] ?? null;

    result.checklistKeyColumn = await queryRows(
      client,
      `
      select column_name, is_nullable, data_type
      from information_schema.columns
      where table_schema='public' and table_name='case_documents' and column_name='checklist_key'
    `,
    );

    const roleAttempt = await tryExec(
      client,
      "reset role; set role app_user; reset role;",
    );
    const roleOk = roleAttempt.ok;
    result.roleAttributes = await getRoleAttributes(client);

    const firmA = await ensureFirm(client, {
      slug: "rls-test-firm-a",
      name: "RLS Test Firm A",
    });
    const firmB = await ensureFirm(client, {
      slug: "rls-test-firm-b",
      name: "RLS Test Firm B",
    });
    await ensureFirmSettings(client, firmA, true);
    await ensureFirmSettings(client, firmB, false);
    await ensureTemplate(client, null, "GLOBAL_TEMPLATE");
    await ensureTemplate(client, firmA, "A_TEMPLATE");
    await ensureTemplate(client, firmB, "B_TEMPLATE");
    await ensurePlatformDocument(client, null, "GLOBAL_DOC");
    await ensurePlatformDocument(client, firmA, "A_DOC");
    await ensurePlatformDocument(client, firmB, "B_DOC");

    result.policies = await getPoliciesForTables(client, [
      "templates",
      "platform_documents",
      "case_documents",
      "document_generation_jobs",
      "document_generation_job_items",
      "document_generation_logs",
      "bank_transactions",
      "case_ledgers",
    ]);

    const rlsTables = [
      "templates",
      "platform_documents",
      "case_documents",
      "document_generation_jobs",
      "document_generation_job_items",
      "document_generation_logs",
      "bank_transactions",
      "case_ledgers",
    ];

    const rlsCounts = {};
    for (const t of rlsTables) {
      const a = await runWithSession(
        client,
        { currentFirmId: firmA, isFounder: false },
        async () => countRows(client, t),
      );
      const b = await runWithSession(
        client,
        { currentFirmId: firmB, isFounder: false },
        async () => countRows(client, t),
      );
      const f = await runWithSession(
        client,
        { currentFirmId: null, isFounder: true },
        async () => countRows(client, t),
      );
      rlsCounts[t] = {
        firmA: { count: a.value, diag: a.diag },
        firmB: { count: b.value, diag: b.diag },
        founder: { count: f.value, diag: f.diag },
      };
    }

    const templatesFirmA = await runWithSession(
      client,
      { currentFirmId: firmA, isFounder: false },
      async () =>
        queryRows(
          client,
          "select id, firm_id, name from templates order by id asc",
        ),
    );
    const templatesFirmB = await runWithSession(
      client,
      { currentFirmId: firmB, isFounder: false },
      async () =>
        queryRows(
          client,
          "select id, firm_id, name from templates order by id asc",
        ),
    );

    const globalWriteFirmA = await runWithSession(
      client,
      { currentFirmId: firmA, isFounder: false },
      async () => {
        const beforeGlobalRow = await getGlobalTemplateRow(client);

        const insertAttempt = await attemptWriteWithSavepoint(client, "global_insert", () =>
          client.query(
            "insert into templates(firm_id, name, file_type, storage_path, is_active) values (null, 'FIRM_GLOBAL_WRITE', 'pdf', '/objects/templates/global/test.pdf', true)",
          ),
        );
        const afterInsertGlobalRow = await getGlobalTemplateRow(client);

        const updateAttempt = await attemptWriteWithSavepoint(client, "global_update", () =>
          client.query(`
            update templates
            set name = 'GLOBAL_TEMPLATE_SHOULD_NOT_CHANGE'
            where firm_id is null and name = 'GLOBAL_TEMPLATE'
          `),
        );
        const afterUpdateGlobalRow = await getGlobalTemplateRow(client);

        const deleteAttempt = await attemptWriteWithSavepoint(client, "global_delete", () =>
          client.query(`
            delete from templates
            where firm_id is null and name = 'GLOBAL_TEMPLATE'
          `),
        );
        const afterDeleteGlobalRow = await getGlobalTemplateRow(client);

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

    result.rls = {
      setRoleAppUser: roleOk,
      rlsCounts,
    };

    result.templatesMasterVisibility = {
      firmA_useMaster_true: { rows: templatesFirmA.value, diag: templatesFirmA.diag },
      firmB_useMaster_false: { rows: templatesFirmB.value, diag: templatesFirmB.diag },
      firmA_global_write_attempts: {
        ...globalWriteFirmA.value,
        diag: globalWriteFirmA.diag,
      },
    };

    result.platformDocumentsPolicy = await queryRows(
      client,
      `
      select policyname, qual
      from pg_policies
      where schemaname='public'
        and tablename='platform_documents'
        and policyname='platform_documents_read'
    `,
    );

    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write("\n");
  } finally {
    await client.end();
  }
};

await main();
