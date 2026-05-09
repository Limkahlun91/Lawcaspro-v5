import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
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
const sqlPath = path.join(__dirname, "apply-rls.sql");
const sqlText = await fs.readFile(sqlPath, "utf8");

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(sqlText);
  await client.query("COMMIT");
} catch (err) {
  try {
    await client.query("ROLLBACK");
  } catch {
  }
  throw err;
} finally {
  await client.end();
}

