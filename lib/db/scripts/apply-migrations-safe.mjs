import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const fromPrefix = process.env.MIGRATE_FROM_PREFIX ?? "0000";

const lowered = databaseUrl.toLowerCase();
const shouldUseSsl =
  lowered.includes("pooler.supabase.com")
  || lowered.includes("supabase.co")
  || lowered.includes("supabase.com");

const { Client } = pg;
const client = new Client({
  connectionString: databaseUrl,
  ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, "../migrations");

const files = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isFile() && /^\d{4}_.+\.sql$/.test(d.name))
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b));

const startIdx = files.findIndex((f) => f.startsWith(`${fromPrefix}_`));
if (startIdx < 0) throw new Error(`MIGRATE_FROM_PREFIX not found: ${fromPrefix}`);

const isSkippableAlreadyAppliedError = (err) => {
  const code = err?.code ? String(err.code) : "";
  const msg = err?.message ? String(err.message) : "";
  if (code === "42P07") return true; // duplicate_table / duplicate_relation / duplicate_index
  if (code === "42710") return true; // duplicate_object
  if (code === "42701") return true; // duplicate_column
  if (code === "23505" && msg.includes("lawcaspro_manual_migrations_pkey")) return true;
  return false;
};

await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.lawcaspro_manual_migrations (
      tag text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  for (let i = startIdx; i < files.length; i++) {
    const fileName = files[i];
    const tag = fileName.replace(/\.sql$/, "");

    const already = await client.query(
      "select tag from public.lawcaspro_manual_migrations where tag = $1 limit 1",
      [tag],
    );
    if (already.rowCount && already.rowCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`skip (recorded): ${tag}`);
      continue;
    }

    const sqlFile = path.join(MIGRATIONS_DIR, fileName);
    const sqlText = fs.readFileSync(sqlFile, "utf8");

    try {
      // eslint-disable-next-line no-console
      console.log(`running: ${tag}`);
      await client.query("begin");
      await client.query(sqlText);
      await client.query(
        "insert into public.lawcaspro_manual_migrations(tag) values ($1)",
        [tag],
      );
      await client.query("commit");
      // eslint-disable-next-line no-console
      console.log(`applied: ${tag}`);
    } catch (err) {
      await client.query("rollback");
      if (isSkippableAlreadyAppliedError(err)) {
        await client.query(
          "insert into public.lawcaspro_manual_migrations(tag) values ($1) on conflict do nothing",
          [tag],
        );
        // eslint-disable-next-line no-console
        console.log(`skip (already applied): ${tag}`);
        continue;
      }
      // eslint-disable-next-line no-console
      console.error(`failed: ${tag}`);
      throw err;
    }
  }
} finally {
  await client.end();
}

