import { describe, expect, it } from "vitest";
import {
  AccountingSettingsLoaderError,
  addBusinessHours,
  buildRoleTemplate,
  getDefaultAccountingSettings,
  resolvePaymentVoucherSlaHours,
  safeLoadAccountingSettings,
  type AccountingSettingsLoaderErrorCode,
} from "../modules/accounting/accounting-settings";
import type { sql as SqlT } from "drizzle-orm";

function fakeEq(lhs: unknown, rhs: unknown) {
  return { op: "eq", lhs, rhs };
}

function sqlStub(): typeof SqlT {
  return {
    raw: (tpl: TemplateStringsArray | string, ...args: unknown[]) => ({
      type: "raw",
      tpl: typeof tpl === "string" ? tpl : tpl.join(""),
      args,
    }),
  } as unknown as typeof SqlT;
}

function makeDbStubWithSelectError(err: unknown, opts?: { hasExecute?: boolean }) {
  const selectCalls: unknown[][] = [];
  return {
    capture: { selectCalls },
    db: {
      select: (...args: unknown[]) => {
        selectCalls.push(args);
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.reject(err),
            }),
          }),
        };
      },
      ...(opts?.hasExecute === false
        ? {}
        : {
          execute: async (_q: unknown) => { return; },
        }),
    },
  };
}

function makeDbStubWithNoRows(opts?: { hasExecute?: boolean }) {
  return {
    db: {
      select: (..._args: unknown[]) => {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        };
      },
      ...(opts?.hasExecute === false
        ? {}
        : {
          execute: async (_q: unknown) => { return; },
        }),
    },
  };
}

function makeDbStubWithRows(rows: unknown[], opts?: { hasExecute?: boolean }) {
  return {
    db: {
      select: (..._args: unknown[]) => {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(rows),
            }),
          }),
        };
      },
      ...(opts?.hasExecute === false
        ? {}
        : {
          execute: async (_q: unknown) => { return; },
        }),
    },
  };
}

const fakeTable = { firmId: "firm_id", status: "status" } as any;

describe("accounting settings helpers", () => {
  it("builds safe default template for account manager and admin", () => {
    const settings = getDefaultAccountingSettings(1);

    const manager = buildRoleTemplate("account_manager", settings).map((row) => `${row.module}:${row.action}`);
    const admin = buildRoleTemplate("account_admin", settings).map((row) => `${row.module}:${row.action}`);

    expect(manager).toContain("accounting:read");
    expect(manager).toContain("accounting:mark_received");
    expect(manager).toContain("accounting:mark_paid");
    expect(manager).not.toContain("accounting:approve");

    expect(admin).toContain("accounting:read");
    expect(admin).toContain("accounting:mark_received");
    expect(admin).not.toContain("accounting:mark_paid");
    expect(admin).not.toContain("accounting:approve");
  });

  it("enables explicit final approval only when settings allow it", () => {
    const settings = getDefaultAccountingSettings(1);
    settings.approvalRules.managerCanFinalApprove = true;
    settings.approvalRules.adminCanFinalApprove = true;

    const manager = buildRoleTemplate("account_manager", settings).map((row) => `${row.module}:${row.action}`);
    const admin = buildRoleTemplate("account_admin", settings).map((row) => `${row.module}:${row.action}`);

    expect(manager).toContain("accounting:approve");
    expect(admin).toContain("accounting:approve");
  });

  it("resolves payment voucher SLA from threshold before voucher type/default", () => {
    const settings = getDefaultAccountingSettings(1);
    settings.paymentVoucherSla.defaultHours = 24;
    settings.paymentVoucherSla.urgentHours = 4;
    settings.paymentVoucherSla.voucherTypeHours.external_payment = 18;
    settings.paymentVoucherSla.thresholds = [
      { minAmount: 5000, hours: 48 },
    ];

    expect(resolvePaymentVoucherSlaHours(6000, "external_payment", true, settings)).toBe(48);
    expect(resolvePaymentVoucherSlaHours(200, "external_payment", false, settings)).toBe(18);
    expect(resolvePaymentVoucherSlaHours(200, "unknown_type", true, settings)).toBe(4);
    expect(resolvePaymentVoucherSlaHours(200, "unknown_type", false, settings)).toBe(24);
  });

  it("adds business hours within working window", () => {
    const settings = getDefaultAccountingSettings(1);
    settings.timezone = "Asia/Kuala_Lumpur";
    const start = new Date("2026-07-27T01:00:00.000Z");
    const due = addBusinessHours(start, 2, settings);

    expect(due.toISOString()).toBe("2026-07-27T03:00:00.000Z");
  });

  it("skips weekends when computing due time", () => {
    const settings = getDefaultAccountingSettings(1);
    settings.timezone = "Asia/Kuala_Lumpur";
    settings.excludeSaturday = true;
    settings.excludeSunday = true;
    const start = new Date("2026-07-24T09:00:00.000Z");
    const due = addBusinessHours(start, 2, settings);

    expect(due.toISOString()).toBe("2026-07-27T02:00:00.000Z");
  });

  it("skips firm holidays when computing due time", () => {
    const settings = getDefaultAccountingSettings(1);
    settings.timezone = "Asia/Kuala_Lumpur";
    settings.firmHolidays = [{ date: "2026-07-28", label: "Firm holiday" }];
    const start = new Date("2026-07-27T08:00:00.000Z");
    const due = addBusinessHours(start, 10, settings);

    expect(due.toISOString()).toBe("2026-07-29T09:00:00.000Z");
  });
});

describe("safeLoadAccountingSettings bounded loader", () => {
  const sql = sqlStub();

  it("maps SQLSTATE 42P01 -> MIGRATION_MISSING (missing table)", async () => {
    const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { db } = makeDbStubWithSelectError(err);
    let threw: AccountingSettingsLoaderError | null = null;
    try {
      await safeLoadAccountingSettings({
        firmId: 1,
        db: db as any,
        accountingSettingsTable: fakeTable,
        sql,
        eq: fakeEq,
      });
    } catch (e) {
      threw = e as AccountingSettingsLoaderError;
    }
    expect(threw).toBeInstanceOf(AccountingSettingsLoaderError);
    expect(threw?.code).toBe("MIGRATION_MISSING");
    expect(threw?.sqlstate).toBe("42P01");
  });

  it("maps SQLSTATE 42703 -> MIGRATION_MISSING (missing column)", async () => {
    const err = Object.assign(new Error("column does not exist"), { code: "42703" });
    const { db } = makeDbStubWithSelectError(err);
    let threw: AccountingSettingsLoaderError | null = null;
    try {
      await safeLoadAccountingSettings({
        firmId: 1,
        db: db as any,
        accountingSettingsTable: fakeTable,
        sql,
        eq: fakeEq,
      });
    } catch (e) {
      threw = e as AccountingSettingsLoaderError;
    }
    expect(threw).toBeInstanceOf(AccountingSettingsLoaderError);
    expect(threw?.code).toBe("MIGRATION_MISSING");
  });

  it("maps SQLSTATE 42501 -> DATABASE_PERMISSION_ERROR", async () => {
    const err = Object.assign(new Error("permission denied"), { code: "42501" });
    const { db } = makeDbStubWithSelectError(err);
    let threw: AccountingSettingsLoaderError | null = null;
    try {
      await safeLoadAccountingSettings({
        firmId: 1,
        db: db as any,
        accountingSettingsTable: fakeTable,
        sql,
        eq: fakeEq,
      });
    } catch (e) {
      threw = e as AccountingSettingsLoaderError;
    }
    expect(threw).toBeInstanceOf(AccountingSettingsLoaderError);
    expect(threw?.code).toBe("DATABASE_PERMISSION_ERROR");
  });

  it("maps SQLSTATE 57014 -> QUERY_TIMEOUT", async () => {
    const err = Object.assign(new Error("statement timeout"), { code: "57014" });
    const { db } = makeDbStubWithSelectError(err);
    let threw: AccountingSettingsLoaderError | null = null;
    try {
      await safeLoadAccountingSettings({
        firmId: 1,
        db: db as any,
        accountingSettingsTable: fakeTable,
        sql,
        eq: fakeEq,
      });
    } catch (e) {
      threw = e as AccountingSettingsLoaderError;
    }
    expect(threw).toBeInstanceOf(AccountingSettingsLoaderError);
    expect(threw?.code).toBe("QUERY_TIMEOUT");
  });

  it("maps SQLSTATE 55P03 -> LOCK_TIMEOUT", async () => {
    const err = Object.assign(new Error("lock timeout"), { code: "55P03" });
    const { db } = makeDbStubWithSelectError(err);
    let threw: AccountingSettingsLoaderError | null = null;
    try {
      await safeLoadAccountingSettings({
        firmId: 1,
        db: db as any,
        accountingSettingsTable: fakeTable,
        sql,
        eq: fakeEq,
      });
    } catch (e) {
      threw = e as AccountingSettingsLoaderError;
    }
    expect(threw).toBeInstanceOf(AccountingSettingsLoaderError);
    expect(threw?.code).toBe("LOCK_TIMEOUT");
  });

  it("returns default settings with rowExisted=false when row missing", async () => {
    const { db } = makeDbStubWithNoRows();
    const result = await safeLoadAccountingSettings({
      firmId: 1,
      db: db as any,
      accountingSettingsTable: fakeTable,
      sql,
      eq: fakeEq,
    });
    expect(result.rowExisted).toBe(false);
    expect(result.settings.firmId).toBe(1);
    expect(typeof result.settings.timezone).toBe("string");
  });

  it("never creates an Unhandled Rejection — all failures are caught as thrown errors", async () => {
    const err = Object.assign(new Error("boom"), { code: "XX999" });
    const { db } = makeDbStubWithSelectError(err);
    const unhandled: unknown[] = [];
    const prev = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const handler = (r: unknown) => { unhandled.push(r); };
    process.on("unhandledRejection", handler);
    let threw: unknown = null;
    try {
      await safeLoadAccountingSettings({
        firmId: 1,
        db: db as any,
        accountingSettingsTable: fakeTable,
        sql,
        eq: fakeEq,
      });
    } catch (e) {
      threw = e;
    }
    process.removeListener("unhandledRejection", handler);
    for (const l of prev) process.on("unhandledRejection", l);
    expect(threw).toBeInstanceOf(AccountingSettingsLoaderError);
    expect(unhandled).toEqual([]);
  });

  it("returns ACCOUNTING_SETTINGS_UNAVAILABLE for unexpected errors", async () => {
    const err = new Error("network oops");
    const { db } = makeDbStubWithSelectError(err);
    let threw: AccountingSettingsLoaderError | null = null;
    try {
      await safeLoadAccountingSettings({
        firmId: 1,
        db: db as any,
        accountingSettingsTable: fakeTable,
        sql,
        eq: fakeEq,
      });
    } catch (e) {
      threw = e as AccountingSettingsLoaderError;
    }
    expect(threw?.code).toBe("ACCOUNTING_SETTINGS_UNAVAILABLE");
  });
});
