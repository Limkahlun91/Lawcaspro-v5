import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/auth.js", () => {
  const passthrough = async (req: any, _res: any, next: any) => {
    req.userType = "firm_user";
    req.userId = 1;
    req.firmId = 1;
    req.roleId = null;
    next();
  };
  return {
    requireAuth: passthrough,
    requireFirmUser: passthrough,
    requirePermission: () => async (_req: any, _res: any, next: any) => next(),
    requireReAuth: async (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
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
  it("routes /payment-vouchers/dashboard to the dashboard handler (no collision with /:id)", async () => {
    const app = express();
    app.use(paymentVoucherActionsRouter);
    app.use(paymentVouchersRouter);

    const res = await request(app).get("/payment-vouchers/dashboard");
    expect(res.status).toBe(403);
  });

  it("routes numeric IDs to detail route and non-numeric IDs to controlled 400", async () => {
    const app = express();
    app.use(paymentVoucherActionsRouter);
    app.use(paymentVouchersRouter);

    const ok = await request(app).get("/payment-vouchers/123");
    expect(ok.status).toBe(404);

    const bad = await request(app).get("/payment-vouchers/not-a-number");
    expect(bad.status).toBe(400);
    expect(String(bad.body?.error ?? "")).toMatch(/invalid voucher id/i);
  });
});

