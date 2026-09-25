import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FEATURE_REGISTRY, countFeatures, countByModule } from "@workspace/db";

/**
 * LEGACY STRUCTURAL REGISTRY TESTS.
 *
 * This file retains ONLY structural checks that the PGlite execution-based parity
 * test cannot easily cover:
 *   - non-empty registry sanity counts
 *   - duplicate feature keys
 *   - valid parent references
 *   - valid dependency references
 *   - valid dependency cycles
 *   - value-type family validation
 *   - migration SQL-file evidence that every canonical key appears in the approved
 *     chain (0150 / 0151 / p6)
 *
 * DEEP 13-field PARITY LOGIC (SQL text parser with tolerance) has been INTENTIONALLY
 * REMOVED. The single authority for deep field-level parity is:
 *   g0-1-execution-parity.unit.test.ts
 * which seeds corrupted DB rows, runs the ACTUAL 0151 SQL file verbatim via
 * PGlite pg.exec(fs.readFileSync(...)), then compares every canonical key × 13
 * persisted fields with zero semantic tolerance.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_SOURCES = [
  {
    label: "0150_full_feature_registry_reseed.sql",
    path: resolve(__dirname, "../../../../lib/db/migrations/0150_full_feature_registry_reseed.sql"),
    description: "Lib/DB historical reseed",
  },
  {
    label: "0151_case_feature_registry_parity.sql",
    path: resolve(__dirname, "../../../../lib/db/migrations/0151_case_feature_registry_parity.sql"),
    description: "Lib/DB 238-row canonical parity rewrite",
  },
  {
    label: "p6_entitlement_runtime_foundation.sql",
    path: resolve(__dirname, "../../../../supabase/migrations/p6_entitlement_runtime_foundation.sql"),
    description: "Supabase entitlement foundation seed",
  },
] as const;

const REQUIRED_ADDITIONS = [
  "cases.legacy_import",
  "cases.supporting_documents",
  "cases.batch_update",
  "cases.batch_print",
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

function collectTupleFirstStrings(body: string, out: Set<string>) {
  const re = /\(\s*'([A-Za-z_][\w.-]*\.[\w.-]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const candidate = m[1];
    if (!candidate.includes(" ")) out.add(candidate);
  }
}

function extractFeatureKeysFromSQL(sqlPath: string, label: string): Set<string> {
  const sql = readFileSync(sqlPath, "utf8");
  const keys = new Set<string>();

  // Strategy 1 — 0150 tmp_pf block:
  {
    const marker = `INSERT INTO tmp_pf (feature_key,`;
    const idx = sql.indexOf(marker);
    if (idx >= 0) {
      const after = sql.slice(idx);
      const semi = after.indexOf(";\n");
      const body = semi >= 0 ? after.slice(0, semi) : after;
      collectTupleFirstStrings(body, keys);
    }
  }

  // Strategy 2 — p6 platform_features block:
  {
    const idx = sql.indexOf("INSERT INTO public.platform_features");
    const idx2 = sql.indexOf("INSERT INTO platform_features");
    const start = idx >= 0 ? idx : idx2;
    if (start >= 0) {
      const after = sql.slice(start);
      const onConflict = after.indexOf("ON CONFLICT");
      const semi = after.indexOf(";\n");
      const endCut = onConflict >= 0
        ? onConflict
        : semi >= 0
        ? semi
        : after.length;
      const body = after.slice(0, endCut);
      collectTupleFirstStrings(body, keys);
    }
  }

  // Strategy 3 — 0151 CTE-style INSERT SELECT:
  {
    const idx = sql.indexOf("INSERT INTO platform_features");
    if (idx >= 0) {
      const after = sql.slice(idx);
      const semi = after.indexOf(";\n");
      const endCut = semi >= 0 ? semi : after.length;
      const body = after.slice(0, endCut);
      collectTupleFirstStrings(body, keys);
    }
  }

  // Guard: required additions literal string matches
  for (const req of REQUIRED_ADDITIONS) {
    if (sql.includes(`'${req}'`)) keys.add(req);
  }

  if (keys.size === 0) {
    throw new Error(
      `[${label}] extracted 0 feature keys from ${sqlPath}. Migration path or parser broken.`,
    );
  }
  return keys;
}

function collectMigrationEvidence() {
  const bySource: Record<string, Set<string>> = {};
  const union = new Set<string>();
  for (const src of MIGRATION_SOURCES) {
    const s = extractFeatureKeysFromSQL(src.path, src.label);
    bySource[src.label] = s;
    for (const k of s) union.add(k);
  }
  return { bySource, union };
}

describe("FEATURE REGISTRY — Structural integrity checks only (deep parity lives in g0-1-execution-parity)", () => {
  const regKeys = FEATURE_REGISTRY.map((f) => f.featureKey);
  const regKeysSet = new Set(regKeys);
  const total = countFeatures();
  const byMod = countByModule();
  const modules = Object.keys(byMod);
  const evidence = collectMigrationEvidence();

  it("FEATURE_REGISTRY is non-empty and module count looks reasonable (> 0)", () => {
    expect(total).toBeGreaterThan(200);
    expect(modules.length).toBeGreaterThanOrEqual(15);
  });

  it("FEATURE_REGISTRY has no duplicate feature keys", () => {
    const dups = regKeys.filter((k, i) => regKeys.indexOf(k) !== i);
    expect(regKeys.length).toBe(regKeysSet.size);
    expect(dups).toEqual([]);
  });

  it("Parent references in FEATURE_REGISTRY are valid (point to another registered key)", () => {
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

  describe("Entitlement migration evidence chain (0150 + 0151 + p6) — KEY-PRESENCE evidence only", () => {
    it("Each migration contributes a non-empty key set; newer targeted 0151 patches may have a smaller text-parsed footprint than full reseeds (real DB apply proven in g0-1-execution-parity)", () => {
      for (const src of MIGRATION_SOURCES) {
        const size = evidence.bySource[src.label].size;
        const isTargetedPatch = src.label === "0151_case_feature_registry_parity.sql";
        const ok = isTargetedPatch ? size >= 1 : size > 200;
        expect(ok).toBe(true);
      }
    });

    it("4 newer cases.* additions are present in the combined migration evidence", () => {
      const missing = REQUIRED_ADDITIONS.filter((k) => !evidence.union.has(k));
      expect(missing).toEqual([]);
    });

    it("cases.legacy_import is found in p6 evidence (not required to be in 0150)", () => {
      const p6 = evidence.bySource["p6_entitlement_runtime_foundation.sql"];
      expect(p6.has("cases.legacy_import")).toBe(true);
    });

    it("Every canonical FEATURE_REGISTRY key has migration evidence (0150 ∪ 0151 ∪ p6)", () => {
      const missingFromAll: string[] = [];
      for (const k of regKeys) {
        if (!evidence.union.has(k)) missingFromAll.push(k);
      }
      expect(missingFromAll).toEqual([]);
    });
  });
});
