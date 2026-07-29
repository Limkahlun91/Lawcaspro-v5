import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./checksum.mjs";
import { verifyMigrationPostconditions } from "./postconditions.mjs";

export function isVerifyOnlyMode(mode) {
  const m = String(mode ?? "apply").toLowerCase();
  return m === "verify" || m === "dry-run" || m === "dryrun";
}

export async function toRegclass(client, name) {
  const r = await client.query("select to_regclass($1) as name", [name]);
  return typeof r.rows?.[0]?.name === "string" ? r.rows[0].name : null;
}

export async function manualMigrationsState(client) {
  const migrations = await toRegclass(client, "public.lawcaspro_manual_migrations");
  const checksums = await toRegclass(client, "public.lawcaspro_manual_migration_checksums");
  return {
    hasMigrationsTable: Boolean(migrations),
    hasChecksumsTable: Boolean(checksums),
  };
}

export async function wasApplied(client, tag) {
  const r = await client.query(
    "select tag from public.lawcaspro_manual_migrations where tag = $1 limit 1",
    [tag],
  );
  return Boolean(r.rowCount && r.rowCount > 0);
}

export async function getChecksum(client, tag) {
  const r = await client.query(
    "select checksum_sha256 from public.lawcaspro_manual_migration_checksums where tag = $1 limit 1",
    [tag],
  );
  return typeof r.rows?.[0]?.checksum_sha256 === "string" ? r.rows[0].checksum_sha256 : null;
}

export function isDuplicateLikeError(err) {
  const code = err?.code ? String(err.code) : "";
  return code === "42P07" || code === "42710" || code === "42701";
}

export async function ensureManualMigrationsTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.lawcaspro_manual_migrations (
      tag text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.lawcaspro_manual_migration_checksums (
      tag text PRIMARY KEY REFERENCES public.lawcaspro_manual_migrations(tag) ON DELETE CASCADE,
      checksum_sha256 text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function verifyOnly({
  client,
  migrationsDir,
  fileName,
  sqlText,
}) {
  const tag = fileName.replace(/\.sql$/, "");
  const checksum = sha256Hex(sqlText);

  const state = await manualMigrationsState(client);
  if (!state.hasMigrationsTable) {
    return { tag, fileName, status: "pending", note: "migration_history_not_initialized" };
  }

  const applied = await wasApplied(client, tag);
  if (!applied) {
    const verify = await verifyMigrationPostconditions(client, tag);
    if (verify.ok) return { tag, fileName, status: "schema_already_present_and_verified" };
    return {
      tag,
      fileName,
      status: verify.issues?.[0] === "no_postcondition_verifier" ? "pending" : "partial_schema",
      issues: verify.issues ?? null,
    };
  }

  if (!state.hasChecksumsTable) {
    return { tag, fileName, status: "legacy_applied_without_checksum", note: "checksum_tracking_not_initialized" };
  }

  const recorded = await getChecksum(client, tag);
  if (!recorded) return { tag, fileName, status: "legacy_applied_without_checksum" };
  if (recorded !== checksum) return { tag, fileName, status: "checksum_mismatch" };
  return { tag, fileName, status: "applied_checksum_matches" };
}

export async function applyOne({ client, fileName, sqlText }) {
  const tag = fileName.replace(/\.sql$/, "");
  const checksum = sha256Hex(sqlText);

  await client.query("begin");
  try {
    await client.query(sqlText);
    const verify = await verifyMigrationPostconditions(client, tag);
    if (!verify.ok) {
      throw Object.assign(new Error(`postconditions failed: ${tag}`), { tag, issues: verify.issues });
    }
    await client.query("insert into public.lawcaspro_manual_migrations(tag) values ($1)", [tag]);
    await client.query(
      "insert into public.lawcaspro_manual_migration_checksums(tag, checksum_sha256) values ($1, $2)",
      [tag, checksum],
    );
    await client.query("commit");
    return { tag, fileName, status: "applied" };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

export async function recordVerifiedAsApplied({ client, fileName, sqlText }) {
  const tag = fileName.replace(/\.sql$/, "");
  const checksum = sha256Hex(sqlText);
  await client.query("begin");
  try {
    const verify = await verifyMigrationPostconditions(client, tag);
    if (!verify.ok) {
      throw Object.assign(new Error(`postconditions failed: ${tag}`), { tag, issues: verify.issues });
    }
    await client.query("insert into public.lawcaspro_manual_migrations(tag) values ($1)", [tag]);
    await client.query(
      "insert into public.lawcaspro_manual_migration_checksums(tag, checksum_sha256) values ($1, $2)",
      [tag, checksum],
    );
    await client.query("commit");
    return { tag, fileName, status: "recorded_after_postcondition_verify" };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

export async function runMigrateSafe({
  client,
  migrationsDir,
  fromPrefix,
  mode,
}) {
  const files = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /^\d{4}_.+\.sql$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const startIdx = files.findIndex((f) => f.startsWith(`${fromPrefix}_`));
  if (startIdx < 0) throw new Error(`MIGRATE_FROM_PREFIX not found: ${fromPrefix}`);

  const verifyOnlyMode = isVerifyOnlyMode(mode);
  const summary = [];

  if (verifyOnlyMode) {
    for (let i = startIdx; i < files.length; i++) {
      const fileName = files[i];
      const sqlFile = path.join(migrationsDir, fileName);
      const sqlText = fs.readFileSync(sqlFile, "utf8");
      summary.push(await verifyOnly({ client, migrationsDir, fileName, sqlText }));
    }
    return { ok: true, mode: "verify", summary };
  }

  await ensureManualMigrationsTables(client);
  const state = await manualMigrationsState(client);
  if (!state.hasChecksumsTable || !state.hasMigrationsTable) {
    throw new Error("manual migrations tables not initialized");
  }

  for (let i = startIdx; i < files.length; i++) {
    const fileName = files[i];
    const tag = fileName.replace(/\.sql$/, "");
    const sqlFile = path.join(migrationsDir, fileName);
    const sqlText = fs.readFileSync(sqlFile, "utf8");
    const checksum = sha256Hex(sqlText);

    const applied = await wasApplied(client, tag);
    if (applied) {
      const recorded = await getChecksum(client, tag);
      if (recorded && recorded !== checksum) {
        throw new Error(`checksum mismatch for already-applied migration: ${tag}`);
      }
      summary.push({ tag, fileName, status: recorded ? "applied_checksum_matches" : "legacy_applied_without_checksum" });
      continue;
    }

    const preVerify = await verifyMigrationPostconditions(client, tag);
    if (preVerify.ok) {
      summary.push(await recordVerifiedAsApplied({ client, fileName, sqlText }));
      continue;
    }

    try {
      summary.push(await applyOne({ client, fileName, sqlText }));
    } catch (err) {
      if (isDuplicateLikeError(err)) {
        const verify = await verifyMigrationPostconditions(client, tag);
        if (verify.ok) {
          summary.push(await recordVerifiedAsApplied({ client, fileName, sqlText }));
          continue;
        }
        throw Object.assign(new Error(`duplicate-object error but postconditions are not satisfied: ${tag}`), { tag, issues: verify.issues });
      }
      throw err;
    }
  }

  return { ok: true, mode: "apply", summary };
}

