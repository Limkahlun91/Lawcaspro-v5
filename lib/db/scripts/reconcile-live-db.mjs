/**
 * reconcile-live-db.mjs
 *
 * Seeds the baseline migration hash into __drizzle_migrations so the live DB
 * (which was built via db:push) is recognised by Drizzle's migration runner.
 * Safe to run multiple times — fully idempotent.
 *
 * Usage:  pnpm --filter @workspace/db run reconcile
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')
);

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id      serial PRIMARY KEY,
    hash    text NOT NULL,
    created_at bigint
  );
`);

let seeded = 0;
for (const entry of journal.entries) {
  const sqlFile = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
  if (!fs.existsSync(sqlFile)) {
    console.warn(`  WARNING: migration file not found: ${sqlFile}`);
    continue;
  }
  const content = fs.readFileSync(sqlFile, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  const { rows } = await client.query(
    'SELECT id FROM __drizzle_migrations WHERE hash = $1',
    [hash]
  );
  if (rows.length > 0) {
    console.log(`  already applied: ${entry.tag} (${hash.slice(0, 12)}...)`);
  } else {
    await client.query(
      'INSERT INTO __drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [hash, Date.now()]
    );
    console.log(`  seeded:          ${entry.tag} (${hash.slice(0, 12)}...)`);
    seeded++;
  }
}

if (seeded > 0) {
  console.log(`\n  ${seeded} migration(s) seeded. Live DB is now under Drizzle migration control.`);
  console.log('  Next: pnpm --filter @workspace/db run migrate  (applies 0 pending migrations)');
} else {
  console.log('\n  All migrations already recorded. No action needed.');
}

await client.end();
