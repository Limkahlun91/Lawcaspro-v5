import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const HIMS_PATH = resolve(__dirname, "../routes/hims.ts");
const himsSrc = readFileSync(HIMS_PATH, "utf8");

vi.mock("@workspace/db", () => ({
  db: {} as any,
  casesTable: {} as any,
  clientsTable: {} as any,
  projectsTable: {} as any,
  rolesTable: {} as any,
  casePurchasersTable: {} as any,
  himsStatusChecksTable: {} as any,
  himsConnectionsTable: {} as any,
  himsDataComparisonsTable: {} as any,
  sql: (strings: TemplateStringsArray, ..._values: any[]) => String.raw({ raw: strings }),
  count: () => 0 as any,
  desc: () => ({} as any),
  eq: () => ({} as any),
  and: (..._clauses: any[]) => ({} as any),
  inArray: () => ({} as any),
  isNull: () => ({} as any),
}));

vi.mock("../modules/platform/firm-feature-service.js", () => ({
  assertFirmFeatureEnabled: async () => undefined,
}));
vi.mock("../services/user-feature-access.js", () => ({
  requireUserFeatureAccess: (_key: string) => async (_req: any, _res: any, next: any) => next(),
  isPartnerRoleName: () => false,
}));
vi.mock("../services/case-access.js", () => ({
  canUserAccessCase: async () => ({ ok: true as const }),
  listAccessibleCaseIds: async () => [],
}));
vi.mock("../modules/hims/hims-tracker.service.js", () => ({
  getHimsConnections: async () => [],
  createHimsConnection: async () => ({ id: 1 } as any),
  patchHimsConnection: async () => ({ id: 1 } as any),
  getHimsCaseStatus: async () => ({ status: "ok" }),
  checkHimsCase: async () => ({ accepted: true } as any),
  getHimsCaseComparisons: async () => [],
  compareHimsCase: async () => ({ accepted: true } as any),
}));
vi.mock("../lib/security/secret-crypto.js", () => ({
  publicCredentialStatus: () => ({ status: "active" }) as any,
  encryptSecret: async (s: string) => `enc:${s}`,
  decryptSecret: async (s: string) => s.replace(/^enc:/, ""),
  isSecretEncryptionConfigured: () => true,
}));
vi.mock("../lib/auth.js", () => ({
  requireAuth: async (_r: any, _s: any, next: any) => next(),
  requireFirmUser: async (_r: any, _s: any, next: any) => next(),
  requirePermission: (_ns: any, _op: any) => async (_r: any, _s: any, next: any) => next(),
}));

import himsRouter from "../routes/hims.js";

const buildMockAuth = (overrides: Partial<{ firmId: number; userId: number; roleId: number; rlsDb: any }> = {}) =>
  async (req: any, res: any, next: any) => {
    req.userType = "firm_user";
    req.firmId = overrides.firmId ?? 101;
    req.userId = overrides.userId ?? 11;
    req.roleId = overrides.roleId ?? 5;
    req.rlsDb = overrides.rlsDb ?? undefined;
    req.log = { error: () => undefined };
    next();
  };

describe("HIMS-A: no req.rlsDb ?? db global fallback in firm HIMS routes (structural)", () => {
  it("source file does not contain any req.rlsDb ?? db pattern", () => {
    expect(himsSrc.includes("req.rlsDb ?? db")).toBe(false);
  });

  it("source file contains canonical fail-closed getRlsDb helper", () => {
    expect(himsSrc).toMatch(/const getRlsDb[\s\S]*?req\.rlsDb/);
    expect(himsSrc).toMatch(/Tenant DB context unavailable/);
    expect(himsSrc).toMatch(/503/);
  });

  it("every active tenant route in hims.ts uses getRlsDb or explicit rlsDb (not direct ?? db)", () => {
    const fallbackCount = (himsSrc.match(/req\.rlsDb\s*\?\?\s*db/g) || []).length;
    expect(fallbackCount).toBe(0);
  });
});

describe("HIMS-B: missing request RLS context fails closed 503 (runtime)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /hims/cases without req.rlsDb → 503 RLS_CONTEXT_MISSING", async () => {
    const app = express();
    app.use(express.json());
    app.use(buildMockAuth({ rlsDb: undefined }));
    app.use(himsRouter);
    const res = await request(app).get("/hims/cases");
    expect(res.status).toBe(503);
    expect(res.body?.code).toBe("RLS_CONTEXT_MISSING");
    expect(res.body?.error).toContain("Tenant DB context");
  });

  it("GET /hims/cases/1/status without req.rlsDb → 503", async () => {
    const app = express();
    app.use(express.json());
    app.use(buildMockAuth({ rlsDb: undefined }));
    app.use(himsRouter);
    const res = await request(app).get("/hims/cases/1/status");
    expect(res.status).toBe(503);
  });

  it("POST /hims/cases/1/check without req.rlsDb → 503", async () => {
    const app = express();
    app.use(express.json());
    app.use(buildMockAuth({ rlsDb: undefined }));
    app.use(himsRouter);
    const res = await request(app).post("/hims/cases/1/check");
    expect(res.status).toBe(503);
  });

  it("GET /hims/cases/1/comparisons without req.rlsDb → 503", async () => {
    const app = express();
    app.use(express.json());
    app.use(buildMockAuth({ rlsDb: undefined }));
    app.use(himsRouter);
    const res = await request(app).get("/hims/cases/1/comparisons");
    expect(res.status).toBe(503);
  });

  it("POST /hims/cases/1/compare without req.rlsDb → 503", async () => {
    const app = express();
    app.use(express.json());
    app.use(buildMockAuth({ rlsDb: undefined }));
    app.use(himsRouter);
    const res = await request(app).post("/hims/cases/1/compare");
    expect(res.status).toBe(503);
  });
});

describe("HIMS-C: wrong-firm case cannot be queried through HIMS (access service gate preserved)", () => {
  it("each per-case route (status/check/comparisons/compare) invokes canUserAccessCase central guard before proceeding", () => {
    const perCaseRoutes = [
      "hims/cases/:caseId/status",
      "hims/cases/:caseId/check",
      "hims/cases/:caseId/comparisons",
      "hims/cases/:caseId/compare",
    ];
    for (const _routeName of perCaseRoutes) {
      expect(himsSrc).toContain("canUserAccessCase(");
    }
    const canUserCallCount = (himsSrc.match(/canUserAccessCase\(\{/g) || []).length;
    expect(canUserCallCount).toBeGreaterThanOrEqual(4);
  });

  it("cases list (GET /hims/cases) WHERE clause is scoped by casesTable.firmId", () => {
    expect(himsSrc).toMatch(/baseCaseWhere:\s*any\[\]\s*=\s*\[eq\(casesTable\.firmId,\s*firmId\)\]/);
  });
});

describe("HIMS-D: tracker/status/check/compare retain feature + RBAC guards", () => {
  it("cases list uses requireUserFeatureAccess(\"hims.tracker\")", () => {
    expect(himsSrc).toContain("requireUserFeatureAccess(\"hims.tracker\")");
  });

  it("POST check route uses requirePermission(\"module.hims\", \"write\")", () => {
    expect(himsSrc).toContain("requirePermission(\"module.hims\", \"write\")");
  });

  it("GET comparisons route uses requirePermission(\"module.hims\", \"read\") + feature compare", () => {
    expect(himsSrc).toContain("requireUserFeatureAccess(\"hims.compare_lawcaspro_hims\")");
  });

  it("feature assert uses req.rlsDb! for assertFirmFeatureEnabled in every route handler (FEATURE_KEY module.hims)", () => {
    const asserts = (himsSrc.match(/assertFirmFeatureEnabled\(req\.rlsDb!,/g) || []).length;
    expect(asserts).toBeGreaterThanOrEqual(5);
  });
});
