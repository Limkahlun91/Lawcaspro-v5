import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "express";

const { withAuthAdminDbMock, isAuthAdminDbConfiguredMock, withAuthSafeDbMock } = vi.hoisted(() => ({
  withAuthAdminDbMock: vi.fn(),
  isAuthAdminDbConfiguredMock: vi.fn(),
  withAuthSafeDbMock: vi.fn(),
}));

const { logger } = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../lib/logger.js", () => ({ logger }));

vi.mock("../lib/auth-admin-db.js", () => ({
  withAuthAdminDb: withAuthAdminDbMock,
  isAuthAdminDbConfigured: isAuthAdminDbConfiguredMock,
}));

vi.mock("../lib/auth-safe-db.js", async (orig) => {
  const actual = await orig<typeof import("../lib/auth-safe-db.js")>();
  return { ...actual, withAuthSafeDb: withAuthSafeDbMock };
});

vi.mock("bcryptjs", () => ({
  default: { compare: async () => false, hash: async () => "hash" },
  compare: async () => false,
  hash: async () => "hash",
}));

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  return { ...actual, db: {} as unknown as typeof actual.db };
});

let app: Application;

function makePgError(code: string) {
  const e = new Error("db error") as Error & { cause?: unknown };
  (e as { cause?: unknown }).cause = { code };
  return e;
}

function makeDbLike(userRows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => userRows,
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
  };
}

type DbLike = ReturnType<typeof makeDbLike>;
type SafeDbFn<T> = (db: DbLike) => Promise<T>;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

beforeEach(() => {
  withAuthAdminDbMock.mockReset();
  isAuthAdminDbConfiguredMock.mockReset();
  withAuthSafeDbMock.mockReset();
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe("POST /api/auth/login admin-db fallback", () => {
  it("nonexistent email returns 401 (not 503) when auth-admin DB has invalid credentials", async () => {
    isAuthAdminDbConfiguredMock.mockReturnValue(true);
    withAuthAdminDbMock.mockRejectedValue(makePgError("28P01"));
    withAuthSafeDbMock.mockImplementation(async (fn: SafeDbFn<unknown>) => await fn(makeDbLike([])));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "noone@example.com", password: "badpw" });

    expect(res.status).toBe(401);
    expect(res.body?.ok).toBe(false);
  });

  it("wrong password returns 401 (not 503) when auth-admin DB has invalid credentials", async () => {
    isAuthAdminDbConfiguredMock.mockReturnValue(true);
    withAuthAdminDbMock.mockRejectedValue(makePgError("28P01"));
    withAuthSafeDbMock.mockImplementation(async (fn: SafeDbFn<unknown>) => {
      const user = {
        id: 10,
        firmId: null,
        email: "user@test.com",
        name: "User",
        passwordHash: "hash",
        userType: "firm_user",
        roleId: null,
        status: "active",
        totpSecret: null,
        totpEnabled: false,
      };
      return await fn(makeDbLike([user]));
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@test.com", password: "wrongpw" });

    expect(res.status).toBe(401);
    expect(res.body?.ok).toBe(false);
  });

  it("transient DB errors still return 503", async () => {
    isAuthAdminDbConfiguredMock.mockReturnValue(true);
    const e = new Error("connect timeout") as Error & { code?: string };
    e.code = "ETIMEDOUT";
    withAuthAdminDbMock.mockRejectedValue(e);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "noone@example.com", password: "badpw" });

    expect(res.status).toBe(503);
    expect(res.body?.ok).toBe(false);
  });

  it("RLS/permission error returns 503 with AUTH_LOOKUP_RLS_BLOCKED and logs sqlstate", async () => {
    isAuthAdminDbConfiguredMock.mockReturnValue(true);
    withAuthAdminDbMock.mockRejectedValue(makePgError("42501"));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "noone@example.com", password: "badpw" });

    expect(res.status).toBe(503);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error?.code).toBe("AUTH_LOOKUP_RLS_BLOCKED");

    const errorCalls = logger.error.mock.calls.map(c => String(c[1] ?? ""));
    expect(errorCalls.some(m => m === "auth.lookup_rls_blocked")).toBe(true);
  });
});
