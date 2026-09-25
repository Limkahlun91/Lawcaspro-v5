// G0.9 Firm A / Firm B Tenant Isolation.
//
// Locked G0.9 constraint: NO exposing private Maps for testing.
// Use OBSERVABLE BEHAVIOR ONLY:
//   (a) resolver output EQUALITY / INEQUALITY,
//   (b) real invalidateAllUserFeatureCachesForFirm prefix-sweep effect
//       observable through output equivalence pre/post (Firm B untouched),
//   (c) staged drizzle FAKE_DB promises returning rows (to exercise real
//       internal loadUserRowsBulk lexical call without breaking, matching
//       the proven hotfix pattern).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // staged entitlements per firm (drives mocked cross-module resolveEntitlementsBulk)
  firmEntitlements: new Map<number, Record<string, { enabled: boolean; denied: string | null; source: string }>>(),
  // staged user rows: key=firmId, value = Map<featureKey, isEnabled>
  userRows: new Map<number, Map<string, boolean>>(),
  entitlementCalls: [] as any[],
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, child: () => ({}) as any },
}));

// Cross-module call → vi.mock can intercept.
vi.mock("../services/entitlement-resolver.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...(real ?? {}),
    resolveEntitlementsBulk: async (firmId: number, keys: readonly string[]) => {
      h.entitlementCalls.push({ firmId, keys: [...keys] });
      const staged = h.firmEntitlements.get(firmId);
      const out: Record<string, any> = {};
      for (const k of keys) {
        if (staged && staged[k]) {
          out[k] = { ...staged[k], value: null, parentFeatureKey: null, dependencies: [] };
        } else {
          out[k] = { enabled: true, denied: null, source: "plan_default", value: null, parentFeatureKey: null, dependencies: [] };
        }
      }
      return out;
    },
  };
});

import { resolveUserFeatureAccessBulk, invalidateAllUserFeatureCachesForFirm } from "../services/user-feature-access";

// Matches hotfix pattern: buildFakeDb returns staged user rows from select().from().where()
// (internal loadUserRowsBulk lexical call in user-feature-access module is NOT interceptable
// by vi.mock because it's same-file local binding).
function buildFakeDb(firmId: number): any {
  const userRows = h.userRows.get(firmId);
  return {
    select: (_cols: any) => ({
      from: (_from: any) => ({
        where: () => {
          if (!userRows) return Promise.resolve([]);
          const out: Array<{ featureKey: string; isEnabled: boolean }> = [];
          userRows.forEach((v, k) => out.push({ featureKey: k, isEnabled: v }));
          return Promise.resolve(out);
        },
        leftJoin: (_lj: any) => ({ where: () => Promise.resolve([]) }),
      }),
    }),
    execute: async () => [],
  };
}

const FIRM_A = 9001;
const FIRM_B = 9002;
const FIRM_C = 9003;
const KEYS = ["cases.read", "cases.create", "accounting.invoice", "documents.generate"] as const;

describe("G0.9 Firm A / Firm B Tenant Isolation (observable output per G0.9 rule)", () => {
  beforeEach(() => {
    h.firmEntitlements.clear();
    h.userRows.clear();
    h.entitlementCalls = [];
    invalidateAllUserFeatureCachesForFirm(FIRM_A);
    invalidateAllUserFeatureCachesForFirm(FIRM_B);
    invalidateAllUserFeatureCachesForFirm(FIRM_C);
  });

  it("FirmA mutation/invalidation → FirmB output byte-identical pre vs post (no cross-firm data leak)", async () => {
    // Stage A: pre-state with accounting.invoice ON in FirmA, B default
    h.firmEntitlements.set(FIRM_A, {
      "cases.read": { enabled: true, denied: null, source: "plan_default" },
      "cases.create": { enabled: true, denied: null, source: "plan_default" },
      "accounting.invoice": { enabled: true, denied: null, source: "plan_default" },
      "documents.generate": { enabled: true, denied: null, source: "plan_default" },
    });

    const aPre = await resolveUserFeatureAccessBulk({
      r: buildFakeDb(FIRM_A), firmId: FIRM_A, userId: 8001, roleId: 3, roleName: "Associate",
      featureKeys: [...KEYS], permissionChecker: async () => true,
    });
    const bPre = JSON.stringify(
      await resolveUserFeatureAccessBulk({
        r: buildFakeDb(FIRM_B), firmId: FIRM_B, userId: 9001, roleId: 3, roleName: "Associate",
        featureKeys: [...KEYS], permissionChecker: async () => true,
      }),
    );
    // Sanity: pre-state A has accounting.invoice ON; B all default ON
    expect(aPre["accounting.invoice"].effectiveEnabled).toBe(true);

    // Mutate ONLY Firm A: all OFF now → invalidate ONLY FirmA caches
    h.firmEntitlements.set(FIRM_A, {
      "cases.read": { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied" },
      "cases.create": { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied" },
      "accounting.invoice": { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied" },
      "documents.generate": { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied" },
    });
    invalidateAllUserFeatureCachesForFirm(FIRM_A);

    const aPost = await resolveUserFeatureAccessBulk({
      r: buildFakeDb(FIRM_A), firmId: FIRM_A, userId: 8001, roleId: 3, roleName: "Associate",
      featureKeys: [...KEYS], permissionChecker: async () => true,
    });
    const bPost = JSON.stringify(
      await resolveUserFeatureAccessBulk({
        r: buildFakeDb(FIRM_B), firmId: FIRM_B, userId: 9001, roleId: 3, roleName: "Associate",
        featureKeys: [...KEYS], permissionChecker: async () => true,
      }),
    );

    // A changed: pre: ON → post: OFF
    for (const k of KEYS) expect(aPost[k].effectiveEnabled).toBe(false);
    expect(aPost["accounting.invoice"].effectiveEnabled).not.toBe(aPre["accounting.invoice"].effectiveEnabled);
    // STRONG: Firm B output BYTE IDENTICAL (no pollution)
    expect(bPost).toBe(bPre);
  });

  it("invalidateAllUserFeatureCachesForFirm sweeps only FirmA prefix → Firm B effective output unchanged", async () => {
    const firmBUserRows = new Map<string, boolean>();
    firmBUserRows.set("documents.generate", true); // user explicit ON (would win role deny)
    h.userRows.set(FIRM_B, firmBUserRows);

    const bPre = JSON.stringify(
      await resolveUserFeatureAccessBulk({
        r: buildFakeDb(FIRM_B), firmId: FIRM_B, userId: 9001, roleId: 3, roleName: "Associate",
        featureKeys: [...KEYS], permissionChecker: async () => false,
      }),
    );

    invalidateAllUserFeatureCachesForFirm(FIRM_A); // invalidate ONLY A

    const bPost = JSON.stringify(
      await resolveUserFeatureAccessBulk({
        r: buildFakeDb(FIRM_B), firmId: FIRM_B, userId: 9001, roleId: 3, roleName: "Associate",
        featureKeys: [...KEYS], permissionChecker: async () => false,
      }),
    );

    // STRONG: byte-identical
    expect(bPost).toBe(bPre);
  });

  it("FirmC: staging A/B never leaks data into C (output all default ON for FirmC)", async () => {
    h.firmEntitlements.set(FIRM_A, {
      "cases.read": { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied" },
    });
    h.firmEntitlements.set(FIRM_B, {
      "accounting.invoice": { enabled: false, denied: "FIRM_ENTITLEMENT_OFF", source: "firm_entitlement_denied" },
    });
    const c = await resolveUserFeatureAccessBulk({
      r: buildFakeDb(FIRM_C), firmId: FIRM_C, userId: 30001, roleId: 3, roleName: "Associate",
      featureKeys: [...KEYS], permissionChecker: async () => true,
    });
    for (const k of KEYS) expect(c[k].effectiveEnabled).toBe(true);
  });
});
