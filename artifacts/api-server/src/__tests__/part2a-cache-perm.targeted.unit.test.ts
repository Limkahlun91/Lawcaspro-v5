import { describe, expect, it, vi } from "vitest";

import {
  resolveUserFeatureAccessBulk,
  resolveUserFeatureAccess,
  resolveRequestPermissionChecker,
  invalidateUserFeatureCacheFor,
} from "../services/user-feature-access.js";

// ---------------------------------------------------------------------------
// Mock resolveEntitlementsBulk — we only test user-feature-access.ts internals
// (entitlements resolver has its own suite). This is the SAME pattern used by
// part1e-security-correctness.targeted.test.ts.
// ---------------------------------------------------------------------------
type EntitlementBulkResult = Record<string, { enabled: boolean; denialReason?: string }>;
const mockResolveEntitlementsBulk = vi.fn() as unknown as {
  mockImplementation: (
    impl: (firmId: number, keys: readonly string[], opts?: unknown) => Promise<EntitlementBulkResult>,
  ) => void;
  mockClear: () => void;
};
vi.mock("../services/entitlement-resolver.js", () => {
  const fn = async (firmId: number, keys: readonly string[], opts?: unknown): Promise<EntitlementBulkResult> => {
    const impl = (mockResolveEntitlementsBulk as any).getMockImplementation?.();
    if (typeof impl === "function") return impl(firmId, keys, opts);
    return {};
  };
  return { resolveEntitlementsBulk: fn };
});

// ---------------------------------------------------------------------------
// Shared test builder. Builds:
//   (a) entitlements record mock (via re-dispatch)
//   (b) drizzle `r` with `select()` that returns requested userRows for
//       loadUserRowsBulk SELECT matching {featureKey, isEnabled}
//   (c) r.execute for resolveRequestPermissionChecker's permissions SELECT
// ---------------------------------------------------------------------------
function buildFixture(opts: {
  firmId: number;
  userId: number;
  roleId: number | null;
  /** requestedFeatureKey -> enabled */
  entitlements: Record<string, boolean>;
  /** explicit user overrides */
  userRows?: Array<{ featureKey: string; isEnabled: boolean }>;
  /** permission rows for resolveRequestPermissionChecker's SELECT query */
  permissionRows?: Array<{ role_id: number; module: string; action: string; allowed: boolean }>;
  /** if true: entitlements for keys NOT in `entitlements` map are LEFT OUT
   *  (triggering resolver's "parentFirmEnabled check returns false for missing keys") */
  omitUnregistered?: boolean;
  /** if true: do NOT call invalidateUserFeatureCacheFor on construction (used
   *  when a single test makes multiple sequential resolver calls and wants cache
   *  to persist between them). Default: false → invalidate on construction. */
  skipInvalidate?: boolean;
}) {
  if (!opts.skipInvalidate) {
    invalidateUserFeatureCacheFor(opts.firmId, opts.userId);
  }
  const userRows = opts.userRows ?? [];
  const permissionRows = opts.permissionRows ?? [];

  mockResolveEntitlementsBulk.mockImplementation(
    async (_firmId: number, keys: readonly string[]) => {
      const out: EntitlementBulkResult = {};
      // Include every key declared in opts.entitlements — parent keys must also
      // be resolvable even if they aren't in the direct request set because
      // parentFirmEnabled() walks up the parent chain outside the requested key set.
      const union = new Set<string>([...keys, ...Object.keys(opts.entitlements)]);
      for (const k of union) {
        if (k in opts.entitlements) {
          out[k] = {
            enabled: opts.entitlements[k],
            denialReason: opts.entitlements[k] ? undefined : "entitlement_off_fixture",
          };
        } else if (!opts.omitUnregistered) {
          out[k] = { enabled: false, denialReason: "not_in_entitlements_fixture" };
        }
      }
      return out;
    },
  );

  let selectCalls = 0; // tracks user_feature_overrides table SELECTs
  let permExecuteCalls = 0; // tracks permissions execute()s

  const r: any = {
    select: (_sel: any) => ({
      from: (_tbl: any) => ({
        where: async (_cond: any): Promise<Array<{ featureKey: string; isEnabled: boolean }>> => {
          selectCalls += 1;
          return userRows.map((u) => ({ featureKey: u.featureKey, isEnabled: u.isEnabled }));
        },
      }),
    }),
    execute: async (_ast: any, _params?: any[]) => {
      permExecuteCalls += 1;
      // Don't try to regex-match drizzle sql tagged-template serialization — it may be a
      // structured object. The fixture's execute only has one semantic consumer:
      // resolveRequestPermissionChecker → the permissions SELECT. If the caller
      // provides permissionRows, simulate that query result.
      return { rows: permissionRows };
    },
    transaction: async (fn: (tx: any) => Promise<unknown>) => await fn(r),
  };

  return {
    r,
    getSelectCalls: () => selectCalls,
    getPermExecuteCalls: () => permExecuteCalls,
  };
}

// =========================================================================
// PART 2A §0A — CACHE runtime tests A-E
// =========================================================================

describe("PART 2A §0A CACHE-A — first request key A only, explicit A=true", () => {
  it("DB queried once for A; result source=user_row_true effective=true", async () => {
    const FIRM = 100, USER = 1, ROLE = 5;
    const { r, getSelectCalls } = buildFixture({
      firmId: FIRM,
      userId: USER,
      roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.invoice": true },
      userRows: [{ featureKey: "accounting.invoice", isEnabled: true }],
    });
    const checker = async () => false;
    const res = await resolveUserFeatureAccessBulk({
      r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKeys: ["accounting.invoice"], permissionChecker: checker,
    });
    expect(getSelectCalls()).toBe(1);
    expect(res["accounting.invoice"].source).toBe("user_row_true");
    expect(res["accounting.invoice"].effectiveEnabled).toBe(true);
  });
});

describe("PART 2A §0A CACHE-B — 2nd request new key B after A cached, DB MUST query B", () => {
  it("after key A cached, request {A,B} => DB SELECT called 1 more time (for missing B only), A still user_row_true from cache", async () => {
    const FIRM = 101, USER = 2, ROLE = 6;

    // --- Step 1: cache accounting.invoice = true ---
    {
      const { r, getSelectCalls } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        entitlements: {
          "module.accounting": true,
          "accounting.invoice": true,
          "accounting.quotation": true,
        },
        userRows: [{ featureKey: "accounting.invoice", isEnabled: true }],
      });
      const res = await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.invoice"], permissionChecker: async () => false,
      });
      expect(getSelectCalls()).toBe(1);
      expect(res["accounting.invoice"].source).toBe("user_row_true");
    }

    // --- Step 2: request invoice + quotation with explicit quotation=true in DB ---
    {
      const { r, getSelectCalls } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        skipInvalidate: true, // KEEP step1 cache for invoice
        entitlements: {
          "module.accounting": true,
          "accounting.invoice": true,
          "accounting.quotation": true,
        },
        // Only return the B row (since it's the one NOT cached — invoice is already cached)
        userRows: [{ featureKey: "accounting.quotation", isEnabled: true }],
      });
      const res = await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.invoice", "accounting.quotation"],
        permissionChecker: async () => false,
      });
      // With the fix: cache exists for invoice so it's read from cache; quotation
      // missing → 1 DB SELECT for quotation only.
      expect(getSelectCalls()).toBe(1);
      expect(res["accounting.invoice"].source).toBe("user_row_true"); // preserved from cache
      expect(res["accounting.quotation"].source).toBe("user_row_true"); // fresh DB
      expect(res["accounting.quotation"].effectiveEnabled).toBe(true);
    }
  });
});

describe("PART 2A §0A CACHE-C — B=false explicit in DB => source=user_row_false (NEVER role fallback allow)", () => {
  it("after A cached; request B with explicit B=false → source=user_row_false USER_OVERRIDE_OFF even when role fallback checker returns true", async () => {
    const FIRM = 102, USER = 3, ROLE = 7;

    // Step 1: cache invoice=true
    {
      const { r } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        entitlements: {
          "module.accounting": true,
          "accounting.invoice": true,
          "accounting.quotation": true,
        },
        userRows: [{ featureKey: "accounting.invoice", isEnabled: true }],
      });
      await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.invoice"],
        permissionChecker: async () => true, // role fallback ALLOWS everything
      });
    }

    // Step 2: request quotation with explicit FALSE row.
    // The permissionChecker STILL returns TRUE (role fallback would allow).
    // MUST be overridden by explicit FALSE row.
    {
      const { r } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        skipInvalidate: true, // KEEP step1 cache
        entitlements: {
          "module.accounting": true,
          "accounting.invoice": true,
          "accounting.quotation": true,
        },
        userRows: [{ featureKey: "accounting.quotation", isEnabled: false }],
      });
      const res = await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.quotation"],
        permissionChecker: async () => true, // role fallback ALLOWS — must be ignored
      });
      expect(res["accounting.quotation"].source).toBe("user_row_false");
      expect(res["accounting.quotation"].effectiveEnabled).toBe(false);
      expect(res["accounting.quotation"].denialCode).toBe("USER_OVERRIDE_OFF");
    }
  });
});

describe("PART 2A §0A CACHE-D — confirmed no-row sentinel cached, later request avoids DB SELECT", () => {
  it("request B when NO explicit row → DB select 1. Second request B → 0 selects (sentinel cache hit)", async () => {
    const FIRM = 103, USER = 4, ROLE = 8;
    const entitlementSet = {
      "module.accounting": true,
      "accounting.quotation": true,
    };

    // --- Call 1: no user row for accounting.quotation ---
    {
      const { r, getSelectCalls } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        entitlements: entitlementSet,
        userRows: [], // NO explicit rows
      });
      await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.quotation"],
        permissionChecker: async () => true,
      });
      expect(getSelectCalls()).toBe(1);
    }

    // --- Call 2: same key, no user row → NO select ---
    {
      const { r, getSelectCalls } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        skipInvalidate: true, // KEEP step1 sentinel cache
        entitlements: entitlementSet,
        userRows: [],
      });
      await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.quotation"],
        permissionChecker: async () => true,
      });
      expect(getSelectCalls()).toBe(0); // sentinel hit → NO DB
    }
  });
});

describe("PART 2A §0A CACHE-E — cache invalidation forces fresh DB lookup", () => {
  it("after cache populated, call invalidate → next request MUST re-query DB", async () => {
    const FIRM = 104, USER = 5, ROLE = 9;

    // Step 1: populate cache
    {
      const { r, getSelectCalls } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        entitlements: { "module.accounting": true, "accounting.quotation": true },
        userRows: [{ featureKey: "accounting.quotation", isEnabled: true }],
      });
      const res = await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.quotation"], permissionChecker: async () => false,
      });
      expect(getSelectCalls()).toBe(1);
      expect(res["accounting.quotation"].source).toBe("user_row_true");
    }

    invalidateUserFeatureCacheFor(FIRM, USER);

    // Step 2: same key → DB MUST be called again
    {
      const { r, getSelectCalls } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        entitlements: { "module.accounting": true, "accounting.quotation": true },
        userRows: [{ featureKey: "accounting.quotation", isEnabled: true }],
      });
      await resolveUserFeatureAccessBulk({
        r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKeys: ["accounting.quotation"], permissionChecker: async () => false,
      });
      expect(getSelectCalls()).toBe(1);
    }
  });
});

// =========================================================================
// PART 2A §0B — PERMISSION checker runtime tests A-F
// =========================================================================

describe("PART 2A §0B PERM-A — non-Partner, no override, role perm=true => allow", () => {
  it("shared permissionChecker module:action hit → source=role_permission_allow effective=true", async () => {
    const FIRM = 200, USER = 1, ROLE = 10;
    // Registry accounting.dashboard has no backendGuardKey → heuristic:
    //   mod=accounting, action=dashboard.  Provide that exact pair.
    const permRows = [
      { role_id: ROLE, module: "accounting", action: "dashboard", allowed: true },
    ];
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.dashboard": true },
      permissionRows: permRows,
      userRows: [], // no explicit user override
    });
    const sharedChecker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    // Direct checker sanity — proves the checker was wired correctly:
    expect(await sharedChecker("accounting", "dashboard")).toBe(true);
    // Now use a FRESH fixture `r2` (doesn't need perm rows since checker is in-mem)
    const { r: r2 } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.dashboard": true },
    });
    const res = await resolveUserFeatureAccessBulk({
      r: r2, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKeys: ["accounting.dashboard"], permissionChecker: sharedChecker,
    });
    // Diagnostic: if direct sharedChecker passed but result still denies, then
    // moduleActionFor(featureKey) produced a DIFFERENT (mod,act) — catch it:
    expect(await sharedChecker("accounting", "dashboard"),
      `sharedChecker(accounting,dashboard) must return true; got denied means registry heuristic differs`).toBe(true);
    expect(res["accounting.dashboard"].source).toBe("role_permission_allow");
    expect(res["accounting.dashboard"].effectiveEnabled).toBe(true);
  });
});

describe("PART 2A §0B PERM-B — non-Partner, no override, role perm=false => ROLE_DENIED", () => {
  it("shared checker NO permissions → source=role_permission_denied denialCode=ROLE_DENIED", async () => {
    const FIRM = 201, USER = 2, ROLE = 11;
    // Empty permission rows → deny-all checker
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": true },
      permissionRows: [],
    });
    const sharedChecker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const { r: r2 } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": true },
    });
    const res = await resolveUserFeatureAccessBulk({
      r: r2, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKeys: ["accounting.quotation"], permissionChecker: sharedChecker,
    });
    expect(res["accounting.quotation"].source).toBe("role_permission_denied");
    expect(res["accounting.quotation"].effectiveEnabled).toBe(false);
    expect(res["accounting.quotation"].denialCode).toBe("ROLE_DENIED");
  });
});

describe("PART 2A §0B PERM-C — Partner + firm entitlement ON => partner_allow", () => {
  it("roleName=Partner ent=ON, no permissions rows → source=partner_allow (bypasses RBAC)", async () => {
    const FIRM = 202, USER = 3, ROLE = 12;
    // Empty permission rows (but Partner bypasses)
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": true },
      permissionRows: [],
    });
    const sharedChecker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const { r: r2 } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": true },
    });
    const res = await resolveUserFeatureAccessBulk({
      r: r2, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "PARTNER",
      featureKeys: ["accounting.quotation"], permissionChecker: sharedChecker,
    });
    expect(res["accounting.quotation"].source).toBe("partner_allow");
    expect(res["accounting.quotation"].effectiveEnabled).toBe(true);
  });
});

describe("PART 2A §0B PERM-D — Partner + firm entitlement OFF => firm_entitlement_denied", () => {
  it("Partner CANNOT bypass when firm entitlement OFF (permission checker allow ignored)", async () => {
    const FIRM = 203, USER = 4, ROLE = 13;
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": false },
      permissionRows: [{ role_id: ROLE, module: "accounting", action: "read", allowed: true }],
    });
    const sharedChecker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const { r: r2 } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": false },
    });
    const res = await resolveUserFeatureAccessBulk({
      r: r2, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "PARTNER",
      featureKeys: ["accounting.quotation"], permissionChecker: sharedChecker,
    });
    expect(res["accounting.quotation"].source).toBe("firm_entitlement_denied");
    expect(res["accounting.quotation"].effectiveEnabled).toBe(false);
  });
});

describe("PART 2A §0B PERM-E — explicit user false => deny even if role perm=true", () => {
  it("user override enabled=false beats role_permission=true → source=user_row_false USER_OVERRIDE_OFF", async () => {
    const FIRM = 204, USER = 5, ROLE = 14;
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": true },
      permissionRows: [{ role_id: ROLE, module: "accounting", action: "read", allowed: true }],
    });
    const sharedChecker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    // Now same user but explicit accounting.quotation = FALSE override
    const { r: r2 } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.quotation": true },
      userRows: [{ featureKey: "accounting.quotation", isEnabled: false }],
    });
    const res = await resolveUserFeatureAccessBulk({
      r: r2, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKeys: ["accounting.quotation"], permissionChecker: sharedChecker,
    });
    expect(res["accounting.quotation"].source).toBe("user_row_false");
    expect(res["accounting.quotation"].effectiveEnabled).toBe(false);
    expect(res["accounting.quotation"].denialCode).toBe("USER_OVERRIDE_OFF");
  });
});

describe("PART 2A §0B PERM-F — middleware vs _self effective parity (same checker → same answers)", () => {
  it("resolveUserFeatureAccess(single-key, middleware) and resolveUserFeatureAccessBulk (multi-key, _self) using SAME shared permissionChecker produce matching results for each key", async () => {
    const FIRM = 205, USER = 6, ROLE = 15;
    invalidateUserFeatureCacheFor(FIRM, USER);
    const entitlements = {
      "module.accounting": true,
      "accounting.quotation": true,
      "accounting.invoice": true,
      "accounting.dashboard": true,
      "accounting.payment_voucher": true,
    };
    const permRows = [
      // Provide BOTH the heuristic actions AND backendGuardKey actions so
      // the fixture is stable across registry backendGuardKey drift:
      //   accounting.dashboard → dashboard (heuristic)
      //   accounting.quotation → quotation (heuristic)
      //   accounting.invoice   → read (backendGuardKey="accounting:read")
      //   accounting.payment_voucher → create = denied below
      { role_id: ROLE, module: "accounting", action: "read", allowed: true },
      { role_id: ROLE, module: "accounting", action: "dashboard", allowed: true },
      { role_id: ROLE, module: "accounting", action: "quotation", allowed: true },
      { role_id: ROLE, module: "accounting", action: "payment_voucher", allowed: false },
    ];
    const keys = [
      "accounting.quotation",
      "accounting.invoice",
      "accounting.dashboard",
      "accounting.payment_voucher",
    ];
    // Builder the shared checker ONCE — must be used for BOTH paths.
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements,
      permissionRows: permRows,
    });
    const sharedChecker = await resolveRequestPermissionChecker(r, FIRM, ROLE);

    // --- PATH 1: _self endpoint — resolveUserFeatureAccessBulk with N keys ---
    const { r: rSelf } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements,
      userRows: [
        // One explicit FALSE on a key where role would allow — proves explicit > role.
        { featureKey: "accounting.invoice", isEnabled: false },
      ],
    });
    invalidateUserFeatureCacheFor(FIRM, USER);
    const bulk = await resolveUserFeatureAccessBulk({
      r: rSelf, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKeys: keys, permissionChecker: sharedChecker,
    });

    // --- PATH 2: middleware path — call resolveUserFeatureAccess per key with the SAME checker ---
    const single: Record<string, any> = {};
    for (const k of keys) {
      const { r: rMid } = buildFixture({
        firmId: FIRM, userId: USER, roleId: ROLE,
        entitlements,
        userRows: [{ featureKey: "accounting.invoice", isEnabled: false }],
      });
      // invalidate before each single call so each populates cache fresh
      invalidateUserFeatureCacheFor(FIRM, USER);
      single[k] = await resolveUserFeatureAccess({
        r: rMid, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
        featureKey: k, permissionChecker: sharedChecker,
      });
    }

    // --- ASSERT PARITY ---
    for (const k of keys) {
      expect(single[k].effectiveEnabled, `[${k}] enabled parity`).toBe(bulk[k].effectiveEnabled);
      expect(single[k].source, `[${k}] source parity`).toBe(bulk[k].source);
      if (bulk[k].denialCode) {
        expect(single[k].denialCode, `[${k}] denialCode parity`).toBe(bulk[k].denialCode);
      }
    }
    // Specific sanity checks on the test fixture contents:
    expect(bulk["accounting.invoice"].source).toBe("user_row_false");
    expect(bulk["accounting.dashboard"].source).toBe("role_permission_allow");
  });
});

// =========================================================================
// PART 2B-1 §1 FIRM-PERM — same-firm permission resolver runtime tests
// =========================================================================

describe("PART 2B-1 §1 FIRM-PERM-A — correct firm + role + allowed permission => allow", () => {
  it("resolveRequestPermissionChecker(r, FIRM, ROLE) loads rows when firm matches role", async () => {
    const FIRM = 300, USER = 1, ROLE = 20;
    const permRows = [
      { role_id: ROLE, module: "accounting", action: "read", allowed: true },
      { role_id: ROLE, module: "accounting", action: "write", allowed: true },
    ];
    const { r, getPermExecuteCalls } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.invoice": true },
      permissionRows: permRows,
    });
    const checker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    expect(getPermExecuteCalls()).toBe(1);
    expect(await checker("accounting", "read")).toBe(true);
    expect(await checker("accounting", "write")).toBe(true);
    expect(await checker("accounting", "approve")).toBe(false);
  });
});

describe("PART 2B-1 §1 FIRM-PERM-B — same roleId but role belongs to DIFFERENT firm => DENY", () => {
  it("permission load when firmId mismatches the firm that owns the role => empty perm cache => deny", async () => {
    const RIGHT_FIRM = 301, WRONG_FIRM = 999, USER = 2, ROLE = 21;
    // Simulate: the role with id=ROLE belongs only to RIGHT_FIRM=301.
    // When caller passes WRONG_FIRM=999 (different firm), the JOIN roles ON
    // roles.id = p.role_id WHERE ro.firm_id = WRONG_FIRM => 0 rows => checker denies all.
    const permRowsForRightFirmOnly: Array<{ role_id: number; module: string; action: string; allowed: boolean }> = [];
    const { r } = buildFixture({
      firmId: WRONG_FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.invoice": true },
      permissionRows: permRowsForRightFirmOnly,
    });
    const checker = await resolveRequestPermissionChecker(r, WRONG_FIRM, ROLE);
    expect(await checker("accounting", "read")).toBe(false);
    expect(await checker("accounting", "write")).toBe(false);
    // Also: resolveUserFeatureAccess for a role_permission-required key uses empty checker => ROLE_DENIED
    const { r: r2 } = buildFixture({
      firmId: WRONG_FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.invoice": true },
    });
    const res = await resolveUserFeatureAccess({
      r: r2, firmId: WRONG_FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKey: "accounting.invoice", permissionChecker: checker,
    });
    expect(res.effectiveEnabled).toBe(false);
    expect(res.source).toBe("role_permission_denied");
  });
});

describe("PART 2B-1 §1 FIRM-PERM-C — firmId missing/invalid => safe deny RBAC", () => {
  it("firmId=null => gate clause skips SQL => empty checker => RBAC-required keys denied", async () => {
    const FIRM: null = null, USER = 3, ROLE = 22;
    const permRows = [
      { role_id: ROLE, module: "accounting", action: "read", allowed: true },
    ];
    const { r, getPermExecuteCalls } = buildFixture({
      firmId: FIRM ?? 0, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.invoice": true },
      permissionRows: permRows,
    });
    const checker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    // firmId=null => DB NOT queried (getPermExecuteCalls = 0)
    expect(getPermExecuteCalls()).toBe(0);
    // Empty checker => denies all including permission row that would have matched
    expect(await checker("accounting", "read")).toBe(false);
  });
  it("firmId=undefined => same safe deny", async () => {
    const FIRM: any = undefined, ROLE: any = 23;
    const { r, getPermExecuteCalls } = buildFixture({
      firmId: 0, userId: 4, roleId: Number(ROLE),
      entitlements: { "module.accounting": true },
      permissionRows: [{ role_id: 23, module: "accounting", action: "read", allowed: true }],
    });
    const checker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    expect(getPermExecuteCalls()).toBe(0);
    expect(await checker("accounting", "read")).toBe(false);
  });
});

describe("PART 2B-1 §1 FIRM-PERM-D — Partner role resolution still uses same-firm lookup", () => {
  it("Partner with firm entitlement ON => partner_allow (firm scope gate passed)", async () => {
    const FIRM = 304, USER = 5, ROLE = 24;
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.payment_voucher": true },
      permissionRows: [], // no RBAC rows: Partner bypasses; role_permission_denied fallback
    });
    const permChecker = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const res = await resolveUserFeatureAccess({
      r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "PARTNER",
      featureKey: "accounting.payment_voucher", permissionChecker: permChecker,
    });
    expect(res.source).toBe("partner_allow");
    expect(res.effectiveEnabled).toBe(true);
  });
});

describe("PART 2B-1 §1 FIRM-PERM-E — _self and middleware checker call identical resolveRequestPermissionChecker", () => {
  it("same firmId+roleId => identical permissionChecker outputs for 12 mod:action pairs", async () => {
    const FIRM = 305, USER = 6, ROLE = 25;
    const permRows = [
      { role_id: ROLE, module: "accounting", action: "read", allowed: true },
      { role_id: ROLE, module: "accounting", action: "write", allowed: true },
      { role_id: ROLE, module: "documents", action: "read", allowed: true },
      { role_id: ROLE, module: "cases", action: "read", allowed: true },
    ];
    const { r: rSelf } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true },
      permissionRows: permRows,
    });
    const { r: rMid } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true },
      permissionRows: permRows,
    });
    const checkerSelf = await resolveRequestPermissionChecker(rSelf, FIRM, ROLE);
    const checkerMiddleware = await resolveRequestPermissionChecker(rMid, FIRM, ROLE);
    const pairs = [
      ["accounting", "read"], ["accounting", "write"], ["accounting", "approve"], ["accounting", "review"],
      ["documents", "read"], ["documents", "update"], ["documents", "delete"],
      ["cases", "read"], ["cases", "write"], ["cases", "delete"],
      ["hr_dashboard", "read"], ["billing", "read"],
    ] as const;
    for (const [m, a] of pairs) {
      const s = await checkerSelf(m, a);
      const mid = await checkerMiddleware(m, a);
      expect(mid, `pair parity ${m}:${a}`).toBe(s);
    }
    // Sanity: known matches are true, non-matches are false
    expect(await checkerSelf("accounting", "read")).toBe(true);
    expect(await checkerSelf("accounting", "approve")).toBe(false);
  });
});
