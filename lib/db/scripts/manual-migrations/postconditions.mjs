async function existsRegclass(client, regclass) {
  const r = await client.query("select to_regclass($1) as name", [regclass]);
  return Boolean(r.rows?.[0]?.name);
}

function normalizeSql(s) {
  return String(s ?? "").replace(/\s+/g, "").toLowerCase();
}

async function getColumn(client, tableName, columnName) {
  const r = await client.query(
    `
    select
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default
    from information_schema.columns
    where table_schema = 'public' and table_name = $1 and column_name = $2
    limit 1
  `,
    [tableName, columnName],
  );
  return r.rows?.[0] ?? null;
}

function isTextColumn(col) {
  const udt = typeof col?.udt_name === "string" ? col.udt_name : "";
  const dt = typeof col?.data_type === "string" ? col.data_type : "";
  return udt === "text" || dt.toLowerCase() === "text";
}

function isIntegerColumn(col) {
  const udt = typeof col?.udt_name === "string" ? col.udt_name : "";
  const dt = typeof col?.data_type === "string" ? col.data_type : "";
  return udt === "int4" || dt.toLowerCase() === "integer";
}

function isTimestamptzColumn(col) {
  const dt = typeof col?.data_type === "string" ? col.data_type : "";
  return dt.toLowerCase() === "timestamp with time zone";
}

function isNotNull(col) {
  return String(col?.is_nullable ?? "").toLowerCase() === "no";
}

function hasDefault(col, needle) {
  const d = String(col?.column_default ?? "");
  return d.toLowerCase().includes(String(needle).toLowerCase());
}

async function indexDefByName(client, indexName) {
  const r = await client.query(
    `
    select indexdef
    from pg_indexes
    where schemaname='public' and indexname=$1
    limit 1
  `,
    [indexName],
  );
  return typeof r.rows?.[0]?.indexdef === "string" ? r.rows[0].indexdef : null;
}

async function tableRlsFlags(client, tableName) {
  const r = await client.query(
    `
    select c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname=$1
    limit 1
  `,
    [tableName],
  );
  const row = r.rows?.[0];
  return { rls: Boolean(row?.rls), forceRls: Boolean(row?.force_rls) };
}

async function getPolicy(client, tableName, policyName) {
  const r = await client.query(
    `
    select roles, cmd, qual, with_check
    from pg_policies
    where schemaname='public' and tablename=$1 and policyname=$2
    limit 1
  `,
    [tableName, policyName],
  );
  return r.rows?.[0] ?? null;
}

async function getFk(client, tableName, columnName) {
  const r = await client.query(
    `
    select
      src_tbl.relname as table_name,
      src_att.attname as column_name,
      tgt_tbl.relname as foreign_table,
      tgt_att.attname as foreign_column,
      con.confdeltype as on_delete
    from pg_constraint con
    join pg_class src_tbl on src_tbl.oid = con.conrelid
    join pg_namespace src_ns on src_ns.oid = src_tbl.relnamespace
    join pg_attribute src_att on src_att.attrelid = con.conrelid and src_att.attnum = con.conkey[1]
    join pg_class tgt_tbl on tgt_tbl.oid = con.confrelid
    join pg_attribute tgt_att on tgt_att.attrelid = con.confrelid and tgt_att.attnum = con.confkey[1]
    where con.contype = 'f'
      and src_ns.nspname = 'public'
      and src_tbl.relname = $1
      and src_att.attname = $2
    limit 1
  `,
    [tableName, columnName],
  );
  return r.rows?.[0] ?? null;
}

function normalizeOnDelete(code) {
  const c = String(code ?? "");
  if (c === "c") return "CASCADE";
  if (c === "r") return "RESTRICT";
  if (c === "n") return "SET NULL";
  if (c === "a") return "NO ACTION";
  if (c === "d") return "SET DEFAULT";
  return null;
}

function includesRole(roles, expected) {
  const list = Array.isArray(roles) ? roles : typeof roles === "string" ? [roles] : [];
  return list.map((x) => String(x).toLowerCase()).includes(String(expected).toLowerCase());
}

async function verify0126(client) {
  const issues = [];

  const pvClientRequestId = await getColumn(client, "payment_vouchers", "client_request_id").catch(() => null);
  if (!pvClientRequestId) {
    issues.push("payment_vouchers.client_request_id_missing");
  } else {
    if (!isTextColumn(pvClientRequestId)) issues.push("payment_vouchers.client_request_id_type_mismatch");
    if (isNotNull(pvClientRequestId)) issues.push("payment_vouchers.client_request_id_nullability_mismatch");
    if (String(pvClientRequestId.column_default ?? "").trim()) issues.push("payment_vouchers.client_request_id_default_mismatch");
  }

  const pvUniqueDef = await indexDefByName(client, "uq_payment_vouchers_client_request");
  if (!pvUniqueDef) {
    issues.push("index_uq_payment_vouchers_client_request_missing");
  } else {
    const n = normalizeSql(pvUniqueDef);
    if (!n.includes("createuniqueindex")) issues.push("index_uq_payment_vouchers_client_request_not_unique");
    if (!n.includes("onpayment_vouchersusing") && !n.includes("onpublic.payment_vouchersusing")) {
      issues.push("index_uq_payment_vouchers_client_request_table_mismatch");
    }
    if (!n.includes("(firm_id,client_request_id)")) issues.push("index_uq_payment_vouchers_client_request_columns_mismatch");
    if (!n.includes("where") || !n.includes("client_request_idisnotnull")) {
      issues.push("index_uq_payment_vouchers_client_request_predicate_mismatch");
    }
  }

  const reqTable = await existsRegclass(client, "public.payment_voucher_create_requests");
  if (!reqTable) issues.push("table_payment_voucher_create_requests_missing");

  if (reqTable) {
    const colChecks = [
      ["id", { type: "integer", notNull: true, defaultLike: "nextval(" }],
      ["firm_id", { type: "integer", notNull: true }],
      ["created_by_user_id", { type: "integer", notNull: true }],
      ["client_request_id", { type: "text", notNull: true }],
      ["request_payload_hash", { type: "text", notNull: false }],
      ["status", { type: "text", notNull: true, defaultLike: "processing" }],
      ["payment_voucher_id", { type: "integer", notNull: false }],
      ["last_error", { type: "text", notNull: false }],
      ["created_at", { type: "timestamptz", notNull: true, defaultLike: "now(" }],
      ["updated_at", { type: "timestamptz", notNull: true, defaultLike: "now(" }],
      ["completed_at", { type: "timestamptz", notNull: false }],
    ];

    for (const [name, exp] of colChecks) {
      const col = await getColumn(client, "payment_voucher_create_requests", name).catch(() => null);
      if (!col) {
        issues.push(`payment_voucher_create_requests.column_missing.${name}`);
        continue;
      }
      if (exp.type === "text" && !isTextColumn(col)) issues.push(`payment_voucher_create_requests.column_type_mismatch.${name}`);
      if (exp.type === "integer" && !isIntegerColumn(col)) issues.push(`payment_voucher_create_requests.column_type_mismatch.${name}`);
      if (exp.type === "timestamptz" && !isTimestamptzColumn(col)) issues.push(`payment_voucher_create_requests.column_type_mismatch.${name}`);
      if (exp.notNull === true && !isNotNull(col)) issues.push(`payment_voucher_create_requests.column_nullability_mismatch.${name}`);
      if (exp.notNull === false && isNotNull(col)) issues.push(`payment_voucher_create_requests.column_nullability_mismatch.${name}`);
      if (exp.defaultLike && !hasDefault(col, exp.defaultLike)) issues.push(`payment_voucher_create_requests.column_default_mismatch.${name}`);
    }

    const firmFk = await getFk(client, "payment_voucher_create_requests", "firm_id").catch(() => null);
    if (!firmFk || firmFk.foreign_table !== "firms" || firmFk.foreign_column !== "id" || normalizeOnDelete(firmFk.on_delete) !== "CASCADE") {
      issues.push("payment_voucher_create_requests.fk_mismatch.firm_id");
    }
    const createdByFk = await getFk(client, "payment_voucher_create_requests", "created_by_user_id").catch(() => null);
    if (!createdByFk || createdByFk.foreign_table !== "users" || createdByFk.foreign_column !== "id" || normalizeOnDelete(createdByFk.on_delete) !== "RESTRICT") {
      issues.push("payment_voucher_create_requests.fk_mismatch.created_by_user_id");
    }
    const voucherFk = await getFk(client, "payment_voucher_create_requests", "payment_voucher_id").catch(() => null);
    if (!voucherFk || voucherFk.foreign_table !== "payment_vouchers" || voucherFk.foreign_column !== "id" || normalizeOnDelete(voucherFk.on_delete) !== "SET NULL") {
      issues.push("payment_voucher_create_requests.fk_mismatch.payment_voucher_id");
    }

    const uniq = await indexDefByName(client, "uq_payment_voucher_create_requests_firm_user_key");
    if (!uniq) {
      issues.push("index_uq_payment_voucher_create_requests_firm_user_key_missing");
    } else {
      const n = normalizeSql(uniq);
      if (!n.includes("createuniqueindex")) issues.push("index_uq_payment_voucher_create_requests_firm_user_key_not_unique");
      if (!n.includes("(firm_id,created_by_user_id,client_request_id)")) {
        issues.push("index_uq_payment_voucher_create_requests_firm_user_key_columns_mismatch");
      }
    }

    const idxStatus = await indexDefByName(client, "idx_payment_voucher_create_requests_firm_status");
    if (!idxStatus) {
      issues.push("index_idx_payment_voucher_create_requests_firm_status_missing");
    } else {
      const n = normalizeSql(idxStatus);
      if (!n.includes("(firm_id,status,created_atdesc)")) {
        issues.push("index_idx_payment_voucher_create_requests_firm_status_columns_mismatch");
      }
    }

    const idxVoucher = await indexDefByName(client, "idx_payment_voucher_create_requests_firm_voucher");
    if (!idxVoucher) {
      issues.push("index_idx_payment_voucher_create_requests_firm_voucher_missing");
    } else {
      const n = normalizeSql(idxVoucher);
      if (!n.includes("(firm_id,payment_voucher_id)")) {
        issues.push("index_idx_payment_voucher_create_requests_firm_voucher_columns_mismatch");
      }
    }

    const { rls, forceRls } = await tableRlsFlags(client, "payment_voucher_create_requests");
    if (!rls) issues.push("rls_not_enabled.payment_voucher_create_requests");
    if (!forceRls) issues.push("rls_not_forced.payment_voucher_create_requests");

    const pol = await getPolicy(client, "payment_voucher_create_requests", "payment_voucher_create_requests_rw");
    if (!pol) {
      issues.push("policy_missing.payment_voucher_create_requests_rw");
    } else {
      const cmd = String(pol.cmd ?? "").toUpperCase();
      if (cmd !== "ALL") issues.push("policy_cmd_mismatch.payment_voucher_create_requests_rw");
      if (!includesRole(pol.roles, "public")) issues.push("policy_roles_mismatch.payment_voucher_create_requests_rw");
      const expected = normalizeSql(
        "current_setting('app.is_founder', true) = 'true' OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer",
      );
      const qual = normalizeSql(pol.qual);
      const withCheck = normalizeSql(pol.with_check);
      if (qual !== expected) issues.push("policy_using_mismatch.payment_voucher_create_requests_rw");
      if (withCheck !== expected) issues.push("policy_with_check_mismatch.payment_voucher_create_requests_rw");
    }
  }

  return { ok: issues.length === 0, issues };
}

async function verify0124(client) {
  const issues = [];
  const hasPermissions = await existsRegclass(client, "public.permissions");
  const hasRoles = await existsRegclass(client, "public.roles");
  if (!hasPermissions) issues.push("table_permissions_missing");
  if (!hasRoles) issues.push("table_roles_missing");
  if (!hasPermissions || !hasRoles) return { ok: false, issues };

  const roles = await client.query(
    `
    select id, name
    from roles
    where lower(name) in ('partner','manager')
  `,
  );
  const idByName = new Map(roles.rows.map((x) => [String(x.name).toLowerCase(), Number(x.id)]));
  const partnerId = idByName.get("partner");
  const managerId = idByName.get("manager");
  if (!partnerId) issues.push("role_missing.partner");
  if (!managerId) issues.push("role_missing.manager");

  for (const [roleName, roleId] of [
    ["partner", partnerId],
    ["manager", managerId],
  ]) {
    if (!roleId) continue;
    const p = await client.query(
      `
      select allowed
      from permissions
      where role_id = $1 and module = 'dashboard' and action = 'view_firmwide'
      limit 1
    `,
      [roleId],
    );
    const allowed = p.rows?.[0]?.allowed;
    if (allowed !== true) issues.push(`permission_missing_or_disallowed.${roleName}.dashboard.view_firmwide`);
  }

  const neg = await client.query(
    `
    select count(*)::int as c
    from permissions p
    join roles r on r.id = p.role_id
    where p.module='dashboard' and p.action='view_firmwide' and p.allowed=false
      and lower(r.name) in ('partner','manager')
  `,
  );
  const negCount = Number(neg.rows?.[0]?.c ?? 0);
  if (negCount > 0) issues.push("unexpected_disallowed_dashboard_view_firmwide_for_partner_manager");
  return { ok: issues.length === 0, issues };
}

const verifiers = new Map([
  ["0124_phase1_dashboard_access_narrowing", verify0124],
  ["0126_payment_voucher_create_request_tracking", verify0126],
  ["0127_core_integrity_hardening", verify0126],
]);

export function getPostconditionVerifier(tag) {
  return verifiers.get(String(tag ?? "")) ?? null;
}

export async function verifyMigrationPostconditions(client, tag) {
  const v = getPostconditionVerifier(tag);
  if (!v) return { ok: false, issues: ["no_postcondition_verifier"] };
  return await v(client);
}
