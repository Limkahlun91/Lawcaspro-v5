import { describe, it, expect, vi } from "vitest";
import { FEATURE_REGISTRY_MAP, getFeatureDefinition, type FeatureStatus } from "@workspace/db/feature-registry";

vi.mock("../lib/logger.js", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, child: () => ({}) as any },
}));

function buildChainable(rows: () => any[]): any {
  const self: any = {
    select: () => self,
    from: () => self,
    where: () => self,
    leftJoin: () => self,
    innerJoin: () => self,
    rightJoin: () => self,
    orderBy: () => self,
    limit: () => self,
    offset: () => self,
    groupBy: () => self,
    having: () => self,
    returning: () => self,
    values: () => self,
    set: () => self,
    execute: async () => rows(),
    then: (onfulfilled: any, onrejected: any) => Promise.resolve(rows()).then(onfulfilled, onrejected),
  };
  return self;
}
let FAKE_SELECT_SHAPE = "default";
function makeRows(): any[] {
  if (FAKE_SELECT_SHAPE === "firm1001") {
    return [{ id: 1001, subscriptionStatus: "active", planId: 1, isCustomPlan: false, customPriceMonthly: null }];
  }
  return [];
}
const FAKE_DB_PROXY = buildChainable(makeRows);
const FAKE_DB = new Proxy(FAKE_DB_PROXY, {
  get(target, prop, recv) {
    if (prop === "select") {
      return (cols: any) => {
        if (cols && typeof cols === "object" && "subscriptionStatus" in cols) {
          FAKE_SELECT_SHAPE = "firm1001";
        } else {
          FAKE_SELECT_SHAPE = "default";
        }
        return buildChainable(makeRows);
      };
    }
    return Reflect.get(target, prop, recv);
  },
});

import { resolveEntitlementsBulk } from "../services/entitlement-resolver";

function findFeatureBy(predicate: (d: any) => boolean): any {
  for (const [, d] of FEATURE_REGISTRY_MAP) {
    if (predicate(d)) return d;
  }
  return undefined;
}

/**
 * Test-scoped temporary mutation of a registered feature's canonical status.
 * Resolver accesses the FeatureDefinition object by reference through getFeatureDefinition(),
 * so changing its .status is visible immediately. We snapshot the original field and RESTORE
 * it after the test (using finally-block guarantee), so this fixture never leaks outside
 * this single test scope.
 *
 * NO permanent registry change. NO production hook. NO production codes altered.
 */
function withCanonicalStatusFixture<T>(
  featureKey: string,
  overrideStatus: FeatureStatus,
  fn: () => Promise<T> | T,
): Promise<T> {
  const def = getFeatureDefinition(featureKey);
  if (!def) throw new Error(`FIXTURE_BAD: featureKey ${featureKey} not registered`);
  const originalStatus = def.status ?? "active";
  const defMutable = def as any;
  defMutable.status = overrideStatus;
  try {
    const out = fn();
    if (out && typeof (out as PromiseLike<T>).then === "function") {
      return Promise.resolve(out as PromiseLike<T>).then(
        (v) => { defMutable.status = originalStatus; return v; },
        (e) => { defMutable.status = originalStatus; throw e; },
      );
    }
    defMutable.status = originalStatus;
    return Promise.resolve(out as T);
  } catch (e) {
    defMutable.status = originalStatus;
    throw e;
  }
}

describe("G0.6 Exact Denial-Code Contract (real production resolver)", () => {
  it("Preflight: fixture registry contains inactive + founderOnly features available (structural proof)", () => {
    const inactive = findFeatureBy((d: any) => d.status === "inactive");
    const founderOnly = findFeatureBy((d: any) => !!d.founderOnly);
    expect(inactive).toBeDefined();
    expect(!!founderOnly).toBe(true);
    expect(getFeatureDefinition(inactive.featureKey)).toBeDefined();
    expect(getFeatureDefinition(founderOnly!.featureKey)).toBeDefined();
    // cases.create baseline: active, non-founderOnly, registered
    const cc = getFeatureDefinition("cases.create");
    expect(cc).toBeDefined();
    expect(cc.status ?? "active").toBe("active");
    expect(!!cc.founderOnly).toBe(false);
  });

  it("status=inactive → denied === 'feature_inactive' for BOTH Founder and non-Founder NO THROWS", async () => {
    const inactiveFeat = findFeatureBy((d: any) => d.status === "inactive" && !d.founderOnly);
    const key = inactiveFeat ? inactiveFeat.featureKey : (findFeatureBy((d: any) => d.status === "inactive")?.featureKey ?? "communications.email");
    let thrown: unknown = null;
    let founder: any = null, partner: any = null;
    try {
      [founder, partner] = await Promise.all([
        resolveEntitlementsBulk(1001, [key], { conn: FAKE_DB, actingAsFounder: true }),
        resolveEntitlementsBulk(1001, [key], { conn: FAKE_DB }),
      ]);
    } catch (e) { thrown = e; }
    expect(thrown).toBeNull();
    for (const r of [founder, partner]) {
      expect(r[key]).toBeDefined();
      expect(Boolean(r[key].enabled)).toBe(false);
      expect(String(r[key].denied)).toBe("feature_inactive");
    }
  }, 30000);

  it("status=emergency_disabled via test-scoped fixture override → denied === 'global_emergency_disabled' BOTH Founder and non-Founder. NO SKIP.", async () => {
    // Use an existing registered feature that is normally active so we can prove
    // the emergency code path triggers for ANY registered key once canonical
    // status flips to emergency_disabled.
    const FIXTURE_KEY = "cases.create";
    // Double-check baseline status is active BEFORE fixture, so the override
    // actually changes something (prevents the test vacuously passing).
    const beforeDef = getFeatureDefinition(FIXTURE_KEY)!;
    expect(beforeDef.status ?? "active").toBe("active");

    await withCanonicalStatusFixture(FIXTURE_KEY, "emergency_disabled", async () => {
      // Inside scope: fixture active — canonical status IS emergency_disabled
      const midDef = getFeatureDefinition(FIXTURE_KEY)!;
      expect(midDef.status).toBe("emergency_disabled");

      let thrown: unknown = null;
      let founder: any = null, non: any = null;
      try {
        [founder, non] = await Promise.all([
          resolveEntitlementsBulk(1001, [FIXTURE_KEY], { conn: FAKE_DB, actingAsFounder: true }),
          resolveEntitlementsBulk(1001, [FIXTURE_KEY], { conn: FAKE_DB }),
        ]);
      } catch (e) { thrown = e; }
      expect(thrown).toBeNull();
      for (const r of [founder, non]) {
        expect(Boolean(r[FIXTURE_KEY].enabled)).toBe(false);
        expect(String(r[FIXTURE_KEY].denied)).toBe("global_emergency_disabled");
      }
    });

    // after fixture: status restored to active (original)
    const afterDef = getFeatureDefinition(FIXTURE_KEY)!;
    expect(afterDef.status ?? "active").toBe("active");
  }, 30000);

  it("founderOnly=true → non-Founder: denied === 'founder_only_denied' exactly; actingAsFounder: NOT denied by this ceiling itself (passes through)", async () => {
    const founderOnlyFeat = findFeatureBy((d: any) => !!d.founderOnly && (d.status ?? "active") === "active");
    const key = founderOnlyFeat ? founderOnlyFeat.featureKey : "module.platform";
    let thrown: unknown = null;
    let founder: any = null, partner: any = null, staff: any = null;
    try {
      [founder, partner, staff] = await Promise.all([
        resolveEntitlementsBulk(1001, [key], { conn: FAKE_DB, actingAsFounder: true }),
        resolveEntitlementsBulk(1001, [key], { conn: FAKE_DB, actingAsFounder: false }),
        resolveEntitlementsBulk(1001, [key], { conn: FAKE_DB }),
      ]);
    } catch (e) { thrown = e; }
    expect(thrown).toBeNull();
    expect(founder[key]).toBeDefined();
    expect(String(founder[key].denied ?? "")).not.toBe("founder_only_denied");
    expect(founder[key].denied !== "founder_only_denied").toBe(true);
    for (const r of [partner, staff]) {
      expect(Boolean(r[key]?.enabled)).toBe(false);
      expect(String(r[key]?.denied)).toBe("founder_only_denied");
    }
  }, 30000);

  it("Negative control: Normal status=active + founderOnly=false (module.cases) → NO 3 codes in denied", async () => {
    const key = "module.cases";
    const def = getFeatureDefinition(key);
    expect(def).toBeDefined();
    expect(def.status ?? "active").toBe("active");
    expect(!!def.founderOnly).toBe(false);
    // Additional guard: verify status is really active (not accidentally left as emergency_disabled by prior test)
    expect(String(def.status ?? "active")).toBe("active");
    const res = await resolveEntitlementsBulk(1001, [key], { conn: FAKE_DB });
    expect(res[key]).toBeDefined();
    const d = String(res[key].denied);
    expect(d !== "feature_inactive" && d !== "global_emergency_disabled" && d !== "founder_only_denied").toBe(true);
  });
});
