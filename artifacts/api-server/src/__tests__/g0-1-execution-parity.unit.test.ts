// G0.1 — EXECUTION-BASED STRICT 13-FIELD PERSISTED-PROJECTION PARITY TEST
//
// Principle (per G0.1 stop rule): NO parser-tolerance trick. Instead:
//   1. Create PGlite + platform_features schema
//   2. Seed deliberately corrupted/stale state BEFORE running 0151
//      (wrong founder_only, wrong default_value, wrong description,
//       wrong sort_order, wrong status, wrong route_hint, remove one
//       canonical row entirely)
//   3. Read the ACTUAL lib/db/migrations/0151_case_feature_registry_parity.sql
//      file from disk and execute it verbatim via PGlite.
//   4. SELECT * FROM platform_features;
//   5. Build the canonical persisted 13-field projection directly from
//      the current FEATURE_REGISTRY (in-memory TypeScript array).
//   6. Strict 1:1 compare EVERY canonical feature × EVERY one of the 13
//      persisted fields. Only JSON/type normalization allowed.
//
// Required assertions:
//   actualDbCanonicalCount === FEATURE_REGISTRY.length
//   mismatches === []
//   deliberately corrupted rows actually repaired (not untouched)
//   missing canonical row actually inserted

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { FEATURE_REGISTRY } from "@workspace/db";

const PERSISTED_COLS_13 = [
  "feature_key",
  "name",
  "module",
  "parent_feature_key",
  "value_type",
  "default_value",
  "configurable",
  "founder_only",
  "dependency_json",
  "route_hint",
  "description",
  "sort_order",
  "status",
] as const;
type PersistedCol = typeof PERSISTED_COLS_13[number];

// Build the canonical 13-field projection row from a FeatureDefinition exactly
// as 0151 SQL would project it via the canonical VALUES CTE. Mirrors the
// defaults from asFeat() (feature-registry.ts L83–L121).
function canonicalProjection(def: (typeof FEATURE_REGISTRY)[number]): Record<PersistedCol, unknown> {
  const dep = Array.isArray(def.dependencies) ? [...def.dependencies] : [];
  const dv =
    def.defaultValue !== undefined
      ? def.defaultValue
      : def.valueType === "boolean"
      ? true
      : def.valueType === "integer" || def.valueType === "decimal"
      ? 0
      : def.valueType === "unlimited"
      ? -1
      : null;
  return {
    feature_key: def.featureKey,
    name: def.name,
    module: def.module,
    parent_feature_key: def.parentFeatureKey ?? null,
    value_type: def.valueType,
    default_value: { v: dv }, // mirrors seedCanonicalFeatureRegistry / plan_value_json convention
    configurable: def.configurable ?? true,
    founder_only: def.founderOnly ?? false,
    dependency_json: dep,
    route_hint: (def.routeHint as string | undefined) ?? null,
    description: (def.description as string | undefined) ?? null,
    sort_order: def.sortOrder ?? 0,
    status: (def.status as string) ?? "active",
  };
}

// Canonical JSON array order comparison (parse from JSONB stored -> array).
function normDep(v: unknown): unknown[] {
  if (Array.isArray(v)) return v as unknown[];
  if (v == null) return [];
  try {
    const p = typeof v === "string" ? JSON.parse(v) : (v as any);
    if (Array.isArray(p?.v)) return p.v as unknown[];
    if (Array.isArray(p)) return p as unknown[];
    return [];
  } catch {
    return [];
  }
}
// default_value is stored as jsonb { v: <native value> } (valueJson convention).
// Tolerate: (a) SQL boolean jsonb roundtrip and (b) number vs numeric string.
// NO semantic tolerance for WRONG values; only representation normalization.
function normDefaultValue(a: unknown, b: unknown): { a: unknown; b: unknown } {
  const unwrap = (x: unknown): unknown => {
    if (x != null && typeof x === "object" && !Array.isArray(x) && "v" in (x as Record<string, unknown>)) {
      return (x as Record<string, unknown>).v;
    }
    return x;
  };
  const av = unwrap(a);
  const bv = unwrap(b);
  if (typeof av === "boolean" && typeof bv === "boolean") return { a: av, b: bv };
  if (typeof av === "number" && typeof bv === "string") return { a: av, b: Number(bv) };
  if (typeof av === "string" && typeof bv === "number") return { a: Number(av), b: bv };
  if (typeof av === "boolean" && typeof bv === "string") return { a: av, b: bv === "true" || bv === "t" };
  if (typeof av === "string" && typeof bv === "boolean") return { a: av === "true" || av === "t" ? true : av === "false" || av === "f" ? false : av, b: bv };
  return { a: av, b: bv };
}

const DDL_PLATFORM_FEATURES = `
CREATE TABLE IF NOT EXISTS platform_features (
  id serial PRIMARY KEY,
  feature_key text UNIQUE NOT NULL,
  name text NOT NULL,
  module text NOT NULL DEFAULT 'general',
  parent_feature_key text,
  value_type text NOT NULL DEFAULT 'boolean',
  default_value jsonb NOT NULL DEFAULT 'false'::jsonb,
  configurable boolean NOT NULL DEFAULT true,
  founder_only boolean NOT NULL DEFAULT false,
  dependency_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  route_hint text,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_features_feature_key ON platform_features(feature_key);
`;

describe("G0.1 Execution-based 13-field strict parity (real 0151 SQL in PGlite)", () => {
  let pg: PGlite;
  // Identities & expected new/stale values used by corruption assertions.
  const CORRUPT_ROW_KEY = "cases.legacy_import"; // canonical: founderOnly=false (Line 148 of feature-registry.ts confirms)
  const STALE_DEFAULT_KEY = "limit.storage.gb"; // canonical default 100
  const STALE_DESC_KEY = "storage.file_custody";
  const STALE_SORT_KEY = "module.cases";
  const STALE_STATUS_KEY = "storage.file_custody"; // canonical status = inactive
  const STALE_ROUTE_KEY = "module.audit";
  const REMOVE_ROW_KEY = "cases.overview";

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(DDL_PLATFORM_FEATURES);
  }, 60000);

  it("Step A: seed corrupted/stale platform_features state — deliberate mismatches", async () => {
    // First, bulk seed from canonical projection but corrupt specific cells.
    const baseRows = FEATURE_REGISTRY.map(canonicalProjection);
    // 1) CORRUPT: cases.legacy_import founder_only = TRUE (canonical says FALSE)
    const corruptFounder = baseRows.find((r) => r.feature_key === CORRUPT_ROW_KEY);
    expect(corruptFounder).toBeDefined();
    corruptFounder!.founder_only = true;
    corruptFounder!.default_value = { v: true };
    // 2) CORRUPT: limit.storage.gb default_value = 1
    const staleDefault = baseRows.find((r) => r.feature_key === STALE_DEFAULT_KEY);
    expect(staleDefault).toBeDefined();
    staleDefault!.default_value = { v: 1 };
    // 3) CORRUPT: storage.file_custody description = NULL (canonical has string)
    const staleDesc = baseRows.find((r) => r.feature_key === STALE_DESC_KEY);
    expect(staleDesc).toBeDefined();
    staleDesc!.description = null;
    // 4) CORRUPT: module.cases sort_order = 999 (canonical sort_order differs)
    const staleSort = baseRows.find((r) => r.feature_key === STALE_SORT_KEY);
    expect(staleSort).toBeDefined();
    staleSort!.sort_order = 999;
    // 5) CORRUPT: storage.file_custody status = active (canonical inactive)
    const staleStatus = baseRows.find((r) => r.feature_key === STALE_STATUS_KEY);
    expect(staleStatus).toBeDefined();
    staleStatus!.status = "active";
    // 6) CORRUPT: module.audit route_hint = NULL (canonical has '/app/audit-logs')
    const staleRoute = baseRows.find((r) => r.feature_key === STALE_ROUTE_KEY);
    expect(staleRoute).toBeDefined();
    staleRoute!.route_hint = null;
    // 7) REMOVE ENTIRELY: cases.overview row
    const insertRows = baseRows.filter((r) => r.feature_key !== REMOVE_ROW_KEY);

    // Insert via per-row SQL literals (minimal, test-only code path)
    const escStr = (s: unknown): string => {
      if (s == null) return "NULL";
      if (typeof s === "string") return "'" + s.replace(/'/g, "''") + "'";
      if (typeof s === "boolean") return s ? "TRUE" : "FALSE";
      if (typeof s === "number") return String(s);
      return "'" + JSON.stringify(s).replace(/'/g, "''") + "'";
    };
    const escJson = (v: unknown): string => {
      if (v == null) return "'{}'::jsonb";
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return "'" + s.replace(/'/g, "''") + "'::jsonb";
    };
    const sqlValues = insertRows
      .map(
        (r) =>
          `(${escStr(r.feature_key)},${escStr(r.name)},${escStr(r.module)},${escStr(r.parent_feature_key)},${escStr(r.value_type)},${escJson(r.default_value)},${r.configurable ? "TRUE" : "FALSE"},${r.founder_only ? "TRUE" : "FALSE"},${escJson(r.dependency_json)},${escStr(r.route_hint)},${escStr(r.description)},${String(r.sort_order)},${escStr(r.status)})`,
      )
      .join(",\n  ");
    await pg.exec(`INSERT INTO platform_features(feature_key,name,module,parent_feature_key,value_type,default_value,configurable,founder_only,dependency_json,route_hint,description,sort_order,status) VALUES\n  ${sqlValues};`);

    // Confirm corrupted state BEFORE 0151.
    const before = (await pg.query<{ feature_key: string; founder_only: boolean; default_value: any; description: string | null; sort_order: number; status: string; route_hint: string | null }>(
      "SELECT feature_key,founder_only,default_value,description,sort_order,status,route_hint FROM platform_features WHERE feature_key IN ($1,$2,$3,$4,$5,$6)",
      [CORRUPT_ROW_KEY, STALE_DEFAULT_KEY, STALE_DESC_KEY, STALE_SORT_KEY, STALE_STATUS_KEY, STALE_ROUTE_KEY],
    )).rows;
    const beforMap = Object.fromEntries(before.map((r) => [r.feature_key, r])) as any;
    expect(beforMap[CORRUPT_ROW_KEY]?.founder_only).toBe(true); // corrupted
    expect((beforMap[STALE_DEFAULT_KEY]?.default_value as any)?.v ?? beforMap[STALE_DEFAULT_KEY]?.default_value).toBe(1); // corrupted
    expect(beforMap[STALE_DESC_KEY]?.description).toBeNull(); // corrupted
    expect(beforMap[STALE_SORT_KEY]?.sort_order).toBe(999); // corrupted
    expect(beforMap[STALE_STATUS_KEY]?.status).toBe("active"); // corrupted
    expect(beforMap[STALE_ROUTE_KEY]?.route_hint).toBeNull(); // corrupted
    const missing = await pg.query<{ c: number }>("SELECT COUNT(*)::int c FROM platform_features WHERE feature_key = $1", [REMOVE_ROW_KEY]);
    expect(missing.rows[0].c).toBe(0); // removed
  }, 60000);

  it("Step B: execute ACTUAL lib/db/migrations/0151_case_feature_registry_parity.sql verbatim via PGlite", async () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "..",
      "..",
      "..",
      "lib",
      "db",
      "migrations",
      "0151_case_feature_registry_parity.sql",
    );
    // Normalize: depending on cwd (api-server), we may need shorter upward path.
    const candidates = [
      migrationPath,
      path.resolve(process.cwd(), "..", "..", "lib", "db", "migrations", "0151_case_feature_registry_parity.sql"),
      path.resolve(process.cwd(), "lib", "db", "migrations", "0151_case_feature_registry_parity.sql"),
    ];
    const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    const filePath = candidates.find(exists);
    expect(filePath).toBeDefined();
    const raw = fs.readFileSync(filePath!, "utf8");
    // Execute the whole migration as a single script.
    await pg.exec(raw);
  }, 60000);

  it("Step C: strict 13-field equality FEATURE_REGISTRY projection vs DB post-0151 (no tolerance for wrong values)", async () => {
    // 1) Load DB mirror indexed by feature_key.
    const all = (await pg.query<Record<string, unknown>>(
      "SELECT feature_key,name,module,parent_feature_key,value_type,default_value,configurable,founder_only,dependency_json,route_hint,description,sort_order,status FROM platform_features ORDER BY feature_key",
    )).rows as unknown as Array<Record<PersistedCol, unknown>>;
    const dbByKey = new Map<string, Record<PersistedCol, unknown>>(all.map((r) => [String(r.feature_key), r]));
    // 2) Count: actual DB rows that match a canonical key.
    const canonicalKeys = FEATURE_REGISTRY.map((d) => d.featureKey);
    const inBoth = all.filter((r) => canonicalKeys.includes(String(r.feature_key)));
    expect(inBoth.length).toBe(FEATURE_REGISTRY.length);

    // 3) Corruption repair assertions per Step A deliberate corruptions.
    const rep = (k: string) => dbByKey.get(k);
    const founderRepair = rep(CORRUPT_ROW_KEY);
    expect(founderRepair?.founder_only).toBe(false); // back to canonical false
    const defRepair = rep(STALE_DEFAULT_KEY);
    const { a: da, b: db } = normDefaultValue(canonicalProjection(FEATURE_REGISTRY.find((x) => x.featureKey === STALE_DEFAULT_KEY)!).default_value, defRepair?.default_value);
    expect(da).toBe(db);
    const descRepair = rep(STALE_DESC_KEY);
    expect(descRepair?.description).toBe(canonicalProjection(FEATURE_REGISTRY.find((x) => x.featureKey === STALE_DESC_KEY)!).description);
    const sortRepair = rep(STALE_SORT_KEY);
    expect(Number(sortRepair?.sort_order)).toBe(canonicalProjection(FEATURE_REGISTRY.find((x) => x.featureKey === STALE_SORT_KEY)!).sort_order);
    const statusRepair = rep(STALE_STATUS_KEY);
    expect(statusRepair?.status).toBe(canonicalProjection(FEATURE_REGISTRY.find((x) => x.featureKey === STALE_STATUS_KEY)!).status);
    const routeRepair = rep(STALE_ROUTE_KEY);
    expect(routeRepair?.route_hint).toBe(canonicalProjection(FEATURE_REGISTRY.find((x) => x.featureKey === STALE_ROUTE_KEY)!).route_hint);

    // 4) Missing row INSERTED.
    expect(rep(REMOVE_ROW_KEY)).toBeDefined();
    expect(rep(REMOVE_ROW_KEY)?.feature_key).toBe(REMOVE_ROW_KEY);

    // 5) Strict cell-by-cell compare every canonical row × every 13 persisted col.
    const mismatches: string[] = [];
    for (const def of FEATURE_REGISTRY) {
      const canonical = canonicalProjection(def);
      const mirror = dbByKey.get(def.featureKey);
      if (!mirror) { mismatches.push(`missing_db_row: ${def.featureKey}`); continue; }
      for (const col of PERSISTED_COLS_13) {
        const a = canonical[col];
        const b = mirror[col];
        let eq = false;
        if (col === "default_value") {
          const { a: av, b: bv } = normDefaultValue(a, b);
          eq = Object.is(av, bv) || String(av) === String(bv);
        } else if (col === "dependency_json") {
          const an = normDep(a);
          const bn = normDep(b);
          eq = JSON.stringify(an) === JSON.stringify(bn);
        } else if (col === "configurable" || col === "founder_only") {
          const aTruthy = a === true || a === "true" || a === "t";
          const bTruthy = b === true || b === "true" || b === "t";
          const aFalsy = a === false || a === "false" || a === "f";
          const bFalsy = b === false || b === "false" || b === "f";
          eq = (aTruthy && bTruthy) || (aFalsy && bFalsy);
        } else if (col === "sort_order") {
          eq = Number(a) === Number(b ?? 0);
        } else if (col === "parent_feature_key" || col === "route_hint" || col === "description") {
          const aS = a == null ? null : String(a);
          const bS = b == null ? null : String(b);
          eq = aS === bS || (aS === "" && bS == null) || (bS === "" && aS == null);
        } else {
          eq = JSON.stringify(a) === JSON.stringify(b);
        }
        if (!eq) mismatches.push(`${def.featureKey}.${col}: canonical=${JSON.stringify(a)} vs mirror=${JSON.stringify(b)}`);
      }
    }

    // 6) Final strict assertions.
    expect(inBoth.length).toBe(FEATURE_REGISTRY.length);
    expect(mismatches).toEqual([]);

    // 7) Report unknown extra feature keys in DB that are not in canonical.
    const extras = all.filter((r) => !canonicalKeys.includes(String(r.feature_key))).map((r) => String(r.feature_key));
    if (extras.length > 0) {
      // eslint-disable-next-line no-console
      console.warn("[G0.1 parity] WARNING: DB contains unknown extra feature keys NOT in canonical registry (not auto-deleted). Extras=", JSON.stringify(extras));
    }
  }, 60000);
});
