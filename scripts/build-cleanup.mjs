// scripts/build-cleanup.mjs
// Cross-platform build cleanup helper. Works on Windows PowerShell 7+ and Vercel Linux.
// Usage: node scripts/build-cleanup.mjs rm <path1> [<path2> ...]
// Usage: node scripts/build-cleanup.mjs ls-head <dir> <maxLines>
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

function safeRm(p) {
  const abs = resolve(process.cwd(), p);
  try {
    if (existsSync(abs)) {
      const s = statSync(abs);
      if (s.isDirectory()) {
        rmSync(abs, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
      } else {
        rmSync(abs, { force: true, maxRetries: 2, retryDelay: 120 });
      }
    }
  } catch (e) {
    // Keep cleanup tolerant: never fail the build for a stale lock/dir
    console.warn(`[build-cleanup] WARN rm failed for ${p}: ${String(e?.message ?? e)}`);
  }
}

function lsHead(dir, maxLines) {
  const abs = resolve(process.cwd(), dir);
  if (!existsSync(abs)) {
    console.log("  MISSING");
    return;
  }
  const entries = readdirSync(abs);
  const n = Math.min(entries.length, Number.isFinite(Number(maxLines)) ? Number(maxLines) : 5);
  for (let i = 0; i < n; i++) console.log(entries[i]);
}

const [, , cmd, ...args] = process.argv;
if (cmd === "rm") {
  if (args.length === 0) process.exit(0);
  args.forEach(safeRm);
  process.exit(0);
}
if (cmd === "ls-head") {
  lsHead(args[0] ?? ".", args[1] ?? 5);
  process.exit(0);
}
console.error("Usage: build-cleanup.mjs rm <paths...>  OR  build-cleanup.mjs ls-head <dir> <max>");
process.exit(1);
