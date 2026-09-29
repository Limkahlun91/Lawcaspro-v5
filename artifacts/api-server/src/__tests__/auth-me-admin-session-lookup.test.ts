import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { usersTable, sessionsTable, rolesTable, firmsTable, permissionsTable } from "@workspace/db";
import type { Application } from "express";

function extractAuthTokenFromSetCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const entry = list.find((s) => typeof s === "string" && s.startsWith("auth_token="));
  if (!entry) return "";
  const raw = entry.slice("auth_token=".length).split(";")[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type MockDb = {
  execute: (query?: unknown) => Promise<unknown[]>;
  select: (sel?: unknown) => {
    from: (table: unknown) => {
      where: (cond?: unknown) => Promise<unknown[]>;
      leftJoin: (other?: unknown, onExpr?: unknown) => { where: (cond?: unknown) => Promise<unknown[]> };
      innerJoin?: (other?: unknown, onExpr?: unknown) => { where: (cond?: unknown) => Promise<unknown[]> };
    };
  };
  insert: (table: unknown) => { values: (values: unknown) => Promise<void> };
  update: (table: unknown) => { set: (values: unknown) => { where: (cond?: unknown) => Promise<void> } };
};

type DbState = {
  usersByEmail: Map<string, unknown>;
  usersById: Map<number, unknown>;
  sessionsByTokenHash: Map<string, unknown>;
  rolesById: Map<number, unknown>;
  firmsById: Map<number, unknown>;
};

let appSessionSelectCalls = 0;

const makeDb = async (
  orig: () => Promise<typeof import("@workspace/db")>,
  state: DbState,
  opts?: { kind?: "app" | "admin" },
): Promise<MockDb> => {
  const actual = await orig();
  const emptyRows = (): unknown[] => [];
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

  return {
    execute: async () => [{ reg: "public.audit_logs" }],
    select: (sel?: unknown) => ({
      from: (table: unknown) => {
        const runWhere = async (projection?: Record<string, unknown> | null): Promise<unknown[]> => {
          if (table === actual.sessionsTable) {
            if (opts?.kind === "app") appSessionSelectCalls += 1;
            const s = Array.from(state.sessionsByTokenHash.values())[0] ?? null;
            return s ? [s] : emptyRows();
          }
          if (table === actual.usersTable) {
            const hasPasswordHash = isRecord(sel) && "passwordHash" in sel;
            if (hasPasswordHash) {
              const u = Array.from(state.usersByEmail.values())[0] ?? null;
              return u ? [u] : emptyRows();
            }
            const u = Array.from(state.usersById.values())[0] ?? null;
            return u ? [u] : emptyRows();
          }
          if (table === actual.rolesTable) {
            const r = Array.from(state.rolesById.values())[0] ?? null;
            return r ? [r] : emptyRows();
          }
          if (table === actual.firmsTable) {
            const f = Array.from(state.firmsById.values())[0] ?? null;
            return f ? [f] : emptyRows();
          }
          if (table === actual.permissionsTable) {
            return [{ module: "dashboard", action: "read", allowed: true }];
          }
          return emptyRows();
        };

        const projectRow = (
          projection: Record<string, unknown> | undefined | null,
          flatRow: Record<string, unknown> | null,
        ): unknown => {
          if (!flatRow) return undefined;
          if (!projection) return flatRow;
          const out: Record<string, unknown> = {};
          for (const alias of Object.keys(projection)) {
            if (alias in flatRow) {
              out[alias] = flatRow[alias];
            } else {
              // Fallback: map roleName → name on role side if exists
              if (alias === "roleName" && "roleName" in flatRow) out[alias] = flatRow.roleName;
              else if (alias === "roleName") out[alias] = flatRow.roleName ?? null;
              else out[alias] = (flatRow as any)[alias] ?? null;
            }
          }
          return out;
        };

        return {
          where: async (_cond?: unknown) => runWhere(isRecord(sel) ? sel : null),
          leftJoin: (_other?: unknown, _onExpr?: unknown) => ({
            where: async (_cond?: unknown) => {
              const projection = isRecord(sel) ? sel : null;
              if (table === actual.sessionsTable) {
                const base = await runWhere(projection);
                const sess = (base[0] as Record<string, unknown> | undefined) ?? null;
                if (!sess) return base;
                const uid = typeof (sess as any).userId === "number" ? (sess as any).userId : null;
                const user = uid !== null ? state.usersById.get(uid as number) ?? null : null;
                const rid = user && typeof (user as any).roleId === "number" ? (user as any).roleId : null;
                const role = rid !== null ? state.rolesById.get(rid as number) ?? null : null;
                const flat: Record<string, unknown> = {
                  ...Object.fromEntries(Object.entries(sess)),
                  ...(user ? Object.fromEntries(Object.entries(user as Record<string, unknown>)) : {}),
                  roleName: role ? (role as Record<string, unknown>).name ?? null : null,
                };
                const projected = projectRow(projection, flat);
                return projected ? [projected] : base;
              }
              // users LEFT JOIN roles + firms
              const userBase = await runWhere(projection);
              const u = (userBase[0] as Record<string, unknown> | undefined) ?? null;
              if (!u) return userBase;
              const rid = typeof (u as any).roleId === "number" ? (u as any).roleId : null;
              const role = rid !== null ? state.rolesById.get(rid as number) ?? null : null;
              const fid = typeof (u as any).firmId === "number" ? (u as any).firmId : null;
              const firm = fid !== null ? state.firmsById.get(fid as number) ?? null : null;
              const flat: Record<string, unknown> = {
                ...Object.fromEntries(Object.entries(u)),
                roleName: role ? (role as Record<string, unknown>).name ?? null : null,
                developerId: (u as any).developerId ?? null,
              };
              if (firm) Object.assign(flat, { firm: firm });
              const projected = projectRow(projection, flat);
              return projected ? [projected] : [flat];
            },
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        if (table === actual.sessionsTable) {
          const v = values as { tokenHash: string; userId: number; expiresAt: Date };
          state.sessionsByTokenHash.set(String(v.tokenHash), {
            userId: v.userId,
            expiresAt: v.expiresAt,
          });
        }
        return undefined;
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  };
};

const appState: DbState = {
  usersByEmail: new Map(),
  usersById: new Map(),
  sessionsByTokenHash: new Map(),
  rolesById: new Map(),
  firmsById: new Map(),
};

const adminState: DbState = {
  usersByEmail: new Map(),
  usersById: new Map(),
  sessionsByTokenHash: new Map(),
  rolesById: new Map(),
  firmsById: new Map(),
};

let authAdminCalls = 0;

const ENV_SNAPSHOT = {
  AUTH_DATABASE_URL: process.env.AUTH_DATABASE_URL,
  ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
};

vi.mock("bcryptjs", () => ({
  default: {
    compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
    hash: async () => "hash",
  },
  compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
  hash: async () => "hash",
}));

vi.mock("../lib/auth-admin-db", () => {
  return {
    isAuthAdminDbConfigured: () => true,
    withAuthAdminDb: async (fn: any) => {
      authAdminCalls += 1;
      const db = await makeDb(async () => await import("@workspace/db"), adminState, { kind: "admin" });
      return await fn(db as any);
    },
  };
});

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  const db = await makeDb(async () => await orig<typeof import("@workspace/db")>(), appState, { kind: "app" });
  return {
    ...actual,
    db: db as unknown as typeof actual.db,
    pool: {
      ...actual.pool,
      connect: async () => {
        throw new Error("pool.connect should not be used in these tests");
      },
      query: async () => {
        throw new Error("pool.query should not be used in these tests");
      },
    } as unknown as typeof actual.pool,
  };
});

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

afterEach(() => {
  if (typeof ENV_SNAPSHOT.AUTH_DATABASE_URL === "string") process.env.AUTH_DATABASE_URL = ENV_SNAPSHOT.AUTH_DATABASE_URL;
  else delete process.env.AUTH_DATABASE_URL;
  if (typeof ENV_SNAPSHOT.ADMIN_DATABASE_URL === "string") process.env.ADMIN_DATABASE_URL = ENV_SNAPSHOT.ADMIN_DATABASE_URL;
  else delete process.env.ADMIN_DATABASE_URL;
  vi.useRealTimers();
});

describe("GET /api/auth/me uses auth-admin session lookup", () => {
  it("finds newly created session when session lives only in auth-admin db", async () => {
    authAdminCalls = 0;
    appSessionSelectCalls = 0;
    appState.sessionsByTokenHash.clear();
    adminState.sessionsByTokenHash.clear();
    appState.rolesById.clear();
    appState.firmsById.clear();
    adminState.usersByEmail.clear();
    adminState.usersById.clear();

    const user = {
      id: 10,
      firmId: 5,
      email: "user@test.com",
      name: "U",
      passwordHash: "hash",
      userType: "firm_user",
      roleId: 7,
      status: "active",
      totpSecret: null,
      totpEnabled: false,
    };
    adminState.usersByEmail.set("user@test.com", user);
    adminState.usersById.set(10, user);
    appState.rolesById.set(7, { id: 7, name: "Clerk" });
    appState.firmsById.set(5, { id: 5, name: "Firm" });

    const login = await request(app).post("/api/auth/login").send({ email: "user@test.com", password: "goodpw" });
    expect(login.status).toBe(200);
    const setCookieHeader = (login.headers as Record<string, unknown>)["set-cookie"] as string[] | string | undefined;
    const token = extractAuthTokenFromSetCookie(setCookieHeader);
    expect(typeof token === "string" && token.length > 0).toBe(true);

    const adminCallsAfterLogin = authAdminCalls;
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body?.ok).toBe(true);
    expect(me.body?.data).toBeTruthy();
    expect(me.body?.data?.id).toBe(10);
    expect(authAdminCalls).toBeGreaterThan(adminCallsAfterLogin);
    expect(appSessionSelectCalls).toBe(0);
  });
});

describe("lookupSessionAndUserByTokenHash", () => {
  it("reports AUTH_DATABASE_URL as identity source when configured, without using normal DB session lookup", async () => {
    process.env.AUTH_DATABASE_URL = "postgres://example.invalid/auth";
    authAdminCalls = 0;
    appSessionSelectCalls = 0;
    appState.sessionsByTokenHash.clear();
    adminState.sessionsByTokenHash.clear();
    adminState.usersById.clear();
    adminState.usersByEmail.clear();

    const tokenHash = "tok_hash_1";
    const expiresAt = new Date(Date.now() + 60_000);
    adminState.sessionsByTokenHash.set(tokenHash, { userId: 10, expiresAt });
    adminState.usersById.set(10, {
      id: 10,
      firmId: 5,
      email: "user@test.com",
      name: "U",
      userType: "firm_user",
      roleId: 7,
      status: "active",
      developerId: null,
    });

    const { lookupSessionAndUserByTokenHash } = await import("../lib/auth");
    const result = await lookupSessionAndUserByTokenHash(tokenHash);

    expect(result?.timing?.identityDbSource).toBe("AUTH_DATABASE_URL");
    expect(result?.session).toBeTruthy();
    expect(result?.user).toBeTruthy();
    expect(appSessionSelectCalls).toBe(0);
    expect(authAdminCalls).toBeGreaterThan(0);
  });

  it("uses short-lived verified-session cache and invalidates by tokenHash", async () => {
    process.env.AUTH_DATABASE_URL = "postgres://example.invalid/auth";
    authAdminCalls = 0;
    appSessionSelectCalls = 0;
    appState.sessionsByTokenHash.clear();
    adminState.sessionsByTokenHash.clear();
    adminState.usersById.clear();
    adminState.usersByEmail.clear();

    const tokenHash = "tok_hash_cache_1";
    adminState.sessionsByTokenHash.set(tokenHash, { userId: 10, expiresAt: new Date(Date.now() + 60_000) });
    adminState.usersById.set(10, {
      id: 10,
      firmId: 5,
      email: "user@test.com",
      name: "U",
      userType: "firm_user",
      roleId: 7,
      status: "active",
      developerId: null,
    });

    const { lookupSessionAndUserByTokenHash, invalidateVerifiedSessionCacheByTokenHash } = await import("../lib/auth");

    const r1 = await lookupSessionAndUserByTokenHash(tokenHash);
    const callsAfterFirst = authAdminCalls;
    expect(r1?.session).toBeTruthy();
    expect(r1?.timing?.cacheHit).not.toBe(true);

    const r2 = await lookupSessionAndUserByTokenHash(tokenHash);
    expect(r2?.session).toBeTruthy();
    expect(r2?.timing?.cacheHit).toBe(true);
    expect(authAdminCalls).toBe(callsAfterFirst);

    invalidateVerifiedSessionCacheByTokenHash(tokenHash);
    const r3 = await lookupSessionAndUserByTokenHash(tokenHash);
    expect(r3?.session).toBeTruthy();
    expect(authAdminCalls).toBeGreaterThan(callsAfterFirst);
  });

  it("does not fall back to normal DB lookup when auth-admin DB is configured but has no session", async () => {
    vi.useFakeTimers();
    process.env.AUTH_DATABASE_URL = "postgres://example.invalid/auth";
    authAdminCalls = 0;
    appSessionSelectCalls = 0;
    appState.sessionsByTokenHash.clear();
    adminState.sessionsByTokenHash.clear();

    const tokenHash = "tok_hash_2";
    appState.sessionsByTokenHash.set(tokenHash, { userId: 10, expiresAt: new Date(Date.now() + 60_000) });

    const { lookupSessionAndUserByTokenHash } = await import("../lib/auth");
    const p = lookupSessionAndUserByTokenHash(tokenHash);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result).toBeNull();
    expect(appSessionSelectCalls).toBe(0);
    expect(authAdminCalls).toBeGreaterThanOrEqual(2);
  });
});
