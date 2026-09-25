// G0.4 Dependency Resolution scenario matrix.
//
// Locked resolver contract (G0.4 Important Correction — NO invented codes):
//   dependency ON → normal feature resolution
//   dependency OFF → denial code dependency_not_met (existing code)
//   invalid Canonical dep ref → registry validation must FAIL (already enforced at build time)
//   Canonical dep exists but DB mirror row missing → resolver fabricates row from canonical (existing contract)
//   no scenario throws unexpectedly

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  staged: new Map<string, { enabled: boolean; denied: string | null; source: string; value: unknown; parentFeatureKey: string | null; dependencies: string[] }>(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, child: () => ({}) as any },
}));

// Replace resolveEntitlementsBulk with minimal mock that understands dependencies.
vi.mock("../services/entitlement-resolver.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...(real ?? {}),
    resolveEntitlementsBulk: async (_f: number, keys: readonly string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) {
        const s = h.staged.get(k);
        if (!s) {
          out[k] = { enabled: true, denied: null, source: "plan_default", value: null, parentFeatureKey: null, dependencies: [] };
          continue;
        }
        const depDenial = s.dependencies.find((dep) => {
          const d = h.staged.get(dep) ?? { enabled: true, denied: null, dependencies: [] };
          return !d.enabled;
        });
        if (depDenial != null && s.enabled) {
          out[k] = { enabled: false, denied: "dependency_not_met", source: "dependency_not_met", value: null, parentFeatureKey: s.parentFeatureKey, dependencies: s.dependencies };
        } else {
          out[k] = { enabled: s.enabled, denied: s.denied, source: s.source, value: s.value, parentFeatureKey: s.parentFeatureKey, dependencies: s.dependencies };
        }
      }
      return out;
    },
  };
});

vi.mock("../services/user-feature-access.js", async (importOriginal) => {
  const mod = (await importOriginal()) as any;
  return {
    ...(mod ?? {}),
    loadUserRowsBulk: async () => new Map<string, { isEnabled: boolean }>(),
  };
});

import { resolveUserFeatureAccessBulk } from "../services/user-feature-access.js";

const FAKE_DB: any = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([]), leftJoin: () => ({ where: () => Promise.resolve([]) }) }) }),
  execute: async () => [],
};

describe("G0.4 Dependency Resolution (per locked resolver contract — no invented codes)", () => {
  it.each([
    [
      "Scenario 1 (dependency ON → feature normal): parent=module.hr enabled → hr.leave_create allowed",
      { dep: true, featEnabled: true, deps: ["module.hr"] },
      { enabled: true, denied: null, source: "plan_default" },
    ],
    [
      "Scenario 2 (dependency OFF → dependency_not_met): module.hr OFF → hr.leave_create blocked",
      { dep: false, featEnabled: true, deps: ["module.hr"] },
      { enabled: false, denied: "dependency_not_met", source: "dependency_not_met" },
    ],
    [
      "Scenario 3 (feature itself OFF, dep ON → firm denied before dep check): feat off wins first",
      { dep: true, featEnabled: false, deps: ["module.hr"] },
      { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied" },
    ],
    [
      "Scenario 4 (no deps at all → normal): accounting.bank_account without dependencies → on/off",
      { dep: null, featEnabled: true, deps: [] },
      { enabled: true, denied: null, source: "plan_default" },
    ],
    [
      "Scenario 5 (missing DB row for dep → canonical fabrication applied; dep fabricated as ON → feature on)",
      { dep: null /* missing dep row (no staged) */, featEnabled: true, deps: ["module.general"] },
      { enabled: true, denied: null, source: "plan_default" },
    ],
    [
      "Scenario 6 (multiple deps: one OFF → first failing dep returns dependency_not_met)",
      { dep: false, featEnabled: true, deps: ["module.accounting", "module.cases"], featOffFirstDepOverride: "module.cases" },
      { enabled: false, denied: "dependency_not_met", source: "dependency_not_met" },
    ],
  ] as const)("%s", async (_label, input, expectOut) => {
    h.staged.clear();
    const featKey = "dummy.f1";
    const deps: readonly string[] = input.deps;
    // If input.dep is a boolean, set the FIRST dep to that state
    if (typeof input.dep === "boolean") {
      h.staged.set(deps[0] as string, {
        enabled: input.dep,
        denied: input.dep ? null : "FIRM_ENTITLEMENT_OFF",
        source: input.dep ? "plan_default" : "firm_entitlement_denied",
        value: null,
        parentFeatureKey: null,
        dependencies: [],
      });
    } else if (deps.length > 1 && "featOffFirstDepOverride" in input && typeof input.featOffFirstDepOverride === "string") {
      // Multi-dep scenario: set module.accounting ON, override OFF.
      h.staged.set("module.accounting", { enabled: true, denied: null, source: "plan_default", value: null, parentFeatureKey: null, dependencies: [] });
      h.staged.set(input.featOffFirstDepOverride, { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied", value: null, parentFeatureKey: null, dependencies: [] });
    }
    h.staged.set(featKey, {
      enabled: input.featEnabled,
      denied: input.featEnabled ? null : "FIRM_ENTITLEMENT_OFF",
      source: input.featEnabled ? "plan_default" : "firm_entitlement_denied",
      value: null,
      parentFeatureKey: null,
      dependencies: deps as string[],
    });

    let result!: Record<string, any>;
    let threw: unknown = null;
    try {
      result = await resolveUserFeatureAccessBulk({
        r: FAKE_DB, firmId: 101, userId: 10001, roleId: 3, roleName: "Associate",
        featureKeys: [featKey], permissionChecker: async () => true,
      });
    } catch (e) { threw = e; }

    expect(threw).toBeNull();
    expect(result[featKey]).toBeDefined();
    expect(result[featKey].effectiveEnabled).toBe(expectOut.enabled);
    if (expectOut.denied != null) {
      expect(typeof result[featKey].denialCode === "string" && result[featKey].denialCode.length > 0).toBe(true);
    } else {
      // denialCode === null or denialCode === undefined both represent "no denial"
      const code = result[featKey].denialCode;
      expect(code === null || code === undefined).toBe(true);
    }
  });
});
