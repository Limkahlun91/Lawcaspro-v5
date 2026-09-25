// G0.8 Partner vs Ordinary Staff — Core Feature Matrix.
//
// Locked rules per G0.5 and G0.8:
//   PARTNER: Firm ALLOW → Partner ALLOW (bypass). User explicit OFF does NOT override it.
//            Firm DENY  → Partner DENIED (Partner CANNOT override firm layer denial).
//   STAFF:   Firm ON → role permission checked, then explicit user row WINS over role.
//            Firm OFF → staff denied (firm layer wins user rows)
//
// IMPORTANT FIXTURE NOTE (matches hotfix pattern, proven 6/6 PASSING):
//   loadUserRowsBulk lives in same module as resolveUserFeatureAccessBulk → vi.mock
//   of export cannot intercept internal lexical call. We stage explicit user rows
//   via REALISTIC drizzle stub returning rows from select().from().where() promise
//   (exactly hotfix-false-parent-off-single-feature.unit.test.ts pattern L70-78).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stagedEntitlements: new Map<string, { enabled: boolean; denied: string | null; source: string }>(),
  stagedUserRows: new Map<string, boolean>(), // featureKey → isEnabled (explicit)
  roleFallback: true,
  entitlementCalls: [] as any[],
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, child: () => ({}) as any },
}));

vi.mock("../services/entitlement-resolver.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...(real ?? {}),
    resolveEntitlementsBulk: async (_f: number, keys: readonly string[]) => {
      h.entitlementCalls.push({ keys: [...keys] });
      const out: Record<string, any> = {};
      for (const k of keys) {
        const s = h.stagedEntitlements.get(k);
        if (s) out[k] = { enabled: s.enabled, denied: s.denied, source: s.source, value: null, parentFeatureKey: null, dependencies: [] };
        else out[k] = { enabled: true, denied: null, source: "plan_default", value: null, parentFeatureKey: null, dependencies: [] };
      }
      return out;
    },
  };
});

import { resolveUserFeatureAccessBulk, invalidateAllUserFeatureCachesForFirm } from "../services/user-feature-access.js";

function buildFakeDb(userRows: Map<string, boolean> | null): any {
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

const FEATURE_KEYS = ["cases.read", "cases.create", "accounting.payment_voucher", "accounting.invoice", "documents.generate", "documents.sign"] as const;

type Row = {
  label: string;
  featureKey: (typeof FEATURE_KEYS)[number];
  role: "partner" | "staff";
  firmOn: boolean;
  userExplicit?: null | boolean;
  roleFallback: boolean;
  expectedEnabled: boolean;
  expectedSource: string;
  expectedDenial?: string;
};

const ROWS: readonly Row[] = [
  ...FEATURE_KEYS.flatMap((featureKey): Row[] => [
    { label: `[${featureKey}] Staff Firm ON, user OFF explicit, role allow → USER_OVERRIDE_OFF`,
      featureKey, role: "staff", firmOn: true, userExplicit: false, roleFallback: true,
      expectedEnabled: false, expectedSource: "user_row_false", expectedDenial: "USER_OVERRIDE_OFF" },
    { label: `[${featureKey}] Staff Firm ON, user ON explicit, role denied → user_row_true wins role deny`,
      featureKey, role: "staff", firmOn: true, userExplicit: true, roleFallback: false,
      expectedEnabled: true, expectedSource: "user_row_true" },
  ]),
  ...(["cases.read", "accounting.payment_voucher", "documents.generate"] as const).flatMap((fk): Row[] => [
    { label: `[${fk}] Partner Firm ON, user OFF → Partner ALLOW (bypass explicit OFF)`,
      featureKey: fk, role: "partner", firmOn: true, userExplicit: false, roleFallback: false,
      expectedEnabled: true, expectedSource: "partner_allow" },
    { label: `[${fk}] Partner Firm ON, user ON → Partner ALLOW`,
      featureKey: fk, role: "partner", firmOn: true, userExplicit: true, roleFallback: true,
      expectedEnabled: true, expectedSource: "partner_allow" },
    { label: `[${fk}] Partner Firm OFF (plan off), user ON → Partner DENIED (Firm layer wins)`,
      featureKey: fk, role: "partner", firmOn: false, userExplicit: true, roleFallback: true,
      expectedEnabled: false, expectedSource: "firm_entitlement_denied", expectedDenial: "FIRM_ENTITLEMENT_OFF" },
    { label: `[${fk}] Partner Firm OFF (perm off), user OFF → Partner DENIED (Firm layer wins)`,
      featureKey: fk, role: "partner", firmOn: false, userExplicit: false, roleFallback: false,
      expectedEnabled: false, expectedSource: "firm_entitlement_denied", expectedDenial: "FIRM_ENTITLEMENT_OFF" },
  ]),
  ...(["cases.create", "accounting.invoice", "documents.sign"] as const).flatMap((fk): Row[] => [
    { label: `[${fk}] Staff Firm OFF, user ON explicit → FIRM_ENTITLEMENT_OFF (Firm layer wins user row)`,
      featureKey: fk, role: "staff", firmOn: false, userExplicit: true, roleFallback: true,
      expectedEnabled: false, expectedSource: "firm_entitlement_denied", expectedDenial: "FIRM_ENTITLEMENT_OFF" },
    { label: `[${fk}] Staff Firm OFF, no user row, role allow → FIRM_ENTITLEMENT_OFF (firm layer deny)`,
      featureKey: fk, role: "staff", firmOn: false, roleFallback: true,
      expectedEnabled: false, expectedSource: "firm_entitlement_denied", expectedDenial: "FIRM_ENTITLEMENT_OFF" },
  ]),
];

describe("G0.8 Partner vs Ordinary Staff — Core Feature Matrix (24 scenarios)", () => {
  beforeEach(() => {
    h.stagedEntitlements.clear();
    h.stagedUserRows.clear();
    h.roleFallback = true;
    h.entitlementCalls = [];
  });

  it.each(ROWS.map((r) => [r.label, r] as const))("%s", async (_label, r) => {
    h.stagedEntitlements.clear();
    h.stagedUserRows.clear();
    h.roleFallback = r.roleFallback;
    h.stagedEntitlements.set(r.featureKey, {
      enabled: r.firmOn,
      denied: r.firmOn ? null : "FIRM_ENTITLEMENT_OFF",
      source: r.firmOn ? "plan_default" : "firm_entitlement_denied",
    });
    if (r.userExplicit != null) h.stagedUserRows.set(r.featureKey, r.userExplicit);
    invalidateAllUserFeatureCachesForFirm(101); // kill cache between cells (prev cell userRow override contamination)

    const fakedb = buildFakeDb(h.stagedUserRows.size > 0 ? new Map(h.stagedUserRows.entries()) : null);
    const firmId = 101;
    const userId = r.role === "partner" ? 5001 : 7001;

    const result = await resolveUserFeatureAccessBulk({
      r: fakedb, firmId, userId,
      roleId: r.role === "partner" ? 2 : 3,
      roleName: r.role === "partner" ? "partner" : "associate",
      featureKeys: [r.featureKey],
      permissionChecker: async () => r.roleFallback,
    });
    const row = result[r.featureKey];
    expect(row).toBeDefined();
    expect(row.effectiveEnabled).toBe(r.expectedEnabled);
    expect(row.source).toBe(r.expectedSource);
    if (r.expectedDenial) expect(row.denialCode).toBe(r.expectedDenial);
  });
});
