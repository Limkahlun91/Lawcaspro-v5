import { describe, expect, it } from "vitest";
import {
  isPaymentVoucherCreateRequestStale,
  PAYMENT_VOUCHER_CREATE_STALE_MS,
  resolvePaymentVoucherCreateStatus,
} from "../modules/accounting/payment-voucher-create-status.js";

describe("payment voucher create status helper", () => {
  const now = new Date("2026-07-28T12:00:00.000Z");

  it("returns completed when a voucher already exists", () => {
    const result = resolvePaymentVoucherCreateStatus({
      clientRequestId: "req-1",
      requestState: { status: "processing", updatedAt: now },
      voucher: { id: 10, voucherNo: "PV-10" },
      isViewerAllowed: true,
      now,
    });

    expect(result).toEqual({
      httpStatus: 200,
      body: { status: "completed", voucher: { id: 10, voucherNo: "PV-10" } },
    });
  });

  it("returns processing while the request is still active", () => {
    const result = resolvePaymentVoucherCreateStatus({
      clientRequestId: "req-2",
      requestState: { status: "processing", updatedAt: now },
      voucher: null,
      isViewerAllowed: true,
      activeLockHeld: true,
      now,
    });

    expect(result).toEqual({
      httpStatus: 202,
      body: { status: "processing", clientRequestId: "req-2" },
    });
  });

  it("returns stale when processing has exceeded the threshold without an active lock", () => {
    const updatedAt = new Date(now.getTime() - PAYMENT_VOUCHER_CREATE_STALE_MS - 1);
    const result = resolvePaymentVoucherCreateStatus({
      clientRequestId: "req-3",
      requestState: { status: "processing", updatedAt },
      voucher: null,
      isViewerAllowed: true,
      activeLockHeld: false,
      now,
    });

    expect(result.httpStatus).toBe(409);
    expect(result.body).toMatchObject({
      status: "stale",
      clientRequestId: "req-3",
      staleAfterMs: PAYMENT_VOUCHER_CREATE_STALE_MS,
    });
  });

  it("returns failed when the request recorded an error", () => {
    const result = resolvePaymentVoucherCreateStatus({
      clientRequestId: "req-4",
      requestState: { status: "failed", lastError: "Insufficient Client Account Balance" },
      voucher: null,
      isViewerAllowed: true,
      now,
    });

    expect(result).toEqual({
      httpStatus: 409,
      body: {
        status: "failed",
        clientRequestId: "req-4",
        error: "Insufficient Client Account Balance",
      },
    });
  });

  it("returns not found when there is no request or voucher", () => {
    const result = resolvePaymentVoucherCreateStatus({
      clientRequestId: "req-5",
      requestState: null,
      voucher: null,
      isViewerAllowed: false,
      now,
    });

    expect(result).toEqual({
      httpStatus: 404,
      body: { error: "Not found" },
    });
  });

  it("returns forbidden for a non-owner without reviewer access when a voucher exists", () => {
    const result = resolvePaymentVoucherCreateStatus({
      clientRequestId: "req-6",
      requestState: null,
      voucher: { id: 12, voucherNo: "PV-12" },
      isViewerAllowed: false,
      now,
    });

    expect(result).toEqual({
      httpStatus: 403,
      body: { error: "Forbidden", code: "FORBIDDEN" },
    });
  });

  it("treats only older processing timestamps as stale", () => {
    expect(isPaymentVoucherCreateRequestStale(new Date(now.getTime() - PAYMENT_VOUCHER_CREATE_STALE_MS - 1), now)).toBe(true);
    expect(isPaymentVoucherCreateRequestStale(new Date(now.getTime() - PAYMENT_VOUCHER_CREATE_STALE_MS + 1), now)).toBe(false);
    expect(isPaymentVoucherCreateRequestStale(null, now)).toBe(false);
  });
});
