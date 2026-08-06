import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequestTimeoutError } from "../../../lib/fetch-with-timeout";
import {
  blockRepeatedEnterWhenDisabled,
  clearPendingPaymentVoucherCreateSessionState,
  derivePaymentVoucherSubmitUiState,
  getPaymentVoucherCreateStatus,
  loadPendingPaymentVoucherCreateSessionState,
  PaymentVoucherConfirmationPendingError,
  PaymentVoucherConfirmationStaleError,
  PaymentVoucherConfirmationUnknownError,
  PaymentVoucherNotFoundError,
  PaymentVoucherStatusCheckFailedError,
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

    await expect(submitPaymentVoucherWithRecovery({ amount: 40 }, "req-2")).rejects.toBeInstanceOf(
      PaymentVoucherConfirmationUnknownError,
    );
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

  it("surfaces failed status via 202 polling instead of pretending success", async () => {
    apiRequestMock
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-5" }))
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

  it("404 not_found throws PaymentVoucherNotFoundError — NOT 'still being confirmed'", async () => {
    apiRequestMock
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-5b2" }))
      .mockResolvedValueOnce(mockResponse(404, { error: "Not found" }));

    const err: any = await submitPaymentVoucherWithRecovery({ amount: 40 }, "req-5b2").catch((e) => e);
    expect(err).toBeInstanceOf(PaymentVoucherNotFoundError);
    expect(err.message).toMatch(/No Payment Voucher request was recorded/);
  });

  it("503 status check returns failed with STATUS_CHECK_UNAVAILABLE", async () => {
    apiRequestMock.mockResolvedValueOnce(mockResponse(503, { error: "Status check failed", code: "STATUS_CHECK_UNAVAILABLE" }));
    const result = await getPaymentVoucherCreateStatus("req-503");
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ clientRequestId: "req-503", error: "STATUS_CHECK_UNAVAILABLE" });
  });

  it("network exception during status check returns failed with STATUS_CHECK_UNAVAILABLE", async () => {
    apiRequestMock.mockRejectedValueOnce(new Error("network down"));
    const result = await getPaymentVoucherCreateStatus("req-netdown");
    expect(result.status).toBe("failed");
    expect((result as any).error).toBe("STATUS_CHECK_UNAVAILABLE");
  });

  it("surfaces stale status via 202 polling when backend reports stale request", async () => {
    apiRequestMock
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-5c" }))
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

  it("keeps the same clientRequestId during 202 polling with processing pending state — no re-submit", async () => {
    apiRequestMock
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-9" }))
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-9" }));

    await expect(submitPaymentVoucherWithRecovery({ amount: 40 }, "req-9")).rejects.toMatchObject({
      name: "PaymentVoucherConfirmationPendingError",
      clientRequestIds: ["req-9"],
    });

    expect(apiRequestMock).toHaveBeenNthCalledWith(2, "/payment-vouchers/by-client-request/req-9", expect.any(Object));
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
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

  it("Enter key is blocked when submit is disabled — prevents repeated Enter presses", () => {
    const fakeEvent: any = {
      key: "Enter",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    const result = blockRepeatedEnterWhenDisabled({ event: fakeEvent, disabled: true });
    expect(result).toBe(false);
    expect(fakeEvent.defaultPrevented).toBe(true);
    expect(fakeEvent.propagationStopped).toBe(true);
  });

  it("Enter key is allowed when submit is not disabled", () => {
    const fakeEvent: any = {
      key: "Enter",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    const result = blockRepeatedEnterWhenDisabled({ event: fakeEvent, disabled: false });
    expect(result).toBe(true);
    expect(fakeEvent.defaultPrevented).toBe(false);
  });

  it("non-Enter keys pass through regardless of disabled state", () => {
    const fakeEvent: any = {
      key: "Tab",
      preventDefault() { throw new Error("should not be called"); },
      stopPropagation() { throw new Error("should not be called"); },
    };
    expect(blockRepeatedEnterWhenDisabled({ event: fakeEvent, disabled: true })).toBe(true);
  });

  it("submitDisabled disables button while both submitting + checking status + pending exists", () => {
    const submitting = derivePaymentVoucherSubmitUiState({
      isSubmitting: true,
      isCheckingStatus: false,
      pendingClientRequestIds: [],
      unresolvedPhase: null,
    });
    expect(submitting.submitDisabled).toBe(true);

    const checking = derivePaymentVoucherSubmitUiState({
      isSubmitting: false,
      isCheckingStatus: true,
      pendingClientRequestIds: [],
      unresolvedPhase: null,
    });
    expect(checking.submitDisabled).toBe(true);

    const pending = derivePaymentVoucherSubmitUiState({
      isSubmitting: false,
      isCheckingStatus: false,
      pendingClientRequestIds: ["req-a"],
      unresolvedPhase: null,
    });
    expect(pending.submitDisabled).toBe(true);
  });

  it("POST timeout throws ConfirmationUnknownError with stable clientRequestId — does not auto-resubmit", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new RequestTimeoutError(20000));

    const err: any = await submitPaymentVoucherWithRecovery({ amount: 99 }, "req-stable-1").catch((e) => e);
    expect(err).toBeInstanceOf(PaymentVoucherConfirmationUnknownError);
    expect(err.clientRequestIds).toEqual(["req-stable-1"]);
    expect(err.message).toBe("Outcome unknown — Check Status");
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it("status check 503 throws PaymentVoucherStatusCheckFailedError — does not claim still processing", async () => {
    apiRequestMock
      .mockResolvedValueOnce(mockResponse(202, { status: "processing", clientRequestId: "req-fail-503" }))
      .mockResolvedValueOnce(mockResponse(503, { error: "Status check failed", code: "STATUS_CHECK_UNAVAILABLE" }));

    const err: any = await submitPaymentVoucherWithRecovery({ amount: 10 }, "req-fail-503").catch((e) => e);
    expect(err).toBeInstanceOf(PaymentVoucherStatusCheckFailedError);
    expect(err.message).toBe("Status check failed.");
  });
});
