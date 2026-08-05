import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

type FakeSelect = {
  from: () => FakeSelect;
  where: () => FakeSelect;
  orderBy: () => FakeSelect;
  limit: () => FakeSelect;
  offset: () => Promise<any[]>;
};

const makeRlsDb = () => {
  const execute = async () => ({ rows: [] });
  const select = (): FakeSelect => {
    const b: any = {};
    b.from = () => b;
    b.where = () => b;
    b.orderBy = () => b;
    b.limit = () => b;
    b.offset = async () => [];
    return b as FakeSelect;
  };
  return { execute, select };
};

vi.mock("../lib/auth.js", () => {
  const requireAuth = async (req: any, _res: any, next: any) => {
    req.userType = "firm_user";
    req.userId = 1;
    req.firmId = 1;
    req.roleId = 1;
    req.timing = { startAt: Date.now(), sections: { authSessionMs: 10, permissionMs: 5, tenantContextDbConnectMs: 7, tenantContextMs: 8 } };
    next();
  };
  const requireFirmUser = async (req: any, _res: any, next: any) => {
    req.rlsDb = makeRlsDb();
    next();
  };
  return {
    requireAuth,
    requireFirmUser,
    requirePermission: () => async (_req: any, _res: any, next: any) => next(),
    sensitiveRateLimiter: (_req: any, _res: any, next: any) => next(),
    requireReAuth: async (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

import router from "../routes/payment-vouchers.js";

describe("Payment vouchers list", () => {
  it("returns 200 with safe timing header and pagination defaults", async () => {
    const app = express();
    app.use(router);

    const res = await request(app).get("/payment-vouchers");
    expect(res.status).toBe(200);
    expect(res.headers["x-lawcaspro-timing"]).toBeTruthy();
    const timing = JSON.parse(String(res.headers["x-lawcaspro-timing"]));
    expect(typeof timing.totalMs).toBe("number");
    expect(typeof timing.queryMs).toBe("number");
    expect(typeof timing.serializeMs).toBe("number");
  });
});

