import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

type FakeSelect = {
  from: () => FakeSelect;
  innerJoin: () => FakeSelect;
  leftJoin: () => FakeSelect;
  where: () => FakeSelect;
  orderBy: () => FakeSelect;
  limit: () => Promise<any[]>;
};

const makeRlsDb = (opts?: { throwSqlState?: string }) => {
  const execute = async () => {
    if (opts?.throwSqlState) {
      const e = new Error("db error") as Error & { code?: string };
      e.code = opts.throwSqlState;
      throw e;
    }
    return { rows: [{ all: 0, active: 0, overdue: 0 }] };
  };
  const select = (): FakeSelect => {
    const b: any = {};
    b.from = () => b;
    b.innerJoin = () => b;
    b.leftJoin = () => b;
    b.where = () => b;
    b.orderBy = () => b;
    b.limit = async () => [];
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
    next();
  };
  const requireFirmUser = async (req: any, _res: any, next: any) => {
    if (!req.rlsDb) req.rlsDb = makeRlsDb();
    next();
  };
  return {
    requireAuth,
    requireFirmUser,
    requirePermission: () => async (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

import router from "../routes/payment-voucher-actions.js";

describe("Payment voucher actions overview", () => {
  it("returns 200 with empty counts/items", async () => {
    const app = express();
    app.use(router);
    const res = await request(app).get("/payment-voucher-actions/my-work/overview");
    expect(res.status).toBe(200);
    expect(res.body?.counts).toEqual({ all: 0, active: 0, overdue: 0 });
    expect(res.body?.items).toEqual([]);
  });

  it("returns structured 500 with SQLSTATE for insufficient privilege", async () => {
    const app = express();
    app.use((req: any, _res, next) => {
      req.rlsDb = makeRlsDb({ throwSqlState: "42501" });
      next();
    });
    app.use(router);

    const res = await request(app).get("/payment-voucher-actions/my-work/overview");
    expect(res.status).toBe(500);
    expect(res.body?.code).toBe("PV_ACTIONS_INSUFFICIENT_PRIVILEGE");
    expect(res.body?.meta?.sqlState).toBe("42501");
    expect(typeof res.body?.meta?.safeCategory).toBe("string");
  });
});
