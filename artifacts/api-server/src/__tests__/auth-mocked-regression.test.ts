import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { usersTable, sessionsTable, rolesTable, firmsTable, permissionsTable } from "@workspace/db";
import type { Express } from "express";

type MockDb = {
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
  throwUndefinedColumnOnUserLookup: boolean;
  throwSideEffects: boolean;
};

const state: AuthDbState = {
  usersByEmail: new Map(),
  usersById: new Map(),
  sessionsByTokenHash: new Map(),
  rolesById: new Map(),
  firmsById: new Map(),
  throwPermissionsSelect: false,
  throwUndefinedColumnOnUserLookup: false,
  throwSideEffects: false,
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
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

  const mockDb: MockDb = {
    execute: async () => [{ reg: "public.audit_logs" }],
    select: (sel?: unknown) => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === actual.sessionsTable) {
            const s = Array.from(state.sessionsByTokenHash.values())[0] ?? null;
            return s ? [s] : emptyRows();
          }
          if (table === actual.usersTable) {
            const hasPasswordHash = isRecord(sel) && "passwordHash" in sel;
            if (hasPasswordHash) {
              if (state.throwUndefinedColumnOnUserLookup) {
                const e = new Error('column "totp_secret" does not exist') as Error & { code?: string };
                e.code = "42703";
                throw e;
              }
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
            if (state.throwPermissionsSelect) throw new Error("permissions query failed");
            return [{ module: "cases", action: "read" }];
          }
          return emptyRows();
        },
      }),
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
        where: async () => {
          if (state.throwSideEffects) throw new Error("side effects failed");
          return undefined;
        },
      }),
    }),
  };

  return {
    ...actual,
    db: mockDb as unknown as typeof actual.db,
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
    state.throwUndefinedColumnOnUserLookup = false;
    state.throwSideEffects = true;

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

  it("login returns 401 when user not found even if schema mismatch triggers fallback", async () => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();
    state.throwPermissionsSelect = false;
    state.throwUndefinedColumnOnUserLookup = true;
    state.throwSideEffects = false;

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "noone@example.com", password: "badpw" });
    expect(res.status).toBe(401);
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
    state.throwUndefinedColumnOnUserLookup = false;

    const res = await request(app).get("/api/auth/me").set("Cookie", "auth_token=token");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("permissions");
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });
});
