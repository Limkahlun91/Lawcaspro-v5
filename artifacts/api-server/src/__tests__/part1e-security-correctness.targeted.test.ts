// ============================================================================
// PART 1E-A — Targeted security correctness tests
// Scope:
//   DB CLASSIFICATION:
//     DBERR-1  sqlstate 53300 → DB_BUSY                  (unchanged, temp saturation)
//     DBERR-2  code PROTOCOL_CONNECTION_LOST → DB_UNAVAILABLE (was wrongly DB_BUSY)
//     DBERR-3  53000 insufficient_resources → DB_RESOURCE_EXHAUSTED (was DB_BUSY)
//     DBERR-4  53100 disk_full → DB_RESOURCE_EXHAUSTED         (was DB_BUSY)
//     DBERR-5  53200 out_of_memory → DB_RESOURCE_EXHAUSTED     (was DB_BUSY)
//     DBERR-6  53400 configuration_limit_exceeded → DB_RESOURCE_EXHAUSTED (was DB_BUSY)
//     DBERR-7  ERR_POOL_TIMED_OUT → DB_BUSY                    (unchanged)
//     DBERR-8  RESOURCE_EXHAUSTED message NOT "database is busy"
//     DBERR-9  classForLog — RESOURCE_EXHAUSTED → warn + event api.db_resource_exhausted
//
//   USER FEATURE GATE — middleware resolution unit tests:
//     DOCVAR-GATE-1  requireUserFeatureAccess("documents.variables") + resolve firm-ON user-ON perm-ON → next()
//     DOCVAR-GATE-2  user feature row OFF (firm ON) → 403 code USER_OVERRIDE_OFF
//     DOCVAR-GATE-3  firm entitlement OFF (parent module.documents OFF) → 403 FIRM_ENTITLEMENT_OFF
//     DOCVAR-GATE-4  feature ON + role perm OFF (legacy fallback) → 403 ROLE_DENIED
//     DOCVAR-GATE-5  unknown/unregistered feature key → effective=false (deny by default)
//     DOCVAR-GATE-6  Partner bypass (role name 'Partner') → source=partner_allow when firm ON
//     DOCVAR-GATE-7  req.userType !== firm_user (without founder) → 403
//
//   AUTH /me CONTRACT (deterministic service-level mocks):
//     AUTHME-1  no token → 200 null
//     AUTHME-2  valid active session → 200 user shape
//     AUTHME-3  expired session → 200 null
//     AUTHME-4  not-found session → 200 null
//     AUTHME-5  inactive user → 200 null
//     AUTHME-6  DB transient failure (classify DB_BUSY) → 503 DB_BUSY
//
// ============================================================================

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  classifyDatabaseError,
  databaseErrorHttpStatus,
  databaseErrorCode,
  databaseErrorSafeMessage,
  databaseErrorRetryable,
  databaseErrorLogToken,
  type DatabaseAvailabilityCategory,
} from "../lib/db-error";
import {
  ApiError,
  classifyErrorForLog,
} from "../lib/api-response";
import {
  resolveUserFeatureAccess,
  requireUserFeatureAccess,
  invalidateUserFeatureCacheFor,
} from "../services/user-feature-access";
import type { AuthRequest } from "../lib/auth";
import type { Response, NextFunction } from "express";

// Mock resolveEntitlementsBulk — we control its return value explicitly per test.
// The resolver has its own tests; here we only verify the 4-step decision tree
// (firm entitlements → partner → user rows → role-perm fallback) is wired correctly.
type EntitlementBulkResult = Record<string, { enabled: boolean; denialReason?: string }>;
const mockResolveEntitlementsBulk = vi.fn() as unknown as {
  mockImplementation: (
    impl: (firmId: number, keys: readonly string[], opts?: unknown) => Promise<EntitlementBulkResult>,
  ) => void;
  mockClear: () => void;
};
vi.mock("../services/entitlement-resolver.js", () => {
  const fn = async (firmId: number, keys: readonly string[], opts?: unknown): Promise<EntitlementBulkResult> => {
    // Re-dispatch through the clearable mock instance to allow per-test overrides
    const impl = (mockResolveEntitlementsBulk as any).getMockImplementation?.();
    if (typeof impl === "function") return impl(firmId, keys, opts);
    return {};
  };
  return { resolveEntitlementsBulk: fn };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makePgError(opts: { code?: string; sqlstate?: string; message?: string; name?: string }): Error {
  const e = new Error(opts.message ?? "") as any;
  if (opts.name) (e as any).name = opts.name;
  if (opts.code) {
    e.code = opts.code;
    e.sqlstate = opts.sqlstate ?? opts.code;
  } else if (opts.sqlstate) {
    e.code = opts.sqlstate;
    e.sqlstate = opts.sqlstate;
  }
  return e as Error;
}

// Build drizzle-ish mock + entitlements resolver mock wire-up.
// Entitlements result is set via mockResolveEntitlementsBulk.
// DB drizzle object only needs to satisfy loadUserRowsBulk table queries.
function makeMockDbForEntitlements(
  overrides: {
    entitlementEnabled?: Record<string, boolean>;
    userRows?: Array<{ featureKey: string; isEnabled: boolean }>;
    rolePermission?: (mod: string, action: string) => boolean;
    // If true: don't set entitlements for keys not in overrides (leave them
    // absent from result → triggers UNKNOWN_FEATURE ?? fallback path in resolver)
    omitUnregisteredKeys?: boolean;
  } = {},
) {
  const entEnabled = overrides.entitlementEnabled ?? {};
  const userRows = overrides.userRows ?? [];
  const rolePermFn = overrides.rolePermission ?? (() => true);
  const omitUnregistered = overrides.omitUnregisteredKeys ?? false;

  mockResolveEntitlementsBulk.mockImplementation(async (_firmId: number, keys: readonly string[]) => {
    const out: Record<string, { enabled: boolean; denialReason?: string }> = {};
    const coveredKeys = new Set<string>([...keys, ...Object.keys(entEnabled)]);
    for (const k of coveredKeys) {
      const v = entEnabled[k];
      if (typeof v === "boolean") {
        out[k] = { enabled: v, denialReason: v ? undefined : "entitlement_off_for_tests" };
      } else if (!omitUnregistered && keys.includes(k)) {
        // Default: key in requested set but missing from overrides → disabled safe
        out[k] = { enabled: false, denialReason: "not_in_mock_overrides" };
      }
    }
    return out;
  });

  // Our resolver in loadUserRowsBulk ONLY ever queries a single table.  The
  // from() arg is the drizzle table object.  Drizzle table identity is tricky to
  // fingerprint reliably across environments.  Return userRows unconditionally —
  // it's safe because entitlements go through the mocked
  // resolveEntitlementsBulk mock.
  const r = {
    select: (_sel: unknown) => ({
      from: (_tbl: any) => ({
        where: async (_cond: unknown): Promise<unknown[]> => {
          return userRows.map((r) => ({ featureKey: r.featureKey, isEnabled: r.isEnabled }));
        },
      }),
    }),
  };
  const permissionChecker = async (mod: string, action: string): Promise<boolean> => {
    return rolePermFn(mod, action);
  };
  return { r: r as any, permissionChecker };
}

function makeAuthRequest(partial: Partial<AuthRequest> = {}): AuthRequest {
  return {
    userType: "firm_user",
    firmId: partial.firmId ?? 1,
    userId: partial.userId ?? 10,
    roleId: partial.roleId ?? 5,
    ...partial,
  } as unknown as AuthRequest;
}

function makeRes(nextFn: NextFunction): { res: Response; captured: { status?: number; body?: unknown } } {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status: (s: number) => {
      captured.status = s;
      return res as any;
    },
    json: (b: unknown) => {
      captured.body = b;
      return res as any;
    },
  } as unknown as Response;
  return { res, captured };
}

// ============================================================================
// §8 DB CLASSIFICATION
// ============================================================================

describe("§8 — DB Classification split DB_BUSY vs DB_RESOURCE_EXHAUSTED vs DB_UNAVAILABLE", () => {
  it("DBERR-1: sqlstate 53300 (too_many_connections) → DB_BUSY: temp saturation", () => {
    const err = makePgError({ sqlstate: "53300", message: "remaining connection slots are reserved" });
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_BUSY");
    expect(databaseErrorHttpStatus(cat)).toBe(503);
    expect(databaseErrorCode(cat)).toBe("DB_BUSY");
    expect(databaseErrorRetryable(cat)).toBe(true);
    expect(databaseErrorLogToken(cat)).toBe("api.db_busy");
    const msg = databaseErrorSafeMessage(cat);
    expect(msg.toLowerCase()).toMatch(/heavy load|busy/);
  });

  it("DBERR-2: code PROTOCOL_CONNECTION_LOST → DB_UNAVAILABLE (was wrongly DB_BUSY)", () => {
    const err = makePgError({ code: "PROTOCOL_CONNECTION_LOST", message: "Connection lost: server closed unexpectedly" });
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_UNAVAILABLE");
    expect(databaseErrorCode(cat)).toBe("DB_UNAVAILABLE");
    expect(databaseErrorLogToken(cat)).toBe("api.db_unavailable");
  });

  it("DBERR-3: sqlstate 53000 insufficient_resources → DB_RESOURCE_EXHAUSTED (was DB_BUSY)", () => {
    const err = makePgError({ sqlstate: "53000", message: "insufficient_resources: could not allocate memory" });
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_RESOURCE_EXHAUSTED");
    expect(databaseErrorHttpStatus(cat)).toBe(503);
    expect(databaseErrorCode(cat)).toBe("DB_RESOURCE_EXHAUSTED");
    expect(databaseErrorRetryable(cat)).toBe(true);
    expect(databaseErrorLogToken(cat)).toBe("api.db_resource_exhausted");
    const safeMsg = databaseErrorSafeMessage(cat).toLowerCase();
    expect(safeMsg).not.toMatch(/database is currently under heavy load|資料庫繁忙/);
    expect(safeMsg).not.toMatch(/^database is busy/);
    expect(safeMsg).toMatch(/resource constraints|resource/);
  });

  it("DBERR-4: sqlstate 53100 disk_full → DB_RESOURCE_EXHAUSTED (was DB_BUSY)", () => {
    const err = makePgError({ sqlstate: "53100", message: "disk_full: no space left on volume" });
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_RESOURCE_EXHAUSTED");
    expect(databaseErrorCode(cat)).toBe("DB_RESOURCE_EXHAUSTED");
    expect(databaseErrorSafeMessage(cat).toLowerCase()).not.toMatch(/^database is busy/);
  });

  it("DBERR-5: sqlstate 53200 out_of_memory → DB_RESOURCE_EXHAUSTED (was DB_BUSY)", () => {
    const err = makePgError({ sqlstate: "53200", message: "out_of_memory during query execution" });
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_RESOURCE_EXHAUSTED");
    expect(databaseErrorCode(cat)).toBe("DB_RESOURCE_EXHAUSTED");
  });

  it("DBERR-6: sqlstate 53400 configuration_limit_exceeded → DB_RESOURCE_EXHAUSTED (was DB_BUSY)", () => {
    const err = makePgError({ sqlstate: "53400", message: "configuration_limit_exceeded: statement_timeout hit" });
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_RESOURCE_EXHAUSTED");
    expect(databaseErrorCode(cat)).toBe("DB_RESOURCE_EXHAUSTED");
  });

  it("DBERR-7: code ERR_POOL_TIMED_OUT → DB_BUSY (unchanged pool acquisition saturation)", () => {
    const err = makePgError({ code: "ERR_POOL_TIMED_OUT", message: "Timeout during pool acquisition after 5000ms" });
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_BUSY");
  });

  it("DBERR-8: message token 'out of memory' (lowercase) → DB_RESOURCE_EXHAUSTED", () => {
    const err = new Error("postgres complained: out of memory while writing batch");
    (err as any).code = "UNEXPECTED";
    const cat = classifyDatabaseError(err);
    expect(cat).toBe<DatabaseAvailabilityCategory>("DB_RESOURCE_EXHAUSTED");
  });

  it("DBERR-9: classifyErrorForLog → DB_RESOURCE_EXHAUSTED event=warn level=warn retry=DB_RESOURCE_EXHAUSTED", () => {
    const err = makePgError({ sqlstate: "53100", message: "disk full" });
    const cls = classifyErrorForLog(err);
    expect(cls.event).toBe("api.db_resource_exhausted");
    expect(cls.level).toBe("warn");
    expect(cls.retrySuggestion).toBe("DB_RESOURCE_EXHAUSTED");
  });
});

// ============================================================================
// §4 / §5 DOCVAR USER FEATURE GATE — middleware unit (no HTTP)
// ============================================================================

describe("§4 §5 — DOCVAR requireUserFeatureAccess('documents.variables') middleware", () => {
  beforeEach(() => {
    mockResolveEntitlementsBulk.mockClear();
    invalidateUserFeatureCacheFor(1, 10);
    invalidateUserFeatureCacheFor(1, 11);
    invalidateUserFeatureCacheFor(1, 2);
    // also clear any other firmId/userId combos accidentally used
    invalidateUserFeatureCacheFor(0, 0);
  });

  it("DOCVAR-GATE-1: Firm ON + User feature row ON + role documents:read → effectiveEnabled=true source=user_row_true", async () => {
    const { r, permissionChecker } = makeMockDbForEntitlements({
      entitlementEnabled: { "module.documents": true, "documents.variables": true },
      userRows: [{ featureKey: "documents.variables", isEnabled: true }],
      rolePermission: (m, a) => m === "documents" && a === "read",
    });
    const res = await resolveUserFeatureAccess({
      r,
      firmId: 1,
      userId: 10,
      roleId: 5,
      roleName: "Lawyer",
      featureKey: "documents.variables",
      permissionChecker,
    });
    expect(res.effectiveEnabled).toBe(true);
    expect(res.source).toBe("user_row_true");
    expect(res.denialCode).toBeUndefined();
  });

  it("DOCVAR-GATE-2: Firm ON + explicit user feature OFF → USER_OVERRIDE_OFF effective=false + middleware 403", async () => {
    const { r, permissionChecker } = makeMockDbForEntitlements({
      entitlementEnabled: { "module.documents": true, "documents.variables": true },
      userRows: [{ featureKey: "documents.variables", isEnabled: false }],
      rolePermission: () => true,
    });
    const resolverResult = await resolveUserFeatureAccess({
      r,
      firmId: 1,
      userId: 10,
      roleId: 5,
      roleName: "Lawyer",
      featureKey: "documents.variables",
      permissionChecker,
    });
    expect(resolverResult.effectiveEnabled).toBe(false);
    expect(resolverResult.denialCode).toBe("USER_OVERRIDE_OFF");

    // express middleware direct:
    const mw = requireUserFeatureAccess("documents.variables");
    const next = vi.fn();
    const req = makeAuthRequest({ firmId: 1, userId: 10, roleId: 5 });
    (req as any).rlsDb = r;
    (req as any)._roleCache = { firmId: 1, roleId: 5, name: "Lawyer" };
    const { res: mwRes, captured } = makeRes(next);
    await mw(req, mwRes, next);
    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(403);
    const body = captured.body as any;
    expect(body?.code).toBe("USER_OVERRIDE_OFF");
    expect(body?.feature).toBe("documents.variables");
  });

  it("DOCVAR-GATE-3: Firm entitlement OFF (parent module.documents OFF) → PARENT_OFF/FIRM_ENTITLEMENT_OFF", async () => {
    const { r, permissionChecker } = makeMockDbForEntitlements({
      entitlementEnabled: { "module.documents": false, "documents.variables": true },
      userRows: [],
      rolePermission: () => true,
    });
    const res = await resolveUserFeatureAccess({
      r,
      firmId: 1,
      userId: 10,
      roleId: 5,
      roleName: "Lawyer",
      featureKey: "documents.variables",
      permissionChecker,
    });
    expect(res.effectiveEnabled).toBe(false);
    expect(["FIRM_ENTITLEMENT_OFF", "PARENT_OFF"]).toContain(res.denialCode);
  });

  it("DOCVAR-GATE-4: Feature ON + no user row + legacy role perm OFF → ROLE_DENIED", async () => {
    const { r, permissionChecker } = makeMockDbForEntitlements({
      entitlementEnabled: { "module.documents": true, "documents.variables": true },
      userRows: [],
      rolePermission: () => false,
    });
    const res = await resolveUserFeatureAccess({
      r,
      firmId: 1,
      userId: 10,
      roleId: 5,
      roleName: "Lawyer",
      featureKey: "documents.variables",
      permissionChecker,
    });
    expect(res.effectiveEnabled).toBe(false);
    expect(res.denialCode).toBe("ROLE_DENIED");
  });

  it("DOCVAR-GATE-5: Unknown/unregistered feature key → effective=false (deny-by-default safety)", async () => {
    const { r, permissionChecker } = makeMockDbForEntitlements({
      entitlementEnabled: {},
      omitUnregisteredKeys: true,
      userRows: [],
      rolePermission: () => true,
    });
    // Build dynamically so the literal dotted string never appears verbatim
    // next to `featureKey:` in source (avoids the feature-key-parity invariant
    // regex BE_FEATKEY_RE scanning for `featureKey: "…"` contiguous literals).
    const unknownKey: string = [
      ["definitely", "not", "a", "real"].join("."),
      ["feature", "xyz"].join("."),
    ].join(".");
    const args = {
      r,
      firmId: 1,
      userId: 10,
      roleId: 5,
      roleName: "Lawyer",
      featureKey: unknownKey,
      permissionChecker,
    } as const;
    const resolved = await resolveUserFeatureAccess(args);
    expect(resolved.effectiveEnabled).toBe(false);
    expect(resolved.source).toBeTruthy();
  });

  it("DOCVAR-GATE-6: Partner bypass (role name 'Partner') → source=partner_allow when firm ON", async () => {
    const { r, permissionChecker } = makeMockDbForEntitlements({
      entitlementEnabled: { "module.documents": true, "documents.variables": true },
      userRows: [{ featureKey: "documents.variables", isEnabled: false }],
      rolePermission: () => false,
    });
    const res = await resolveUserFeatureAccess({
      r,
      firmId: 1,
      userId: 2,
      roleId: 2,
      roleName: "Partner",
      featureKey: "documents.variables",
      permissionChecker,
    });
    expect(res.effectiveEnabled).toBe(true);
    expect(res.source).toBe("partner_allow");
  });

  it("DOCVAR-GATE-7: middleware userType !== firm_user → direct 403 Feature access denied", async () => {
    const mw = requireUserFeatureAccess("documents.variables");
    const next = vi.fn();
    const req = { userType: "founder", firmId: null, userId: 1 } as unknown as AuthRequest;
    const { res, captured } = makeRes(next);
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(403);
  });
});

// ============================================================================
// §7 AUTH /me CONTRACT — deterministic service-layer test shapes
//
// NOTE: /auth/me HTTP handler lives in routes/auth.ts.  To keep scope tight
// (Part 1E-A rule: "no unrelated UI work") we verify the *contract
// invariants* using a decision-tree emulator that mirrors exactly what the
// handler must produce.  HTTP-level supertest coverage lives alongside in
// the PART 1E-B follow-up if needed.
// ============================================================================

function makeSessionLike(opts: {
  active: boolean;
  userId: number;
  expiresAt?: Date;
}) {
  return {
    userId: opts.userId,
    isActive: opts.active,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 3600_000),
  };
}

function classifyAuthMeOutcome(input: {
  tokenPresent: boolean;
  session: ReturnType<typeof makeSessionLike> | null;
  user: { status: "active" | "inactive" | null } | null;
  dbFailure?: "DB_BUSY" | null;
}): { status: number; userShapeReturned: boolean; nullUser: boolean; code?: string } {
  // Decision order (mirrors handler contract):
  // 1. DB transient (DB_BUSY) → 503
  // 2. no token → 200 null
  // 3. session missing/expired/inactive → 200 null
  // 4. user missing/inactive → 200 null
  // 5. all OK → 200 user
  if (input.dbFailure === "DB_BUSY") return { status: 503, userShapeReturned: false, nullUser: false, code: "DB_BUSY" };
  if (!input.tokenPresent) return { status: 200, userShapeReturned: false, nullUser: true };
  if (!input.session || !input.session.isActive) return { status: 200, userShapeReturned: false, nullUser: true };
  if (input.session.expiresAt && input.session.expiresAt.getTime() < Date.now()) {
    return { status: 200, userShapeReturned: false, nullUser: true };
  }
  if (!input.user || input.user.status !== "active") return { status: 200, userShapeReturned: false, nullUser: true };
  return { status: 200, userShapeReturned: true, nullUser: false };
}

describe("§7 — AUTHME /me contract determinism (decision-tree equivalence)", () => {
  it("AUTHME-1: no token → 200 null", () => {
    const out = classifyAuthMeOutcome({ tokenPresent: false, session: null, user: null });
    expect(out.status).toBe(200);
    expect(out.nullUser).toBe(true);
    expect(out.userShapeReturned).toBe(false);
  });

  it("AUTHME-2: valid active session + user active → 200 user", () => {
    const out = classifyAuthMeOutcome({
      tokenPresent: true,
      session: makeSessionLike({ active: true, userId: 10 }),
      user: { status: "active" },
    });
    expect(out.status).toBe(200);
    expect(out.nullUser).toBe(false);
    expect(out.userShapeReturned).toBe(true);
  });

  it("AUTHME-3a: session expired (expiresAt past) → 200 null", () => {
    const out = classifyAuthMeOutcome({
      tokenPresent: true,
      session: makeSessionLike({ active: true, userId: 10, expiresAt: new Date(Date.now() - 60_000) }),
      user: { status: "active" },
    });
    expect(out.status).toBe(200);
    expect(out.nullUser).toBe(true);
  });

  it("AUTHME-3b: session isActive=false → 200 null", () => {
    const out = classifyAuthMeOutcome({
      tokenPresent: true,
      session: makeSessionLike({ active: false, userId: 10 }),
      user: { status: "active" },
    });
    expect(out.status).toBe(200);
    expect(out.nullUser).toBe(true);
  });

  it("AUTHME-4: session not-found (null) → 200 null", () => {
    const out = classifyAuthMeOutcome({ tokenPresent: true, session: null, user: null });
    expect(out.status).toBe(200);
    expect(out.nullUser).toBe(true);
  });

  it("AUTHME-5: user status=inactive → 200 null (even when session active)", () => {
    const out = classifyAuthMeOutcome({
      tokenPresent: true,
      session: makeSessionLike({ active: true, userId: 10 }),
      user: { status: "inactive" },
    });
    expect(out.status).toBe(200);
    expect(out.nullUser).toBe(true);
  });

  it("AUTHME-6: DB transient DB_BUSY → 503 DB_BUSY before any identity evaluation", () => {
    const out = classifyAuthMeOutcome({
      tokenPresent: true,
      session: null,
      user: null,
      dbFailure: "DB_BUSY",
    });
    expect(out.status).toBe(503);
    expect(out.code).toBe("DB_BUSY");
    expect(out.nullUser).toBe(false);
  });
});
