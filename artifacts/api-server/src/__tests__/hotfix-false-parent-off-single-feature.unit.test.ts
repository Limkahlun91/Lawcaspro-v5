import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HOTFIX REGRESSION: resolveUserFeatureAccessBulk false PARENT_OFF
// on single-child-feature lookups (e.g. ["accounting.quotation"]).
//
// Root cause: local parentFirmEnabled(k) re-walked parents from the
// entitlements map. But resolveEntitlementsBulk returns ONLY the requested
// keys in its result map — parent keys may not be present. The local
// walker saw `entitlements["module.accounting"] === undefined`, read
// `!e?.enabled` === true, and returned false -> false PARENT_OFF.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  loadUserRowsBulk: vi.fn() as any,
  entitlementCalls: [] as Array<{ keys: string[] }>,
  stagedEntitlements: null as Record<string, any> | null,
}));

// 1) Logger — stubbed so module import doesn't fail.
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => ({}) as any,
  },
}));

// 2) Entitlement resolver — stage test results via stagedEntitlements.
vi.mock("../services/entitlement-resolver.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...(real ?? {}),
    resolveEntitlementsBulk: async (
      _firmId: number,
      keys: ReadonlyArray<string>,
    ) => {
      hoisted.entitlementCalls.push({ keys: [...keys] });
      return hoisted.stagedEntitlements ?? {};
    },
  };
});

// 3) user-feature-access — stub loadUserRowsBulk (never exercised here).
vi.mock("../services/user-feature-access.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...(real ?? {}),
    loadUserRowsBulk: hoisted.loadUserRowsBulk,
  };
});

hoisted.loadUserRowsBulk.mockResolvedValue(new Map());

// 4) Real imports (must come AFTER all vi.mocks, because vi.mock hoists).
import {
  resolveUserFeatureAccessBulk,
  resolveUserFeatureAccess,
} from "../services/user-feature-access.js";

// 5) Fake drizzle DB: loadUserRowsBulk is a lexical binding in the SAME module
//    as resolveUserFeatureAccessBulk, so vi.mock on user-feature-access.js
//    cannot intercept internal calls to it. Instead, provide a plausible
//    r.select().from().where() chain that returns [] (no user rows) — since
//    these tests exercise only the firm-entitlement layer, no explicit user
//    rows should exist anyway.
const FAKE_DB: any = {
  select: (cols: any) => ({
    from: (_from: any) => ({
      where: (_w: any) => Promise.resolve([]),
      leftJoin: (_lj: any) => ({ where: (_w: any) => Promise.resolve([]) }),
    }),
  }),
  execute: async () => [],
};

function stubPermissionChecker(allow: boolean = true): any {
  return async (_m: string, _a: string) => allow;
}

describe("HF-PARENT-OFF — resolveUserFeatureAccessBulk: false PARENT_OFF hotfix", () => {
  beforeEach(() => {
    hoisted.loadUserRowsBulk.mockClear();
    hoisted.loadUserRowsBulk.mockResolvedValue(new Map());
    hoisted.entitlementCalls.length = 0;
    hoisted.stagedEntitlements = null;
  });

  // ────────────────────────────────────────────────────────────
  // TEST A  —  single-child key request, child enabled true.
  // Entitlement map returns child, NOT parent.
  // Pre-fix would return false PARENT_OFF. Post-fix must pass.
  // ────────────────────────────────────────────────────────────
  it("HF-A: ['accounting.quotation'] child enabled, no module.accounting returned -> MUST NOT produce PARENT_OFF", async () => {
    hoisted.stagedEntitlements = {
      "accounting.quotation": {
        featureKey: "accounting.quotation",
        enabled: true,
        value: true,
        valueType: "boolean",
        source: "plan_entitlement",
      },
    };
    const result = await resolveUserFeatureAccessBulk({
      r: FAKE_DB,
      firmId: 12,
      userId: 1001,
      roleId: 3,
      roleName: "partner",
      featureKeys: ["accounting.quotation"],
      permissionChecker: stubPermissionChecker(true),
    });
    expect(hoisted.entitlementCalls[0].keys).toEqual(["accounting.quotation"]);
    const q = result["accounting.quotation"];
    expect(q).toBeDefined();
    expect(q.featureKey).toBe("accounting.quotation");
    // Firm entitlement resolved as authoritative enabled:true from the child row.
    expect(q.firmEnabled).toBe(true);
    // Partner shortcut -> source: partner_allow.
    expect(q.effectiveEnabled).toBe(true);
    expect(q.source).toBe("partner_allow");
    // CRITICAL: must NOT have any denialCode; was PARENT_OFF pre-fix.
    expect(q.denialCode, "Pre-fix behavior FAILED here: returned PARENT_OFF even though child was enabled (parent absent from map, not off)").toBeUndefined();
    // Parent key must still be tracked (informational, not source of denial).
    expect(q.parentKey).toBeDefined();
  });

  it("HF-A2 (non-partner): same scenario but associate role -> still no false denial", async () => {
    hoisted.stagedEntitlements = {
      "accounting.payment_voucher": {
        featureKey: "accounting.payment_voucher",
        enabled: true,
        value: true,
        valueType: "boolean",
        source: "firm_override_permanent",
      },
    };
    const result = await resolveUserFeatureAccessBulk({
      r: FAKE_DB,
      firmId: 12,
      userId: 1002,
      roleId: 5,
      roleName: "associate",
      featureKeys: ["accounting.payment_voucher"],
      permissionChecker: stubPermissionChecker(true),
    });
    const pv = result["accounting.payment_voucher"];
    expect(pv).toBeDefined();
    expect(pv.firmEnabled).toBe(true);
    expect(pv.effectiveEnabled).toBe(true);
    expect(pv.denialCode).toBeUndefined();
    // Source must reflect fallback path, not entitlement denial.
    expect(pv.source !== "firm_entitlement_denied").toBe(true);
    expect(pv.source).toBe("role_permission_allow");
  });

  // ────────────────────────────────────────────────────────────
  // TEST B  —  resolver returns denied: "parent_disabled".
  // We must honor this and set denialCode = PARENT_OFF correctly.
  // ────────────────────────────────────────────────────────────
  it("HF-B: ['accounting.quotation'] explicitly denied=parent_disabled -> PARENT_OFF propagated", async () => {
    hoisted.stagedEntitlements = {
      "accounting.quotation": {
        featureKey: "accounting.quotation",
        enabled: false,
        value: false,
        valueType: "boolean",
        source: "denial",
        denied: "parent_disabled",
        denialReason: "Parent feature disabled: module.accounting disabled by Founder",
      },
    };
    const result = await resolveUserFeatureAccessBulk({
      r: FAKE_DB,
      firmId: 12,
      userId: 1003,
      roleId: 3,
      roleName: "partner",
      featureKeys: ["accounting.quotation"],
      permissionChecker: stubPermissionChecker(true),
    });
    const q = result["accounting.quotation"];
    expect(q).toBeDefined();
    expect(q.effectiveEnabled).toBe(false);
    expect(q.firmEnabled).toBe(false);
    expect(q.source).toBe("firm_entitlement_denied");
    expect(q.denialCode).toBe("PARENT_OFF");
    expect(q.denialReason).toContain("Parent feature disabled");
  });

  // ────────────────────────────────────────────────────────────
  // TEST C  —  ordinary plan/firm denial -> FIRM_ENTITLEMENT_OFF.
  // (Not mistaken for parent issue.)
  // ────────────────────────────────────────────────────────────
  it("HF-C: ['accounting.payment_voucher'] denied=plan_entitlement_denied -> FIRM_ENTITLEMENT_OFF (not PARENT_OFF)", async () => {
    hoisted.stagedEntitlements = {
      "accounting.payment_voucher": {
        featureKey: "accounting.payment_voucher",
        enabled: false,
        value: false,
        valueType: "boolean",
        source: "denial",
        denied: "plan_entitlement_denied",
        denialReason: "Downgraded plan: payment_vouchers are included only in Professional tier",
      },
    };
    const result = await resolveUserFeatureAccessBulk({
      r: FAKE_DB,
      firmId: 12,
      userId: 1004,
      roleId: 3,
      roleName: "partner",
      featureKeys: ["accounting.payment_voucher"],
      permissionChecker: stubPermissionChecker(true),
    });
    const pv = result["accounting.payment_voucher"];
    expect(pv).toBeDefined();
    expect(pv.effectiveEnabled).toBe(false);
    expect(pv.firmEnabled).toBe(false);
    expect(pv.source).toBe("firm_entitlement_denied");
    expect(pv.denialCode).toBe("FIRM_ENTITLEMENT_OFF");
    expect(pv.denialReason).toContain("Downgraded plan");
  });

  // ────────────────────────────────────────────────────────────
  // TEST D  —  singular resolveUserFeatureAccess forwards correctly.
  // ────────────────────────────────────────────────────────────
  it("HF-D: resolveUserFeatureAccess(single enabled child) -> no denialCode", async () => {
    hoisted.stagedEntitlements = {
      "accounting.quotation": {
        featureKey: "accounting.quotation",
        enabled: true,
        value: true,
        valueType: "boolean",
        source: "plan_entitlement",
      },
    };
    const r = await resolveUserFeatureAccess({
      r: FAKE_DB,
      firmId: 12,
      userId: 1005,
      roleId: 3,
      roleName: "partner",
      featureKey: "accounting.quotation",
    });
    expect(r.featureKey).toBe("accounting.quotation");
    expect(r.effectiveEnabled).toBe(true);
    expect(r.denialCode).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────
  // TEST E  —  singular path with parent_disabled -> PARENT_OFF.
  // ────────────────────────────────────────────────────────────
  it("HF-E: resolveUserFeatureAccess single key with parent_disabled -> PARENT_OFF", async () => {
    hoisted.stagedEntitlements = {
      "accounting.payment_voucher": {
        featureKey: "accounting.payment_voucher",
        enabled: false,
        value: false,
        valueType: "boolean",
        source: "denial",
        denied: "parent_disabled",
        denialReason: "Parent feature disabled: module.accounting",
      },
    };
    const r = await resolveUserFeatureAccess({
      r: FAKE_DB,
      firmId: 12,
      userId: 1006,
      roleId: 3,
      roleName: "partner",
      featureKey: "accounting.payment_voucher",
    });
    expect(r.effectiveEnabled).toBe(false);
    expect(r.denialCode).toBe("PARENT_OFF");
  });
});
