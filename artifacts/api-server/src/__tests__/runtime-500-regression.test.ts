import request from "supertest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "express-async-errors";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { sendError, classifyErrorForLog, resolveDbBusyResponse, ApiError } from "../lib/api-response.js";

let token: string;
const skipDb = process.env.VITEST_SKIP_DB === "1";

beforeAll(async () => {
  if (skipDb) return;
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@test.com", password: "password123" });
  expect(res.status).toBe(200);
  token = res.body?.data?.token;
  expect(typeof token).toBe("string");
});

describe("Runtime 500 regressions (no-db)", () => {
  const isEnvelopeUnauthorized = (body: any): boolean =>
    !!body &&
    typeof body === "object" &&
    body.ok === false &&
    typeof body.error?.message === "string" &&
    body.error.message.length > 0;

  const isLegacyUnauthorized = (body: any): boolean =>
    !!body && typeof body === "object" && typeof body.error === "string" && body.error.length > 0;

  it("auth/me unauthenticated returns 200 or 401 (not 500)", async () => {
    const res = await request(app).get("/api/auth/me");
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body?.ok).toBe(true);
      expect(res.body?.data).toBeNull();
    }
    if (res.status === 401) {
      expect(isEnvelopeUnauthorized(res.body) || isLegacyUnauthorized(res.body)).toBe(true);
      expect(res.body).not.toHaveProperty("detail");
      expect(res.body).not.toHaveProperty("stack");
      expect(res.body).not.toHaveProperty("sql");
    }
  });

  it("users create unauthenticated returns 401 (not 500)", async () => {
    const res = await request(app).post("/api/users").send({ email: "x@test.com" });
    expect(res.status).toBe(401);
    expect(isEnvelopeUnauthorized(res.body) || isLegacyUnauthorized(res.body)).toBe(true);
    expect(res.body).not.toHaveProperty("detail");
    expect(res.body).not.toHaveProperty("stack");
    expect(res.body).not.toHaveProperty("sql");
  });

  it("hub/documents unauthenticated returns 401 (not 500)", async () => {
    const res = await request(app).get("/api/hub/documents");
    expect(res.status).toBe(401);
    expect(isEnvelopeUnauthorized(res.body) || isLegacyUnauthorized(res.body)).toBe(true);
    expect(res.body).not.toHaveProperty("detail");
    expect(res.body).not.toHaveProperty("stack");
    expect(res.body).not.toHaveProperty("sql");
  });

  it("auth/login invalid body returns 400 (not 500)", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error?.message).toBeTruthy();
    expect(res.body).not.toHaveProperty("detail");
    expect(res.body).not.toHaveProperty("stack");
    expect(res.body).not.toHaveProperty("sql");
  });
});

describe("P0 V4 — express-async-errors forwards rejected async handlers to Express error middleware", () => {
  let unhandledCount = 0;
  const unhandledHandler = () => {
    unhandledCount++;
  };
  let capturedError: unknown = null;

  beforeAll(() => {
    process.on("unhandledRejection", unhandledHandler);
  });
  afterAll(() => {
    process.removeListener("unhandledRejection", unhandledHandler);
  });
  beforeEach(() => {
    unhandledCount = 0;
    capturedError = null;
  });

  const buildTestApp = () => {
    const testApp = express();
    testApp.use(express.json());

    // 1. Deliberately rejecting async route (registered FIRST)
    testApp.get("/__p0_async_throw", async (_req, _res) => {
      await Promise.resolve();
      throw new Error("P0_ASYNC_BOOM");
    });

    // 2. Healthy probe route
    testApp.get("/__p0_health", (_req, res) => {
      res.status(200).json({ status: "ok" });
    });

    // 3. Minimal test-only error middleware (AFTER routes) — captures the forwarded error
    testApp.use((err: unknown, _req: any, res: any, _next: any) => {
      capturedError = err;
      if (res.headersSent) {
        // If headers already sent, fallback to Express default close behavior.
        // Not calling _next(err) here because we want deterministic JSON 500.
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      res.status(500).json({
        ok: false,
        error: {
          code: "__P0_TEST_500__",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });

    return testApp;
  };

  it("rejected async route → next(err) → error middleware → HTTP 500 → no unhandledRejection → subsequent health OK", async () => {
    const testApp = buildTestApp();
    const agent = request(testApp);

    const boom = await agent.get("/__p0_async_throw");
    expect(boom.status).toBe(500);
    expect(String(boom.headers["content-type"] ?? "")).toContain("json");
    expect(boom.body?.ok).toBe(false);
    expect(boom.body?.error?.code).toBe("__P0_TEST_500__");
    expect(boom.body?.error?.message).toBe("P0_ASYNC_BOOM");

    // Proof that the exact error object reached error middleware via next(err)
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error)?.message).toBe("P0_ASYNC_BOOM");

    // Supplementary: allow a tick for stray Promise to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandledCount).toBe(0);

    // Primary: subsequent health request still succeeds (server alive)
    const health = await agent.get("/__p0_health");
    expect(health.status).toBe(200);
    expect(health.body?.status).toBe("ok");
  });
});

describe("P0 V5 — Accounting summary structural regression guard (DB-independent, source scanner)", () => {
  it("V5 structural guard: /accounting/summary handler body must not call bare queryRows(sql...); must contain exactly 4 queryRowsFrom(...) calls; req.rlsDb ?? db must be present; firm_id filters retained", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const src = fs.readFileSync(path.resolve(__dirname, "../routes/accounting.ts"), "utf8") as string;

    const summaryRouteIdx = src.indexOf('/accounting/summary');
    expect(summaryRouteIdx).toBeGreaterThan(0);

    // Correct single-match boundary: FIRST subsequent newline-level `router.`
    const afterSummary = src.slice(summaryRouteIdx);
    const match = /\nrouter\./.exec(afterSummary);
    const end = match ? match.index : afterSummary.length;
    const summaryHandlerBody = afterSummary.slice(0, end);

    // (1) No bare `queryRows(sql\``
    const bareMatches = summaryHandlerBody.match(/\bqueryRows\s*\(\s*sql`/g) || [];
    expect(bareMatches).toEqual([]);

    // (2) Exactly 4 `queryRowsFrom(` calls (4 queries: topCases, monthly, totals, byCategory)
    const fromMatches = summaryHandlerBody.match(/\bqueryRowsFrom\s*\(/g) || [];
    expect(fromMatches.length).toBe(4);

    // (3) req.rlsDb ?? db must appear at least once
    const rlsDbFallbackCount = (summaryHandlerBody.match(/req\.rlsDb\s*\?\?\s*db/g) || []).length;
    expect(rlsDbFallbackCount).toBeGreaterThanOrEqual(1);

    // (4) Explicit firm_id filters retained — expected 4 (one per query)
    const firmIdMatches = summaryHandlerBody.match(/firm_id\s*=\s*\$\{req\.firmId!\}/g) || [];
    expect(firmIdMatches.length).toBeGreaterThanOrEqual(4);
  });
});

const suite = skipDb ? describe.skip : describe;

suite("Runtime 500 regressions (with-db)", () => {
  it("dashboard does not 500 for valid auth", async () => {
    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });

  it("cases list does not 500 with milestone + overdue filters", async () => {
    const res = await request(app)
      .get("/api/cases")
      .query({
        page: 1,
        limit: 50,
        sortBy: "updatedAt",
        sortDir: "desc",
        milestone: "loan_docs_signed_date",
        milestonePresence: "missing",
        overdueDays: 7,
      })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });

  it("cases workbench does not 500 for valid auth", async () => {
    const res = await request(app)
      .get("/api/cases/workbench")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });
});
