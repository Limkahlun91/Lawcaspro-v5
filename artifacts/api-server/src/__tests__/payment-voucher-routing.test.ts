import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/auth.js", () => {
  const passthrough = async (req: any, _res: any, next: any) => {
    req.userType = "firm_user";
    req.userId = 1;
    req.firmId = 1;
    req.roleId = null;
    if (!req.rlsDb) {
      const makeChainable = (): any => {
        const b: any = {};
        const self = () => b;
        b.from = self; b.innerJoin = self; b.leftJoin = self;
        b.where = self; b.orderBy = self; b.groupBy = self; b.having = self;
        b.limit = async () => [];
        b.then = (resolve: any) => Promise.resolve([]).then(resolve);
        b.catch = (reject: any) => Promise.resolve([]).catch(reject);
        b.finally = (fin: any) => Promise.resolve([]).finally(fin);
        b.execute = async () => ({ rows: [] });
        return b;
      };
      req.rlsDb = {
        execute: async () => ({ rows: [] }),
        select: makeChainable,
        transaction: async (fn: any) => fn({
          execute: async () => ({ rows: [] }),
          select: makeChainable,
        }),
      };
    }
    next();
  };
  return {
    requireAuth: passthrough,
    requireFirmUser: passthrough,
    requireFirmUserSession: passthrough,
    requireFirmUserFinancialSession: passthrough,
    requirePermission: () => async (_req: any, _res: any, next: any) => next(),
    requireReAuth: async (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

vi.mock("../services/user-feature-access.js", () => {
  return {
    requireUserFeatureAccess: () => async (_req: any, _res: any, next: any) => next(),
    resolveRequestFirmRoleName: async () => null,
    resolveRequestPermissionChecker: async () => () => true,
    isPartnerRoleName: () => false,
  };
});

vi.mock("../modules/accounting-settings/accounting-settings-loader.js", () => {
  return {
    safeLoadAccountingSettingsOrDefault: async () => ({
      vatRatePercent: 0,
      defaultCurrencyCode: "MYR",
      nextVoucherNoSeq: 1,
      nextInvoiceNoSeq: 1,
      nextReceiptNoSeq: 1,
      nextQuotationNoSeq: 1,
      caseTaggingEnabled: true,
      defaultInvoiceTermsDays: 30,
    }),
  };
});

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  const mockDb = {
    select: () => ({
      from: () => ({
        where: async () => [],
        limit: async () => [],
      }),
    }),
  };
  return {
    ...actual,
    db: mockDb as unknown as typeof actual.db,
  };
});

import paymentVoucherActionsRouter from "../routes/payment-voucher-actions.js";
import paymentVouchersRouter from "../routes/payment-vouchers.js";

describe("Payment voucher routing", () => {
  it("routes /payment-vouchers/dashboard to NOT collide with numeric /:id (dashboard handler reached via distinct router path)", async () => {
    const app = express();
    app.use(paymentVoucherActionsRouter);
    app.use(paymentVouchersRouter);

    const res = await request(app).get("/payment-vouchers/dashboard");
    expect(res.status).toBe(403);
  });

  it("routes numeric IDs to detail route (404 when empty db) and non-numeric IDs to controlled 400", async () => {
    const app = express();
    app.use(paymentVoucherActionsRouter);
    app.use(paymentVouchersRouter);

    const ok = await request(app).get("/payment-vouchers/123");
    expect(ok.status).toBe(404);

    const bad = await request(app).get("/payment-vouchers/not-a-number");
    expect(bad.status).toBe(400);
    expect(String(bad.body?.error ?? "")).toMatch(/invalid voucher/i);
  });
});

