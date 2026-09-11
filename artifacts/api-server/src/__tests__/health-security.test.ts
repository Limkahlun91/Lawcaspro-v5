import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "express";

const TEST_DEBUG_TOKEN = "TEST-ONLY-R6B-C2-DEBUG-TOKEN-0123456789-ABCDEF";
const FAKE_SECRET_HOST = "secret-host.test-only.example.invalid";
const FAKE_SECRET_ROLE = "test_only_secret_role_XYZ";
const FAKE_SQLSTATE = "TST99";
const FAKE_PROJECT_REF = "testonlyprojrefxxxx";
const FAKE_PG_URL = "postgres://test_only_user:supersecretpass@secret-host.test-only.example.invalid:5432/testonlydb";

const poolConnectSpy: any = vi.fn();
const poolQuerySpy: any = vi.fn();
const drizzleCallSpy: any = vi.fn();

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const client = {
    query: poolQuerySpy.mockImplementation(async (q: string, ..._args: any[]) => {
      if (poolQuerySpy._failAll) {
        const sensitiveErr: any = new Error(
          `connection failed host=${FAKE_SECRET_HOST} role=${FAKE_SECRET_ROLE} SQLSTATE=${FAKE_SQLSTATE} detail=leaked_sekrit_value project_ref=${FAKE_PROJECT_REF}`,
        );
        sensitiveErr.stack = `Error: secret at stack line ${FAKE_PG_URL} / additional_password=TOPSECRET`;
        sensitiveErr.code = FAKE_SQLSTATE;
        sensitiveErr.host = FAKE_SECRET_HOST;
        sensitiveErr.user = FAKE_SECRET_ROLE;
        throw sensitiveErr;
      }
      if (q.includes("current_database()")) {
        return { rows: [{ db: "postgres", user: "lawcaspro_app_user", project_ref: null }] };
      }
      if (q.includes("pg_roles where rolname = current_user")) {
        return { rows: [{ role: "lawcaspro_app_user", bypass: false, superuser: false }] };
      }
      if (q.includes("to_regclass")) {
        return {
          rows: [{
            case_key_dates: true,
            case_workflow_steps: true,
            case_billing_entries: true,
            case_communications: true,
          }],
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(() => undefined),
  };

  const fakeDb = {
    select: (..._: any[]) => ({
      from: (..._2: any[]) => ({
        where: (..._3: any[]) => ({
          limit: (..._4: any[]) => {
            if ((fakeDb as any)._drizzleFail) {
              const sensitiveErr: any = new Error(
                `drizzle failed host=${FAKE_SECRET_HOST} role=${FAKE_SECRET_ROLE} SQLSTATE=${FAKE_SQLSTATE}`,
              );
              sensitiveErr.stack = `Error at ${FAKE_PG_URL}`;
              throw sensitiveErr;
            }
            drizzleCallSpy();
            return Promise.resolve([{ status: "active" }]);
          },
        }),
      }),
    }),
  };

  return {
    ...actual,
    db: fakeDb,
    usersTable: actual.usersTable,
    sql: actual.sql,
    pool: {
      ...actual.pool,
      query: poolQuerySpy,
      connect: async () => {
        poolConnectSpy();
        if (poolConnectSpy._failAll) {
          const e: any = new Error(`connect failed host=${FAKE_SECRET_HOST} role=${FAKE_SECRET_ROLE} SQLSTATE=${FAKE_SQLSTATE}`);
          e.stack = `stack ${FAKE_PG_URL}`;
          e.code = FAKE_SQLSTATE;
          e.host = FAKE_SECRET_HOST;
          throw e;
        }
        return client as unknown as Awaited<ReturnType<typeof actual.pool.connect>>;
      },
    } as unknown as typeof actual.pool,
  };
});

const SECRET_SENTINELS = [
  FAKE_SECRET_HOST,
  FAKE_SECRET_ROLE,
  FAKE_SQLSTATE,
  FAKE_PROJECT_REF,
  "TOPSECRET",
  "supersecretpass",
  "postgres://",
  "postgresql://",
  "secret-host",
  "leaked_sekrit_value",
  "SQLSTATE",
  "stack line",
];

const assertNoSecretsLeak = (payload: unknown, label: string) => {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  const lower = serialized.toLowerCase();
  for (const s of SECRET_SENTINELS) {
    const needle = s.toLowerCase();
    const present = lower.includes(needle);
    if (present) {
      // Provide precise location on failure: first 80 chars around hit
      const idx = lower.indexOf(needle);
      const ctx = lower.slice(Math.max(0, idx - 20), idx + needle.length + 20);
      expect(`${label} LEAKED sentinel starting …${ctx}…`).toBe("SAFE");
    }
    expect(present).toBe(false);
  }
  expect(lower).not.toMatch(/error:\s+connection failed/);
  expect(lower).not.toMatch(/host=[^\s"]+\.example\.invalid/);
  expect(lower).not.toMatch(/postgres(?:ql)?:\/\//);
  expect(lower).not.toContain("sqlstate");
  expect(lower).not.toContain("additional_password=");
};

let app: Application;

describe.sequential("HSEC — Health Diagnostic Route Security", () => {
  beforeAll(async () => {
    vi.stubEnv("API_DEBUG_TOKEN", TEST_DEBUG_TOKEN);
    vi.stubEnv("NODE_ENV", "test");
    const mod = await import("../app");
    app = mod.default;
  });

  beforeEach(() => {
    poolConnectSpy.mockClear();
    poolQuerySpy.mockClear();
    drizzleCallSpy.mockClear();
    delete (poolQuerySpy as any)._failAll;
    delete (poolConnectSpy as any)._failAll;
    delete (vi.mocked as any)?._drizzleFail;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("HSEC-1: anonymous /healthz/dbinfo => 404", async () => {
    const res = await request(app).get("/api/healthz/dbinfo");
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
  });

  it("HSEC-2: anonymous /healthz/founder-exists => 404 before DB query", async () => {
    const res = await request(app).get("/api/healthz/founder-exists?email=any@example.com");
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
    expect(drizzleCallSpy).toHaveBeenCalledTimes(0);
  });

  it("HSEC-3: anonymous /healthz/founder-status => 404", async () => {
    const res = await request(app).get("/api/healthz/founder-status");
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
  });

  it("HSEC-4: anonymous /healthz/rls-role => 404", async () => {
    const res = await request(app).get("/api/healthz/rls-role");
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
  });

  it("HSEC-5: anonymous /healthz/schema => 404", async () => {
    const res = await request(app).get("/api/healthz/schema");
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
  });

  it("HSEC-6: wrong debug token => 404", async () => {
    const res = await request(app)
      .get("/api/healthz/dbinfo")
      .set("x-debug-token", "WRONG-TOKEN-VALUE-0000-DIFFERENT-LENGTH-ABCDEF");
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
  });

  it("HSEC-7: valid TEST-ONLY debug token allows diagnostic handler", async () => {
    const res = await request(app)
      .get("/api/healthz/dbinfo")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });

  it("HSEC-8: /healthz/version => 200 without token", async () => {
    const res = await request(app).get("/api/healthz/version");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });

  it("HSEC-9: /healthz/db public health-only and contains no URL/secret/project credential", async () => {
    const res = await request(app).get("/api/healthz/db");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "ok" });
    expect(Object.keys(res.body).sort()).toEqual(["db", "status"]);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toMatch(/postgres/i);
    expect(bodyStr).not.toMatch(/password/i);
    expect(bodyStr).not.toMatch(/DATABASE_URL/i);
    expect(bodyStr).not.toMatch(/:\/\/[^\s]{3,}/);
    expect(bodyStr).not.toMatch(/error/i);
  });

  it("HSEC-10: dbinfo authenticated response contains no databaseUrlSanitized field", async () => {
    const res = await request(app)
      .get("/api/healthz/dbinfo")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("databaseUrlSanitized");
    expect(res.body).not.toHaveProperty("serverAddr");
    expect(res.body).not.toHaveProperty("isPostgresUrl");
    expect(res.body).not.toHaveProperty("hostSuffix");
    expect(res.body).not.toHaveProperty("rawConnection");
    expect(res.body).not.toHaveProperty("password");
    expect(res.body).toHaveProperty("currentDatabase");
    expect(res.body).toHaveProperty("currentUser");
    expect(res.body).toHaveProperty("supabaseProjectRef");
  });

  it("HSEC-11: /healthz/db failure path returns minimal 500 with no leak", async () => {
    (poolQuerySpy as any)._failAll = true;
    (poolConnectSpy as any)._failAll = true;

    const res = await request(app).get("/api/healthz/db");
    expect(res.status).toBe(500);

    expect(res.body).toMatchObject({ status: "error", db: "error" });
    expect(Object.keys(res.body).sort()).toEqual(["db", "status"]);

    const serialized = JSON.stringify(res.body).toLowerCase();
    expect(serialized).not.toContain("connection failed");
    expect(serialized).not.toContain(FAKE_SECRET_HOST.toLowerCase());
    expect(serialized).not.toContain(FAKE_SECRET_ROLE.toLowerCase());
    expect(serialized).not.toContain(FAKE_SQLSTATE.toLowerCase());
    expect(serialized).not.toContain("postgres");
    expect(serialized).not.toContain("database_url");
    expect(serialized).not.toContain("sqlstate");
    expect(serialized).not.toContain("stack");
    expect(res.body).not.toHaveProperty("error");
    expect(res.body).not.toHaveProperty("message");
  });

  it("HSEC-12: server API_DEBUG_TOKEN empty => 404 before DB access", async () => {
    vi.stubEnv("API_DEBUG_TOKEN", "");
    try {
      const res = await request(app)
        .get("/api/healthz/dbinfo")
        .set("x-debug-token", TEST_DEBUG_TOKEN);
      expect(res.status).toBe(404);
      expect(poolConnectSpy).toHaveBeenCalledTimes(0);
      expect(poolQuerySpy).toHaveBeenCalledTimes(0);

      const res2 = await request(app)
        .get("/api/healthz/founder-status")
        .set("x-debug-token", TEST_DEBUG_TOKEN);
      expect(res2.status).toBe(404);
      expect(poolConnectSpy).toHaveBeenCalledTimes(0);
    } finally {
      vi.stubEnv("API_DEBUG_TOKEN", TEST_DEBUG_TOKEN);
    }
  });

  it("HSEC-13: /healthz/dbinfo query failure => sanitized response, no secrets", async () => {
    (poolQuerySpy as any)._failAll = true;
    const res = await request(app)
      .get("/api/healthz/dbinfo")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("status", "error");
    expect(res.body).toHaveProperty("error", "Health check unavailable");
    expect(Object.keys(res.body).sort()).toEqual(["error", "status"]);
    assertNoSecretsLeak(res.body, "dbinfo-fail");
  });

  it("HSEC-14: /healthz/founder-exists query failure => sanitized response, no secrets", async () => {
    const dbMod = await import("@workspace/db");
    (dbMod.db as any)._drizzleFail = true;
    const res = await request(app)
      .get("/api/healthz/founder-exists?email=founder@example.test")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    try {
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("status", "error");
      expect(res.body).toHaveProperty("error", "Health check unavailable");
      expect(Object.keys(res.body).sort()).toEqual(["error", "status"]);
      assertNoSecretsLeak(res.body, "founder-exists-fail");
    } finally {
      delete (dbMod.db as any)._drizzleFail;
    }
  });

  it("HSEC-15: /healthz/founder-status connect failure => sanitized response, no secrets", async () => {
    (poolConnectSpy as any)._failAll = true;
    const res = await request(app)
      .get("/api/healthz/founder-status")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("status", "error");
    expect(res.body).toHaveProperty("error", "Health check unavailable");
    expect(Object.keys(res.body).sort()).toEqual(["error", "status"]);
    assertNoSecretsLeak(res.body, "founder-status-connect-fail");
  });

  it("HSEC-16: /healthz/founder-status query failure => sanitized response, no secrets", async () => {
    (poolQuerySpy as any)._failAll = true;
    const res = await request(app)
      .get("/api/healthz/founder-status")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("status", "error");
    expect(res.body).toHaveProperty("error", "Health check unavailable");
    expect(Object.keys(res.body).sort()).toEqual(["error", "status"]);
    assertNoSecretsLeak(res.body, "founder-status-query-fail");
  });

  it("HSEC-17: /healthz/rls-role connect failure => sanitized response, no secrets", async () => {
    (poolConnectSpy as any)._failAll = true;
    const res = await request(app)
      .get("/api/healthz/rls-role")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("ok", false);
    expect(res.body).toHaveProperty("status", "error");
    expect(res.body).toHaveProperty("error", "Health check unavailable");
    const keys = Object.keys(res.body).sort();
    expect(keys).toEqual(["error", "ok", "status"]);
    assertNoSecretsLeak(res.body, "rls-role-connect-fail");
  });

  it("HSEC-18: /healthz/rls-role query failure => sanitized response, no secrets", async () => {
    (poolQuerySpy as any)._failAll = true;
    const res = await request(app)
      .get("/api/healthz/rls-role")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("ok", false);
    expect(res.body).toHaveProperty("status", "error");
    expect(res.body).toHaveProperty("error", "Health check unavailable");
    assertNoSecretsLeak(res.body, "rls-role-query-fail");
  });

  it("HSEC-19: /healthz/schema connect failure (non-production) => sanitized response, no secrets", async () => {
    (poolConnectSpy as any)._failAll = true;
    const res = await request(app)
      .get("/api/healthz/schema")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("status", "error");
    expect(res.body).toHaveProperty("schema", "error");
    expect(res.body).toHaveProperty("error", "Health check unavailable");
    assertNoSecretsLeak(res.body, "schema-connect-fail");
  });

  it("HSEC-20: /healthz/schema query failure (non-production) => sanitized response, no secrets + trySelect never emits raw selectError", async () => {
    (poolQuerySpy as any)._failAll = true;
    const res = await request(app)
      .get("/api/healthz/schema")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("status", "error");
    expect(res.body).toHaveProperty("schema", "error");
    expect(res.body).toHaveProperty("error", "Health check unavailable");
    assertNoSecretsLeak(res.body, "schema-query-fail");
    expect(res.text).not.toContain("selectError");
  });
});
