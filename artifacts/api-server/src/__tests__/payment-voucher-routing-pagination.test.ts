import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AnyNext = (err?: unknown) => void;

const eqCalls: Array<[unknown, unknown]> = [];

vi.mock("drizzle-orm", async () => {
  const actual: any = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: (a: unknown, b: unknown) => {
      eqCalls.push([a, b]);
      return actual.eq(a, b);
    },
  };
});

let permissionAllowed = true;

vi.mock("../lib/auth.js", () => {
  const passthrough = (req: any, _res: any, next: AnyNext) => {
    req.userId = 1;
    req.firmId = 1;
    req.userType = "firm_user";
    req.roleId = 10;
    req.roleName = "Partner";
    next();
  };
  return {
    requireAuth: passthrough,
    requireFirmUser: passthrough,
    requirePermission: () => (req: any, res: any, next: AnyNext) => {
      passthrough(req, res, () => undefined);
      if (!permissionAllowed) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }
      next();
    },
    requireReAuth: passthrough,
    writeAuditLog: async () => undefined,
  };
});

const dbState = {
  paymentVoucherSelectLimit: 0,
  dashboardSelectCalls: 0,
};

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const makeListRows = (n: number) =>
    Array.from({ length: n }, (_v, i) => ({
      id: i + 1,
      caseId: null,
      voucherType: "external_payment",
      voucherNo: `PV-${i + 1}`,
      status: "pending_account",
      approvalStatus: "approved",
      isAdvance: false,
      fundStatus: null,
      payeeName: "Payee",
      paymentMethod: "bank_transfer",
      accountType: "office",
      bankChequeRefNo: "",
      amount: "1.00",
      purpose: "",
      receivedAt: null,
      paymentDueAt: null,
      deadlineOverrideReason: "",
      assignedAccountUserId: null,
      assignedClerkUserId: null,
      paidAt: null,
      proofDocumentPath: "",
      nextActionType: "Collect Physical File",
      nextActionCustom: "",
      nextActionRemarks: "",
      clerkActionExemptReason: "",
      lateCompletionReason: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

  const mockDb: any = {
    select: (sel?: any) => ({
      from: (table: unknown) => ({
        where: (_cond?: unknown) => {
          const isDashboardPvAgg = sel && typeof sel === "object" && "awaitingReceipt" in sel;
          const isDashboardActionsAgg = sel && typeof sel === "object" && "clerkPending" in sel;
          if (isDashboardPvAgg || isDashboardActionsAgg) dbState.dashboardSelectCalls += 1;

          const thenable: any = {
            then: (onFulfilled: any, onRejected: any) => {
              const resolve = async () => {
                if (isDashboardPvAgg) {
                  return [{
                    awaitingReceipt: null,
                    receivedAndProcessing: null,
                    waitingApproval: null,
                    dueSoon: null,
                    overdue: null,
                    paidToday: null,
                    completedMonth: null,
                  }];
                }
                if (isDashboardActionsAgg) {
                  return [{
                    clerkPending: null,
                    clerkOverdue: null,
                  }];
                }
                if (table === actual.paymentVouchersTable) {
                  return [{
                    id: 123,
                    voucherNo: "PV-123",
                    caseId: null,
                    targetCaseId: null,
                    createdBy: null,
                    preparedBy: null,
                    lawyerApprovedBy: null,
                    partnerApprovedBy: null,
                    paidBy: null,
                  }];
                }
                if (table === actual.paymentVoucherCreateRequestsTable) {
                  return [{
                    firmId: 1,
                    createdByUserId: 1,
                    clientRequestId: "cr_1",
                    status: "processing",
                    paymentVoucherId: null,
                    updatedAt: new Date(),
                  }];
                }
                return [];
              };
              return resolve().then(onFulfilled, onRejected);
            },
            orderBy: (...args: any[]) => {
              if (table === actual.paymentVoucherItemsTable && args.length > 0) return Promise.resolve([]);
              return {
                limit: (n: number) => ({
                  offset: async () => {
                    if (table === actual.paymentVouchersTable) {
                      dbState.paymentVoucherSelectLimit = n;
                      return makeListRows(n);
                    }
                    return [];
                  },
                }),
              };
            },
            limit: async () => [],
          };
          return thenable;
        },
      }),
    }),
    execute: async () => [],
    insert: () => ({ values: async () => [{ id: 1 }] }),
    update: () => ({ set: () => ({ where: async () => [{ id: 1 }] }) }),
    delete: () => ({ where: async () => [{ id: 1 }] }),
    transaction: async (fn: any) => fn(mockDb),
  };

  return { ...actual, db: mockDb };
});

describe("payment voucher route collision + pagination regressions", () => {
  const makeApp = async () => {
    const pv = (await import("../routes/payment-vouchers")).default;
    const pva = (await import("../routes/payment-voucher-actions")).default;
    const app = express();
    app.use(express.json());
    app.use("/api", pv);
    app.use("/api", pva);
    return app;
  };

  beforeEach(() => {
    dbState.paymentVoucherSelectLimit = 0;
    dbState.dashboardSelectCalls = 0;
    permissionAllowed = true;
    eqCalls.length = 0;
  });

  it("GET /api/payment-vouchers/dashboard requires accounting read permission", async () => {
    permissionAllowed = false;
    const app = await makeApp();
    const res = await request(app).get("/api/payment-vouchers/dashboard");
    expect(res.status).toBe(403);
  });

  it("GET /api/payment-vouchers/dashboard reaches dashboard handler (not :id)", async () => {
    const app = await makeApp();
    const res = await request(app).get("/api/payment-vouchers/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("awaitingReceipt");
    expect(res.body).toHaveProperty("receivedAndProcessing");
    expect(res.body).toHaveProperty("waitingApproval");
    expect(res.body).toHaveProperty("dueSoon");
    expect(res.body).toHaveProperty("overdue");
    expect(res.body).toHaveProperty("paidToday");
    expect(res.body).toHaveProperty("clerkPending");
    expect(res.body).toHaveProperty("clerkOverdue");
    expect(res.body).toHaveProperty("completedMonth");
    expect(Object.values(res.body).every((v) => typeof v === "number")).toBe(true);
    expect(Object.values(res.body).every((v) => v === 0)).toBe(true);
    expect(dbState.dashboardSelectCalls).toBeLessThanOrEqual(2);
    expect(dbState.dashboardSelectCalls).toBe(2);

    const { paymentVouchersTable, paymentVoucherActionsTable } = await import("@workspace/db");
    const hasPvFirm = eqCalls.some(([a, b]) => a === paymentVouchersTable.firmId && b === 1);
    const hasPvaFirm = eqCalls.some(([a, b]) => a === paymentVoucherActionsTable.firmId && b === 1);
    expect(hasPvFirm).toBe(true);
    expect(hasPvaFirm).toBe(true);
  });

  it("only one /payment-vouchers/dashboard route definition exists", () => {
    const pvPath = fileURLToPath(new URL("../routes/payment-vouchers.ts", import.meta.url));
    const pvaPath = fileURLToPath(new URL("../routes/payment-voucher-actions.ts", import.meta.url));
    const pv = readFileSync(pvPath, "utf8");
    const pva = readFileSync(pvaPath, "utf8");
    const re = /router\.get\(\s*["']\/payment-vouchers\/dashboard["']/g;
    const count = (pv.match(re)?.length ?? 0) + (pva.match(re)?.length ?? 0);
    expect(count).toBe(1);
  });

  it("GET /api/payment-vouchers/123 reaches ID handler", async () => {
    const app = await makeApp();
    const res = await request(app).get("/api/payment-vouchers/123");
    expect(res.status).toBe(200);
    expect(Number(res.body?.id)).toBe(123);
  });

  it("GET /api/payment-vouchers/not-a-number returns 400 invalid voucher ID", async () => {
    const app = await makeApp();
    const res = await request(app).get("/api/payment-vouchers/not-a-number");
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/invalid voucher id/i);
  });

  it("GET /api/payment-vouchers clamps limit to 100", async () => {
    const app = await makeApp();
    const res = await request(app).get("/api/payment-vouchers?page=1&limit=200");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(100);
    expect(dbState.paymentVoucherSelectLimit).toBe(100);
  });
});
