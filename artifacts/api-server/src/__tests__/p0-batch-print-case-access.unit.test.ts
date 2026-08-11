import express, { NextFunction, Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import documentsRouter from "../routes/documents.js";

type AccessMode =
  | "assigned_lawyer"
  | "unassigned_staff"
  | "cross_firm"
  | "partner_firmwide"
  | "inactive_user";

const mockDecisions: Record<AccessMode, {
  active: boolean;
  userId: number;
  firmId: number;
  roleName: string;
  caseExists: boolean;
  accessGranted: boolean;
  denyReason: "FORBIDDEN_NOT_ASSIGNED" | "NOT_FOUND_OR_CROSS_FIRM" | null;
}> = {
  assigned_lawyer: {
    active: true,
    userId: 50,
    firmId: 1,
    roleName: "lawyer",
    caseExists: true,
    accessGranted: true,
    denyReason: null,
  },
  unassigned_staff: {
    active: true,
    userId: 51,
    firmId: 1,
    roleName: "lawyer",
    caseExists: true,
    accessGranted: false,
    denyReason: "FORBIDDEN_NOT_ASSIGNED",
  },
  cross_firm: {
    active: true,
    userId: 60,
    firmId: 2,
    roleName: "lawyer",
    caseExists: true,
    accessGranted: false,
    denyReason: "NOT_FOUND_OR_CROSS_FIRM",
  },
  partner_firmwide: {
    active: true,
    userId: 70,
    firmId: 1,
    roleName: "Partner",
    caseExists: true,
    accessGranted: true,
    denyReason: null,
  },
  inactive_user: {
    active: false,
    userId: 99,
    firmId: 1,
    roleName: "Clerk",
    caseExists: true,
    accessGranted: false,
    denyReason: null,
  },
};

vi.mock("../lib/auth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const requireAuth = async (req: any, res: Response, next: NextFunction) => {
    const cfg = (req as any)._accessCfg as (typeof mockDecisions)[AccessMode];
    if (!cfg.active) {
      res.status(401).json({ error: "User account is inactive", code: "AUTH_USER_INACTIVE" });
      return;
    }
    req.userType = "firm_user";
    req.userId = cfg.userId;
    req.firmId = cfg.firmId;
    req.roleId = 1;
    req.roleName = cfg.roleName;
    req.timing = { startAt: Date.now(), sections: {} };
    next();
  };
  const rlsDbStub = () => {
    const b: any = {};
    b.select = () => b;
    b.from = () => b;
    b.where = () => b;
    b.leftJoin = () => b;
    b.innerJoin = () => b;
    b.and = () => b;
    b.or = () => b;
    b.limit = async () => [];
    b.execute = async () => ({ rows: [] });
    b.transaction = async (fn: any) => fn(b);
    return b;
  };
  const requireFirmUser = async (req: any, _res: any, next: NextFunction) => {
    if (!req.rlsDb) req.rlsDb = rlsDbStub();
    next();
  };
  const requirePermission = () => async (_req: any, _res: any, next: NextFunction) => next();
  const hasCasesFirmwideScope = async (_req: any, roleName?: string) =>
    roleName === "Partner" || roleName === "Manager";
  const canAccessCase = async (opts: any) => {
    const { mode } = opts;
    const cfg = mockDecisions[mode as AccessMode];
    if (!cfg) return { granted: false, deniedReason: "UNKNOWN_MODE" };
    if (cfg.denyReason) return { granted: false, deniedReason: cfg.denyReason };
    return { granted: cfg.accessGranted };
  };
  const writeAuditLog = async (_params: unknown) => undefined;
  const enforceCaseAccessGeneric = async (
    _r: any,
    req: any,
    res: Response,
    caseId: number,
    opts: any,
  ): Promise<boolean> => {
    const cfg = (req as any)._accessCfg as (typeof mockDecisions)[AccessMode];
    const purpose = (opts as any).purpose;
    if (!Number.isFinite(caseId)) {
      res.status(400).json({ error: "Invalid case ID" });
      return false;
    }
    if (purpose !== "print_documents") {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
      return false;
    }
    const firmwide = cfg.roleName === "Partner" || cfg.roleName === "Manager";
    const decision = await canAccessCase({ mode: (req as any)._accessMode });
    const scope = await hasCasesFirmwideScope(req, cfg.roleName);
    if (!firmwide && !scope && !decision.granted) {
      if (decision.deniedReason === "NOT_FOUND_OR_CROSS_FIRM") {
        res.status(404).json({ error: "Case not found", code: "CASE_NOT_FOUND" });
      } else {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
      }
      return false;
    }
    if (firmwide || scope) {
      return true;
    }
    return decision.granted;
  };
  const roleHasPermission = async () => true;
  const classifyCaseWorkflowRole = () => "clerk";
  return {
    ...actual,
    requireAuth,
    requireFirmUser,
    requirePermission,
    writeAuditLog,
    enforceCaseAccessGeneric,
    canAccessCase,
    hasCasesFirmwideScope,
    roleHasPermission,
    classifyCaseWorkflowRole,
  };
});

const makeApp = (mode: AccessMode) => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req._accessMode = mode;
    req._accessCfg = mockDecisions[mode];
    next();
  });
  app.use(documentsRouter);
  return app;
};

describe("P0-6 Batch Print route-level case access (purpose: print_documents)", () => {
  it("assigned permitted staff → allowed (HTTP != 403, != 404)", async () => {
    const app = makeApp("assigned_lawyer");
    const res = await request(app)
      .post("/cases/1001/documents/print")
      .send({ printKey: "spa", documentName: "SPA.pdf" });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("unassigned staff → 403 Forbidden", async () => {
    const app = makeApp("unassigned_staff");
    const res = await request(app)
      .post("/cases/1001/documents/print")
      .send({ printKey: "spa", documentName: "SPA.pdf" });
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe("FORBIDDEN");
  });

  it("cross-firm case → deny/not found (404)", async () => {
    const app = makeApp("cross_firm");
    const res = await request(app)
      .post("/cases/1001/documents/print")
      .send({ printKey: "spa", documentName: "SPA.pdf" });
    expect(res.status).toBe(404);
    expect(res.body?.code).toBe("CASE_NOT_FOUND");
  });

  it("Partner firmwide scope → canonical policy (allow, HTTP != 403, != 404)", async () => {
    const app = makeApp("partner_firmwide");
    const res = await request(app)
      .post("/cases/1001/documents/print")
      .send({ printKey: "spa", documentName: "SPA.pdf" });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("inactive user → deny at requireAuth (401 AUTH_USER_INACTIVE)", async () => {
    const app = makeApp("inactive_user");
    const res = await request(app)
      .post("/cases/1001/documents/print")
      .send({ printKey: "spa", documentName: "SPA.pdf" });
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe("AUTH_USER_INACTIVE");
  });
});
