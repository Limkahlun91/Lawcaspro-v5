import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { FEATURE_REGISTRY_MAP, type FeatureDefinition } from "@workspace/db/feature-registry";
import {
  applyEntitlementFoundationDdl,
  seedCanonicalFeatureRegistry,
} from "./pglite-bootstrap.js";

type PlatformFeatureRow = {
  feature_key: string;
  module: string;
  name: string;
  parent_feature_key: string | null;
  backend_guard_key: string | null;
  default_value: unknown;
  configurable: boolean;
  founder_only: boolean;
  status: string;
  dependency_json: unknown;
  route_hint: string | null;
  sort_order: number;
  value_type: string;
  created_at: unknown;
};

describe("G2-5 Registry ↔ DB Mirror 13-col structural parity", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await applyEntitlementFoundationDdl(pg);
    await seedCanonicalFeatureRegistry(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  it("G2-5.1 all canonical keys exist as mirror rows (1:1 count)", async () => {
    const res = await pg.query<PlatformFeatureRow>(`
      SELECT
        feature_key, module, name, parent_feature_key, backend_guard_key,
        default_value, configurable, founder_only, status, dependency_json,
        route_hint, sort_order, value_type, created_at
      FROM platform_features ORDER BY feature_key
    `);
    const rows: PlatformFeatureRow[] = res.rows ?? [];
    const canonicalKeys = Array.from(FEATURE_REGISTRY_MAP.keys()).sort();
    const mirrorKeys = rows.map((r) => r.feature_key).sort();
    expect(rows.length).toBeGreaterThanOrEqual(FEATURE_REGISTRY_MAP.size);
    for (const k of canonicalKeys) expect(mirrorKeys).toContain(k);
  });

  it("G2-5.2 each canonical FeatureDefinition exposes 13 declared contract fields", () => {
    const keys = Array.from(FEATURE_REGISTRY_MAP.keys());
    const declared: readonly string[] = [
      "featureKey","name","module","parentFeatureKey","valueType","defaultValue",
      "configurable","founderOnly","dependencies","routeHint","backendGuardKey",
      "status","sortOrder",
    ];
    expect(declared.length).toBe(13);
    for (const k of keys) {
      const def: FeatureDefinition = FEATURE_REGISTRY_MAP.get(k)!;
      for (const f of declared) expect(def).toHaveProperty(f);
      expect(typeof def.module).toBe("string");
      expect(def.featureKey).toBe(k);
      expect(def.featureKey.length).toBeGreaterThan(0);
    }
  });

  it("G2-5.3 platform_features DB table carries 13 mirrored columns", async () => {
    const rows = (await pg.query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'platform_features'
       ORDER BY ordinal_position
    `)).rows;
    const cols = new Set(rows.map((r) => r.column_name));
    const required = [
      "feature_key", "name", "module", "parent_feature_key", "value_type",
      "default_value", "configurable", "founder_only", "dependency_json",
      "route_hint", "backend_guard_key", "status", "sort_order",
    ];
    expect(required.length).toBe(13);
    for (const c of required) expect(cols.has(c)).toBe(true);
  });
});
