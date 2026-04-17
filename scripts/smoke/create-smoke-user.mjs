const requiredEnv = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const optionalEnv = (k) => process.env[k] ?? null;

const now = () => new Date().toISOString();

const main = async () => {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const smokeEmail = requiredEnv("SMOKE_EMAIL").toLowerCase();
  const smokePassword = requiredEnv("SMOKE_PASSWORD");
  const firmIdRaw = optionalEnv("SMOKE_FIRM_ID");
  const firmSlug = optionalEnv("SMOKE_FIRM_SLUG");

  const firmId =
    firmIdRaw && /^[0-9]+$/.test(firmIdRaw) ? Number.parseInt(firmIdRaw, 10) : null;

  const { Pool } = await import("pg");
  const bcrypt = await import("bcryptjs");
  const pool = new Pool({ connectionString: databaseUrl });

  const perms = [
    ["users", "create"],
    ["users", "delete"],
    ["documents", "read"],
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let resolvedFirmId = firmId;
    if (!resolvedFirmId && firmSlug) {
      const r = await client.query("select id from firms where slug = $1 limit 1", [firmSlug]);
      resolvedFirmId = typeof r.rows?.[0]?.id === "number" ? r.rows[0].id : null;
    }
    if (!resolvedFirmId) {
      throw new Error("Missing SMOKE_FIRM_ID or SMOKE_FIRM_SLUG");
    }

    const roleName = "Smoke";
    let roleId = null;
    {
      const r = await client.query(
        "select id from roles where firm_id = $1 and name = $2 limit 1",
        [resolvedFirmId, roleName],
      );
      roleId = typeof r.rows?.[0]?.id === "number" ? r.rows[0].id : null;
    }

    if (!roleId) {
      const r = await client.query(
        "insert into roles (firm_id, name, is_system_role) values ($1, $2, false) returning id",
        [resolvedFirmId, roleName],
      );
      roleId = typeof r.rows?.[0]?.id === "number" ? r.rows[0].id : null;
    }

    if (!roleId) throw new Error("Failed to create role");

    for (const [module, action] of perms) {
      const existing = await client.query(
        "select id from permissions where role_id = $1 and module = $2 and action = $3 limit 1",
        [roleId, module, action],
      );
      if (existing.rowCount) continue;
      await client.query(
        "insert into permissions (role_id, module, action, allowed) values ($1, $2, $3, true)",
        [roleId, module, action],
      );
    }

    const u = await client.query(
      "select id from users where email = $1 limit 1",
      [smokeEmail],
    );

    let userId = typeof u.rows?.[0]?.id === "number" ? u.rows[0].id : null;
    const passwordHash = await bcrypt.hash(smokePassword, 10);

    if (!userId) {
      const name = "Smoke Runner";
      const r = await client.query(
        "insert into users (firm_id, email, name, password_hash, user_type, role_id, status, totp_enabled) values ($1,$2,$3,$4,'firm_user',$5,'active',false) returning id",
        [resolvedFirmId, smokeEmail, name, passwordHash, roleId],
      );
      userId = typeof r.rows?.[0]?.id === "number" ? r.rows[0].id : null;
    } else {
      await client.query(
        "update users set firm_id=$1, role_id=$2, password_hash=$3, status='active', totp_enabled=false where id=$4",
        [resolvedFirmId, roleId, passwordHash, userId],
      );
    }

    if (!userId) throw new Error("Failed to create user");

    await client.query("COMMIT");
    console.log(
      JSON.stringify(
        {
          at: now(),
          ok: true,
          firmId: resolvedFirmId,
          roleId,
          userId,
          email: smokeEmail,
          passwordGenerated: false,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    const msg = err instanceof Error ? err.message : String(err ?? "");
    console.error(JSON.stringify({ at: now(), ok: false, error: msg.slice(0, 500) }, null, 2));
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  console.error(JSON.stringify({ at: now(), ok: false, error: msg.slice(0, 500) }, null, 2));
  process.exit(1);
});
