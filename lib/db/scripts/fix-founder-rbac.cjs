const pg = require("pg");

const FOUNDER_EMAIL = "lun.6923@hotmail.com";
const FOUNDER_SUPER_ADMIN_ROLE_ID = "1d3d1db7-5b58-4d83-a3f7-2c9e2f5a6c04";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const ssl = /pooler\.supabase\.com|supabase\.(co|com)/i.test(databaseUrl)
  ? { rejectUnauthorized: false }
  : undefined;

const { Client } = pg;

(async () => {
  const c = new Client({ connectionString: databaseUrl, ssl });
  await c.connect();
  try {
    const id1 = await c.query("select id, email from public.users where id = 1");
    const id1Email = id1.rows?.[0]?.email ?? null;

    const founder = await c.query(
      "select id, email from public.users where lower(email) = lower($1) limit 1",
      [FOUNDER_EMAIL]
    );
    if (!founder.rowCount) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          code: "FOUNDER_USER_NOT_FOUND",
          message: "Founder user not found by email",
          founder_email: FOUNDER_EMAIL,
          users_id_1_email: id1Email,
        })
      );
      process.exit(2);
    }
    const founderUserId = Number(founder.rows[0].id);

    await c.query(
      `
      insert into public.platform_founder_roles (id, code, name, level, is_system)
      values ($1, 'founder_super_admin', 'Founder Super Admin', 'super_admin', true)
      on conflict (code) do nothing
    `,
      [FOUNDER_SUPER_ADMIN_ROLE_ID]
    );

    const role = await c.query(
      "select id from public.platform_founder_roles where code = 'founder_super_admin' limit 1"
    );
    const roleId = role.rows?.[0]?.id ?? null;
    if (!roleId) throw new Error("founder_super_admin role missing");

    const roleAssign = await c.query(
      `
      insert into public.platform_founder_user_roles (user_id, role_id, assigned_by_user_id)
      values ($1, $2, $1)
      on conflict (user_id, role_id) do nothing
    `,
      [founderUserId, roleId]
    );

    const allFounderPerms = await c.query(
      `
      select distinct permission_code
      from public.platform_founder_role_permissions
      where permission_code like 'founder.%'
    `
    );
    const permCodes = new Set(
      (allFounderPerms.rows || [])
        .map((r) => (r ? r.permission_code : null))
        .filter((x) => typeof x === "string" && x.length > 0)
    );
    permCodes.add("founder.ops.read");

    const permList = Array.from(permCodes);
    let insertedPerms = 0;
    for (const p of permList) {
      const ins = await c.query(
        `
        insert into public.platform_founder_role_permissions (role_id, permission_code)
        values ($1, $2)
        on conflict (role_id, permission_code) do nothing
      `,
        [roleId, p]
      );
      insertedPerms += ins.rowCount || 0;
    }

    const check = await c.query(
      `
      select count(*)::int as c
      from public.platform_founder_role_permissions
      where role_id = $1 and permission_code like 'founder.%'
    `,
      [roleId]
    );

    process.stdout.write(
      JSON.stringify({
        ok: true,
        founder_user_id: founderUserId,
        founder_email: founder.rows[0].email,
        users_id_1_email: id1Email,
        assigned_super_admin: true,
        inserted_role_assignment_rows: roleAssign.rowCount || 0,
        inserted_permission_rows: insertedPerms,
        founder_permission_count_for_super_admin: check.rows?.[0]?.c ?? null,
      })
    );
  } finally {
    await c.end();
  }
})().catch((e) => {
  const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  process.stderr.write(msg);
  process.exit(1);
});

