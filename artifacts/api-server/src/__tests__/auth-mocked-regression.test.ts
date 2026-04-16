import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { usersTable, sessionsTable, rolesTable, firmsTable, permissionsTable } from "@workspace/db";
import type { Express } from "express";

type AuthDb = {
  execute: (query?: unknown) => Promise<unknown[]>;
  select: (sel?: unknown) => { from: (table: unknown) => { where: (cond?: unknown) => Promise<unknown[]> } };
  insert: (table: unknown) => { values: (values: unknown) => Promise<void> };
  update: (table: unknown) => { set: (values: unknown) => { where: (cond?: unknown) => Promise<void> } };
};

type AuthDbState = {
  usersByEmail: Map<string, unknown>;
  usersById: Map<number, unknown>;
  sessionsByTokenHash: Map<string, unknown>;
  rolesById: Map<number, unknown>;
  firmsById: Map<number, unknown>;
  throwPermissionsSelect: boolean;
};

const state: AuthDbState = {
  usersByEmail: new Map(),
  usersById: new Map(),
  sessionsByTokenHash: new Map(),
  rolesById: new Map(),
  firmsById: new Map(),
  throwPermissionsSelect: false,
};

vi.mock("bcryptjs", () => ({
  default: {
    compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
    hash: async () => "hash",
  },
  compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
  hash: async () => "hash",
}));

vi.mock("../lib/auth-safe-db", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;

  const emptyRows = (): unknown[] => [];

  const makeAuthDb = (): AuthDb => ({
    execute: async () => [{ reg: "public.audit_logs" }],
    select: () => ({
      from: () => ({
        where: async () => emptyRows(),
      }),
    }),
    insert: () => ({
      values: async () => undefined,
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  });

  const withAuthSafeDb = async (
    fn: (authDb: AuthDb) => Promise<unknown>,
    opts: { ctx?: { stage?: unknown } } | undefined
  ) => {
    const stage = typeof opts?.ctx?.stage === "string" ? opts.ctx.stage : undefined;
    if (stage === "side_effects.persist") {
      throw new Error("audit write failed");
    }

    const authDb = makeAuthDb();

    authDb.select = () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === usersTable && stage === "user_lookup") {
            const u = Array.from(state.usersByEmail.values())[0] ?? null;
            return u ? [u] : emptyRows();
          }
          if (table === sessionsTable && stage === "me") {
            const s = Array.from(state.sessionsByTokenHash.values())[0] ?? null;
            return s ? [s] : emptyRows();
          }
          if (table === usersTable && stage === "me") {
            const s = Array.from(state.sessionsByTokenHash.values())[0] ?? null;
            const userId = (s as { userId?: unknown } | null)?.userId;
            const u = typeof userId === "number" ? (state.usersById.get(userId) ?? null) : null;
            return u ? [u] : emptyRows();
          }
          if (table === rolesTable) {
            const anyUser = Array.from(state.usersById.values())[0] ?? Array.from(state.usersByEmail.values())[0] ?? null;
            const roleId = (anyUser as { roleId?: unknown } | null)?.roleId ?? null;
            const r = typeof roleId === "number" ? (state.rolesById.get(roleId) ?? null) : null;
            return r ? [r] : emptyRows();
          }
          if (table === firmsTable) {
            const anyUser = Array.from(state.usersById.values())[0] ?? Array.from(state.usersByEmail.values())[0] ?? null;
            const firmId = (anyUser as { firmId?: unknown } | null)?.firmId ?? null;
            const f = typeof firmId === "number" ? (state.firmsById.get(firmId) ?? null) : null;
            return f ? [f] : emptyRows();
          }
          if (table === permissionsTable) {
            if (state.throwPermissionsSelect) throw new Error("permissions query failed");
            return [{ module: "cases", action: "read" }];
          }
          return emptyRows();
        },
      }),
    });

    authDb.insert = (table: unknown) => ({
      values: async (values: unknown) => {
        if (table === sessionsTable) {
          const v = values as { tokenHash: string; userId: number; expiresAt: Date };
          state.sessionsByTokenHash.set(String(v.tokenHash), {
            userId: v.userId,
            expiresAt: v.expiresAt,
          });
        }
        return undefined;
      },
    });

    return fn(authDb);
  };

  const isTransientDbConnectionError =
    (actual.isTransientDbConnectionError as ((err: unknown) => boolean) | undefined) ?? (() => false);
  return { ...(actual as object), withAuthSafeDb, isTransientDbConnectionError };
});

let app: Express;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Auth mocked regressions", () => {
  it("login succeeds even if side effects fail", async () => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();
    state.throwPermissionsSelect = false;

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
    state.usersByEmail.set("user@test.com", user);
    state.usersById.set(10, user);
    state.rolesById.set(7, { id: 7, name: "Clerk" });
    state.firmsById.set(5, { id: 5, name: "Firm" });

    const res = await request(app).post("/api/auth/login").send({ email: "user@test.com", password: "goodpw" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.headers["set-cookie"]).toBeTruthy();
  });

  it("auth/me no token returns 204", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(204);
  });

  it("auth/me invalid token returns 401 and clears cookie", async () => {
    state.sessionsByTokenHash.clear();
    const res = await request(app).get("/api/auth/me").set("Cookie", "auth_token=invalid");
    expect(res.status).toBe(401);
    const scHeader = (res.headers as Record<string, unknown>)["set-cookie"];
    const sc = Array.isArray(scHeader) ? scHeader.join(";") : String(scHeader ?? "");
    expect(sc).toMatch(/auth_token=/);
  });

  it("auth/me returns 200 and degrades when permissions query fails", async () => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();

    const user = {
      id: 11,
      firmId: 5,
      email: "p@test.com",
      name: "P",
      userType: "firm_user",
      roleId: 7,
      department: null,
      status: "active",
    };
    state.usersById.set(11, user);
    state.rolesById.set(7, { id: 7, name: "Clerk" });
    state.firmsById.set(5, { id: 5, name: "Firm" });

    state.sessionsByTokenHash.set("th", { userId: 11, expiresAt: new Date(Date.now() + 60_000) });
    state.throwPermissionsSelect = true;

    const res = await request(app).get("/api/auth/me").set("Cookie", "auth_token=token");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("permissions");
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });
});
