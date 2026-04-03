#!/usr/bin/env node
/**
 * Build freshness guard.
 * Called before `node dist/index.mjs` to catch stale dist in production.
 * Exits 1 with a clear error when dist/index.mjs is missing or older than any .ts source file.
 */
import { statSync, readdirSync } from "fs";
import { join } from "path";

const DIST_FILE = new URL("../dist/index.mjs", import.meta.url).pathname;
const SRC_DIR  = new URL("../src",            import.meta.url).pathname;

function newestMtime(dir) {
  let t = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      t = Math.max(t, newestMtime(full));
    } else if (entry.name.endsWith(".ts")) {
      t = Math.max(t, statSync(full).mtimeMs);
    }
  }
  return t;
}

let distMtime;
try {
  distMtime = statSync(DIST_FILE).mtimeMs;
} catch {
  console.error("FATAL: dist/index.mjs not found. Run `pnpm run build` before `pnpm run start`.");
  process.exit(1);
}

const srcNewest = newestMtime(SRC_DIR);
if (srcNewest > distMtime) {
  const staleSec = Math.round((srcNewest - distMtime) / 1000);
  console.error(
    `FATAL: dist/index.mjs is stale — source is ${staleSec}s newer than the last build.\n` +
    `       Run \`pnpm run build\` then retry.`
  );
  process.exit(1);
}
