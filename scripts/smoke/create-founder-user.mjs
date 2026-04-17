const requiredEnv = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const now = () => new Date().toISOString();

const main = async () => {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const founderEmail = requiredEnv("FOUNDER_EMAIL").trim().toLowerCase();
  const founderPassword = requiredEnv("FOUNDER_PASSWORD");

  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    console.error(
      JSON.stringify(
        {
          at: now(),
          ok: false,
          error: "DATABASE_URL must be a Postgres connection string, not Supabase project HTTPS URL",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const { Pool } = await import("pg");
  const bcrypt = await import("bcryptjs");
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const founders = await client.query(
      "select id, email from users where user_type = 'founder' order by id asc",
    );

    const passwordHash = await bcrypt.hash(founderPassword, 10);

    if (founders.rowCount > 0) {
      const match = founders.rows.find((r) => String(r.email).toLowerCase() === founderEmail) ?? null;
      const targetId = match ? match.id : founders.rows[0].id;
      const action = match ? "updated" : "replaced";

      await client.query(
        "update users set email=$1, password_hash=$2, status='active', firm_id=null, role_id=null, user_type='founder', totp_enabled=false, totp_secret=null where id=$3",
        [founderEmail, passwordHash, targetId],
      );

      await client.query("COMMIT");
      console.log(JSON.stringify({ at: now(), ok: true, action, userId: targetId, email: founderEmail }, null, 2));
      return;
    }

    const existingUser = await client.query(
      "select id, user_type from users where email = $1 limit 1",
      [founderEmail],
    );

    if (existingUser.rowCount > 0) {
      const id = existingUser.rows[0].id;
      await client.query(
        "update users set password_hash=$1, status='active', firm_id=null, role_id=null, user_type='founder', totp_enabled=false, totp_secret=null where id=$2",
        [passwordHash, id],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ at: now(), ok: true, action: "converted", userId: id, email: founderEmail }, null, 2));
      return;
    }

    const name = "System Founder";
    const inserted = await client.query(
      "insert into users (firm_id, email, name, password_hash, user_type, role_id, status, totp_enabled) values (null, $1, $2, $3, 'founder', null, 'active', false) returning id",
      [founderEmail, name, passwordHash],
    );
    const id = inserted.rows?.[0]?.id ?? null;
    await client.query("COMMIT");

    console.log(JSON.stringify({ at: now(), ok: true, action: "created", userId: id, email: founderEmail }, null, 2));
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
