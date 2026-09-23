import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const DEV_PATH = resolve(__dirname, "../routes/developer.ts");
const devSrc = readFileSync(DEV_PATH, "utf8");

type FakeSelect = Promise<any[]> & {
  from: () => FakeSelect; where: () => FakeSelect; orderBy: () => FakeSelect;
  groupBy: () => FakeSelect; having: () => FakeSelect; limit: () => FakeSelect;
  offset: () => Promise<any[]>; leftJoin: () => FakeSelect;
  innerJoin: () => FakeSelect; rightJoin: () => FakeSelect;
  ilike: () => FakeSelect; or: () => FakeSelect; count: () => FakeSelect;
};
const buildAwaitable = (rows: any[] = []): FakeSelect => {
  const b: any = {};
  const p = Promise.resolve(rows);
  const chain = () => b;
  b.from = chain; b.where = chain; b.orderBy = chain; b.groupBy = chain;
  b.having = chain; b.limit = chain; b.leftJoin = chain; b.innerJoin = chain;
  b.rightJoin = chain; b.ilike = chain; b.or = chain; b.count = chain;
  b.offset = async () => rows;
  b.then = (onF: any, onR: any) => p.then(onF, onR);
  b.catch = (onR: any) => p.catch(onR);
  b.finally = (onF: any) => p.finally(onF);
  return b as FakeSelect;
};
const makeRlsDb = () => ({
  select: () => buildAwaitable([]),
  execute: async () => ({ rows: [] }),
  transaction: async <T>(fn: (c: any) => Promise<T>) => fn(makeRlsDb()),
});

vi.mock("@workspace/db", () => {
  const sqlTag = (strings: TemplateStringsArray, ..._v: any[]) => String.raw({ raw: strings });
  return {
    db: {} as any, RlsDb: {} as any,
    caseAssignmentsTable: {} as any, caseKeyDatesTable: {} as any,
    caseMessagesTable: {} as any, casePurchasersTable: {} as any,
    casesTable: {} as any, caseWorkflowStepsTable: {} as any,
    clientsTable: {} as any, developersTable: {} as any,
    projectsTable: {} as any, rolesTable: {} as any, usersTable: {} as any,
    sql: sqlTag,
    and: (..._a: any[]) => ({} as any), asc: () => ({} as any), count: () => ({} as any),
    desc: () => ({} as any), eq: () => ({} as any), ilike: () => ({} as any),
    inArray: () => ({} as any), or: (..._a: any[]) => ({} as any),
  };
});
vi.mock("../lib/developer-portal.js", () => ({
  classifyCurrentStageLabel: () => "", classifySpaLoanStage: () => ({} as any),
  collectAttentionItems: () => [] as any, deriveMotStatus: () => "",
  deriveNextAction: () => ({} as any), deriveSpaStatus: () => "",
  deriveLoanStatus: () => "", formatPurchasePrice: () => "",
  getDeveloperPortalUnitLabel: () => "", kdFromJoined: () => ({} as any),
  mapJoinedCaseToDetailDto: () => ({} as any), mapJoinedCaseToListDto: () => ({} as any),
  sanitizePurchasers: () => [] as any, summarizeCards: () => ({} as any),
  summarizeProgress: () => ({} as any), toBankName: () => "",
  buildSpaLoanTimeline: () => [] as any, buildMotTimeline: () => [] as any,
  buildRecentActivity: () => [] as any, extractLawyerClerk: () => ({} as any),
  portalSummaryAggregateSelect: () => ({}) as any, portalProgressAggregateSelect: () => ({}) as any,
  portalStagePredicateSql: () => null as any,
}));
vi.mock("xlsx", async () => {
  const actual: any = await vi.importActual("xlsx");
  const XLSX = actual.default ?? actual;
  const write = XLSX?.write ?? (() => Buffer.alloc(0));
  return {
    default: XLSX,
    utils: XLSX?.utils ?? { book_new: () => ({}), json_to_sheet: () => ({}), book_append_sheet: () => undefined },
    write,
  };
});
vi.mock("../lib/auth.js", () => ({
  requireAuth: async (_r: any, _s: any, next: any) => next(),
  requireFirmUser: async (_r: any, _s: any, next: any) => next(),
  writeAuditLog: async () => undefined,
}));
import { router as developerRouter } from "../routes/developer.js";

const buildFirmUserSession = (overrides: Partial<{
  firmId: number; userId: number; roleId: number; developerId: number; rlsDb: any;
  roleName: string;
}> = {}) =>
  async (req: any, res: any, next: any) => {
    req.userType = "firm_user";
    req.firmId = overrides.firmId ?? 77;
    req.userId = overrides.userId ?? 202;
    req.roleId = overrides.roleId ?? 9;
    req.developerId = overrides.developerId ?? 3003;
    req.rlsDb = overrides.rlsDb;
    req.headers = req.headers ?? {};
    req.headers["user-agent"] = "vitest";
    next();
  };

const stubRoleAndDeveloper = (firmUser: { firmId: number; roleId: number; developerId: number }, roleName: string) => {
  const rows: Record<string, any[]> = {
    roles: [{ name: roleName }],
    developers: [{ id: firmUser.developerId }],
  };
  const sel: any = (cols: any) => {
    if (cols && typeof cols === "object" && "name" in cols && cols.name?.name) return buildAwaitable(rows.roles);
    if (cols && typeof cols === "object" && "id" in cols && cols.id?.name === "id") return buildAwaitable(rows.developers);
    return buildAwaitable([]);
  };
  const db = makeRlsDb();
  (db as any).select = sel;
  return db;
};

describe("DEV-A: no tenant global db fallback in developer portal routes (structural)", () => {
  it("source developer.ts has zero req.rlsDb ?? db patterns", () => {
    expect(devSrc.includes("req.rlsDb ?? db")).toBe(false);
  });
  it("helper renamed to canonical getRlsDb and returns 503 JSON error when missing", () => {
    expect(devSrc).toContain("const getRlsDb");
    expect(devSrc).toMatch(/status\(503\)\.json\(\{ error: "Tenant DB context unavailable"/);
  });
  it("every site of old const r = rdb(req); replaced with getRlsDb(req,res); if (!r) return", () => {
    const remainingRdbCall = (devSrc.match(/\brdb\(req\)/g) || []).length;
    expect(remainingRdbCall).toBe(0);
    const ifNotRReturns = (devSrc.match(/if \(!r\) return;/g) || []).length;
    expect(ifNotRReturns).toBeGreaterThanOrEqual(11);
  });
});

describe("DEV-B: Developer A cannot resolve Developer B data through explicit WHERE developerId = ctx.developerId guards", () => {
  it("dashboard WHERE eq(casesTable.developerId, ctx.developerId)", () => {
    expect(devSrc).toMatch(/eq\(casesTable\.developerId,\s*ctx\.developerId\)/);
  });
  it("inventory list, overview, units, unit detail, export — all add developerId guard", () => {
    const guardedDeveloperId = (devSrc.match(/casesTable\.developerId,\s*ctx\.developerId/g) || []).length;
    expect(guardedDeveloperId).toBeGreaterThanOrEqual(6);
  });
  it("messages + progress per case verify case belongs to ctx.developerId before return", () => {
    const perCaseDevGuard = (devSrc.match(/eq\(casesTable\.developerId,\s*ctx\.developerId\)/g) || []).length;
    expect(perCaseDevGuard).toBeGreaterThanOrEqual(8);
  });
});

describe("DEV-C: same-firm Developer_User identity gate preserved in requireDeveloperUser", () => {
  it("requireDeveloperUser checks role.name === Developer_User via roles.name INNER select + firmId filter", () => {
    expect(devSrc).toContain("role?.name !== \"Developer_User\"");
    expect(devSrc).toMatch(/eq\(rolesTable\.firmId,\s*req\.firmId\)/);
  });
  it("requireDeveloperUser checks developersTable.id + same-firm developer row existence with firmId filter", () => {
    expect(devSrc).toMatch(/eq\(developersTable\.firmId,\s*req\.firmId\)/);
  });
});

describe("DEV-D: missing RLS context fails closed (runtime 503) — requireDeveloperUser returns null when RLS missing", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("GET /developer/dashboard without rlsDb → 503 (requireDeveloperUser getRlsDb missing)", async () => {
    const app = express();
    app.use(buildFirmUserSession({ firmId: 77, userId: 202, roleId: 9, developerId: 3003, rlsDb: undefined }));
    app.use(developerRouter);
    const res = await request(app).get("/developer/dashboard");
    expect(res.status).toBe(503);
  });

  it("GET /developer/inventory without rlsDb → 503", async () => {
    const app = express();
    app.use(buildFirmUserSession({ rlsDb: undefined, developerId: 3003, roleId: 9, firmId: 77, userId: 202 }));
    app.use(developerRouter);
    const res = await request(app).get("/developer/inventory");
    expect(res.status).toBe(503);
  });

  it("GET /developer/portal/projects without rlsDb → 503", async () => {
    const app = express();
    app.use(buildFirmUserSession({ rlsDb: undefined, developerId: 3003, roleId: 9, firmId: 77, userId: 202 }));
    app.use(developerRouter);
    const res = await request(app).get("/developer/portal/projects");
    expect(res.status).toBe(503);
  });

  it("requireDeveloperUser returns 403 when role.name != Developer_User", async () => {
    const app = express();
    const rlsMissingRole = stubRoleAndDeveloper({ firmId: 77, roleId: 9, developerId: 3003 }, "Partner");
    app.use(buildFirmUserSession({ rlsDb: rlsMissingRole, developerId: 3003, roleId: 9, firmId: 77, userId: 202 }));
    app.use(developerRouter);
    const res = await request(app).get("/developer/dashboard");
    expect(res.status).toBe(403);
  });
});
