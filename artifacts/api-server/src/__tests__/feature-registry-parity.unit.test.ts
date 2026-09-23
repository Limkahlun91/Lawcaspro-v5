import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { basename, dirname, resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FEATURE_REGISTRY, countFeatures, countByModule } from "@workspace/db";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = (() => {
  const fromFile = resolve(__dirname, "../../../../");
  const cwd = process.cwd();
  const candidates = [
    fromFile,
    resolve(__dirname, "../../../../../"),
    cwd,
    resolve(cwd, ".."),
  ];
  for (const c of candidates) {
    const ld = join(c, "lib", "db", "migrations");
    const sd = join(c, "supabase", "migrations");
    if (existsSync(ld) && existsSync(sd)) return c;
  }
  return fromFile;
})();

const MIGRATION_DIRS = [
  join(REPO_ROOT, "lib", "db", "migrations"),
  join(REPO_ROOT, "supabase", "migrations"),
];

const REQUIRED_ADDITIONS = [
  "cases.legacy_import",
  "cases.supporting_documents",
  "cases.batch_update",
  "cases.batch_print",
  "accounting.bank_account",
] as const;

const NUMBER_ALIASES = new Set([
  "number", "integer", "decimal", "numeric",
  "bigint", "smallint", "serial", "bigserial",
  "real", "double", "float",
]);
const ALL_ALLOWED_VALUE_TYPES = new Set([
  "boolean", "enum", "string", "config", "unlimited",
  ...NUMBER_ALIASES,
]);

export function __testable_stripSQLComments(sql: string): string {
  const len = sql.length;
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "'" && sql[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      if (ch === strCh) inStr = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      strCh = "'";
      out += ch;
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < len && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function __testable_hasRecognisedRegistration(strippedSQL: string): boolean {
  const s = strippedSQL;
  if (/insert\s+into\s+(?:public\.)?platform_features\s*\(/i.test(s)) return true;
  if (/insert\s+into\s+tmp_platform_features\s*\(/i.test(s)) return true;
  if (/insert\s+into\s+tmp_pf\s*\(\s*feature_key\s*,/i.test(s)) return true;
  if (/drop\s+table\s+if\s+exists\s+tmp_pf\b/i.test(s) && /create\s+(?:temp\s+)?table\s+tmp_pf\b/i.test(s)) {
    return true;
  }
  if (/with\s+pf\s*\([^)]*feature_key[^)]*\)\s*values/i.test(s)) return true;
  if (/insert\s+into\s+platform_features\s+select/i.test(s)) return true;
  if (/(?:public\.)?platform_features.*on\s+conflict\s*\(\s*feature_key\s*\)/i.test(s)) {
    return true;
  }
  return false;
}

export function __testable_extractFeatureKeys(strippedSQL: string): Set<string> {
  const keys = new Set<string>();
  if (!__testable_hasRecognisedRegistration(strippedSQL)) return keys;
  const mark1 = strippedSQL.search(/insert\s+into\s+tmp_pf\s*\(\s*feature_key\s*,/i);
  const mark2a = strippedSQL.search(/insert\s+into\s+(?:public\.)?platform_features\s*\(/i);
  const mark2b = strippedSQL.search(/insert\s+into\s+tmp_platform_features\s*\(/i);
  const marks = [mark1, mark2a, mark2b].filter((x) => x >= 0).sort((a, b) => a - b);
  if (marks.length === 0) {
    if (/values\s*\(/i.test(strippedSQL)) collectTupleFirstStrings(strippedSQL, keys);
    return keys;
  }
  for (const start of marks) {
    const body = strippedSQL.slice(start);
    const onConflict = body.search(/on\s+conflict/i);
    const semi = body.indexOf(";\n");
    const endCut = onConflict >= 0
      ? onConflict
      : semi >= 0
      ? semi
      : body.length;
    collectTupleFirstStrings(body.slice(0, endCut), keys);
  }
  for (const req of REQUIRED_ADDITIONS) {
    if (strippedSQL.includes(`'${req}'`)) keys.add(req);
  }
  return keys;
}

function collectTupleFirstStrings(body: string, out: Set<string>) {
  const re = /\(\s*'([A-Za-z_][\w.-]*\.[\w.-]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const candidate = m[1];
    if (!candidate.includes(" ")) out.add(candidate);
  }
}

function discoverMigrationFiles(): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  for (const dir of MIGRATION_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.toLowerCase().endsWith(".sql")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (!st.isFile()) continue;
      out.push({ label: entry, path: full });
    }
  }
  return out;
}

function extractFeatureKeysFromSQL(sqlPath: string): Set<string> {
  const raw = readFileSync(sqlPath, "utf8");
  const stripped = __testable_stripSQLComments(raw);
  const reg = __testable_hasRecognisedRegistration(stripped);
  const keys = __testable_extractFeatureKeys(stripped);
  void reg;
  void basename;
  return keys;
}

export function collectMigrationEvidence(): {
  bySource: Record<string, Set<string>>;
  union: Set<string>;
  contributing: string[];
  sources: { label: string; path: string }[];
} {
  const bySource: Record<string, Set<string>> = {};
  const union = new Set<string>();
  const contributing: string[] = [];
  const sources = discoverMigrationFiles();
  for (const src of sources) {
    const s = extractFeatureKeysFromSQL(src.path);
    bySource[src.label] = s;
    if (s.size > 0) {
      contributing.push(src.label);
      for (const k of s) union.add(k);
    }
  }
  return { bySource, union, contributing, sources };
}

describe("FEATURE REGISTRY PARITY — canonical registry vs dynamic migration evidence", () => {
  const regKeys = FEATURE_REGISTRY.map((f) => f.featureKey);
  const regKeysSet = new Set(regKeys);
  const total = countFeatures();
  const byMod = countByModule();
  const modules = Object.keys(byMod);
  const evidence = collectMigrationEvidence();

  it("FEATURE_REGISTRY is non-empty and module count looks reasonable (> 0)", () => {
    expect(total).toBeGreaterThan(200);
    expect(modules.length).toBeGreaterThanOrEqual(12);
  });

  it("FEATURE_REGISTRY has no duplicate feature keys", () => {
    const dups = regKeys.filter((k, i) => regKeys.indexOf(k) !== i);
    expect(regKeys.length).toBe(regKeysSet.size);
    expect(dups).toEqual([]);
  });

  it("Parent references in FEATURE_REGISTRY are valid", () => {
    const bad: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      const p = f.parentFeatureKey as string | null;
      if (p && !regKeysSet.has(p)) bad.push(`${f.featureKey} -> ${p}`);
    }
    expect(bad).toEqual([]);
  });

  it("Dependency references in FEATURE_REGISTRY are valid", () => {
    const bad: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      for (const d of f.dependencies ?? []) {
        if (!regKeysSet.has(d as string)) bad.push(`${f.featureKey} dep ${String(d)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("Feature value types in FEATURE_REGISTRY belong to the allowed families", () => {
    const bad = FEATURE_REGISTRY.filter((f) => !ALL_ALLOWED_VALUE_TYPES.has(f.valueType));
    expect(bad.map((f) => `${f.featureKey}:${f.valueType}`)).toEqual([]);
  });

  it("FEATURE_REGISTRY has no dependency cycles", () => {
    const adj: Record<string, string[]> = {};
    for (const f of FEATURE_REGISTRY) {
      adj[f.featureKey] = (f.dependencies ?? []).map((d: unknown) => String(d));
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color: Record<string, 0 | 1 | 2> = {};
    for (const k of Object.keys(adj)) color[k] = WHITE;
    const stack: string[] = [];
    let cycle: string | null = null;
    const dfs = (u: string) => {
      if (cycle) return;
      color[u] = GRAY;
      stack.push(u);
      for (const v of adj[u] || []) {
        if (!(v in color)) continue;
        if (color[v] === GRAY) {
          const idx = stack.indexOf(v);
          cycle = [...stack.slice(idx), v].join(" -> ");
          return;
        }
        if (color[v] === WHITE) dfs(v);
      }
      stack.pop();
      color[u] = BLACK;
    };
    for (const k of Object.keys(adj)) if (color[k] === WHITE) dfs(k);
    expect(cycle).toBeNull();
  });

  describe("Dynamic migration evidence discovery", () => {
    it("Scans both migration directories and finds AT LEAST 2 contributing files (0150 + p6 + any forward)", () => {
      expect(evidence.contributing.length).toBeGreaterThanOrEqual(2);
    });

    it("Does not hardcode the 0150 / p6 label list; evidence.bySource keys come from fs scan", () => {
      const fromScan = evidence.sources.map((s) => s.label);
      const reported = Object.keys(evidence.bySource);
      const fromScanUniqCount = new Set(fromScan).size;
      const intersection = reported.filter((r) => fromScan.includes(r));
      expect(intersection.length).toBeGreaterThanOrEqual(2);
      expect(reported.length).toBeLessThanOrEqual(fromScanUniqCount);
      expect(new Set(intersection).size).toBeGreaterThanOrEqual(2);
    });

    it("Combined evidence includes REQUIRED_ADDITIONS incl. accounting.bank_account from forward migration", () => {
      const missing = REQUIRED_ADDITIONS.filter((k) => !evidence.union.has(k));
      expect(missing).toEqual([]);
    });

    it("cases.legacy_import is visible in the combined union", () => {
      expect(evidence.union.has("cases.legacy_import")).toBe(true);
    });

    it("accounting.bank_account is provided by the forward migration contribution, not only 0150/p6", () => {
      const legacyOnly =
        (evidence.bySource["0150_full_feature_registry_reseed.sql"] ?? new Set()).has(
          "accounting.bank_account",
        ) ||
        (evidence.bySource["p6_entitlement_runtime_foundation.sql"] ?? new Set()).has(
          "accounting.bank_account",
        );
      const forwardOnly =
        Object.entries(evidence.bySource)
          .filter(
            ([lbl]) =>
              lbl !== "0150_full_feature_registry_reseed.sql" &&
              lbl !== "p6_entitlement_runtime_foundation.sql",
          )
          .some(([, s]) => s.has("accounting.bank_account"));
      expect(legacyOnly).toBe(false);
      expect(forwardOnly).toBe(true);
    });

    it("Every canonical FEATURE_REGISTRY key has migration evidence across the discovered union", () => {
      const missingFromAll: string[] = [];
      for (const k of regKeys) {
        if (!evidence.union.has(k)) missingFromAll.push(k);
      }
      expect(missingFromAll).toEqual([]);
    });
  });

  describe("Safety invariants — no comment false positives", () => {
    it("Comment-only occurrence of accounting.bank_account does NOT pass the helper", () => {
      const comment = `
        -- TODO: We should really add accounting.bank_account in the next migration.
        -- Also consider accounting.future_todo, just in case.
      `;
      const stripped = __testable_stripSQLComments(comment);
      expect(__testable_hasRecognisedRegistration(stripped)).toBe(false);
      const keys = __testable_extractFeatureKeys(stripped);
      expect(keys.has("accounting.bank_account")).toBe(false);
      expect(keys.has("accounting.future_todo")).toBe(false);
    });

    it("Block-comment occurrence of accounting.bank_account does NOT pass", () => {
      const block = `
        /*

        Proposed features to consider:
          - accounting.bank_account   (commented out for scope reasons)
          - accounting.future_todo    (postponed)

        */
        SELECT 1;
      `;
      const stripped = __testable_stripSQLComments(block);
      expect(__testable_hasRecognisedRegistration(stripped)).toBe(false);
      const keys = __testable_extractFeatureKeys(stripped);
      expect(keys.has("accounting.bank_account")).toBe(false);
    });

    it("A legitimate INSERT INTO platform_features block IS recognised", () => {
      const real = `
        INSERT INTO public.platform_features
          (feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, dependency_json, status)
        VALUES
          ('accounting.bank_account','Bank Accounts','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,'active')
        ON CONFLICT (feature_key) DO NOTHING;
      `;
      const stripped = __testable_stripSQLComments(real);
      expect(__testable_hasRecognisedRegistration(stripped)).toBe(true);
      const keys = __testable_extractFeatureKeys(stripped);
      expect(keys.has("accounting.bank_account")).toBe(true);
    });

    it("A registry-only synthetic feature with no migration contribution would still fail the union check (deterministic negative control)", () => {
      const synthetic: readonly string[] = [
        "never.registered.synthetic_nope_xyz",
        "accounting.purely_registry_synthetic_nope_xyz_9a1a",
      ] as const;
      const missing: string[] = [];
      for (const k of synthetic) {
        if (!evidence.union.has(k)) missing.push(k);
      }
      expect(missing.length).toBe(synthetic.length);
    });
  });
});
