import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FEATURE_REGISTRY, countFeatures, countByModule } from "@workspace/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_0150 = resolve(
  __dirname,
  "../../../../lib/db/migrations/0150_full_feature_registry_reseed.sql",
);

type SQLRow = {
  feature_key: string;
  module: string;
  parent_feature_key: string | null;
  value_type: string;
  dependency_json: string[];
};

function read0150Rows(): SQLRow[] {
  const sql = readFileSync(MIGRATION_0150, "utf8");
  const marker = `INSERT INTO tmp_pf (feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, dependency_json, route_hint, status) VALUES`;
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error("tmp_pf VALUES clause not found in 0150");
  const body = sql.slice(start + marker.length);
  const semicolon = body.indexOf(";\n");
  const valuesBlock = semicolon >= 0 ? body.slice(0, semicolon) : body;
  const lines = valuesBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("("));

  const out: SQLRow[] = [];
  for (const raw of lines) {
    const row = raw.endsWith(",") ? raw.slice(0, -1) : raw;
    out.push(parseTuple(row));
  }
  return out;
}

// Parse one tuple of the form:
//   ('cases.create','Create case','cases','module.cases','boolean','true',true,false,'[]','/app/cases','active')
// Handles single-quoted strings with possible '' escapes inside, SQL syntax
function parseTuple(sql: string): SQLRow {
  const trimmed = sql.replace(/^\(/, "").replace(/\)$/, "");
  const tokens: string[] = [];
  let cur = "";
  let inStr = false;
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (inStr) {
      if (ch === "'" && trimmed[i + 1] === "'") {
        cur += "'";
        i += 2;
        continue;
      }
      if (ch === "'") {
        inStr = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push(cur);
      cur = "";
      i++;
      continue;
    } else {
        cur += ch;
        i++;
      }
  }
  tokens.push(cur);
  const feature_key = tokens[0];
  const module = tokens[2];
  let parent_feature_key: string | null = tokens[3] === "NULL" ? null : tokens[3];
  const value_type = tokens[4];
  const dependency_json = parseSQLArray(tokens[8]);
  return { feature_key, module, parent_feature_key, value_type, dependency_json };
}

function parseSQLArray(sql: string): string[] {
  const s = sql.trim();
  if (s === "{}" || s === "'[]'") return [];
  const inner = s.replace(/^\{/, "").replace(/\}$/, "");
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((v) => v.trim().replace(/^'/, "").replace(/'$/, ""));
}

function findDeps(parsed: string[] | undefined) {
  if (!parsed) return [];
  return parsed.map((e) => e.trim().replace(/^'/, "").replace(/'$/, "")).filter(Boolean);
}

describe("PART 2.1 P7 — FEATURE REGISTRY PARITY (REAL registry.ts ↔ 0150_full_feature_registry_reseed.sql)", () => {
  it("Registry: total features = 234, modules = 20", () => {
    expect(countFeatures()).toBe(234);
    const byMod = countByModule();
    const modules = Object.keys(byMod);
    expect(modules.length).toBe(20);
  });

  it("0150 tmp_pf row count = 234", () => {
    const rows = read0150Rows();
    expect(rows.length).toBe(234);
  });

  it("0150 unique feature_key count = 234", () => {
    const rows = read0150Rows();
    const keys = rows.map((r) => r.feature_key);
    const set = new Set(keys);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(set.size).toBe(234);
    expect(dups).toEqual([]);
  });

  it("Registry unique feature keys = 234, no duplicates in FEATURE_REGISTRY", () => {
    const keys = FEATURE_REGISTRY.map((f) => f.featureKey);
    const set = new Set(keys);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(keys.length).toBe(234);
    expect(set.size).toBe(234);
    expect(dups).toEqual([]);
  });

  it("Keys missing from 0150 (reg → SQL) = []", () => {
    const sqlKeys = new Set(read0150Rows().map((r) => r.feature_key));
    const regKeys = FEATURE_REGISTRY.map((f) => f.featureKey);
    const missing = regKeys.filter((k) => !sqlKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("Keys extra in 0150 (SQL → reg) = []", () => {
    const regKeys = new Set(FEATURE_REGISTRY.map((f) => f.featureKey));
    const sqlRows = read0150Rows();
    const extra = sqlRows.filter((r) => !regKeys.has(r.feature_key));
    expect(extra.map((r) => r.feature_key)).toEqual([]);
  });

  it("Parent references in registry are valid", () => {
    const byKey = new Map(FEATURE_REGISTRY.map((f) => [f.featureKey, f]));
    const bad: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      const p = f.parentFeatureKey as string | null;
      if (p && !byKey.has(p)) bad.push(`${f.featureKey} -> ${p}`);
    }
    expect(bad).toEqual([]);
  });

  it("Dependency references in registry are valid", () => {
    const byKey = new Set(FEATURE_REGISTRY.map((f) => f.featureKey));
    const bad: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      for (const d of f.dependencies ?? []) {
        if (!byKey.has(d as string)) bad.push(`${f.featureKey} dep ${String(d)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("Feature value types consistent (boolean/enum/number/string only)", () => {
    const allowed = ["boolean", "enum", "number", "string"] as const;
    const bad = FEATURE_REGISTRY.filter((f) => !allowed.includes(f.valueType as typeof allowed[number]));
    expect(bad.map((f) => `${f.featureKey}:${f.valueType}`)).toEqual([]);
  });

  it("Registry dependency cycles: no cycles in dependency graph", () => {
    const adj: Record<string, string[]> = {};
    for (const f of FEATURE_REGISTRY) {
      adj[f.featureKey] = (f.dependencies ?? []).map((d: unknown) => String(d));
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color: Record<string, 0 | 1 | 2> = {};
    for (const k of Object.keys(adj)) color[k] = WHITE;
    const stack: string[] = [];
    let cycle: string | null = null;
    function dfs(u: string) {
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
    }
    for (const k of Object.keys(adj)) if (color[k] === WHITE) dfs(k);
    expect(cycle).toBeNull();
  });
});
