export const PAYMENT_VOUCHER_CREATE_STALE_MS = 60_000;

export type PaymentVoucherCreateRequestStateLike = {
  status: string;
  updatedAt?: Date | string | null;
  lastError?: string | null;
  paymentVoucherId?: number | null;
  createdByUserId?: number | null;
};

export type PaymentVoucherCreateStatusVoucher = {
  id: number;
  voucherNo: string;
};

export function isPaymentVoucherCreateRequestStale(
  updatedAt: Date | string | null | undefined,
  now: Date = new Date(),
  thresholdMs: number = PAYMENT_VOUCHER_CREATE_STALE_MS,
): boolean {
  if (!updatedAt) return false;
  const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return now.getTime() - ts >= thresholdMs;
}

export function resolvePaymentVoucherCreateStatus(args: {
  clientRequestId: string;
  requestState?: PaymentVoucherCreateRequestStateLike | null;
  voucher?: PaymentVoucherCreateStatusVoucher | null;
  isViewerAllowed: boolean;
  activeLockHeld?: boolean;
  now?: Date;
}):
  | { httpStatus: 200; body: { status: "completed"; voucher: PaymentVoucherCreateStatusVoucher } }
  | { httpStatus: 202; body: { status: "processing"; clientRequestId: string } }
  | { httpStatus: 404; body: { error: "Not found" } }
  | { httpStatus: 403; body: { error: "Forbidden"; code: "FORBIDDEN" } }
  | { httpStatus: 409; body: { status: "failed"; clientRequestId: string; error: string } }
  | { httpStatus: 409; body: { status: "stale"; clientRequestId: string; error: string; staleAfterMs: number } } {
  const { clientRequestId, requestState, voucher, isViewerAllowed, activeLockHeld = false, now = new Date() } = args;

  if (requestState?.status === "processing") {
    if (voucher) {
      return { httpStatus: 200, body: { status: "completed", voucher } };
    }
    if (isPaymentVoucherCreateRequestStale(requestState.updatedAt, now) && !activeLockHeld) {
      return {
        httpStatus: 409,
        body: {
          status: "stale",
          clientRequestId,
          error: "Payment Voucher submission status is stale. Please retry status confirmation before submitting again.",
          staleAfterMs: PAYMENT_VOUCHER_CREATE_STALE_MS,
        },
      };
    }
    return { httpStatus: 202, body: { status: "processing", clientRequestId } };
  }

  if (requestState?.status === "failed") {
    if (voucher) {
      return { httpStatus: 200, body: { status: "completed", voucher } };
    }
    return {
      httpStatus: 409,
      body: {
        status: "failed",
        clientRequestId,
        error: requestState.lastError || "Payment Voucher creation failed",
      },
    };
  }

  if (!voucher) {
    return { httpStatus: 404, body: { error: "Not found" } };
  }

  if (!isViewerAllowed) {
    return { httpStatus: 403, body: { error: "Forbidden", code: "FORBIDDEN" } };
  }

  return { httpStatus: 200, body: { status: "completed", voucher } };
}
