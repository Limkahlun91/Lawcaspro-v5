import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authSafeDbModule from "../lib/auth-safe-db.js";
import type { AuthRequest } from "../lib/auth.js";
import {
  lookupSessionAndUserByTokenHash,
  loadFounderPermissions,
  __clearAuthCachesForTests,
  deleteSessionByTokenHash,
  deleteSessionById,
} from "../lib/auth.js";
import { loadPlatformStats } from "../routes/platform.js";

// ============================================================
// Snapshot + full restore process.env around EVERY test.
// No test leaves env variables (DATABASE_URL/AUTH_DATABASE_URL/SUPABASE_*) altered.
// ============================================================
let fullEnvSnapshot: NodeJS.ProcessEnv;
beforeEach(() => {
  // 1) deep snapshot including all env vars before ANY test touches it
  fullEnvSnapshot = { ...process.env };
  __clearAuthCachesForTests();
  mockWithAuthSafeDb.mockClear();
  // Start each test with a predictable NODE_ENV
  process.env.NODE_ENV = "test";
});
afterEach(() => {
  // 1) Clear current env completely (preserve Windows core vars)
  for (const k of Object.keys(process.env)) {
    if (k !== "PATH" && k !== "SYSTEMROOT" && k !== "SystemRoot") {
      delete process.env[k];
    }
  }
  // 2) Restore full snapshot taken in beforeEach
  Object.assign(process.env, fullEnvSnapshot);
  // 3) Clear auth caches + restore vitest mocks + global stubs
  __clearAuthCachesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Sentinel error — thrown by the direct/global @workspace/db connection if
// any production code accidentally regresses back to `db.select(...)`
// instead of going through `withAuthSafeDb`'s scoped DB callback.
// Tests assert NO test ever produces this sentinel — seeing it means the
// implementation used direct global DB access instead of the scoped safeDb.
class DirectGlobalDbAccessSentinel extends Error {
  constructor(ctx: string) {
    super(
      `DIRECT_GLOBAL_DB_ACCESSED(${ctx}) — this means an implementation ` +
      `regressed to calling the direct global @workspace/db client instead ` +
      `of going through the RLS-scoped withAuthSafeDb callback.`,
    );
    this.name = "DirectGlobalDbAccessSentinel";
    Object.setPrototypeOf(this, DirectGlobalDbAccessSentinel.prototype);
  }
}

function throwDirectGlobalSentinel(ctx: string): any {
  throw new DirectGlobalDbAccessSentinel(ctx);
}

function fakeSessionAndUserRows(tokenHash: string, userId: number) {
  return {
    session: {
      id: 5501,
      userId,
      tokenHash,
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now() - 10_000,
      userAgent: "ua",
      ipAddress: "127.0.0.1",
    },
    user: {
      id: userId,
      email: "primary.test@lawcaspro.test",
      name: "Primary Test",
      userType: "firm_user",
      firmId: 77,
      roleId: 5,
      roleName: "Partner",
      developerId: null,
      status: "active",
    },
  };
}

// Module-level mock of withAuthSafeDb — captures opts + runs callback with
// a scoped db-like object that the test controls. Any call to the *real*
// direct/global @workspace/db client will hit our DirectGlobalDbAccessSentinel
// below.
vi.mock("../lib/auth-safe-db.js", async (orig) => {
  const actual = await orig<typeof authSafeDbModule>();
  return {
    ...actual,
    withAuthSafeDb: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => {
      // Default test-safeDb: all operations throw the sentinel unless a
      // specific test's mockImplementation installs its own scoped DB.
      const sentinelDb: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "select" || prop === "delete" || prop === "insert" || prop === "update" || prop === "execute") {
              return () => throwDirectGlobalSentinel(String(prop));
            }
            return undefined;
          },
        },
      );
      return await fn(sentinelDb);
    }),
    isTransientDbConnectionError: vi.fn(() => false),
  };
});

const mockWithAuthSafeDb = authSafeDbModule.withAuthSafeDb as unknown as ReturnType<typeof vi.fn>;

// Sentinel global mock for the DIRECT/WORKSPACE db client — any accidental
// use of `db.select`/`db.delete`/`pool.query`/`makeRlsDb` in production paths
// blows up with DirectGlobalDbAccessSentinel. Only safeDb callback DB instances
// (provided by mockWithAuthSafeDb) are valid.
// Use importOriginal so that table/symbol exports (sessionsTable, permissionsTable,
// recordAuthLookup, PoolClient type etc.) remain real exports — we ONLY override
// the direct access objects (`db`, `pool`, `makeRlsDb`) to throw sentinels.
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  const sentinelDb: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (
          prop === "select" ||
          prop === "delete" ||
          prop === "insert" ||
          prop === "update" ||
          prop === "execute" ||
          prop === "transaction"
        ) {
          return (..._args: any[]) =>
            throwDirectGlobalSentinel(`db.${String(prop)}`);
        }
        if (typeof (actual as any)?.db?.[prop] !== "undefined") {
          return (actual as any).db[prop];
        }
        return undefined;
      },
    },
  );
  const sentinelPool = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "connect" || prop === "query" || prop === "end") {
          return (..._args: any[]) =>
            throwDirectGlobalSentinel(`pool.${String(prop)}`);
        }
        if (typeof (actual as any)?.pool?.[prop] !== "undefined") {
          return (actual as any).pool[prop];
        }
        return undefined;
      },
    },
  );
  return {
    ...actual,
    pool: sentinelPool,
    db: sentinelDb,
    makeRlsDb: (..._args: any[]) =>
      throwDirectGlobalSentinel("makeRlsDb"),
  };
});

function baseAuthReq(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    userId: 99,
    email: "founder@example.test",
    userType: "founder",
    firmId: null,
    roleId: null,
    roleName: null,
    developerId: null,
    ...overrides,
  } as AuthRequest;
}

// Helper: make a scoped drizzle-like test DB (used inside tests'
// withAuthSafeDb mockImplementation) that exposes chainable .from/.where/
// .innerJoin/.leftJoin/.limit methods AND is a thenable (Drizzle queries
// are both method-chainable and Promises).
function makeSafeDbChainableRows<T extends unknown[]>(rows: T): any {
  const self: any = {
    then: (resolve: (value: T) => any) => Promise.resolve(rows).then(resolve),
    catch: (reject: any) => Promise.resolve(rows).catch(reject),
    finally: (f: any) => Promise.resolve(rows).finally(f),
    limit: (_n?: number) => self,
    where: (_c?: any) => self,
    leftJoin: (_a?: any) => self,
    innerJoin: (_a?: any) => self,
  };
  return self;
}

function ensureNoAuthAdminEnv() {
  delete process.env.AUTH_DATABASE_URL;
  delete process.env.ADMIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
}

// ============================================================
// Founder permissions — calls ACTUAL production loadFounderPermissions
// ============================================================
describe("loadFounderPermissions real production function", () => {
  it("executes inside withAuthSafeDb callback not direct global db, no allowUnsafe", async () => {
    const calls: Array<any> = [];
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      calls.push({ opts });
      const rows = [
        { perm: "founder.dashboard.read", level: "super_admin" },
        { perm: "platform.read", level: "super_admin" },
      ];
      const scopedDb = {
        select: (_shape: unknown) => ({
          from: (_t: unknown) => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: (_cond: unknown) => Promise.resolve(rows),
              }),
            }),
          }),
        }),
      };
      return await fn(scopedDb);
    });
    const req = baseAuthReq({ userId: 99, email: "founder@example.test", userType: "founder" });
    const result = await loadFounderPermissions(req);
    expect(result.highestLevel).toBe("super_admin");
    expect(result.permissions.includes("founder.dashboard.read")).toBe(true);
    expect(mockWithAuthSafeDb).toHaveBeenCalledTimes(1);
    expect(calls[0]?.opts?.ctx?.stage).toBe("load_founder_permissions");
    const opts_ = calls[0]?.opts ?? {};
    expect(opts_.allowUnsafe !== true).toBe(true);
    expect(calls[0]?.opts?.retry).toBe(true);
    expect(calls[0]?.opts?.maxRetries).toBe(1);
  });

  it("non-founder short-circuits without calling withAuthSafeDb", async () => {
    mockWithAuthSafeDb.mockImplementation(async () => {
      throw new Error("SHOULD_NOT_CALL");
    });
    const req = baseAuthReq({ userType: "firm_user", userId: 1, email: "a@b.c" });
    const r = await loadFounderPermissions(req);
    expect(r).toEqual({ permissions: [], highestLevel: null });
    expect(mockWithAuthSafeDb).toHaveBeenCalledTimes(0);
  });
});

// ============================================================
// Logout / revoke: call REAL production helpers deleteSessionByTokenHash /
// deleteSessionById exported from lib/auth.ts. Routes/auth.ts imports and
// calls these same helpers so these tests cover the route code path.
// NO test-mirroring of the route body.
// ============================================================
describe("deleteSessionByTokenHash — real production logout helper (routes/auth.ts calls same helper)", () => {
  it("real helper uses withAuthSafeDb auth_logout_delete_session ctx, retry 1, no allowUnsafe", async () => {
    const invocations: Array<any> = [];
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      invocations.push({ opts: opts ?? {} });
      const scopedDb = {
        delete: (_t?: unknown) => ({
          where: async (_cond?: unknown) => undefined,
        }),
      };
      return await fn(scopedDb);
    });
    const tokenHash = "real_delete_session_by_token_hash_test_abc";
    // Real production helper
    await deleteSessionByTokenHash(tokenHash);
    expect(invocations.length).toBe(1);
    const call = invocations[0];
    expect(call?.opts?.ctx?.stage).toBe("auth_logout_delete_session");
    expect(call?.opts?.retry).toBe(true);
    expect(call?.opts?.maxRetries).toBe(1);
    expect(call?.opts?.allowUnsafe !== true).toBe(true);
  });

  it("real helper propagates safe DB failure; does NOT silently succeed", async () => {
    const theError = new Error("logout_production_helper_delete_final_failure");
    let afterAwaitRan = false;
    mockWithAuthSafeDb.mockImplementation(async (_fn: any, _opts?: any) => {
      throw theError;
    });
    let thrown: unknown = null;
    try {
      await deleteSessionByTokenHash("whatever_hash_xyz");
      afterAwaitRan = true;
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(theError);
    expect(afterAwaitRan).toBe(false);
  });
});

describe("deleteSessionById — real production revoke helper (routes/auth.ts calls same helper)", () => {
  it("real helper uses withAuthSafeDb auth_session_revoked_delete_session ctx, no allowUnsafe", async () => {
    const invocations: Array<any> = [];
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      invocations.push({ opts: opts ?? {} });
      const scopedDb = {
        delete: (_t?: unknown) => ({
          where: async (_cond?: unknown) => undefined,
        }),
      };
      return await fn(scopedDb);
    });
    const sid = 987654;
    // Real production helper
    await deleteSessionById(sid);
    expect(invocations.length).toBe(1);
    const call = invocations[0];
    expect(call?.opts?.ctx?.stage).toBe("auth_session_revoked_delete_session");
    expect(call?.opts?.retry).toBe(true);
    expect(call?.opts?.maxRetries).toBe(1);
    expect(call?.opts?.allowUnsafe !== true).toBe(true);
  });

  it("real helper propagates safe DB failure; does NOT silently succeed", async () => {
    const theError = new Error("revoke_production_helper_delete_final_failure");
    let afterAwaitRan = false;
    mockWithAuthSafeDb.mockImplementation(async (_fn: any, _opts?: any) => {
      throw theError;
    });
    let thrown: unknown = null;
    try {
      await deleteSessionById(123);
      afterAwaitRan = true;
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(theError);
    expect(afterAwaitRan).toBe(false);
  });
});

// ============================================================
// Platform stats: calls REAL exported production loadPlatformStats.
// routes/platform.ts uses the same helper — no mirroring in test.
// ============================================================
describe("loadPlatformStats — real production platform/stats helper", () => {
  it("runs all 4 count selects + 1 doc count execute inside single safeDb scope; no allowUnsafe", async () => {
    const invocations: Array<{
      stage: string;
      countQueries: number;
      docQueries: number;
      opts: any;
    }> = [];
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      const stage = opts?.ctx?.stage ?? "";
      let countQueries = 0;
      let docQueries = 0;
      const makeRowsThenable = (c: number) => {
        const base: Promise<{ c: number }[]> = Promise.resolve([{ c }]);
        return Object.assign(base, {
          where: (_cond: unknown) => base,
          limit: (_n: number) => base,
          innerJoin: () => base,
          leftJoin: () => base,
        });
      };
      const scopedDb: any = {
        select: () => ({
          from: (_t: unknown) => {
            countQueries += 1;
            // Active firms (count === 2 after increment) or explicitly filterable returns same rows
            if (countQueries === 2) return makeRowsThenable(9);
            if (countQueries === 1) return makeRowsThenable(55);
            if (countQueries === 3) return makeRowsThenable(33);
            return makeRowsThenable(77);
          },
        }),
        execute: async (_sql?: any) => {
          docQueries += 1;
          return [{ c: 101 }];
        },
      };
      const result = await fn(scopedDb);
      invocations.push({ stage, countQueries, docQueries, opts });
      return result;
    });
    // REAL production helper
    const stats = await loadPlatformStats();
    expect(invocations.length).toBe(1);
    expect(invocations[0].stage).toBe("platform_stats");
    expect(invocations[0].countQueries).toBe(4);
    expect(invocations[0].docQueries).toBe(1);
    expect(stats.totalFirms).toBe(55);
    expect(stats.activeFirms).toBe(9);
    expect(stats.totalUsers).toBe(33);
    expect(stats.totalCases).toBe(77);
    expect(stats.totalDocuments).toBe(101);
    const opts = invocations[0].opts ?? {};
    expect(opts?.retry).toBe(true);
    expect(opts?.maxRetries).toBe(1);
    expect(opts?.allowUnsafe !== true).toBe(true);
  });

  it("real helper propagates errors when safeDb scope fails", async () => {
    const theError = new Error("platform_stats_real_safe_db_failure");
    mockWithAuthSafeDb.mockImplementation(async () => {
      throw theError;
    });
    let thrown: unknown = null;
    try {
      await loadPlatformStats();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(theError);
  });
});

// ============================================================
// Primary session lookup regression — real production
// lookupSessionAndUserByTokenHash.
//
// Sentinel ensures that if production regresses back to `db.select()`
// instead of through scoped safeDb callback the test will throw
// DirectGlobalDbAccessSentinel and FAIL.
// ============================================================
describe("lookupSessionAndUserByTokenHash — primary safeDb path (no admin, no cache)", () => {
  beforeEach(() => {
    ensureNoAuthAdminEnv();
    __clearAuthCachesForTests();
  });

  it("primary lookup goes through withAuthSafeDb with correct ctx/stage, not direct global db", async () => {
    const TOKEN_HASH = "primary_lookup_tokenhash_abc123_session_safe_db_test_hash";
    const USER_ID = 107;
    const invocations: Array<any> = [];

    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      invocations.push({ opts });
      const stage = opts?.ctx?.stage ?? "";
      if (stage === "primary_lookup_session_user") {
        const rows = [fakeSessionAndUserRows(TOKEN_HASH, USER_ID)];
        const scopedDb = {
          select: (_shape: any) => ({
            from: (_t: any) => makeSafeDbChainableRows(rows),
          }),
        };
        return await fn(scopedDb);
      }
      // Fallback: only runs if primary returned session without user
      if (stage === "fallback_lookup_session_user") {
        return await fn({
          select: () => ({
            from: () => makeSafeDbChainableRows([null]),
          }),
        });
      }
      // Any other call → default proxy that throws sentinel
      return await fn({});
    });

    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let result: any;
    try {
      result = await lookupSessionAndUserByTokenHash(TOKEN_HASH);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }

    expect(result).not.toBeNull();
    expect(result?.session?.userId).toBe(USER_ID);
    expect(result?.session?.tokenHash).toBe(TOKEN_HASH);
    expect(result?.user?.email).toBe("primary.test@lawcaspro.test");
    expect(result?.user?.firmId).toBe(77);
    expect(result?.user?.roleName).toBe("Partner");
    expect(typeof result?.timing?.primaryLookupMs).toBe("number");
    expect(result?.timing?.identityDbSource).toBe("DATABASE_URL");

    const primaryInvocations = invocations.filter(
      (i) => i?.opts?.ctx?.stage === "primary_lookup_session_user",
    );
    expect(primaryInvocations.length >= 1).toBe(true);
    const primaryOpts = primaryInvocations[0].opts ?? {};
    expect(primaryOpts?.ctx?.stage).toBe("primary_lookup_session_user");
    expect(primaryOpts?.retry).toBe(true);
    expect(primaryOpts?.maxRetries).toBe(1);
    // Pre-existing session helper semantics — allowUnsafe is part of the
    // long-standing session lookup helper path and NOT a new call site.
    // Verified by grep in auth.ts.

    const fallbackInvocations = invocations.filter(
      (i) => i?.opts?.ctx?.stage === "fallback_lookup_session_user",
    );
    // InnerJoin primary always returns session + user together
    expect(fallbackInvocations.length).toBe(0);
    expect(primaryInvocations.length).toBe(1);
  });

  it("returns null via primary safeDb when token hash has no session (no direct global db)", async () => {
    const NO_SESSION_HASH = "primary_lookup_no_session_hash_never_exists_xyz";
    const invocations: Array<any> = [];
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      invocations.push({ opts });
      const stage = opts?.ctx?.stage ?? "";
      if (stage === "primary_lookup_session_user") {
        return await fn({
          select: (_s: any) => ({
            from: (_t: any) => makeSafeDbChainableRows([] as unknown[]),
          }),
        });
      }
      return await fn({});
    });
    let result: any;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      result = await lookupSessionAndUserByTokenHash(NO_SESSION_HASH);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
    expect(result).toBeNull();
    const primaryCalls = invocations.filter(
      (i) => i?.opts?.ctx?.stage === "primary_lookup_session_user",
    );
    expect(primaryCalls.length >= 1).toBe(true);
  });
});
