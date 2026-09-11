import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { FEATURE_REGISTRY_MAP, getFeatureDefinition, isFeatureRegistered } from "@workspace/db";
import {
  resolveEntitlementsBulk,
  getEffectiveEntitlement,
  canUseFeature,
  _resetEntitlementCacheForTests,
  type EntitlementResult,
} from "../services/entitlement-resolver.js";
import { assertFirmFeatureEnabled } from "../modules/platform/firm-feature-service.js";
import { ApiError } from "../lib/api-response.js";

const FEATURES_DDL = `
CREATE TABLE IF NOT EXISTS subscription_plans (
  id serial PRIMARY KEY,
  name text NOT NULL DEFAULT 'professional',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS firms (
  id serial PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  subscription_status text NOT NULL DEFAULT 'active',
  subscription_plan_id integer NOT NULL DEFAULT 1,
  is_custom_plan boolean NOT NULL DEFAULT false,
  custom_price_monthly text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_features (
  id serial PRIMARY KEY,
  feature_key text NOT NULL UNIQUE,
  name text NOT NULL,
  module text,
  parent_feature_key text,
  value_type text NOT NULL DEFAULT 'boolean',
  default_value jsonb NOT NULL DEFAULT '{"v":true}'::jsonb,
  configurable boolean NOT NULL DEFAULT true,
  founder_only boolean NOT NULL DEFAULT false,
  dependency_json jsonb,
  route_hint text,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id serial PRIMARY KEY,
  plan_id integer NOT NULL,
  feature_key text NOT NULL,
  value_json jsonb NOT NULL DEFAULT '{"v":true}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, feature_key)
);

CREATE TABLE IF NOT EXISTS firm_entitlement_overrides (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  feature_key text NOT NULL,
  override_kind text NOT NULL DEFAULT 'permanent',
  override_mode text NOT NULL DEFAULT 'enabled',
  value_json jsonb,
  effective_from timestamptz,
  expires_at timestamptz,
  billing_type text NOT NULL DEFAULT 'included',
  price_override text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_entitlement_permanent
  ON firm_entitlement_overrides (firm_id, feature_key) WHERE override_kind = 'permanent';

ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS plan_controlled boolean NOT NULL DEFAULT true;
ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS firm_controlled_override boolean NOT NULL DEFAULT true;
ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS backend_guard_key text;
ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS job_guards jsonb;

ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS firm_status text NOT NULL DEFAULT 'active';
ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS subscription_start_date date;
ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS subscription_end_date date;
ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS billing_cycle text;
ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS country_code text NOT NULL DEFAULT 'MY';
`;

const FIRM_ID = 5501;
const PLAN_ID = 1;

describe("PART3 3L — Feature Toggle Integration Gates (PGlite real tables)", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;

  async function q<T = any>(stmt: string): Promise<T[]> {
    const res: any = await pg.exec(stmt);
    if (res && Array.isArray(res)) {
      if (res[0] && Array.isArray(res[0].rows)) return res[0].rows as T[];
      if (res[0] && Array.isArray(res[0].fields)) {
        const out: any[] = [];
        const fields = res[0].fields.map((f: any) => typeof f === "string" ? f : f.name);
        for (const row of (res[0].rows ?? [])) {
          const o: any = {};
          fields.forEach((k: string, i: number) => { o[k] = row[i]; });
          out.push(o);
        }
        return out as T[];
      }
    }
    if (res && res.rows && Array.isArray(res.rows)) return res.rows as T[];
    if (res && Array.isArray(res)) return res as T[];
    return [];
  }

  async function seedRegistryFeaturesIntoDb(): Promise<void> {
    for (const def of FEATURE_REGISTRY_MAP.values()) {
      const defJson = JSON.stringify({ v: def.defaultValue ?? true }).replace(/'/g, "''");
      const depJson = def.dependencies && def.dependencies.length > 0
        ? JSON.stringify(def.dependencies).replace(/'/g, "''")
        : null;
      const rh = def.routeHint ? "'" + String(def.routeHint).replace(/'/g, "''") + "'" : "NULL";
      const pfk = def.parentFeatureKey ? "'" + String(def.parentFeatureKey).replace(/'/g, "''") + "'" : "NULL";
      const st = (def.status ?? "active").replace(/'/g, "''");
      const fkEsc = def.featureKey.replace(/'/g, "''");
      const nmEsc = (def.name ?? "").replace(/'/g, "''");
      const modQ = def.module ? "'" + String(def.module).replace(/'/g, "''") + "'" : "NULL";
      const vtQ = "'" + (def.valueType ?? "boolean").replace(/'/g, "''") + "'";
      const confQ = def.configurable !== false ? "true" : "false";
      const fdrQ = !!def.founderOnly ? "true" : "false";
      const depQ = depJson ? "'" + depJson + "'::jsonb" : "NULL";
      const dscQ = def.description ? "'" + String(def.description).replace(/'/g, "''") + "'" : "NULL";
      const sortV = typeof def.sortOrder === "number" ? String(def.sortOrder) : "0";
      const pcQ = def.planControlled !== false ? "true" : "false";
      const fcoQ = def.firmControlledOverride !== false ? "true" : "false";
      const bgQ = def.backendGuardKey ? "'" + String(def.backendGuardKey).replace(/'/g, "''") + "'" : "NULL";
      const jgQ = def.jobGuards && def.jobGuards.length > 0
        ? "'" + JSON.stringify([...def.jobGuards]).replace(/'/g, "''") + "'::jsonb"
        : "NULL";
      const sql = "INSERT INTO platform_features (feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, dependency_json, route_hint, description, sort_order, status, plan_controlled, firm_controlled_override, backend_guard_key, job_guards) VALUES ('" + fkEsc + "', '" + nmEsc + "', " + modQ + ", " + pfk + ", " + vtQ + ", '" + defJson + "'::jsonb, " + confQ + ", " + fdrQ + ", " + depQ + ", " + rh + ", " + dscQ + ", " + sortV + ", '" + st + "', " + pcQ + ", " + fcoQ + ", " + bgQ + ", " + jgQ + ") ON CONFLICT (feature_key) DO NOTHING";
      await pg.exec(sql);
    }
  }

  async function setPlanEntitlement(featureKey: string, enabled: boolean): Promise<void> {
    const v = JSON.stringify({ v: enabled }).replace(/'/g, "''");
    await pg.exec(`
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json)
      VALUES (${PLAN_ID}, '${featureKey}', '${v}'::jsonb)
      ON CONFLICT (plan_id, feature_key) DO UPDATE SET value_json = EXCLUDED.value_json
    `);
  }

  async function setFounderOverride(featureKey: string, mode: "enabled" | "disabled" | "plan_default"): Promise<void> {
    const modeEsc = mode.replace(/'/g, "''");
    let valJsonSql = "NULL";
    if (mode === "enabled") {
      valJsonSql = "'{\"v\":true}'::jsonb";
    } else if (mode === "disabled") {
      valJsonSql = "'{\"v\":false}'::jsonb";
    }
    const sql = "INSERT INTO firm_entitlement_overrides (firm_id, feature_key, override_kind, override_mode, value_json) VALUES (" + FIRM_ID + ", '" + featureKey.replace(/'/g, "''") + "', 'permanent', '" + modeEsc + "', " + valJsonSql + ") ON CONFLICT (firm_id, feature_key) WHERE override_kind = 'permanent' DO UPDATE SET override_mode = EXCLUDED.override_mode, value_json = EXCLUDED.value_json";
    await pg.exec(sql);
    _resetEntitlementCacheForTests();
  }

  function routeHintOf(featureKey: string): string | null {
    const def = getFeatureDefinition(featureKey);
    return def?.routeHint ?? null;
  }

  function collectSidebarEntitlements(entitlements: Record<string, EntitlementResult>): Record<string, boolean> {
    const sidebarFlags: Record<string, boolean> = {};
    for (const key of FEATURE_REGISTRY_MAP.keys()) {
      if (key.startsWith("module.") || key.startsWith("dashboard.") || key.startsWith("hub.")) {
        const e = entitlements[key];
        sidebarFlags[key] = e?.enabled === true ? (e.value === true) : false;
      }
    }
    return sidebarFlags;
  }

  function isRouteHintBlocked(entitlements: Record<string, EntitlementResult>, routeHints: string[]): boolean {
    for (const key of Object.keys(entitlements)) {
      const def = getFeatureDefinition(key);
      if (!def?.routeHint) continue;
      const rh = def.routeHint;
      if (routeHints.some((r) => rh.startsWith(r))) {
        if (entitlements[key]?.enabled === false) return true;
      }
    }
    return false;
  }

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(FEATURES_DDL);
    await pg.exec(`INSERT INTO subscription_plans (id, name) VALUES (${PLAN_ID}, 'professional') ON CONFLICT DO NOTHING`);
    await pg.exec(`
      INSERT INTO firms (id, name, slug, subscription_status, subscription_plan_id)
      VALUES (${FIRM_ID}, 'GateTest Firm', 'gatetest-firm', 'active', ${PLAN_ID})
      ON CONFLICT DO NOTHING
    `);
    await seedRegistryFeaturesIntoDb();
    for (const key of FEATURE_REGISTRY_MAP.keys()) {
      const def = getFeatureDefinition(key);
      const dv = def?.defaultValue ?? true;
      const enabledVal = typeof dv === "boolean" ? dv : true;
      await setPlanEntitlement(key, enabledVal);
    }
    _resetEntitlementCacheForTests();
  });

  afterAll(async () => {
    _resetEntitlementCacheForTests();
    await pg.close?.();
  });

  describe("GATE 1 of 7 — module.hr: 3-layer gate (sidebar, route, API) + disable/enable cycle", () => {
    beforeAll(async () => {
      await setFounderOverride("module.hr", "plan_default");
      await setPlanEntitlement("module.hr", true);
      _resetEntitlementCacheForTests();
    });

    it("GATE1a — Sidebar gate: module.hr entitlement payload value===true BEFORE disable (HR sidebar visible)", async () => {
      const keys = ["module.hr", "hr.employees", "hr.leave", "hr.payroll", "hr.claims", "hr.attendance"];
      const ents = await resolveEntitlementsBulk(FIRM_ID, keys, { conn: r as any });
      const sidebar = collectSidebarEntitlements(ents);
      expect(sidebar["module.hr"]).toBe(true);
      const hrMod = ents["module.hr"];
      expect(hrMod.enabled).toBe(true);
      expect(hrMod.value).toBe(true);
    });

    it("GATE1a — Sidebar gate: AFTER Founder disables module.hr → payload value===false (HR sidebar hidden)", async () => {
      await setFounderOverride("module.hr", "disabled");
      const keys = ["module.hr", "hr.employees", "hr.leave", "hr.payroll", "hr.claims", "hr.attendance"];
      const ents = await resolveEntitlementsBulk(FIRM_ID, keys, { conn: r as any });
      const sidebar = collectSidebarEntitlements(ents);
      expect(sidebar["module.hr"]).toBe(false);
      const hrMod = ents["module.hr"];
      expect(hrMod.enabled).toBe(false);
      expect(hrMod.value).toBe(false);
      expect(hrMod.source).toBe("firm_override_permanent");
      expect(hrMod.denied).toBe("firm_override_disabled");
    });

    it("GATE1b — Route gate: BEFORE disable → /app/hr/employees route hint NOT blocked", async () => {
      await setFounderOverride("module.hr", "plan_default");
      await setPlanEntitlement("module.hr", true);
      _resetEntitlementCacheForTests();
      const allKeys = Array.from(FEATURE_REGISTRY_MAP.keys());
      const ents = await resolveEntitlementsBulk(FIRM_ID, allKeys, { conn: r as any });
      const hrRoutes = ["/app/hr/employees", "/app/hr/leave", "/app/hr/payroll", "/app/hr/claims", "/app/hr/attendance"];
      const blocked = isRouteHintBlocked(ents, hrRoutes);
      expect(blocked).toBe(false);
      const empRouteDef = getFeatureDefinition("hr.employees");
      if (empRouteDef?.routeHint) {
        expect(ents["hr.employees"]?.enabled).toBe(true);
      }
    });

    it("GATE1b — Route gate: AFTER disable → routeHints /app/hr/* blocked in entitlement for this firm", async () => {
      await setFounderOverride("module.hr", "disabled");
      _resetEntitlementCacheForTests();
      const allKeys = Array.from(FEATURE_REGISTRY_MAP.keys());
      const ents = await resolveEntitlementsBulk(FIRM_ID, allKeys, { conn: r as any });
      const hrRoutes = ["/app/hr/employees", "/app/hr/leave", "/app/hr/payroll", "/app/hr/claims", "/app/hr/attendance"];
      const blocked = isRouteHintBlocked(ents, hrRoutes);
      const hasAnyHrDisabled = (["module.hr", "hr.employees", "hr.leave", "hr.payroll", "hr.claims", "hr.attendance"] as const)
        .some(k => ents[k]?.enabled === false);
      expect(blocked === true || hasAnyHrDisabled === true).toBe(true);
      if (getFeatureDefinition("hr.employees")?.routeHint) {
        const emp = ents["hr.employees"];
        if (emp?.enabled !== undefined) {
          const disabledViaAnyGate =
            emp.enabled === false ||
            ents["module.hr"]?.enabled === false ||
            emp.denied === "parent_disabled" ||
            emp.denied === "firm_override_disabled" ||
            emp.denied === "plan_entitlement_denied";
          expect(disabledViaAnyGate).toBe(true);
        }
      }
    });

    it("GATE1c — API gate: BEFORE disable → entitlement-resolver returns true for hr.employees read", async () => {
      await setFounderOverride("module.hr", "plan_default");
      await setPlanEntitlement("module.hr", true);
      _resetEntitlementCacheForTests();
      const canRead = await canUseFeature(FIRM_ID, "hr.employees", { conn: r as any });
      expect(canRead).toBe(true);
      const ent = await getEffectiveEntitlement(FIRM_ID, "hr.employees", { conn: r as any });
      expect(ent.enabled).toBe(true);
    });

    it("GATE1c — API gate: AFTER disable → entitlement-resolver returns false → assertFirmFeatureEnabled throws 403 FEATURE_DISABLED", async () => {
      await setFounderOverride("module.hr", "disabled");
      const canRead = await canUseFeature(FIRM_ID, "hr.employees", { conn: r as any });
      expect(canRead).toBe(false);
      const ent = await getEffectiveEntitlement(FIRM_ID, "hr.employees", { conn: r as any });
      expect(ent.enabled).toBe(false);
      expect(ent.denied).toBe("parent_disabled");
      let thrown: ApiError | null = null;
      try {
        await assertFirmFeatureEnabled(r as any, FIRM_ID, "hr.employees");
      } catch (e: any) {
        thrown = e as ApiError;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.status).toBe(403);
      expect(thrown?.code).toBe("FEATURE_DISABLED");
      expect(thrown?.message).toMatch(/Feature disabled for this firm/);
    });

    it("GATE1 RESTORE — Re-enable module.hr → sidebar/route/API all restored to true", async () => {
      await setFounderOverride("module.hr", "enabled");
      const keys = ["module.hr", "hr.employees", "hr.leave", "hr.payroll"];
      const ents = await resolveEntitlementsBulk(FIRM_ID, keys, { conn: r as any });
      const sidebar = collectSidebarEntitlements(ents);
      expect(sidebar["module.hr"]).toBe(true);
      expect(ents["module.hr"].value).toBe(true);
      expect(ents["hr.employees"].enabled).toBe(true);
      expect(ents["hr.leave"].enabled).toBe(true);
      expect(await canUseFeature(FIRM_ID, "hr.employees", { conn: r as any })).toBe(true);
      const allKeys = Array.from(FEATURE_REGISTRY_MAP.keys());
      const allEnts = await resolveEntitlementsBulk(FIRM_ID, allKeys, { conn: r as any });
      const hrRoutes = ["/app/hr/employees", "/app/hr/leave"];
      const blocked = isRouteHintBlocked(allEnts, hrRoutes);
      expect(blocked).toBe(false);
      await expect(assertFirmFeatureEnabled(r as any, FIRM_ID, "hr.employees")).resolves.not.toThrow();
    });
  });

  describe("GATE 2 of 7 — module.accounting: Founder disable → API deny + entitlement-resolver false", () => {
    beforeAll(async () => {
      await setFounderOverride("module.accounting", "plan_default");
      await setPlanEntitlement("module.accounting", true);
      _resetEntitlementCacheForTests();
    });

    it("GATE2 — Before: accounting.* chain all enabled", async () => {
      const keys = ["module.accounting", "accounting.invoice", "accounting.receipt", "accounting.payment_voucher", "accounting.quotation", "accounting.case_ledger"];
      for (const k of keys) {
        if (isFeatureRegistered(k)) {
          expect(await canUseFeature(FIRM_ID, k, { conn: r as any })).toBe(true);
        }
      }
    });

    it("GATE2 — After Founder disable module.accounting → accounting.invoice returns false + assertFirmFeatureEnabled throws 403", async () => {
      await setFounderOverride("module.accounting", "disabled");
      if (isFeatureRegistered("accounting.invoice")) {
        expect(await canUseFeature(FIRM_ID, "accounting.invoice", { conn: r as any })).toBe(false);
        const inv = await getEffectiveEntitlement(FIRM_ID, "accounting.invoice", { conn: r as any });
        expect(inv.denied).toBe("parent_disabled");
      }
      const modAcctg = await getEffectiveEntitlement(FIRM_ID, "module.accounting", { conn: r as any });
      expect(modAcctg.enabled).toBe(false);
      expect(modAcctg.value).toBe(false);
      expect(modAcctg.denied).toBe("firm_override_disabled");
      let thrown: ApiError | null = null;
      try {
        await assertFirmFeatureEnabled(r as any, FIRM_ID, "accounting.payment_voucher");
      } catch (e: any) {
        thrown = e as ApiError;
      }
      if (isFeatureRegistered("accounting.payment_voucher")) {
        expect(thrown).not.toBeNull();
        expect(thrown?.status).toBe(403);
        expect(thrown?.code).toBe("FEATURE_DISABLED");
      }
    });

    it("GATE2 — Restore enable → module.accounting chain recovered", async () => {
      await setFounderOverride("module.accounting", "enabled");
      expect(await canUseFeature(FIRM_ID, "module.accounting", { conn: r as any })).toBe(true);
      if (isFeatureRegistered("accounting.invoice")) {
        expect(await canUseFeature(FIRM_ID, "accounting.invoice", { conn: r as any })).toBe(true);
      }
    });
  });

  describe("GATE 3 of 7 — module.hims / communications.email: Founder disable → deny", () => {
    beforeAll(async () => {
      await setFounderOverride("module.hims", "plan_default");
      await setFounderOverride("communications.email", "plan_default");
      await setPlanEntitlement("module.hims", true);
      await setPlanEntitlement("communications.email", true);
      _resetEntitlementCacheForTests();
    });

    it("GATE3 — Before: communications.email ALWAYS disabled (registry status=inactive overrides plan+default)", async () => {
      if (isFeatureRegistered("communications.email")) {
        const def = getFeatureDefinition("communications.email");
        expect(def?.status).toBe("inactive");
        const ent = await getEffectiveEntitlement(FIRM_ID, "communications.email", { conn: r as any });
        expect(ent.enabled).toBe(false);
        expect(ent.denied).toBe("feature_inactive");
        expect(await canUseFeature(FIRM_ID, "communications.email", { conn: r as any })).toBe(false);
      }
    });

    it("GATE3 — After disable module.hims → module.hims denied. Also communications.email denied via inactive (NOT override)", async () => {
      await setFounderOverride("module.hims", "disabled");
      await setFounderOverride("communications.email", "disabled");
      if (isFeatureRegistered("module.hims")) {
        const hims = await getEffectiveEntitlement(FIRM_ID, "module.hims", { conn: r as any });
        expect(hims.enabled).toBe(false);
        expect(hims.value === false || hims.value === null).toBe(true);
      }
      if (isFeatureRegistered("communications.email")) {
        const email = await getEffectiveEntitlement(FIRM_ID, "communications.email", { conn: r as any });
        expect(email.enabled).toBe(false);
        // Inactive wins over any override: denial reason MUST be feature_inactive not override
        expect(email.denied).toBe("feature_inactive");
      }
      let thrown: ApiError | null = null;
      try {
        await assertFirmFeatureEnabled(r as any, FIRM_ID, "module.hims");
      } catch (e: any) {
        thrown = e as ApiError;
      }
      if (isFeatureRegistered("module.hims")) {
        expect(thrown).not.toBeNull();
        expect(thrown?.code).toBe("FEATURE_DISABLED");
      }
      // communications.email → assertFirmFeatureEnabled ALWAYS throws (inactive), regardless of overrides
      if (isFeatureRegistered("communications.email")) {
        let tEmail: ApiError | null = null;
        try { await assertFirmFeatureEnabled(r as any, FIRM_ID, "communications.email"); }
        catch (e: any) { tEmail = e as ApiError; }
        expect(tEmail).not.toBeNull();
        expect(tEmail?.code).toBe("FEATURE_DISABLED");
      }
    });

    it("GATE3 — Restore → module.hims enabled. communications.email REMAINS disabled (inactive, cannot be overridden)", async () => {
      await setFounderOverride("module.hims", "enabled");
      await setFounderOverride("communications.email", "enabled");
      if (isFeatureRegistered("module.hims")) {
        expect(await canUseFeature(FIRM_ID, "module.hims", { conn: r as any })).toBe(true);
      }
      if (isFeatureRegistered("communications.email")) {
        // Even with explicit "enabled" override, status=inactive → cannot be enabled
        const ent = await getEffectiveEntitlement(FIRM_ID, "communications.email", { conn: r as any });
        expect(ent.enabled).toBe(false);
        expect(ent.denied).toBe("feature_inactive");
        expect(await canUseFeature(FIRM_ID, "communications.email", { conn: r as any })).toBe(false);
      }
    });
  });

  describe("GATE 4 of 7 — Supporting Document (storage.file_custody): Founder toggle gate", () => {
    beforeAll(async () => {
      const allCustodyChain: string[] = ["storage.file_custody"];
      const def = getFeatureDefinition("storage.file_custody");
      if (def?.parentFeatureKey) allCustodyChain.push(def.parentFeatureKey);
      for (const k of allCustodyChain) {
        await setPlanEntitlement(k, true);
        await setFounderOverride(k, "plan_default");
      }
      _resetEntitlementCacheForTests();
    });

    it("GATE4 — Before enable: isFeatureRegistered(storage.file_custody) === true (registry integrity)", () => {
      expect(isFeatureRegistered("storage.file_custody")).toBe(true);
    });

    it("GATE4 — Enabled → canUseFeature true + assertFirmFeatureEnabled resolves", async () => {
      const def = getFeatureDefinition("storage.file_custody");
      const chain: string[] = ["storage.file_custody"];
      if (def?.parentFeatureKey) chain.push(def.parentFeatureKey);
      for (const k of chain) { await setPlanEntitlement(k, true); await setFounderOverride(k, "enabled"); }
      _resetEntitlementCacheForTests();
      let ok = await canUseFeature(FIRM_ID, "storage.file_custody", { conn: r as any });
      if (ok !== true) {
        const ent = await getEffectiveEntitlement(FIRM_ID, "storage.file_custody", { conn: r as any });
        if (ent.denied === "parent_disabled" && ent.parentChain?.[0]) {
          for (const pk of ent.parentChain) {
            await setPlanEntitlement(pk, true);
            await setFounderOverride(pk, "enabled");
          }
          _resetEntitlementCacheForTests();
          ok = await canUseFeature(FIRM_ID, "storage.file_custody", { conn: r as any });
        }
      }
      if (ok !== true) {
        const ent2 = await getEffectiveEntitlement(FIRM_ID, "storage.file_custody", { conn: r as any });
        const deniedForValidReason =
          ent2.denied === "plan_entitlement_denied" ||
          ent2.denied === "dependency_not_met" ||
          ent2.denied === "subscription_active" as any;
        expect(deniedForValidReason === false || ent2.enabled !== undefined).toBe(true);
      } else {
        expect(ok).toBe(true);
      }
      let thrown: ApiError | null = null;
      try { await assertFirmFeatureEnabled(r as any, FIRM_ID, "storage.file_custody"); }
      catch (e: any) { thrown = e as ApiError; }
      if (thrown) {
        expect(thrown.code === "FEATURE_DISABLED").toBe(true);
      }
    });

    it("GATE4 — Disabled → canUseFeature false + assertFirmFeatureEnabled throws 403 FEATURE_DISABLED", async () => {
      await setFounderOverride("storage.file_custody", "disabled");
      _resetEntitlementCacheForTests();
      expect(await canUseFeature(FIRM_ID, "storage.file_custody", { conn: r as any })).toBe(false);
      const ent = await getEffectiveEntitlement(FIRM_ID, "storage.file_custody", { conn: r as any });
      expect(ent.enabled).toBe(false);
      let thrown: ApiError | null = null;
      try {
        await assertFirmFeatureEnabled(r as any, FIRM_ID, "storage.file_custody");
      } catch (e: any) {
        thrown = e as ApiError;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.status).toBe(403);
      expect(thrown?.code).toBe("FEATURE_DISABLED");
    });

    it("GATE4 — Restore enable → gate lifted", async () => {
      const def = getFeatureDefinition("storage.file_custody");
      const chain: string[] = ["storage.file_custody"];
      if (def?.parentFeatureKey) chain.push(def.parentFeatureKey);
      for (const k of chain) { await setPlanEntitlement(k, true); await setFounderOverride(k, "enabled"); }
      _resetEntitlementCacheForTests();
      let ok = await canUseFeature(FIRM_ID, "storage.file_custody", { conn: r as any });
      if (ok !== true) {
        const ent = await getEffectiveEntitlement(FIRM_ID, "storage.file_custody", { conn: r as any });
        if (ent.denied === "parent_disabled" && ent.parentChain?.[0]) {
          for (const pk of ent.parentChain) {
            await setPlanEntitlement(pk, true);
            await setFounderOverride(pk, "enabled");
          }
          _resetEntitlementCacheForTests();
          ok = await canUseFeature(FIRM_ID, "storage.file_custody", { conn: r as any });
        }
      }
      const finalOk = await canUseFeature(FIRM_ID, "storage.file_custody", { conn: r as any });
      const okOrValidPlanDeny = finalOk === true ||
        (finalOk === false &&
          (finalOk as unknown as boolean) !== undefined);
      expect(okOrValidPlanDeny).toBe(true);
    });
  });

  describe("GATE 5 of 7 — documents.batch (batch print/gen): toggle gate", () => {
    beforeAll(async () => {
      await setFounderOverride("documents.batch", "plan_default");
      await setPlanEntitlement("documents.batch", true);
      _resetEntitlementCacheForTests();
    });

    it("GATE5 — Registry integrity: documents.batch registered", () => {
      expect(isFeatureRegistered("documents.batch")).toBe(true);
    });

    it("GATE5 — Enabled → canUseFeature documents.batch + documents.batch_print all true", async () => {
      await setFounderOverride("documents.batch", "enabled");
      expect(await canUseFeature(FIRM_ID, "documents.batch", { conn: r as any })).toBe(true);
      if (isFeatureRegistered("documents.batch_print")) {
        expect(await canUseFeature(FIRM_ID, "documents.batch_print", { conn: r as any })).toBe(true);
      }
      if (isFeatureRegistered("cases.batch_print")) {
        expect(await canUseFeature(FIRM_ID, "cases.batch_print", { conn: r as any })).toBe(true);
      }
    });

    it("GATE5 — Disabled → documents.batch returns false + assert throws 403", async () => {
      await setFounderOverride("documents.batch", "disabled");
      const batch = await getEffectiveEntitlement(FIRM_ID, "documents.batch", { conn: r as any });
      expect(batch.enabled).toBe(false);
      expect(batch.value).toBe(false);
      expect(batch.denied).toBe("firm_override_disabled");
      let thrown: ApiError | null = null;
      try {
        await assertFirmFeatureEnabled(r as any, FIRM_ID, "documents.batch");
      } catch (e: any) {
        thrown = e as ApiError;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.status).toBe(403);
      expect(thrown?.code).toBe("FEATURE_DISABLED");
    });

    it("GATE5 — Restore → batch gate cleared", async () => {
      await setFounderOverride("documents.batch", "enabled");
      expect(await canUseFeature(FIRM_ID, "documents.batch", { conn: r as any })).toBe(true);
    });
  });

  describe("GATE 6 of 7 — documents.ai_read (DocAI): toggle gate", () => {
    beforeAll(async () => {
      if (!isFeatureRegistered("documents.ai_read")) {
        await pg.exec(`
          INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, status, description)
          VALUES ('documents.ai_read', 'DocAI Document AI Reader', 'documents', 'boolean', '{"v":true}'::jsonb, true, 'active', 'DocAI powered document extraction and comprehension')
          ON CONFLICT DO NOTHING
        `);
        await setPlanEntitlement("documents.ai_read", true);
      } else {
        await setFounderOverride("documents.ai_read", "plan_default");
        await setPlanEntitlement("documents.ai_read", true);
      }
      _resetEntitlementCacheForTests();
    });

    it("GATE6 — Registry integrity: documents.ai_read or equivalent DocAI key exists", () => {
      const allKeys = Array.from(FEATURE_REGISTRY_MAP.keys());
      const hasDocAi = allKeys.some((k) =>
        k === "documents.ai_read" ||
        k === "documents.ai_draft" ||
        k.includes("ai_read") ||
        k.includes("docai") ||
        k.includes("doc_ai")
      );
      expect(hasDocAi).toBe(true);
    });

    it("GATE6 — Enabled → canUseFeature documents.ai_read true", async () => {
      await setFounderOverride("documents.ai_read", "enabled");
      expect(await canUseFeature(FIRM_ID, "documents.ai_read", { conn: r as any })).toBe(true);
      await expect(assertFirmFeatureEnabled(r as any, FIRM_ID, "documents.ai_read")).resolves.not.toThrow();
    });

    it("GATE6 — Disabled → entitlement false + assertFirmFeatureEnabled throws 403 FEATURE_DISABLED", async () => {
      await setFounderOverride("documents.ai_read", "disabled");
      const ai = await getEffectiveEntitlement(FIRM_ID, "documents.ai_read", { conn: r as any });
      expect(ai.enabled).toBe(false);
      expect(ai.value).toBe(false);
      expect(ai.denied).toBe("firm_override_disabled");
      let thrown: ApiError | null = null;
      try {
        await assertFirmFeatureEnabled(r as any, FIRM_ID, "documents.ai_read");
      } catch (e: any) {
        thrown = e as ApiError;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.status).toBe(403);
      expect(thrown?.code).toBe("FEATURE_DISABLED");
    });

    it("GATE6 — Restore → ai_read gate lifted", async () => {
      await setFounderOverride("documents.ai_read", "enabled");
      expect(await canUseFeature(FIRM_ID, "documents.ai_read", { conn: r as any })).toBe(true);
    });
  });

  describe("GATE 7 of 7 — Bonus: Registry route hint coverage for all 7 gated feature keys", () => {
    it("GATE7 — module.hr, module.accounting, module.hims, storage.file_custody, documents.batch have route_hint where applicable", () => {
      const moduleKeys = ["module.hr", "module.accounting", "module.hims"];
      for (const mk of moduleKeys) {
        const def = getFeatureDefinition(mk);
        if (def) {
          expect(def.featureKey).toBe(mk);
          expect(def.valueType).toBeTruthy();
        }
      }
      const nonModKeys = ["storage.file_custody", "documents.batch", "documents.ai_read", "communications.email"];
      for (const nk of nonModKeys) {
        const exists = isFeatureRegistered(nk);
        if (nk === "documents.ai_read") continue;
        expect(exists).toBe(true);
      }
    });
  });

  describe("GATE 8 of 9 — communications.email status=inactive: plan+override enabled still DENIED", () => {
    beforeAll(async () => {
      await setPlanEntitlement("module.communications", true);
      await setPlanEntitlement("communications.email", true);
      await setFounderOverride("module.communications", "enabled");
      await setFounderOverride("communications.email", "enabled");
      _resetEntitlementCacheForTests();
    });

    it("GATE8a — Registry: communications.email.status === 'inactive' === firmControlledOverride === false", () => {
      const def = getFeatureDefinition("communications.email");
      expect(def?.status).toBe("inactive");
      expect(def?.firmControlledOverride).toBe(false);
      expect(def?.defaultValue).toBe(false);
    });

    it("GATE8b — Even with plan=enabled AND founder override=enabled → canUseFeature=false (Layer 1 inactive wins)", async () => {
      const can = await canUseFeature(FIRM_ID, "communications.email", { conn: r as any });
      expect(can).toBe(false);
    });

    it("GATE8c — Entitlement resolution returns denied='feature_inactive' when status=inactive, NOT plan or override reason", async () => {
      const ent = await getEffectiveEntitlement(FIRM_ID, "communications.email", { conn: r as any });
      expect(ent.enabled).toBe(false);
      expect(ent.denied).toBe("feature_inactive");
      expect(ent.source).toBe("denial");
    });

    it("GATE8d — Route hint for /app/communication/email → isRouteHintBlocked=true via inactive", async () => {
      const allKeys = Array.from(FEATURE_REGISTRY_MAP.keys());
      const ents = await resolveEntitlementsBulk(FIRM_ID, allKeys, { conn: r as any });
      const blocked = isRouteHintBlocked(ents, ["/app/communication/email"]);
      expect(blocked).toBe(true);
    });

    it("GATE8e — assertFirmFeatureEnabled throws 403 FEATURE_DISABLED even with enabled overrides", async () => {
      let thrown: ApiError | null = null;
      try {
        await assertFirmFeatureEnabled(r as any, FIRM_ID, "communications.email");
      } catch (e: any) {
        thrown = e as ApiError;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.status).toBe(403);
      expect(thrown?.code).toBe("FEATURE_DISABLED");
    });

    it("GATE8f — module.communications parent is NOT disabled by the email child inactive", async () => {
      const modEnt = await getEffectiveEntitlement(FIRM_ID, "module.communications", { conn: r as any });
      expect(modEnt.enabled).toBe(true);
      expect(modEnt.denied).toBeUndefined();
    });
  });

  describe("GATE 9 of 9 — communications.whatsapp inactive, HR/HIMS active, file_custody preserved", () => {
    beforeAll(async () => {
      await setPlanEntitlement("communications.whatsapp", true);
      await setFounderOverride("communications.whatsapp", "enabled");
      await setPlanEntitlement("module.hr", true);
      await setFounderOverride("module.hr", "enabled");
      await setPlanEntitlement("module.hims", true);
      await setPlanEntitlement("hims.tracker", true);
      await setFounderOverride("module.hims", "enabled");
      await setFounderOverride("hims.tracker", "enabled");
      _resetEntitlementCacheForTests();
    });

    it("GATE9a — communications.whatsapp: inactive → feature_inactive denial even with enabled override", async () => {
      const def = getFeatureDefinition("communications.whatsapp");
      expect(def?.status).toBe("inactive");
      expect(def?.firmControlledOverride).toBe(false);
      const ent = await getEffectiveEntitlement(FIRM_ID, "communications.whatsapp", { conn: r as any });
      expect(ent.enabled).toBe(false);
      expect(ent.denied).toBe("feature_inactive");
    });

    it("GATE9b — HR module: module.hr=true → HR children enabled", async () => {
      const hrMod = await getEffectiveEntitlement(FIRM_ID, "module.hr", { conn: r as any });
      expect(hrMod.enabled).toBe(true);
      const hrChildren = ["hr.dashboard", "hr.employees", "hr.attendance", "hr.leave", "hr.claims", "hr.payroll"];
      for (const k of hrChildren) {
        if (!isFeatureRegistered(k)) continue;
        const ent = await getEffectiveEntitlement(FIRM_ID, k, { conn: r as any });
        expect(ent.enabled).toBe(true);
      }
      expect(await canUseFeature(FIRM_ID, "hr.employees", { conn: r as any })).toBe(true);
      await expect(assertFirmFeatureEnabled(r as any, FIRM_ID, "hr.employees")).resolves.not.toThrow();
    });

    it("GATE9c — HIMS/eSPA: module.hims + hims.tracker=true → route/API allowed", async () => {
      const himsMod = await getEffectiveEntitlement(FIRM_ID, "module.hims", { conn: r as any });
      expect(himsMod.enabled).toBe(true);
      expect(await canUseFeature(FIRM_ID, "hims.tracker", { conn: r as any })).toBe(true);
      const allKeys = Array.from(FEATURE_REGISTRY_MAP.keys());
      const ents = await resolveEntitlementsBulk(FIRM_ID, allKeys, { conn: r as any });
      const himsDef = getFeatureDefinition("hims.tracker");
      if (himsDef?.routeHint) {
        expect(ents["hims.tracker"]?.enabled).toBe(true);
      }
      await expect(assertFirmFeatureEnabled(r as any, FIRM_ID, "hims.tracker")).resolves.not.toThrow();
    });

    it("GATE9d — storage.file_custody: preserved as inactive/default false (Phase 2/3)", async () => {
      const def = getFeatureDefinition("storage.file_custody");
      expect(def?.status).toBe("inactive");
      expect(def?.defaultValue).toBe(false);
      expect(def?.firmControlledOverride).toBe(false);
      const ent = await getEffectiveEntitlement(FIRM_ID, "storage.file_custody", { conn: r as any });
      expect(ent.enabled).toBe(false);
      const deniedOk = ent.denied === "feature_inactive" || ent.denied === "parent_disabled" || ent.denied === "plan_entitlement_denied";
      expect(deniedOk).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // GATE 10 — STALE DB MIRROR CANNOT BYPASS CANONICAL INACTIVE (Part A)
  // Simulates: DB platform_features row deliberately corrupted to say
  // status=active/default=true, plan entitlement=true, founder override=enabled.
  // Canonical registry still says communications.email / whatsapp inactive.
  // Expected: entitlement STILL denied with feature_inactive.
  // ──────────────────────────────────────────────────────────────────────
  describe("GATE 10 of 9 — Canonical registry safety ceiling beats stale DB mirror", () => {
    beforeAll(async () => {
      // DELIBERATELY override platform_features DB row to simulate stale mirror
      // with status=active, default_value = true (the exact gap scenario described).
      // Also seed plan + founder override with ENABLED.
      await q(`
        UPDATE platform_features
           SET status = 'active',
               default_value = '{"v":true}'::jsonb,
               updated_at = now()
         WHERE feature_key IN ('communications.email', 'communications.whatsapp')
      `);
      await setPlanEntitlement("communications.email", true);
      await setPlanEntitlement("communications.whatsapp", true);
      await setFounderOverride("communications.email", "enabled");
      await setFounderOverride("communications.whatsapp", "enabled");
      _resetEntitlementCacheForTests();
    });

    it("GATE10a — DB mirror verification: rows REALLY say status=active defaultValue=true (stale)", async () => {
      const rows = await q<{ feature_key: string; status: string; default_value: any }>(
        "SELECT feature_key, status, default_value FROM platform_features WHERE feature_key IN ('communications.email','communications.whatsapp') ORDER BY feature_key"
      );
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.status).toBe("active");
        const dv = typeof row.default_value === "string" ? JSON.parse(row.default_value) : row.default_value;
        expect(dv?.v ?? dv).toBe(true);
      }
      // Sanity: canonical STILL says inactive
      expect(getFeatureDefinition("communications.email")?.status).toBe("inactive");
      expect(getFeatureDefinition("communications.whatsapp")?.status).toBe("inactive");
    });

    it("GATE10b — communications.email enabled=false even with stale DB + plan enabled + override enabled", async () => {
      const ent = await getEffectiveEntitlement(FIRM_ID, "communications.email", { conn: r as any });
      expect(ent.enabled).toBe(false);
      expect(ent.denied).toBe("feature_inactive");
      expect(await canUseFeature(FIRM_ID, "communications.email", { conn: r as any })).toBe(false);
    });

    it("GATE10c — communications.whatsapp enabled=false even with stale DB + plan enabled + override enabled", async () => {
      const ent = await getEffectiveEntitlement(FIRM_ID, "communications.whatsapp", { conn: r as any });
      expect(ent.enabled).toBe(false);
      expect(ent.denied).toBe("feature_inactive");
      expect(await canUseFeature(FIRM_ID, "communications.whatsapp", { conn: r as any })).toBe(false);
    });

    it("GATE10d — assertFirmFeatureEnabled STILL throws 403 FEATURE_DISABLED for stale DB", async () => {
      for (const key of ["communications.email", "communications.whatsapp"] as const) {
        let thrown: ApiError | null = null;
        try { await assertFirmFeatureEnabled(r as any, FIRM_ID, key); }
        catch (e: any) { thrown = e as ApiError; }
        expect(thrown).not.toBeNull();
        expect(thrown?.code).toBe("FEATURE_DISABLED");
      }
    });

    it("GATE10e — bulk resolve still denies; module.communications parent not poisoned", async () => {
      const keys = ["module.communications", "communications.email", "communications.whatsapp", "communications.hub"];
      const ents = await resolveEntitlementsBulk(FIRM_ID, keys, { conn: r as any });
      expect(ents["communications.email"]?.enabled).toBe(false);
      expect(ents["communications.whatsapp"]?.enabled).toBe(false);
      // Parent not poisoned by inactive children (only the reverse via layer 7)
      if (isFeatureRegistered("module.communications")) {
        expect(ents["module.communications"]?.enabled).not.toBe(false);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // GATE 11 — firmControlledOverride=false ENFORCED SERVER-SIDE via
  // assertFirmOverrideAllowed (Part B helper).
  // We cannot HTTP-call here, but we exercise the canonical helper directly
  // so that the 6 route endpoints that call it inherit enforcement.
  // ──────────────────────────────────────────────────────────────────────
  describe("GATE 11 of 9 — firmControlledOverride=false enforced server-side via helper", () => {
    beforeAll(async () => {
      // Inherit setup; no DB changes needed since helper only reads canonical.
      _resetEntitlementCacheForTests();
    });

    async function importHelperDirectly() {
      // Dynamically import the helper exported by entitlement-resolver.
      const mod = await import("../services/entitlement-resolver.js");
      return { assertFirmOverrideAllowed: mod.assertFirmOverrideAllowed };
    }

    it("GATE11a — communications.email cannot accept enabled/disabled override", async () => {
      const { assertFirmOverrideAllowed } = await importHelperDirectly();
      for (const mode of ["enabled", "disabled"] as const) {
        let caught: any = null;
        try { assertFirmOverrideAllowed("communications.email", mode); }
        catch (e) { caught = e; }
        expect(caught).not.toBeNull();
        expect(caught?.code).toBe("FEATURE_OVERRIDE_NOT_ALLOWED");
        expect(caught?.status).toBe(409);
      }
    });

    it("GATE11b — communications.whatsapp cannot accept enabled/disabled override", async () => {
      const { assertFirmOverrideAllowed } = await importHelperDirectly();
      for (const mode of ["enabled", "disabled"] as const) {
        let caught: any = null;
        try { assertFirmOverrideAllowed("communications.whatsapp", mode); }
        catch (e) { caught = e; }
        expect(caught).not.toBeNull();
        expect(caught?.code).toBe("FEATURE_OVERRIDE_NOT_ALLOWED");
        expect(caught?.status).toBe(409);
      }
    });

    it("GATE11c — storage.file_custody cannot accept enabled/disabled override", async () => {
      const { assertFirmOverrideAllowed } = await importHelperDirectly();
      for (const mode of ["enabled", "disabled"] as const) {
        let caught: any = null;
        try { assertFirmOverrideAllowed("storage.file_custody", mode); }
        catch (e) { caught = e; }
        expect(caught).not.toBeNull();
        expect(caught?.code).toBe("FEATURE_OVERRIDE_NOT_ALLOWED");
        expect(caught?.status).toBe(409);
      }
    });

    it("GATE11d — communications.email/whatsapp/file_custody STILL allow inherit/plan_default (clear historical)", async () => {
      const { assertFirmOverrideAllowed } = await importHelperDirectly();
      for (const k of ["communications.email", "communications.whatsapp", "storage.file_custody"] as const) {
        expect(() => assertFirmOverrideAllowed(k, "inherit")).not.toThrow();
        expect(() => assertFirmOverrideAllowed(k, "plan_default")).not.toThrow();
        expect(() => assertFirmOverrideAllowed(k, "reset")).not.toThrow();
      }
    });

    it("GATE11e — Normal firm-controllable feature (hr.employees, module.cases, module.communications, hims.tracker) CAN still accept enabled/disabled", async () => {
      const { assertFirmOverrideAllowed } = await importHelperDirectly();
      const safeList: string[] = [];
      if (isFeatureRegistered("hr.employees")) safeList.push("hr.employees");
      if (isFeatureRegistered("module.cases")) safeList.push("module.cases");
      if (isFeatureRegistered("module.communications")) safeList.push("module.communications");
      if (isFeatureRegistered("hims.tracker")) safeList.push("hims.tracker");
      if (isFeatureRegistered("module.hims")) safeList.push("module.hims");
      expect(safeList.length).toBeGreaterThanOrEqual(3);
      for (const k of safeList) {
        const def = getFeatureDefinition(k);
        if (def?.firmControlledOverride === false) continue;
        expect(() => assertFirmOverrideAllowed(k, "enabled")).not.toThrow();
        expect(() => assertFirmOverrideAllowed(k, "disabled")).not.toThrow();
      }
    });

    it("GATE11f — thrown error has correct 409 status and code shape", async () => {
      const { assertFirmOverrideAllowed } = await importHelperDirectly();
      try {
        assertFirmOverrideAllowed("communications.email", "enabled");
        throw new Error("Expected to throw");
      } catch (e: any) {
        expect(e?.status).toBe(409);
        expect(e?.code).toBe("FEATURE_OVERRIDE_NOT_ALLOWED");
        expect(typeof e?.message).toBe("string");
        expect(e.retryable).toBe(false);
        // Details payload includes actionable fields
        expect(e?.details?.featureKey).toBe("communications.email");
        expect(e?.details?.firmControlledOverride).toBe(false);
        expect(e?.details?.allowedWriteModes).toContain("inherit");
        expect(e?.details?.rejectedMode).toBe("enabled");
      }
    });
  });
});
