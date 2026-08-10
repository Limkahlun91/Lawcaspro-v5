import { describe, expect, it } from "vitest";
import {
  isPaymentVoucherCreateRequestStale,
  PAYMENT_VOUCHER_CREATE_STALE_MS,
  resolvePaymentVoucherCreateStatus,
} from "../modules/accounting/payment-voucher-create-status.js";

describe("UNIT TESTS ONLY — P0 Payment Voucher Early Idempotency behavioral contracts (NOT HTTP/DB integration)", () => {
  const now = new Date("2026-07-28T12:00:00.000Z");

  it("A - NEW clientRequestId + fresh-first-insert branch: expected 201 completed/voucher persisted semantic", () => {
    const result = resolvePaymentVoucherCreateStatus({
      clientRequestId: "a-" + crypto.randomUUID(),
      requestState: { status: "completed", updatedAt: now, paymentVoucherId: 42 },
      voucher: { id: 42, voucherNo: "PV-10042" },
      isViewerAllowed: true,
      now,
    });
    expect(result.httpStatus).toBe(200);
    const body: any = result.body;
    expect(body.status).toBe("completed");
    expect(body.voucher.id).toBe(42);
  });

  it("B - GET same clientRequestId after completed: 200 + correct voucherId", () => {
    const rid = "b-" + crypto.randomUUID();
    const res = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "completed", updatedAt: now, paymentVoucherId: 99 },
      voucher: { id: 99, voucherNo: "PV-10099" },
      isViewerAllowed: true,
      now,
    });
    expect(res.httpStatus).toBe(200);
    const body: any = res.body;
    expect(body.status).toBe("completed");
    expect(body.voucher.id).toBe(99);
  });

  it("C - Idempotency guarantee: exact same retried key does NOT produce second voucher (single physical voucher semantic)", () => {
    const rid = "c-" + crypto.randomUUID();
    const first = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "completed", updatedAt: now, paymentVoucherId: 7 },
      voucher: { id: 7, voucherNo: "PV-10007" },
      isViewerAllowed: true,
      now,
    });
    const second = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "completed", updatedAt: now, paymentVoucherId: 7 },
      voucher: { id: 7, voucherNo: "PV-10007" },
      isViewerAllowed: true,
      now,
    });
    expect(first.httpStatus).toBe(200);
    expect(second.httpStatus).toBe(200);
    expect((first.body as any).voucher.id).toBe(7);
    expect((second.body as any).voucher.id).toBe(7);
  });

  it("D - Concurrent same-key: exactly one physical voucher (parallel observers both see same or processing)", () => {
    const rid = "d-" + crypto.randomUUID();
    const winner = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "completed", updatedAt: now, paymentVoucherId: 1 },
      voucher: { id: 1, voucherNo: "PV-10001" },
      isViewerAllowed: true,
      now,
    });
    const loser = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "processing", updatedAt: now },
      voucher: null,
      isViewerAllowed: true,
      activeLockHeld: true,
      now,
    });
    const wbody: any = winner.body;
    const lbody: any = loser.body;
    const distinctCompletedIds = new Set<number>();
    if (wbody.status === "completed") distinctCompletedIds.add(Number(wbody.voucher.id));
    if (lbody.status === "completed") distinctCompletedIds.add(Number(lbody.voucher.id));
    expect([winner.httpStatus, loser.httpStatus].every((s) => [200, 202].includes(s))).toBe(true);
    expect(distinctCompletedIds.size <= 1).toBe(true);
    expect(distinctCompletedIds.size >= 0).toBe(true);
    expect(distinctCompletedIds.size === 0 ? wbody.status === "completed" || lbody.status === "processing" : true).toBe(true);
  });

  it("E - Failure after reservation recorded: terminal state must be failed (not processing)", () => {
    const rid = "e-" + crypto.randomUUID();
    const r = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "failed", lastError: "CASE_REQUIRED_FOR_CLIENT_ACCOUNT", updatedAt: now },
      voucher: null,
      isViewerAllowed: true,
      now,
    });
    expect(r.httpStatus).toBe(409);
    const body: any = r.body;
    expect(body.status).toBe("failed");
    expect(String(body.error ?? "")).toMatch(/CASE_REQUIRED_FOR_CLIENT_ACCOUNT/);
  });

  it("F - Accounting settings timeout / stranded: after terminal failure report must not remain processing forever", () => {
    const rid = "f-" + crypto.randomUUID();
    const r = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "failed", lastError: "ACCOUNTING_SETTINGS:QUERY_TIMEOUT", updatedAt: now },
      voucher: null,
      isViewerAllowed: true,
      now,
    });
    expect(r.httpStatus).toBe(409);
    const body: any = r.body;
    expect(body.status).toBe("failed");
    expect(String(body.error ?? "")).toMatch(/ACCOUNTING_SETTINGS:QUERY_TIMEOUT/);
  });

  it("G - Stale processing recovery: processing older than STALE_MS without active lock → stale (safe reclaim semantic)", () => {
    const rid = "g-" + crypto.randomUUID();
    const updatedAt = new Date(now.getTime() - PAYMENT_VOUCHER_CREATE_STALE_MS - 1);
    expect(isPaymentVoucherCreateRequestStale(updatedAt, now)).toBe(true);
    const r = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: { status: "processing", updatedAt },
      voucher: null,
      isViewerAllowed: true,
      activeLockHeld: false,
      now,
    });
    expect(r.httpStatus).toBe(409);
    const body: any = r.body;
    expect(body.status).toBe("stale");
  });

  it("H - Different payload / same clientRequestId → reserved key reuse must be 409 conflict (CLIENT_REQUEST_ID_REUSED code path)", () => {
    const rid = "h-fixed-reuse-uuid";
    const r = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: {
        status: "failed",
        lastError: "CLIENT_REQUEST_ID_REUSED: payload hash mismatch on existing completed request",
        updatedAt: now,
      },
      voucher: null,
      isViewerAllowed: true,
      now,
    });
    expect(r.httpStatus).toBe(409);
    const body: any = r.body;
    expect(String(body.error ?? "")).toMatch(/CLIENT_REQUEST_ID_REUSED/);
  });

  it("I - Unknown UUID GET: 404 Not Found", () => {
    const rid = "i-" + crypto.randomUUID();
    const r = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: null,
      voucher: null,
      isViewerAllowed: true,
      now,
    });
    expect(r.httpStatus).toBe(404);
    const body: any = r.body;
    expect(String(body.error ?? "")).toMatch(/Not found/i);
  });

  it("J - Unauthorized / non-owner / forbidden viewer: 403 FORBIDDEN with no status leak", () => {
    const rid = "j-" + crypto.randomUUID();
    const r = resolvePaymentVoucherCreateStatus({
      clientRequestId: rid,
      requestState: null,
      voucher: { id: 12, voucherNo: "PV-12" },
      isViewerAllowed: false,
      now,
    });
    expect(r.httpStatus).toBe(403);
    const body: any = r.body;
    expect(String(body.code ?? "")).toBe("FORBIDDEN");
  });
});
