import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const fromPrefix = process.env.MIGRATE_FROM_PREFIX;
if (!fromPrefix) {
  throw new Error("MIGRATE_FROM_PREFIX is required (e.g. 0017)");
}

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
if (startIdx < 0) {
  throw new Error(`MIGRATE_FROM_PREFIX not found in migrations dir: ${fromPrefix}`);
}

await client.connect();
try {
  for (let i = startIdx; i < files.length; i++) {
    const fileName = files[i];
    const tag = fileName.replace(/\.sql$/, "");
    const sqlFile = path.join(MIGRATIONS_DIR, fileName);
    const sqlText = fs.readFileSync(sqlFile, "utf8");
    // eslint-disable-next-line no-console
    console.log(`running: ${tag}`);
    await client.query(sqlText);
    // eslint-disable-next-line no-console
    console.log(`applied: ${tag}`);
  }
} finally {
  await client.end();
}
