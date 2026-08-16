import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usersTable, sessionsTable, rolesTable, firmsTable, permissionsTable, developersTable } from "@workspace/db";
import type { Application, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import type { AuthRequest } from "../lib/auth.js";

type MockDbState = {
  usersById: Map<number, Record<string, unknown>>;
  sessionsByTokenHash: Map<string, Record<string, unknown>>;
  rolesByIdFirm: Map<string, Record<string, unknown>>;
  firmsById: Map<number, Record<string, unknown>>;
  developersByIdFirm: Map<string, Record<string, unknown>>;
  dbCalls: Array<{ table: string; where: unknown; calls: number }>;
};

const state: MockDbState = {
  usersById: new Map(),
  sessionsByTokenHash: new Map(),
  rolesByIdFirm: new Map(),
  firmsById: new Map(),
  developersByIdFirm: new Map(),
  dbCalls: [],
};

vi.mock("bcryptjs", () => ({
  default: {
    compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
    hash: async () => "hash",
  },
  compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
  hash: async () => "hash",
}));

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  const emptyRows = (): unknown[] => [];

  const selectFromWhere = async (tableRef: unknown, whereFn: (rows: unknown[]) => unknown[]): Promise<unknown[]> => {
    if (tableRef === actual.sessionsTable) {
      const rows = Array.from(state.sessionsByTokenHash.values());
      return whereFn ? whereFn(rows as any[]) : rows;
    }
    if (tableRef === actual.usersTable) {
      const rows = Array.from(state.usersById.values());
      return whereFn ? whereFn(rows as any[]) : rows;
    }
    if (tableRef === actual.rolesTable) {
      const rows = Array.from(state.rolesByIdFirm.values());
      return whereFn ? whereFn(rows as any[]) : rows;
    }
    if (tableRef === actual.firmsTable) {
      const rows = Array.from(state.firmsById.values());
      return whereFn ? whereFn(rows as any[]) : rows;
    }
    if (tableRef === actual.permissionsTable) {
      return [{ module: "cases", action: "read" }];
    }
    if (tableRef === actual.developersTable) {
      const rows = Array.from(state.developersByIdFirm.values());
      return whereFn ? whereFn(rows as any[]) : rows;
    }
    return emptyRows();
  };

  function mockSelect(_projected: unknown): unknown {
    const hasProjection = !!(
      _projected &&
      typeof _projected === "object" &&
      Object.keys(_projected as Record<string, unknown>).length > 0
    );
    const projectedObj = hasProjection ? (_projected as Record<string, unknown>) : null;

    const applyProjection = (sourceRow: Record<string, unknown>): Record<string, unknown> => {
      if (!projectedObj) return sourceRow;
      const out: Record<string, unknown> = {};
      for (const [alias, src] of Object.entries(projectedObj)) {
        if (src === actual.usersTable?.id) out[alias] = sourceRow.id;
        else if (src === actual.usersTable?.email) out[alias] = sourceRow.email;
        else if (src === actual.usersTable?.name) out[alias] = sourceRow.name;
        else if (src === actual.usersTable?.userType) out[alias] = sourceRow.userType;
        else if (src === actual.usersTable?.firmId) out[alias] = sourceRow.firmId;
        else if (src === actual.usersTable?.roleId) out[alias] = sourceRow.roleId;
        else if (src === actual.usersTable?.developerId) out[alias] = sourceRow.developerId;
        else if (src === actual.usersTable?.status) out[alias] = sourceRow.status;
        else if (src === actual.rolesTable?.name) out[alias] = sourceRow.roleName ?? null;
        else if (src === actual.sessionsTable?.id) out[alias] = sourceRow.id;
        else if (src === actual.sessionsTable?.userId) out[alias] = sourceRow.userId;
        else if (src === actual.sessionsTable?.tokenHash) out[alias] = sourceRow.tokenHash;
        else if (src === actual.sessionsTable?.expiresAt) out[alias] = sourceRow.expiresAt;
        else if (src === actual.sessionsTable?.createdAt) out[alias] = sourceRow.createdAt;
        else if (src === actual.sessionsTable?.userAgent) out[alias] = sourceRow.userAgent;
        else if (src === actual.sessionsTable?.ipAddress) out[alias] = sourceRow.ipAddress;
        else if (src === actual.developersTable?.name) out[alias] = sourceRow.name;
        else if (typeof src === "string") out[alias] = sourceRow[src];
        else out[alias] = (sourceRow as any)[alias];
      }
      return out;
    };

    return {
      from: (table: unknown) => ({
        innerJoin: (table2: unknown, _on: unknown) => ({
          leftJoin: (table3: unknown, on2: unknown) => ({
            where: async (cond: unknown) => {
              if (table === actual.sessionsTable && table2 === actual.usersTable) {
                const sessionRows = Array.from(state.sessionsByTokenHash.values());
                const tokenKey = extractEq(cond, actual.sessionsTable?.tokenHash);
                const s = tokenKey ? sessionRows.find((r) => r.tokenHash === tokenKey) : sessionRows[0];
                if (!s) return [];
                const u = state.usersById.get(Number(s.userId));
                if (!u) return [];
                const roleKey = `${String(u.roleId ?? "")}|${String(u.firmId ?? "")}`;
                const role = state.rolesByIdFirm.get(roleKey);
                const merged = {
                  ...s,
                  ...u,
                  roleName: role?.name ?? null,
                } as any;
                return [{ session: applyProjectionOn(merged, projectedObj, "session"), user: applyProjectionOn(merged, projectedObj, "user") }];
              }
              return [];
            },
            limit: (_n: number) => ({ where: async () => [] }),
          }),
          where: async () => [],
        }),
        leftJoin: (table2: unknown, onExpr: unknown) => ({
          where: async (cond: unknown): Promise<unknown[]> => {
            if (table === actual.usersTable && table2 === actual.rolesTable) {
              const userIdVal = extractEq(cond, actual.usersTable?.id);
              const u = userIdVal ? state.usersById.get(Number(userIdVal)) : Array.from(state.usersById.values())[0];
              if (!u) return [];
              const roleKey = `${String(u.roleId ?? "")}|${String(u.firmId ?? "")}`;
              const role = state.rolesByIdFirm.get(roleKey);
              const merged: Record<string, unknown> = {
                ...u,
                roleName: role?.name ?? null,
              };
              return [applyProjection(merged)];
            }
            return [];
          },
        }),
        where: async (cond: unknown): Promise<unknown[]> => {
          if (table === actual.sessionsTable) {
            const rows = Array.from(state.sessionsByTokenHash.values());
            return rows.map(applyProjection);
          }
          if (table === actual.usersTable) {
            const rows = Array.from(state.usersById.values());
            return rows.map(applyProjection);
          }
          if (table === actual.rolesTable) {
            return Array.from(state.rolesByIdFirm.values()).map(applyProjection);
          }
          if (table === actual.permissionsTable) return [{ module: "cases", action: "read" }];
          if (table === actual.developersTable) return Array.from(state.developersByIdFirm.values()).map(applyProjection);
          if (table === actual.firmsTable) return Array.from(state.firmsById.values()).map(applyProjection);
          return [];
        },
        limit: (_n: number) => ({ where: async (_c: unknown) => [] }),
      }),
    };
  }

  function applyProjectionOn(sourceRow: Record<string, unknown>, projectedObj: Record<string, unknown> | null, ns: string): Record<string, unknown> {
    if (!projectedObj) return sourceRow;
    const out: Record<string, unknown> = {};
    for (const [alias, src] of Object.entries(projectedObj)) {
      out[alias] = resolveFrom(sourceRow, src as any);
    }
    return out;
  }

  function resolveFrom(row: Record<string, unknown>, ref: unknown): unknown {
    if (ref === null || ref === undefined) return null;
    if (ref === actual.usersTable?.id) return row.id;
    if (ref === actual.usersTable?.email) return row.email;
    if (ref === actual.usersTable?.name) return row.name;
    if (ref === actual.usersTable?.userType) return row.userType;
    if (ref === actual.usersTable?.firmId) return row.firmId;
    if (ref === actual.usersTable?.roleId) return row.roleId;
    if (ref === actual.usersTable?.status) return row.status;
    if (ref === actual.usersTable?.developerId) return row.developerId;
    if (ref === actual.rolesTable?.name) return row.roleName ?? null;
    if (ref === actual.sessionsTable?.id) return row.id;
    if (ref === actual.sessionsTable?.userId) return row.userId;
    if (ref === actual.sessionsTable?.tokenHash) return row.tokenHash;
    if (ref === actual.sessionsTable?.expiresAt) return row.expiresAt;
    if (ref === actual.sessionsTable?.createdAt) return row.createdAt;
    if (ref === actual.sessionsTable?.userAgent) return row.userAgent;
    if (ref === actual.sessionsTable?.ipAddress) return row.ipAddress;
    if (ref === actual.developersTable?.name) return row.name;
    if (ref === actual.rolesTable?.id) return row.roleId;
    if (ref === actual.rolesTable?.firmId) return row.rolesFirmId ?? null;
    if (typeof ref === "string") return row[ref];
    return null;
  }

  function extractEq(_cond: unknown, _ref: unknown): string | number | null {
    return null;
  }

  const mockDb = {
    execute: async () => [{ reg: "public.audit_logs" }],
    select: (projected?: unknown) => mockSelect(projected ?? {}),
    insert: (_table: unknown) => ({ values: async () => undefined }),
    update: (_table: unknown) => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async (fn: any) => fn(),
  };

  return {
    ...actual,
    db: mockDb as unknown as typeof actual.db,
    pool: {
      ...actual.pool,
      connect: async () => {
        throw new Error("pool.connect unused");
      },
      query: async () => {
        throw new Error("pool.query unused");
      },
    } as unknown as typeof actual.pool,
  };
});

beforeEach(async () => {
  const { __clearAuthCachesForTests } = await import("../lib/auth.js");
  __clearAuthCachesForTests();
  state.usersById.clear();
  state.sessionsByTokenHash.clear();
  state.rolesByIdFirm.clear();
  state.firmsById.clear();
  state.developersByIdFirm.clear();
  state.dbCalls.length = 0;
});

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

type SeedCtx = {
  firmId: number;
  developerId: number;
  roleIds: Record<string, number>;
};

function seedBasicFirm(): SeedCtx {
  const firmId = 100;
  const developerId = 77;
  state.firmsById.set(firmId, { id: firmId, name: "Firm A" });
  state.developersByIdFirm.set(`${developerId}|${firmId}`, { id: developerId, firmId, name: "Developer A" });
  const roleIds: Record<string, number> = { Developer_User: 301, Partner: 302, Accounting: 303 };
  for (const [name, id] of Object.entries(roleIds)) {
    state.rolesByIdFirm.set(`${id}|${firmId}`, { id, firmId, name, isSystemRole: false });
  }
  return { firmId, developerId, roleIds };
}

function seedSessionFor(tokenClear: string, user: { id: number; firmId: number | null; email: string; name: string; userType: string; roleId: number | null; status: string; developerId: number | null }): string {
  state.usersById.set(user.id, user);
  const tokenHash = crypto.createHash("sha256").update(tokenClear).digest("hex");
  state.sessionsByTokenHash.set(tokenHash, {
    id: 1000 + user.id,
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    userAgent: "test/1.0",
    ipAddress: "127.0.0.1",
  });
  return tokenClear;
}

const PATH_PROJECTS = "/api/developer/portal/projects";
const PATH_OVERVIEW = "/api/developer/portal/overview";
const PATH_QUOTATIONS = "/api/quotations";
const PATH_INVOICES = "/api/invoices";
const PATH_RECEIPTS = "/api/receipts";
const PATH_PV = "/api/payment-vouchers";
const PATH_USERS = "/api/users";
const PATH_LEDGER = "/api/cases/1/ledger";

describe("PART 2 — Real Auth Chain (requireAuth → session lookup → roleName LEFT JOIN → cache → allowlist)", () => {
  it("AUTH-DEV-CHAIN-1 Developer_User session hydrates roleName via real session+user+role join", async () => {
    const ctx = seedBasicFirm();
    const clearTok = seedSessionFor("tok-dev-1", {
      id: 501,
      firmId: ctx.firmId,
      email: "dev@firm.test",
      name: "Dev User",
      userType: "firm_user",
      roleId: ctx.roleIds.Developer_User,
      status: "active",
      developerId: ctx.developerId,
    });
    const { lookupSessionAndUserByTokenHash } = await import("../lib/auth.js");
    const tokenHash = crypto.createHash("sha256").update(clearTok).digest("hex");
    const r = await lookupSessionAndUserByTokenHash(tokenHash);
    expect(r?.user?.id).toBe(501);
    expect(r?.user?.userType).toBe("firm_user");
    expect(r?.user?.firmId).toBe(ctx.firmId);
    expect(r?.user?.roleId).toBe(ctx.roleIds.Developer_User);
    expect(r?.user?.roleName).toBe("Developer_User");
    expect(r?.user?.developerId).toBe(ctx.developerId);
    expect(r?.timing?.cacheHit).not.toBe(true);
  });

  it("AUTH-DEV-CHAIN-2 second lookup is cache hit, roleName/firmId/roleId/developerId same, no extra role select", async () => {
    const ctx = seedBasicFirm();
    const clearTok = seedSessionFor("tok-dev-2", {
      id: 502,
      firmId: ctx.firmId,
      email: "dev2@firm.test",
      name: "Dev 2",
      userType: "firm_user",
      roleId: ctx.roleIds.Developer_User,
      status: "active",
      developerId: ctx.developerId,
    });
    const { lookupSessionAndUserByTokenHash, __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const tokenHash = crypto.createHash("sha256").update(clearTok).digest("hex");
    const r1 = await lookupSessionAndUserByTokenHash(tokenHash);
    expect(r1?.user?.roleName).toBe("Developer_User");
    expect(r1?.timing?.identityDbSource).toBeDefined();
    expect(Number(r1?.session?.expiresAt as any) > 0 || (r1?.session?.expiresAt instanceof Date)).toBe(true);
    const r2 = await lookupSessionAndUserByTokenHash(tokenHash);
    const r2CacheHit = r2?.timing?.cacheHit === true;
    expect(r2CacheHit ? "cache_hit" : "cache_miss").toBe("cache_hit");
    expect(r2?.user?.id).toBe(r1?.user?.id);
    expect(r2?.user?.roleName).toBe(r1?.user?.roleName);
    expect(r2?.user?.roleId).toBe(r1?.user?.roleId);
    expect(r2?.user?.firmId).toBe(r1?.user?.firmId);
    expect(r2?.user?.developerId).toBe(r1?.user?.developerId);
  });

  it("AUTH-DEV-CHAIN-3 Partner role hydration stays valid (roleName never null)", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("tok-partner", {
      id: 601,
      firmId: ctx.firmId,
      email: "p@firm.test",
      name: "Partner",
      userType: "firm_user",
      roleId: ctx.roleIds.Partner,
      status: "active",
      developerId: null,
    });
    const tokenHash = crypto.createHash("sha256").update("tok-partner").digest("hex");
    const { lookupSessionAndUserByTokenHash } = await import("../lib/auth.js");
    const r = await lookupSessionAndUserByTokenHash(tokenHash);
    expect(r?.user?.roleName).toBe("Partner");
    expect(r?.user?.firmId).toBe(ctx.firmId);
    expect(r?.user?.roleId).toBe(ctx.roleIds.Partner);
  });

  it("AUTH-DEV-CHAIN-4 Accounting user hydration stays valid", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("tok-acc", {
      id: 602,
      firmId: ctx.firmId,
      email: "acc@firm.test",
      name: "Accounting",
      userType: "firm_user",
      roleId: ctx.roleIds.Accounting,
      status: "active",
      developerId: null,
    });
    const tokenHash = crypto.createHash("sha256").update("tok-acc").digest("hex");
    const { lookupSessionAndUserByTokenHash } = await import("../lib/auth.js");
    const r = await lookupSessionAndUserByTokenHash(tokenHash);
    expect(r?.user?.roleName).toBe("Accounting");
  });

  it("AUTH-DEV-CHAIN-5 Founder platform user returns valid structure (roleName null because no firm role)", async () => {
    const FOUNDER_ROLE_GLOBAL: any = null;
    seedSessionFor("tok-founder", {
      id: 9001,
      firmId: null,
      email: "founder@lawcas.pro",
      name: "Founder",
      userType: "founder",
      roleId: FOUNDER_ROLE_GLOBAL,
      status: "active",
      developerId: null,
    });
    const tokenHash = crypto.createHash("sha256").update("tok-founder").digest("hex");
    const { lookupSessionAndUserByTokenHash } = await import("../lib/auth.js");
    const r = await lookupSessionAndUserByTokenHash(tokenHash);
    expect(r?.user?.userType).toBe("founder");
    expect(r?.user?.firmId).toBeNull();
    expect(r?.user?.roleId).toBeNull();
    expect(r?.user?.roleName).toBeNull();
  });

  it("SEC-CHAIN-HTTP-1 Developer_User HTTP /quotations → 403 DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-dev-1", {
      id: 511, firmId: ctx.firmId, email: "devhttp@test.com", name: "Dev H1",
      userType: "firm_user", roleId: ctx.roleIds.Developer_User, status: "active", developerId: ctx.developerId,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_QUOTATIONS).set("Cookie", "auth_token=http-dev-1");
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-2 Developer_User HTTP /invoices → 403 allowlist", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-dev-2", {
      id: 512, firmId: ctx.firmId, email: "devhttp2@test.com", name: "Dev H2",
      userType: "firm_user", roleId: ctx.roleIds.Developer_User, status: "active", developerId: ctx.developerId,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_INVOICES).set("Cookie", "auth_token=http-dev-2");
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-3 Developer_User HTTP /receipts → 403 allowlist", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-dev-3", {
      id: 513, firmId: ctx.firmId, email: "devhttp3@test.com", name: "Dev H3",
      userType: "firm_user", roleId: ctx.roleIds.Developer_User, status: "active", developerId: ctx.developerId,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_RECEIPTS).set("Cookie", "auth_token=http-dev-3");
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-4 Developer_User HTTP /payment-vouchers → 403 allowlist", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-dev-4", {
      id: 514, firmId: ctx.firmId, email: "devhttp4@test.com", name: "Dev H4",
      userType: "firm_user", roleId: ctx.roleIds.Developer_User, status: "active", developerId: ctx.developerId,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_PV).set("Cookie", "auth_token=http-dev-4");
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-5 Developer_User HTTP /users → 403 allowlist", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-dev-5", {
      id: 515, firmId: ctx.firmId, email: "devhttp5@test.com", name: "Dev H5",
      userType: "firm_user", roleId: ctx.roleIds.Developer_User, status: "active", developerId: ctx.developerId,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_USERS).set("Cookie", "auth_token=http-dev-5");
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-6 Developer_User HTTP /cases/1/ledger → 403 allowlist", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-dev-6", {
      id: 516, firmId: ctx.firmId, email: "devhttp6@test.com", name: "Dev H6",
      userType: "firm_user", roleId: ctx.roleIds.Developer_User, status: "active", developerId: ctx.developerId,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_LEDGER).set("Cookie", "auth_token=http-dev-6");
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-7/8 Developer_User portal routes NOT blocked by allowlist (may then fail later biz RLS/empty db → not 403 allowlist)", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-dev-7", {
      id: 517, firmId: ctx.firmId, email: "devhttp7@test.com", name: "Dev H7",
      userType: "firm_user", roleId: ctx.roleIds.Developer_User, status: "active", developerId: ctx.developerId,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r1 = await request(app).get(PATH_PROJECTS).set("Cookie", "auth_token=http-dev-7");
    expect(r1.body?.error?.code).not.toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
    const r2 = await request(app).get(PATH_OVERVIEW).set("Cookie", "auth_token=http-dev-7");
    expect(r2.body?.error?.code).not.toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-9 Partner /quotations never gets DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-p1", {
      id: 611, firmId: ctx.firmId, email: "phttp@test.com", name: "Partner H",
      userType: "firm_user", roleId: ctx.roleIds.Partner, status: "active", developerId: null,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_QUOTATIONS).set("Cookie", "auth_token=http-p1");
    expect(r.body?.error?.code).not.toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-10 Accounting /payment-vouchers never gets DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const ctx = seedBasicFirm();
    seedSessionFor("http-a1", {
      id: 612, firmId: ctx.firmId, email: "ahttp@test.com", name: "Acc H",
      userType: "firm_user", roleId: ctx.roleIds.Accounting, status: "active", developerId: null,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_PV).set("Cookie", "auth_token=http-a1");
    expect(r.body?.error?.code).not.toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-CHAIN-HTTP-11 Founder never gets DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST on normal routes", async () => {
    seedSessionFor("http-f1", {
      id: 9002, firmId: null, email: "founder2@test.com", name: "Founder H",
      userType: "founder", roleId: null, status: "active", developerId: null,
    });
    const { __clearAuthCachesForTests } = await import("../lib/auth.js");
    __clearAuthCachesForTests();
    const r = await request(app).get(PATH_QUOTATIONS).set("Cookie", "auth_token=http-f1");
    expect(r.body?.error?.code).not.toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });
});
