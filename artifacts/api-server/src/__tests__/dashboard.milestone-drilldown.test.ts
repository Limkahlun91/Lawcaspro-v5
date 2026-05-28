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
      let i = 0;
      req.rlsDb = {
        execute: async () => {
          i += 1;
          if (i === 1) return { rows: [{ reg: "firm_dashboard_stats_cache" }] };
          if (i === 2) return { rows: [{ payload_json: { ok: false, degraded: true, totalCases: 0 } }] };
          return { rows: [] };
        },
      };
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock("../services/dashboard-stats.js", () => {
  return {
    computeDashboardStats: vi.fn(async () => ({
      ok: true,
      degraded: false,
      totalCases: 5,
      activeCases: 4,
      completedCases: 1,
      totalClients: 1,
      totalDevelopers: 1,
      totalProjects: 1,
      recentCases: [],
      milestoneSections: [],
      milestoneCards: [],
      billing: { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
      commsThisMonth: 0,
    })),
  };
});

describe("Dashboard cache does not pin degraded payload", () => {
  it("ignores degraded cached payload and recomputes", async () => {
    const mod = await import("../routes/dashboard.js");
    const router = mod.default;
    const app = express();
    app.use(router);

    const res = await request(app).get("/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.totalCases).toBe(5);
  });
});
