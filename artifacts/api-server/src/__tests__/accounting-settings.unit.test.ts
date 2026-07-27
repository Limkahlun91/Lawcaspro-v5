import { describe, expect, it } from "vitest";
import {
  addBusinessHours,
  buildRoleTemplate,
  getDefaultAccountingSettings,
  resolvePaymentVoucherSlaHours,
} from "../modules/accounting/accounting-settings";

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
