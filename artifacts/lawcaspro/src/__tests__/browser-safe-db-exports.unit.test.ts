import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const LIB_DB_SRC = join(REPO_ROOT, "lib", "db", "src");

const ENTRY_FILES = [
  join(LIB_DB_SRC, "legacy-case-import.contract.ts"),
  join(LIB_DB_SRC, "feature-registry.ts"),
];

const FORBIDDEN = [
  `"pg"`,
  `'pg'`,
  `from "pg"`,
  `from 'pg'`,
  `drizzle-orm/node-postgres`,
  `drizzle-orm/pg-core`,
  `DATABASE_URL`,
];

const IMPORT_PATH_RE =
  /^\s*import\s+(?:[^;'"`]*?\s+from\s+)?["']([^"']+)["']\s*;?\s*$/gm;

function readSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function resolveImport(base: string, spec: string): string | null {
  if (spec.startsWith("node:") || /^[a-z@][^/]*$/i.test(spec.split("/")[0] || spec)) {
    return spec;
  }
  const baseDir = dirname(base);
  const candidates = [
    resolve(baseDir, spec) + ".ts",
    resolve(baseDir, spec) + ".tsx",
    resolve(baseDir, spec) + ".js",
    resolve(baseDir, spec) + "/index.ts",
    resolve(baseDir, spec) + "/index.tsx",
    resolve(baseDir, spec) + "/index.js",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function collectFiles(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const files: string[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const body = readSafe(file);
    if (!body) continue;
    files.push(file);
    let m: RegExpExecArray | null;
    IMPORT_PATH_RE.lastIndex = 0;
    while ((m = IMPORT_PATH_RE.exec(body)) !== null) {
      const spec = m[1];
      const resolved = resolveImport(file, spec);
      if (resolved && isAbsolute(resolved) && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return files;
}

describe("Browser-safe @workspace/db subpath exports (transitive graph)", () => {
  beforeAll(() => {
    process.env.NODE_ENV ??= "test";
  });

  it.each(ENTRY_FILES)(
    "entry %s imports transitively do NOT contain pg / drizzle-orm pg-core / node-postgres / DATABASE_URL",
    (entry) => {
      expect(existsSync(entry)).toBe(true);
      const graph = collectFiles(entry);
      expect(graph.length).toBeGreaterThan(0);
      const agg = graph.map((f) => readSafe(f)).join("\n");
      for (const token of FORBIDDEN) {
        expect(agg).not.toContain(token);
      }
    },
  );

  it.each(ENTRY_FILES)(
    "entry %s does not import @workspace/db root or ./index.ts or ./schema",
    (entry) => {
      const graph = collectFiles(entry);
      const rootIndex = join(LIB_DB_SRC, "index.ts");
      const schemaIndex = join(LIB_DB_SRC, "schema", "index.ts");
      expect(graph.includes(rootIndex)).toBe(false);
      expect(graph.includes(schemaIndex)).toBe(false);
      for (const f of graph) {
        const body = readSafe(f);
        expect(body).not.toMatch(/from\s+["']\.\.?\/index["']/);
        expect(body).not.toMatch(/from\s+["']\.\.?\/schema["']/);
      }
    },
  );
});
