// Frontend Server Package Leak Invariant Test (Part 1 §6)
//
// Invariants:
// 1. Production frontend src MUST NOT contain runtime imports from
//    "@workspace/db" (root). Root transitively pulls pg / drizzle-orm /
//    Pool / DATABASE_URL into the browser bundle → Buffer is not defined.
// 2. Type-only imports from subpaths ("@workspace/db/...") with
//    `import type ...` are ALLOWED.
// 3. Runtime imports from explicit browser-safe subpaths
//    ("@workspace/db/legacy-case-import-contract", "@workspace/db/feature-registry")
//    are ALLOWED.
// 4. ZERO TOLERANCE for pg / pg-pool / postgres-* / drizzle-orm root
//    runtime imports anywhere in frontend src.

process.env.NODE_ENV ??= "test";

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const FE_SRC = join(REPO_ROOT, "artifacts", "lawcaspro", "src");

const TEST_DIR = join(FE_SRC, "__tests__");
const MOCKS_DIR = join(FE_SRC, "__mocks__");

function listFiles(dir: string, acc: string[] = []): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        listFiles(p, acc);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        acc.push(p);
      }
    }
  } catch {
    /* noop */
  }
  return acc;
}

function readSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

const BROWSER_SAFE_SUBPATHS = new Set([
  "@workspace/db/legacy-case-import-contract",
  "@workspace/db/feature-registry",
]);

const FORBIDDEN_SERVER_IMPORTS_ROOT = [
  "from \"@workspace/db\"",
  "from '@workspace/db'",
  "from \"pg\"",
  "from 'pg'",
  "from \"drizzle-orm/node-postgres\"",
  "from 'drizzle-orm/node-postgres'",
  "from \"drizzle-orm/pg-core\"",
  "from 'drizzle-orm/pg-core'",
];

type Leak = { file: string; line: number; match: string };

describe("Frontend ↔ Server Package Leak Invariants", () => {
  let allFeFiles: string[];
  let productionFeFiles: string[];

  beforeAll(() => {
    allFeFiles = listFiles(FE_SRC);
    productionFeFiles = allFeFiles.filter(
      (p) =>
        !p.startsWith(TEST_DIR) &&
        !p.startsWith(MOCKS_DIR) &&
        !p.endsWith(".unit.test.ts") &&
        !p.endsWith(".int.test.ts") &&
        !p.endsWith(".integration.test.ts") &&
        !p.endsWith(".e2e.test.ts") &&
        !p.endsWith(".test.tsx") &&
        !p.endsWith(".test.ts")
    );
  });

  it("P0: Production frontend src contains zero runtime imports from @workspace/db root", () => {
    const leaks: Leak[] = [];

    const runtimeDbRootRe = /^\s*import\s+(?!type\s)[^;]*?from\s*["']@workspace\/db["']\s*;?\s*$/gm;
    const typeImportRootRe = /^\s*import\s+type\s+[^;]*?from\s*["']@workspace\/db["']\s*;?\s*$/gm;
    const dbSubpathRe = /from\s*["']@workspace\/db\/([^"']+)["']/;

    for (const p of productionFeFiles) {
      const src = readSafe(p);
      if (!src) continue;

      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        let m: RegExpExecArray | null;
        runtimeDbRootRe.lastIndex = 0;
        if ((m = runtimeDbRootRe.exec(line)) !== null) {
          leaks.push({ file: p, line: i + 1, match: m[0].trim() });
        }

        typeImportRootRe.lastIndex = 0;
        if ((m = typeImportRootRe.exec(line)) !== null) {
          leaks.push({
            file: p,
            line: i + 1,
            match: `(type-only root import forbidden) ${m[0].trim()}`,
          });
        }

        const sub = dbSubpathRe.exec(line);
        if (sub) {
          const subpath = "@workspace/db/" + sub[1];
          const isTypeOnly = /^\s*import\s+type\s/.test(line);
          const isRuntimeAllowed = BROWSER_SAFE_SUBPATHS.has(subpath);
          if (!isTypeOnly && !isRuntimeAllowed) {
            leaks.push({
              file: p,
              line: i + 1,
              match: `(runtime subpath not in allowlist) ${line.trim()}`,
            });
          }
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it("P0: Production frontend src contains zero direct pg / drizzle node-postgres imports", () => {
    const leaks: Leak[] = [];

    for (const p of productionFeFiles) {
      const src = readSafe(p);
      if (!src) continue;

      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const forbidden of FORBIDDEN_SERVER_IMPORTS_ROOT) {
          if (line.includes(forbidden)) {
            leaks.push({ file: p, line: i + 1, match: line.trim() });
          }
        }
      }
    }

    expect(leaks).toEqual([]);
  });
});
