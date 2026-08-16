import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type NextFunction, type Response } from "express";
import request from "supertest";
import type { AuthRequest } from "../lib/auth.js";
import {
  __clearAuthCachesForTests,
} from "../lib/auth.js";
import {
  isDeveloperPortalUser,
  developerOnlyAllowlistMiddleware,
} from "../lib/developer-allowlist.js";

vi.mock("../lib/rate-limit.js", () => ({
  sensitiveRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

beforeEach(() => {
  __clearAuthCachesForTests();
});

afterEach(() => {
  __clearAuthCachesForTests();
});

const FIRM_ID = 99;
const PARTNER_ROLE_ID = 1;
const ACCOUNTING_ROLE_ID = 5;
const DEVELOPER_ROLE_ID = 7;
const DEVELOPER_ID = 10;

function makeStubAuth(shape: {
  userType: string;
  firmId?: number | null;
  roleId?: number | null;
  roleName?: string | null;
  developerId?: number | null;
  userId?: number;
  email?: string;
}) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    Object.defineProperty(req, "ip", {
      value: "127.0.0.1",
      writable: true,
      configurable: true,
      enumerable: true,
    });
    req.timing = { startAt: Date.now(), sections: {} };
    req.headers = req.headers ?? {};
    req.cookies = req.cookies ?? {};
    req.userType = shape.userType;
    req.firmId = shape.firmId ?? FIRM_ID;
    req.roleId = shape.roleId ?? null;
    req.roleName = shape.roleName ?? null;
    req.developerId = shape.developerId ?? null;
    req.userId = shape.userId ?? 1001;
    req.email = shape.email ?? "test@lawcaspro.my";
    if (req.firmId !== undefined && req.roleId !== undefined && req.roleName !== undefined) {
      req._roleCache = { firmId: req.firmId, roleId: req.roleId, name: req.roleName };
    }
    next();
  };
}

function buildAppFor(authShape: Parameters<typeof makeStubAuth>[0]) {
  const app = express();
  app.use(express.json());
  app.use(makeStubAuth(authShape));
  app.use((req: any, res: any, next: any) => {
    developerOnlyAllowlistMiddleware(req, res, next);
  });
  app.get("/api/developer/portal/overview", (_req, res) => res.status(200).json({ ok: true, route: "overview" }));
  app.get("/api/developer/portal/projects", (_req, res) => res.status(200).json({ ok: true, route: "projects" }));
  app.get("/api/quotations", (_req, res) => res.status(200).json({ ok: true, route: "quotations" }));
  app.get("/api/invoices", (_req, res) => res.status(200).json({ ok: true, route: "invoices" }));
  app.get("/api/payment-vouchers", (_req, res) => res.status(200).json({ ok: true, route: "pv" }));
  app.get("/api/users", (_req, res) => res.status(200).json({ ok: true, route: "users" }));
  app.get("/api/cases/1/ledger", (_req, res) => res.status(200).json({ ok: true, route: "ledger" }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: String(err?.message ?? err) });
  });
  return app;
}

describe("AUTH-DEV: Developer canonical account = firm_user + roleName=Developer_User (NOT userType=developer_user)", () => {
  it("AUTH-DEV-1: isDeveloperPortalUser TRUE for canonical shape (userType=firm_user, roleName=Developer_User)", () => {
    const req: any = {
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    };
    expect(isDeveloperPortalUser(req)).toBe(true);
  });

  it("AUTH-DEV-2: isDeveloperPortalUser FALSE for real-session bug shape WITHOUT roleName (P0 scenario)", () => {
    const req: any = {
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      developerId: DEVELOPER_ID,
    };
    expect(req.roleName).toBeUndefined();
    expect(isDeveloperPortalUser(req)).toBe(false);
  });

  it("AUTH-DEV-3: isDeveloperPortalUser TRUE legacy userType=developer_user retained for historical rows", () => {
    const req: any = { userType: "developer_user", roleId: null, roleName: undefined };
    expect(isDeveloperPortalUser(req)).toBe(true);
  });

  it("AUTH-DEV-4: Partner session isDeveloperPortalUser false", () => {
    const req: any = {
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: PARTNER_ROLE_ID,
      roleName: "Partner",
    };
    expect(isDeveloperPortalUser(req)).toBe(false);
  });

  it("AUTH-DEV-5: Accounting user isDeveloperPortalUser false", () => {
    const req: any = {
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: ACCOUNTING_ROLE_ID,
      roleName: "Accounting",
    };
    expect(isDeveloperPortalUser(req)).toBe(false);
  });

  it("AUTH-DEV-6: Developer canonical session hydrates _roleCache via allowlist req shape", () => {
    const req: any = {};
    const mw = makeStubAuth({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    mw(req as AuthRequest, {} as Response, () => {});
    expect(req.userType).toBe("firm_user");
    expect(req.roleName).toBe("Developer_User");
    expect(req.roleId).toBe(DEVELOPER_ROLE_ID);
    expect(req.developerId).toBe(DEVELOPER_ID);
    expect(req._roleCache).toEqual({ firmId: FIRM_ID, roleId: DEVELOPER_ROLE_ID, name: "Developer_User" });
  });
});

describe("SEC-HTTP: Developer Portal allowlist middleware HTTP chain (canonical shape: userType=firm_user + roleName=Developer_User)", () => {
  it("SEC-HTTP-1: Developer session GET /api/quotations → 403 DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    const r = await request(app).get("/api/quotations");
    expect(r.statusCode).toBe(403);
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-HTTP-2: Developer session GET /api/invoices → 403 DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    const r = await request(app).get("/api/invoices");
    expect(r.statusCode).toBe(403);
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-HTTP-3: Developer session GET /api/payment-vouchers → 403 DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    const r = await request(app).get("/api/payment-vouchers");
    expect(r.statusCode).toBe(403);
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-HTTP-4: Developer session GET /api/users → 403 DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    const r = await request(app).get("/api/users");
    expect(r.statusCode).toBe(403);
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-HTTP-5: Developer session GET /api/developer/portal/overview → allowlisted, NOT blocked by middleware", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    const r = await request(app).get("/api/developer/portal/overview");
    expect(r.statusCode).toBeLessThan(400);
    expect(r.body?.route).toBe("overview");
  });

  it("SEC-HTTP-6: Partner session GET /api/quotations → NOT blocked by Developer allowlist (must not get DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST)", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: PARTNER_ROLE_ID,
      roleName: "Partner",
    });
    const r = await request(app).get("/api/quotations");
    expect(r.statusCode).toBe(200);
    expect(r.body?.error?.code).not.toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
    expect(r.body?.route).toBe("quotations");
  });

  it("SEC-HTTP-7: Accounting session GET /api/payment-vouchers → NOT blocked by Developer allowlist", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: ACCOUNTING_ROLE_ID,
      roleName: "Accounting",
    });
    const r = await request(app).get("/api/payment-vouchers");
    expect(r.statusCode).toBe(200);
    expect(r.body?.error?.code).not.toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
    expect(r.body?.route).toBe("pv");
  });

  it("SEC-HTTP-8: Developer session GET /api/cases/1/ledger → 403 DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    const r = await request(app).get("/api/cases/1/ledger");
    expect(r.statusCode).toBe(403);
    expect(r.body?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
  });

  it("SEC-HTTP-9: Developer session GET /api/developer/portal/projects → allowlisted OK", async () => {
    const app = buildAppFor({
      userType: "firm_user",
      firmId: FIRM_ID,
      roleId: DEVELOPER_ROLE_ID,
      roleName: "Developer_User",
      developerId: DEVELOPER_ID,
    });
    const r = await request(app).get("/api/developer/portal/projects");
    expect(r.statusCode).toBeLessThan(400);
    expect(r.body?.route).toBe("projects");
  });
});
