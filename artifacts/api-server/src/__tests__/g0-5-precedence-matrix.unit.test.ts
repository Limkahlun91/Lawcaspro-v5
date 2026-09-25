// G0.5 Effective Result Precedence matrix.
//
// Locked precedence rules (9-layer resolver + G0.5 Important Correction Partner rule):
//   L4 Plan (base)
//   L5 Firm override PERMANENT (beats Plan)
//   L6 Firm override TEMPORARY (beats Permanent)
//   (user-level rules are evaluated ONLY AFTER Firm layer passes)
//   PARTNER BYPASS (G0.5 rule):  Firm ALLOW → Partner ALLOWED (user explicit OFF does NOT revert partner allow)
//                               Firm DENY  → Partner DENIED
//   USER_ROW (Staff only): explicit user row beats role fallback
//   ROLE_FALLBACK (Staff only): role permission allow/deny
//
// IMPORTANT FIXTURE NOTE (matches hotfix pattern):
//   loadUserRowsBulk lives in the SAME module as resolveUserFeatureAccessBulk.
//   vi.mock of module export cannot intercept internal lexical calls.
//   Therefore we mock resolveEntitlementsBulk via vi.mock, but stage
//   explicit user rows via a REALISTIC drizzle stub FAKE_DB that returns
//   staged rows from its select().from().where() chain Promise — exactly as
//   hotfix-false-parent-off-single-feature.unit.test.ts does.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  entitlementCalls: [] as Array<{ keys: string[] }>,
  stagedEntitlements: new Map<string, { enabled: boolean; denied: string | null; source: string }>(),
  stagedUserRows: new Map<string, boolean>(), // featureKey → isEnabled (explicit)
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

// Realistic drizzle stub (matches hotfix pattern L70-78).
// The internal loadUserRowsBulk calls r.select(...).from(...).where(...);
// return staged user rows from that Promise.
function buildFakeDb(userRows: Map<string, boolean> | null): any {
  return {
    select: (_cols: any) => ({
      from: (_from: any) => ({
        where: () => {
          // If user rows staged, return them as drizzle rows
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

type Cell = {
  label: string;
  planOn: boolean;
  permanentOverride: null | boolean;
  temporaryOverride: null | boolean;
  role: "partner" | "staff";
  userExplicit?: null | boolean;
  roleFallbackOk?: boolean;
  expectedEnabled: boolean;
  expectedDenialCode?: null | string;
  expectedSource?: string;
};

const MATRIX: readonly Cell[] = [
  // Staff matrix
  { label: "Staff: plan ON, no overrides, role allow → true (plan)",
    planOn: true, permanentOverride: null, temporaryOverride: null,
    role: "staff", roleFallbackOk: true, expectedEnabled: true },
  { label: "Staff: plan OFF → denied (Firm layer)",
    planOn: false, permanentOverride: null, temporaryOverride: null,
    role: "staff", roleFallbackOk: true, expectedEnabled: false, expectedDenialCode: "FIRM_ENTITLEMENT_OFF", expectedSource: "firm_entitlement_denied" },
  { label: "Staff: plan OFF, permanent ON override → allowed (Perm beats Plan)",
    planOn: false, permanentOverride: true, temporaryOverride: null,
    role: "staff", roleFallbackOk: true, expectedEnabled: true },
  { label: "Staff: plan ON, permanent OFF → denied (Perm deny wins Plan)",
    planOn: true, permanentOverride: false, temporaryOverride: null,
    role: "staff", roleFallbackOk: true, expectedEnabled: false, expectedDenialCode: "FIRM_ENTITLEMENT_OFF", expectedSource: "firm_entitlement_denied" },
  { label: "Staff: plan ON, perm ON, temp OFF → denied (Temp wins Perm)",
    planOn: true, permanentOverride: true, temporaryOverride: false,
    role: "staff", roleFallbackOk: true, expectedEnabled: false, expectedDenialCode: "FIRM_ENTITLEMENT_OFF", expectedSource: "firm_entitlement_denied" },
  { label: "Staff: plan ON, perm OFF, temp ON → allowed (Temp wins Perm deny)",
    planOn: true, permanentOverride: false, temporaryOverride: true,
    role: "staff", roleFallbackOk: true, expectedEnabled: true },
  { label: "Staff: plan ON, user explicit OFF → USER_OVERRIDE_OFF beats role allow",
    planOn: true, permanentOverride: null, temporaryOverride: null,
    role: "staff", userExplicit: false, roleFallbackOk: true,
    expectedEnabled: false, expectedDenialCode: "USER_OVERRIDE_OFF", expectedSource: "user_row_false" },
  { label: "Staff: plan ON, user ON explicit → user_row_true beats role denied",
    planOn: true, permanentOverride: null, temporaryOverride: null,
    role: "staff", userExplicit: true, roleFallbackOk: false,
    expectedEnabled: true, expectedSource: "user_row_true" },
  { label: "Staff: plan ON, no user row, role denied → ROLE_DENIED",
    planOn: true, permanentOverride: null, temporaryOverride: null,
    role: "staff", roleFallbackOk: false,
    expectedEnabled: false, expectedDenialCode: "ROLE_DENIED", expectedSource: "role_permission_denied" },
  // Partner bypass rule (G0.5 Important Correction lock)
  { label: "Partner: Firm ALLOW → Partner ALLOW (bypass; user explicit OFF does NOT override partner allow)",
    planOn: true, permanentOverride: null, temporaryOverride: null,
    role: "partner", userExplicit: false, roleFallbackOk: false,
    expectedEnabled: true, expectedDenialCode: null, expectedSource: "partner_allow" },
  { label: "Partner: Firm DENY (Perm OFF) → Partner DENIED (Partner CANNOT override Firm layer)",
    planOn: true, permanentOverride: false, temporaryOverride: null,
    role: "partner", userExplicit: true, roleFallbackOk: true,
    expectedEnabled: false, expectedDenialCode: "FIRM_ENTITLEMENT_OFF", expectedSource: "firm_entitlement_denied" },
  { label: "Partner: Plan OFF directly → Partner DENIED (firm layer denial)",
    planOn: false, permanentOverride: null, temporaryOverride: null,
    role: "partner", expectedEnabled: false, expectedDenialCode: "FIRM_ENTITLEMENT_OFF", expectedSource: "firm_entitlement_denied" },
] as const;

function stageForCell(c: Cell) {
  h.entitlementCalls = [];
  h.stagedEntitlements.clear();
  h.stagedUserRows.clear();
  const featureKey = "accounting.quotation";
  let enabled = !!c.planOn;
  let source = c.planOn ? "plan_default" : "firm_entitlement_denied";
  let denied: string | null = c.planOn ? null : "FIRM_ENTITLEMENT_OFF";
  if (c.permanentOverride !== null) {
    enabled = !!c.permanentOverride;
    source = c.permanentOverride ? "firm_override_permanent" : "firm_entitlement_denied";
    denied = c.permanentOverride ? null : "FIRM_ENTITLEMENT_OFF";
  }
  if (c.temporaryOverride !== null) {
    enabled = !!c.temporaryOverride;
    source = c.temporaryOverride ? "firm_override_temporary" : "firm_entitlement_denied";
    denied = c.temporaryOverride ? null : "FIRM_ENTITLEMENT_OFF";
  }
  h.stagedEntitlements.set(featureKey, { enabled, denied, source });
  if (c.userExplicit != null) h.stagedUserRows.set(featureKey, c.userExplicit);
}

describe("G0.5 Plan→Firm→User→Role Effective Result Precedence Matrix (12 rows + Partner bypass rule)", () => {
  beforeEach(() => { stageForCell(MATRIX[0]); }); // reset hoisted state between cells

  it.each(MATRIX.map((c) => [c.label, c] as const))("%s", async (_label, c) => {
    stageForCell(c);
    invalidateAllUserFeatureCachesForFirm(101); // kill cached userRows from prev cell
    const fakedb = buildFakeDb(h.stagedUserRows.size > 0 ? new Map(h.stagedUserRows.entries()) : null);
    const roleName = c.role === "partner" ? "partner" : "associate";
    const userId = c.role === "partner" ? 5001 : 7001;
    const result = await resolveUserFeatureAccessBulk({
      r: fakedb,
      firmId: 101,
      userId,
      roleId: c.role === "partner" ? 2 : 3,
      roleName,
      featureKeys: ["accounting.quotation"],
      permissionChecker: async (_m, _a) => (c.roleFallbackOk ?? true),
    });
    const q = result["accounting.quotation"];
    expect(q).toBeDefined();
    expect(q.effectiveEnabled).toBe(c.expectedEnabled);
    if (c.expectedDenialCode) expect(q.denialCode).toBe(c.expectedDenialCode);
    if (c.expectedSource) expect(q.source).toBe(c.expectedSource);
  });
});
