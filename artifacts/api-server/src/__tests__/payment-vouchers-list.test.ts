import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

type FakeSelect = Promise<any[]> & {
  from: () => FakeSelect;
  where: () => FakeSelect;
  orderBy: () => FakeSelect;
  groupBy: () => FakeSelect;
  having: () => FakeSelect;
  limit: () => FakeSelect;
  offset: () => Promise<any[]>;
  leftJoin: () => FakeSelect;
  rightJoin: () => FakeSelect;
  innerJoin: () => FakeSelect;
  fullJoin: () => FakeSelect;
};

type FakeDb = {
  execute: () => Promise<{ rows: any[] }>;
  select: () => FakeSelect;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const buildAwaitableBuilder = (rows: any[] = []): FakeSelect => {
  const b: any = {};
  const resolve = Promise.resolve(rows);
  const chain = () => b;
  b.from = chain;
  b.where = chain;
  b.orderBy = chain;
  b.groupBy = chain;
  b.having = chain;
  b.limit = chain;
  b.leftJoin = chain;
  b.rightJoin = chain;
  b.innerJoin = chain;
  b.fullJoin = chain;
  b.offset = async () => rows;
  b.then = (onFulfilled: any, onRejected: any) => resolve.then(onFulfilled, onRejected);
  b.catch = (onRejected: any) => resolve.catch(onRejected);
  b.finally = (onFinally: any) => resolve.finally(onFinally);
  return b as FakeSelect;
};

const makeFakeDb = (): FakeDb => {
  const execute = async () => ({ rows: [] });
  const select: FakeDb["select"] = () => buildAwaitableBuilder([]);
  const transaction: FakeDb["transaction"] = async (fn) => {
    const inner = makeFakeDb();
    return await fn(inner);
  };
  return { execute, select, transaction };
};

const makeRlsDb = (): FakeDb => makeFakeDb();

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
  const requireFirmUserFinancialSession = async (req: any, _res: any, next: any) => {
    next();
  };
  return {
    requireAuth,
    requireFirmUser,
    requireFirmUserFinancialSession,
    requirePermission: () => async (_req: any, _res: any, next: any) => next(),
    sensitiveRateLimiter: (_req: any, _res: any, next: any) => next(),
    requireReAuth: async (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

vi.mock("../services/user-feature-access.js", () => {
  return {
    requireUserFeatureAccess: (_featureKey: string) => async (_req: any, _res: any, next: any) => next(),
    resolveRequestPermissionChecker: async () => async (_mod: string, _act: string) => true,
    ensureFeatureCache: async () => undefined,
  };
});

vi.mock("../services/accounting-settings.js", () => {
  return {
    safeLoadAccountingSettingsOrDefault: async () => ({
      id: 1, firmId: 1, nextVoucherNo: 1, nextReceiptNo: 1, nextInvoiceNo: 1, nextQuotationNo: 1,
      createdAt: new Date(), updatedAt: new Date(), settings: {}, defaultClientAccountId: null,
      defaultOfficeAccountId: null, defaultTaxRate: "0.00", defaultPaymentTermsDays: 30,
      receiptPrefix: "R", invoicePrefix: "INV", quotationPrefix: "Q", voucherPrefix: "PV", useRunningNumbers: true,
    }),
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

