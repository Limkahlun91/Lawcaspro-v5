import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Application } from "express";

type FakeDb = {
  execute: (query?: unknown) => Promise<unknown>;
  select: (sel?: unknown) => {
    from: (table: unknown) => {
      where: (cond?: unknown) => unknown;
      orderBy: (...args: unknown[]) => unknown;
      limit: (n: number) => unknown;
    };
  };
};

var sharedDb: unknown;

function queryable(getRows: () => Promise<unknown[]>) {
  const q: any = {};
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => getRows().then(resolve, reject);
  q.where = () => q;
  q.orderBy = () => q;
  q.limit = () => q;
  return q;
}

function makeDb(): FakeDb {
  const db: FakeDb = {
    execute: async () => [],
    select: (_sel?: unknown) => ({
      from: (_table: unknown) => {
        const q = queryable(async () => []);
        return q;
      },
    }),
  };
  return db;
}

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  const fakeDb = makeDb();
  sharedDb = fakeDb;
  return { ...actual, db: fakeDb as unknown as typeof actual.db };
});

vi.mock("../lib/auth", async (orig) => {
  const actual = await orig<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireFirmUser: (req: any, _res: any, next: any) => {
      req.userId = 10;
      req.userType = "firm_user";
      req.firmId = 1;
      req.roleId = 7;
      req.rlsDb = sharedDb;
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

vi.mock("../services/dashboard-stats", () => ({
  computeDashboardStats: async () => ({
    ok: true,
    degraded: false,
    warnings: [],
    unavailableFields: [],
    totalCases: 0,
    activeCases: 0,
    completedCases: 0,
    totalClients: 0,
    totalProjects: 0,
    totalDevelopers: 0,
    milestoneSections: [],
    milestoneCards: [],
    recentCases: [],
    commsThisMonth: 0,
    completionSlaOverdue: [],
    cashCases: 0,
    loanCases: 0,
    masterTitleCases: 0,
    individualTitleCases: 0,
    strataTitleCases: 0,
  }),
}));

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Documents automation regressions", () => {
  it("POST /api/documents/automation/generate-job returns 202 and jobId (firm only)", async () => {
    const res = await request(app).post("/api/documents/automation/generate-job?blind=true").send({
      caseIds: [3],
      templateIds: [7],
      templates: [{ source: "firm", id: 7 }],
      config: { action: "download" },
    });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("ok", true);
    expect(typeof res.body.jobId).toBe("string");
    expect(res.body.jobId.length).toBeGreaterThan(10);
    expect(res.body).toHaveProperty("status");
  });

  it("GET /api/firm-settings returns 200 with defaults even without firm_settings row", async () => {
    const res = await request(app).get("/api/firm-settings");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body).toHaveProperty("settings");
    expect(res.body.settings).toHaveProperty("useMasterDocuments", true);
    expect(res.body.settings).toHaveProperty("enableFirmLetterhead", false);
  });

  it("GET /api/hub/documents returns 200 (no 503)", async () => {
    const res = await request(app).get("/api/hub/documents");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(Array.isArray(res.body.folders)).toBe(true);
  });

  it("GET /api/dashboard returns 200 and does not require accounting", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body).toHaveProperty("dashboard");
    expect(res.body.dashboard).toHaveProperty("totalCases");
    expect(res.body.dashboard).toHaveProperty("milestoneSections");
    expect(Array.isArray(res.body.dashboard.milestoneSections)).toBe(true);
  });
});

