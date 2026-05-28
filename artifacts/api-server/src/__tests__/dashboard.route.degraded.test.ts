import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/auth.js", () => {
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.userId = 1;
      req.firmId = 1;
      req.roleId = 1;
      req.userType = "firm_user";
      next();
    },
    requireFirmUser: (req: any, _res: any, next: any) => {
      req.rlsDb = {
        execute: async () => ({ rows: [] }),
      };
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock("../services/dashboard-stats.js", () => {
  return {
    computeDashboardStats: vi.fn(async () => {
      throw new Error("boom");
    }),
  };
});

describe("GET /dashboard degraded", () => {
  it("returns 200 degraded payload when computeDashboardStats throws", async () => {
    const mod = await import("../routes/dashboard.js");
    const router = mod.default;
    const app = express();
    app.use(router);

    const res = await request(app).get("/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      degraded: true,
      error: "Dashboard partially unavailable",
    });
    expect(res.body.stats).toBeTruthy();
    expect(res.body.dashboard).toBeTruthy();
  });
});

