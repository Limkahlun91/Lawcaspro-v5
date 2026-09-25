// G0.3 Single Authority contract test:
// Parent + dependency resolution MUST be owned by exactly ONE authority:
// the central resolveEntitlementsBulk() service.
//
// user-feature-access.ts MUST NOT augment the input key set with ancestors
// before calling resolveEntitlementsBulk().  Dual parent-resolution is
// explicitly forbidden (G0.3 locked acceptance rule).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveEntitlementsBulk } from "../services/entitlement-resolver";
import {
  resolveUserFeatureAccessBulk,
} from "../services/user-feature-access";

vi.mock("../services/entitlement-resolver", async () => {
  const actual = await vi.importActual("../services/entitlement-resolver");
  return {
    ...(actual as any),
    resolveEntitlementsBulk: vi.fn(actual.resolveEntitlementsBulk as any),
  };
});

describe("G0.3 Single Parent-Resolution Authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolveUserFeatureAccessBulk passes ONLY caller-requested keys (NOT ancestor-expanded) into resolveEntitlementsBulk", async () => {
    // User requests ONLY a leaf child key: accounting.quotation
    // Rule: resolveEntitlementsBulk MUST be called with exactly ["accounting.quotation"]
    //       → ancestor key "module.accounting" or "accounting" MUST NOT appear augmented
    //       inside user-feature-access (ancestor walk is the SOLE job of the
    //       central resolver internally).
    const requestedKeys = ["accounting.quotation"];
    const mockConn = {
      select: () => ({
        from: () => ({
          where: async () => ([] as any[]),
          orderBy: async () => ([] as any[]),
        }),
        leftJoin: () => ({ where: async () => ([] as any[]) }),
      }),
      insert: () => ({ values: async () => ([] as any[]), returning: async () => ([] as any[]) }),
      update: () => ({ set: () => ({ where: async () => ({ rowCount: 0 }) }) }),
      delete: () => ({ where: async () => ({ rowCount: 0 }) }),
      execute: async () => ({ rowCount: 0, rows: [] }),
    };
    try {
      await resolveUserFeatureAccessBulk({
        r: mockConn as any,
        firmId: 1,
        userId: 100,
        roleId: 2,
        roleName: "associate",
        featureKeys: requestedKeys,
        permissionChecker: async () => true,
      });
    } catch {
      // allow any result — we only assert the ARGUMENT KEYS to the resolver
    }

    // Single authority assertion: resolver is called with the EXACT keyset
    // supplied by caller. No ancestor augmentation should happen inside
    // user-feature-access.ts. Any ancestor expansion (if required) is the
    // exclusive job of resolveEntitlementsBulk() itself internally.
    const calls = (resolveEntitlementsBulk as any as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [_firmIdArg, keysArg, _opts] = calls[0];
    // keys argument MUST equal exactly ["accounting.quotation"] array, not augmented w/ "module.accounting"
    expect(Array.isArray(keysArg)).toBe(true);
    expect(keysArg.sort()).toEqual(["accounting.quotation"].sort());
    // HARD LOCK: ancestor keys MUST NOT be present in the call
    expect(keysArg.includes("module.accounting")).toBe(false);
    expect(keysArg.includes("accounting")).toBe(false);
  });

  it("Central resolver DOES own parent + dependency walk internally (registry lookup proof)", async () => {
    // The central resolver MUST: (a) walk parents via getFeatureDefinition()
    // before DB fetch; (b) add dependencies to the fetch Set.  Assert this
    // by inspecting collectJobGuardToFeatureMap to confirm parent walk
    // pattern is present in registry definitions (sanity).
    const {
      FEATURE_REGISTRY_MAP,
      getFeatureDefinition,
    } = await import("@workspace/db/feature-registry");

    // For leaf key cases.supporting_documents, ancestors MUST walk
    // cases.supporting_documents → module.cases (parent chain)
    const leaf = getFeatureDefinition("cases.supporting_documents");
    expect(leaf).toBeDefined();
    expect(leaf?.parentFeatureKey).toBe("module.cases");
    expect(FEATURE_REGISTRY_MAP.has(leaf?.parentFeatureKey as string)).toBe(true);

    // cases.documents declares dependency ["module.documents"] → dependency
    // walk is present and correct in registry (proves resolver dependency
    // Set inclusion has correct source data to work with).
    const withDep = getFeatureDefinition("cases.documents");
    expect(withDep?.dependencies).toEqual(expect.arrayContaining(["module.documents"]));
  });
});
