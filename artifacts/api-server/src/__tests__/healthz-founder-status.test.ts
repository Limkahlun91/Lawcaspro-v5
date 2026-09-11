import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "express";

const TEST_DEBUG_TOKEN = "TEST-ONLY-R6B-C2-FOUNDER-STATUS-98765";

const poolConnectSpy: any = vi.fn();
const poolQuerySpy: any = vi.fn();

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const client = {
    query: poolQuerySpy.mockImplementation(async (q: string) => {
      if (q.includes("select status from users where user_type = 'founder'")) {
        return {
          rows: [
            { status: "active" },
            { status: "inactive" },
          ],
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(() => undefined),
  };

  return {
    ...actual,
    pool: {
      ...actual.pool,
      query: poolQuerySpy,
      connect: async () => {
        poolConnectSpy();
        return client as unknown as Awaited<ReturnType<typeof actual.pool.connect>>;
      },
    } as unknown as typeof actual.pool,
  };
});

describe.sequential("Healthz founder status (hardened)", () => {
  let app: Application;

  beforeAll(async () => {
    vi.stubEnv("API_DEBUG_TOKEN", TEST_DEBUG_TOKEN);
    vi.stubEnv("NODE_ENV", "test");
    const mod = await import("../app");
    app = mod.default;
  });

  beforeEach(() => {
    poolConnectSpy.mockClear();
    poolQuerySpy.mockClear();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("anonymous => 404 before any query", async () => {
    const res = await request(app).get("/api/healthz/founder-status");
    expect(res.status).toBe(404);
  });

  it("wrong debug token => 404", async () => {
    const res = await request(app)
      .get("/api/healthz/founder-status")
      .set("x-debug-token", "WRONG-TOKEN-DIFFERENT");
    expect(res.status).toBe(404);
  });

  it("valid debug token returns counts only, no PII", async () => {
    const res = await request(app)
      .get("/api/healthz/founder-status")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      founderCount: 2,
      activeFounderCount: 1,
    });
    expect(res.body).not.toHaveProperty("expectedFounderEmail");
    expect(res.body).not.toHaveProperty("expectedExists");
    expect(res.body).not.toHaveProperty("email");
    expect(res.body).not.toHaveProperty("id");
  });
});

describe.sequential("Healthz schema endpoint production protection", () => {
  let app: Application;

  beforeAll(async () => {
    vi.stubEnv("API_DEBUG_TOKEN", TEST_DEBUG_TOKEN);
    vi.stubEnv("NODE_ENV", "production");
    const mod = await import("../app");
    app = mod.default;
  });

  beforeEach(() => {
    poolConnectSpy.mockClear();
    poolQuerySpy.mockClear();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("NODE_ENV=production + correct debug token => /healthz/schema returns 404, no DB work", async () => {
    const res = await request(app)
      .get("/api/healthz/schema")
      .set("x-debug-token", TEST_DEBUG_TOKEN);
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
    expect(poolQuerySpy).toHaveBeenCalledTimes(0);
  });

  it("NODE_ENV=production + anonymous => /healthz/schema still 404 (no leak)", async () => {
    const res = await request(app).get("/api/healthz/schema");
    expect(res.status).toBe(404);
    expect(poolConnectSpy).toHaveBeenCalledTimes(0);
  });
});
