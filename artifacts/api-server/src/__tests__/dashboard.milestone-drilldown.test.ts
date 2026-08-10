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
        all: async (_: unknown) => {
          i += 1;
          if (i === 1) return { rows: [{ c: 5 }] };
          if (i === 2) return { rows: [{ c: 3 }] };
          if (i === 3) return { rows: [{ c: 2 }] };
          if (i === 4) return { rows: [{ c: 1 }] };
          return { rows: [] };
        },
      };
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireManagementRoleForDashboard: (_req: any, _res: any, next: any) => next(),
    hasCasesFirmwideScope: async () => true,
    writeAuditLog: async () => {},
  };
});

describe("Dashboard cache does not pin degraded payload", () => {
  it("returns summary-only dashboard without timing out", async () => {
    const mod = await import("../routes/dashboard.js");
    const router = mod.default;
    const app = express();
    app.use(router);

    const res = await request(app).get("/dashboard?includeStats=0");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dashboard.totalCases).toBe(5);
    expect(res.body.dashboard.totalClients).toBe(3);
    expect(res.body.dashboard.totalProjects).toBe(2);
    expect(res.body.dashboard.totalDevelopers).toBe(1);
  });
});
