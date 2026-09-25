import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  resolveUserFeatureAccess,
  makeRequestScopedPermissionChecker,
} from "../services/user-feature-access.js";
import {
  firmUserFeatureAccessTable,
  permissionsTable,
  rolesTable,
} from "@workspace/db";

// ── ISOLATE STEP 4 ──────────────────────────────────────────────────────────
// Stub resolveEntitlementsBulk so firmEnabled always = true for every key,
// and unknown-feature short-circuits are bypassed. This lets this test file
// focus solely on STEP-4 permissionChecker behavior without mocking 8 tables.
// ────────────────────────────────────────────────────────────────────────────
vi.mock("../services/entitlement-resolver.js", () => ({
  resolveEntitlementsBulk: async (_firmId: number, keys: readonly string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = { enabled: true, denied: null as null, denialReason: null };
    }
    return out;
  },
  isFeatureRegistered: () => true,
  getFeatureDefinition: (k: string) => ({
    featureKey: k,
    name: k,
    module: k.split(".")[0] ?? "core",
    parentFeatureKey: null,
    valueType: "boolean",
    defaultValue: true,
    configurable: true,
    founderOnly: false,
    dependencies: [],
    routeHint: null,
    backendGuardKey: k,
    status: "active",
    sortOrder: 0,
  }),
}));

function buildMockDb(tables: {
  roles: Array<Record<string, unknown>>;
  permissions: Array<Record<string, unknown>>;
  userAccess: Array<Record<string, unknown>>;
}) {
  function buildChain(filtered: Array<Record<string, unknown>>) {
    const promise = Promise.resolve(filtered);
    return Object.assign(promise, {
      where: () => buildChain(filtered),
      limit: (_n?: number) => Promise.resolve(filtered),
    });
  }
  return {
    select: (_shape?: unknown) => ({
      from: (from: unknown) => {
        let rows: Array<Record<string, unknown>> = [];
        if ((from as any) === rolesTable) rows = tables.roles;
        else if ((from as any) === permissionsTable) rows = tables.permissions;
        else if ((from as any) === firmUserFeatureAccessTable) rows = tables.userAccess;
        return buildChain(rows);
      },
    }),
  } as unknown as Parameters<typeof resolveUserFeatureAccess>[0]["r"];
}

describe("G2-2 STEP-4 PermissionChecker injection — ROLE_DENIED vs legacy", () => {
  const firmId = 1, userId = 101, roleId = 3, roleName = "Clerk";

  it("G2-2.1 permissionChecker=false → source=role_permission_denied denialCode=ROLE_DENIED", async () => {
    const mockDb = buildMockDb({
      roles: [{ id: roleId, firm_id: firmId, name: roleName }],
      permissions: [{ roleId, module: "accounting", action: "read", allowed: false }],
      userAccess: [],
    });
    // resolveEntitlementsBulk stubbed above → firmEnabled=true
    const pcFalse = makeRequestScopedPermissionChecker({
      r: mockDb,
      firmId,
      roleId,
    });
    const result = await resolveUserFeatureAccess({
      r: mockDb,
      firmId,
      userId,
      roleId,
      roleName,
      featureKey: "accounting.invoice",
      permissionChecker: pcFalse,
    });
    expect(result.source).toBe("role_permission_denied");
    expect(result.denialCode).toBe("ROLE_DENIED");
    expect(result.effectiveEnabled).toBe(false);
  });

  it("G2-2.2 default (no explicit user row) + permissions exists → role_permission_allow", async () => {
    const mockDb = buildMockDb({
      roles: [{ id: roleId, firm_id: firmId, name: roleName }],
      permissions: [{ roleId, module: "accounting", action: "read", allowed: true }],
      userAccess: [],
    });
    const pcAllow = makeRequestScopedPermissionChecker({ r: mockDb, firmId, roleId });
    const result = await resolveUserFeatureAccess({
      r: mockDb,
      firmId,
      userId,
      roleId,
      roleName,
      featureKey: "accounting.invoice",
      permissionChecker: pcAllow,
    });
    const readAllow = await pcAllow("accounting", "read");
    expect(readAllow).toBe(true);
    expect(result.source).toBe("role_permission_allow");
    expect(result.effectiveEnabled).toBe(true);
  });
});
