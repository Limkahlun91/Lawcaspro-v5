import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestTimeoutError } from "../../../lib/fetch-with-timeout";
import {
  clearPendingPaymentVoucherCreateSessionState,
  derivePaymentVoucherSubmitUiState,
  getPaymentVoucherCreateStatus,
  loadPendingPaymentVoucherCreateSessionState,
  PaymentVoucherConfirmationPendingError,
  PaymentVoucherConfirmationStaleError,
  PaymentVoucherConfirmationUnknownError,
  restorePendingPaymentVoucherCreateFromSessionStorage,
  savePendingPaymentVoucherCreateSessionState,
  submitPaymentVoucherWithRecovery,
} from "./payment-voucher-submit";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", () => ({
  apiRequest: (...args: any[]) => apiRequestMock(...args),
}));

function mockResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
  } as any;
}

describe("payment voucher submit recovery", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it("returns the voucher when create succeeds immediately", async () => {
    apiRequestMock.mockResolvedValueOnce(mockResponse(201, { id: 7, voucherNo: "PV-2026-0007" }));

    const result = await submitPaymentVoucherWithRecovery({ amount: 40 }, "req-1");

    expect(result).toMatchObject({ id: 7, voucherNo: "PV-2026-0007" });
  });

  it("returns the confirmed voucher after a timeout", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new RequestTimeoutError(20000))
      .mockResolvedValueOnce(mockResponse(200, { status: "completed", voucher: { id: 8, voucherNo: "PV-2026-0008" } }));

    const result = await submitPaymentVoucherWithRecovery({ amount: 40 }, "req-2");

    expect(result).toMatchObject({ id: 8, voucherNo: "PV-2026-0008" });
    expect(apiRequestMock).toHaveBeenNthCalledWith(2, "/payment-vouchers/by-client-request/req-2", expect.any(Object));
  });

  it("throws a confirmation-pending error when create responds 202 processing", async () => {
    apiRequestMock
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-3" }))
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-3" }));

    await expect(submitPaymentVoucherWithRecovery({ amount: 40 }, "req-3")).rejects.toMatchObject({
      name: "PaymentVoucherConfirmationPendingError",
      clientRequestIds: ["req-3"],
    });
  });

  it("returns processing status from the status endpoint", async () => {
    apiRequestMock.mockResolvedValueOnce(mockResponse(202, {
      status: "processing",
      clientRequestId: "req-3b",
    }));

    await expect(getPaymentVoucherCreateStatus("req-3b")).resolves.toEqual({
      status: "processing",
      clientRequestId: "req-3b",
    });
  });

  it("returns failed status details for a known failed request", async () => {
    apiRequestMock.mockResolvedValueOnce(mockResponse(409, {
      status: "failed",
      clientRequestId: "req-4",
      error: "Insufficient Client Account Balance",
    }));

    const result = await getPaymentVoucherCreateStatus("req-4");

    expect(result).toEqual({
      status: "failed",
      clientRequestId: "req-4",
      error: "Insufficient Client Account Balance",
    });
  });

  it("returns stale status details when the backend marks the request stale", async () => {
    apiRequestMock.mockResolvedValueOnce(mockResponse(409, {
      status: "stale",
      clientRequestId: "req-4b",
      error: "Payment Voucher submission status is stale. Please retry status confirmation before submitting again.",
      staleAfterMs: 60000,
    }));

    await expect(getPaymentVoucherCreateStatus("req-4b")).resolves.toEqual({
      status: "stale",
      clientRequestId: "req-4b",
      error: "Payment Voucher submission status is stale. Please retry status confirmation before submitting again.",
      staleAfterMs: 60000,
    });
  });

  it("surfaces failed status after a timeout instead of pretending success", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new RequestTimeoutError(20000))
      .mockResolvedValueOnce(mockResponse(409, {
        status: "failed",
        clientRequestId: "req-5",
        error: "Insufficient Client Account Balance",
      }));

    await expect(submitPaymentVoucherWithRecovery({ amount: 40 }, "req-5")).rejects.toThrow(
      "Insufficient Client Account Balance",
    );
  });

  it("surfaces unknown timeout state when the status lookup cannot find the request yet", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new RequestTimeoutError(20000))
      .mockResolvedValueOnce(mockResponse(404, { error: "Not found" }));

    await expect(submitPaymentVoucherWithRecovery({ amount: 40 }, "req-5b")).rejects.toBeInstanceOf(
      PaymentVoucherConfirmationUnknownError,
    );
  });

  it("surfaces stale status after a timeout when the backend reports a stale request", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new RequestTimeoutError(20000))
      .mockResolvedValueOnce(mockResponse(409, {
        status: "stale",
        clientRequestId: "req-5c",
        error: "Payment Voucher submission status is stale. Please retry status confirmation before submitting again.",
        staleAfterMs: 60000,
      }));

    await expect(submitPaymentVoucherWithRecovery({ amount: 40 }, "req-5c")).rejects.toBeInstanceOf(
      PaymentVoucherConfirmationStaleError,
    );
  });

  it("check status never calls the create endpoint", async () => {
    apiRequestMock.mockResolvedValueOnce(mockResponse(200, {
      status: "completed",
      voucher: { id: 9, voucherNo: "PV-2026-0009" },
    }));

    await getPaymentVoucherCreateStatus("req-6");

    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith("/payment-vouchers/by-client-request/req-6", expect.any(Object));
  });

  it("derives disabled submit state while a request is active", () => {
    expect(derivePaymentVoucherSubmitUiState({
      isSubmitting: false,
      isCheckingStatus: false,
      pendingClientRequestIds: ["req-7"],
      unresolvedPhase: "processing",
    })).toEqual({
      phase: "processing",
      submitDisabled: true,
      showCheckStatus: true,
      submitLabel: "Awaiting confirmation…",
    });
  });

  it("keeps a safe stale UI phase distinct from failed", () => {
    expect(derivePaymentVoucherSubmitUiState({
      isSubmitting: false,
      isCheckingStatus: true,
      pendingClientRequestIds: ["req-8"],
      unresolvedPhase: "stale",
    })).toEqual({
      phase: "stale",
      submitDisabled: true,
      showCheckStatus: true,
      submitLabel: "Status stale…",
    });
  });

  it("keeps the same clientRequestId during timeout recovery status checks", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new RequestTimeoutError(20000))
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-9" }));

    await expect(submitPaymentVoucherWithRecovery({ amount: 40 }, "req-9")).rejects.toMatchObject({
      name: "PaymentVoucherConfirmationPendingError",
      clientRequestIds: ["req-9"],
    });

    expect(apiRequestMock).toHaveBeenNthCalledWith(2, "/payment-vouchers/by-client-request/req-9", expect.any(Object));
  });

  it("keeps the pending error type stable for callers", async () => {
    const err = new PaymentVoucherConfirmationPendingError(["req-6"]);
    expect(err.clientRequestIds).toEqual(["req-6"]);
    expect(err.completedVouchers).toEqual([]);
  });

  it("persists and restores a pending create request across refresh using sessionStorage-safe state", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };

    savePendingPaymentVoucherCreateSessionState({
      v: 1,
      firmId: 1,
      userId: 2,
      createdAt: new Date("2026-07-28T12:00:00.000Z").toISOString(),
      clientRequestIds: ["req-10"],
      phase: "unknown",
    }, storage);

    const loaded = loadPendingPaymentVoucherCreateSessionState({
      firmId: 1,
      userId: 2,
      now: new Date("2026-07-28T12:01:00.000Z"),
      storage,
    });

    expect(loaded).toMatchObject({
      firmId: 1,
      userId: 2,
      clientRequestIds: ["req-10"],
      phase: "unknown",
    });

    clearPendingPaymentVoucherCreateSessionState(storage);
    expect(loadPendingPaymentVoucherCreateSessionState({ firmId: 1, userId: 2, storage })).toBe(null);
  });

  it("ignores persisted pending state from another firm/user", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };

    savePendingPaymentVoucherCreateSessionState({
      v: 1,
      firmId: 99,
      userId: 99,
      createdAt: new Date("2026-07-28T12:00:00.000Z").toISOString(),
      clientRequestIds: ["req-11"],
      phase: "processing",
    }, storage);

    expect(loadPendingPaymentVoucherCreateSessionState({ firmId: 1, userId: 2, storage })).toBe(null);
  });

  it("restores pending state and triggers caller restoration callback (refresh recovery)", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };

    savePendingPaymentVoucherCreateSessionState({
      v: 1,
      firmId: 5,
      userId: 6,
      createdAt: new Date("2026-07-28T12:00:00.000Z").toISOString(),
      clientRequestIds: ["req-12"],
      phase: "processing",
    }, storage);

    const restored: any[] = [];
    const state = restorePendingPaymentVoucherCreateFromSessionStorage({
      firmId: 5,
      userId: 6,
      storage,
      now: new Date("2026-07-28T12:01:00.000Z"),
      onRestore: (s) => restored.push(s),
    });

    expect(state?.clientRequestIds).toEqual(["req-12"]);
    expect(restored).toHaveLength(1);
  });
});
