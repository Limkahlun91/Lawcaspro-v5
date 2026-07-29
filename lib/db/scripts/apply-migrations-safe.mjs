import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { runMigrateSafe } from "./manual-migrations/runner.mjs";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const fromPrefix = process.env.MIGRATE_FROM_PREFIX ?? "0000";
  const mode = (process.env.MIGRATE_MODE ?? "apply").toLowerCase();

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

  await client.connect();
  try {
    const result = await runMigrateSafe({
      client,
      migrationsDir: MIGRATIONS_DIR,
      fromPrefix,
      mode,
    });

    if (String(result.mode) === "verify") {
      process.stdout.write(JSON.stringify(result, null, 2));
      process.stdout.write("\n");
    }
    return result;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { main };

