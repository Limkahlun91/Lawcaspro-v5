import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const ARTIFACTS_FE_DIR = join(REPO_ROOT, "artifacts", "lawcaspro");
const ASSET_CANDIDATES = [
  join(ARTIFACTS_FE_DIR, "dist", "public", "assets"),
  join(ARTIFACTS_FE_DIR, "dist", "assets"),
];

const FORBIDDEN = [
  "pg-pool",
  "pg-protocol",
  "pg-types",
  "pgpass",
  "postgres-array",
  "postgres-date",
  "postgres-interval",
  "postgres-bytea",
  "drizzle-orm/node-postgres",
  "DATABASE_URL must be set",
];

function listJs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      listJs(p, acc);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function findAssetDir(): string | null {
  for (const candidate of ASSET_CANDIDATES) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

function main(): number {
  const assetDir = findAssetDir();
  if (!assetDir) {
    console.error(
      "[assert-browser-bundle-safe] No frontend asset dir found. Tried:\n  - " +
        ASSET_CANDIDATES.join("\n  - ") +
        "\nRun `pnpm run build` first.",
    );
    return 1;
  }
  const files = listJs(assetDir);
  if (files.length === 0) {
    console.error("[assert-browser-bundle-safe] No JS files found in " + assetDir);
    return 1;
  }
  const violations: string[] = [];
  for (const file of files) {
    const rel = file.slice(REPO_ROOT.length + 1);
    let body = "";
    try {
      body = readFileSync(file, "utf8");
    } catch {
      violations.push(`${rel}: could not read file`);
      continue;
    }
    for (const token of FORBIDDEN) {
      if (rel.includes(token) || body.includes(token)) {
        violations.push(`${rel}: ${token}`);
      }
    }
  }
  if (violations.length) {
    console.error("[assert-browser-bundle-safe] FAIL");
    console.error(violations.join("\n"));
    return 1;
  }
  console.log(
    `[assert-browser-bundle-safe] PASS — scanned ${files.length} JS files in ${assetDir}`,
  );
  return 0;
}

process.exit(main());
