import { apiRequest } from "../../../lib/api-client";
import { RequestTimeoutError } from "../../../lib/fetch-with-timeout";

export type PaymentVoucherPendingCreatePhase = "processing" | "unknown" | "stale";

export type PaymentVoucherPendingCreateSessionStateV1 = {
  v: 1;
  firmId: number;
  userId: number;
  createdAt: string;
  clientRequestIds: string[];
  phase: PaymentVoucherPendingCreatePhase;
};

const PV_PENDING_CREATE_STORAGE_KEY = "lawcaspro.payment_voucher.pending_create.v1";
const PV_PENDING_CREATE_RETENTION_MS = 30 * 60 * 1000;

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPendingCreatePhase(value: unknown): value is PaymentVoucherPendingCreatePhase {
  return value === "processing" || value === "unknown" || value === "stale";
}

export function clearPendingPaymentVoucherCreateSessionState(storage: Pick<Storage, "removeItem"> = sessionStorage) {
  try {
    storage.removeItem(PV_PENDING_CREATE_STORAGE_KEY);
  } catch {}
}

export function savePendingPaymentVoucherCreateSessionState(
  state: PaymentVoucherPendingCreateSessionStateV1,
  storage: Pick<Storage, "setItem"> = sessionStorage,
) {
  try {
    storage.setItem(PV_PENDING_CREATE_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function loadPendingPaymentVoucherCreateSessionState(args: {
  firmId: number;
  userId: number;
  now?: Date;
  storage?: Pick<Storage, "getItem" | "removeItem">;
}): PaymentVoucherPendingCreateSessionStateV1 | null {
  const now = args.now ?? new Date();
  const storage = args.storage ?? sessionStorage;
  let raw: string | null = null;
  try {
    raw = storage.getItem(PV_PENDING_CREATE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  const parsed = safeParseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const p = parsed as Partial<PaymentVoucherPendingCreateSessionStateV1>;
  const createdAtMs = typeof p.createdAt === "string" ? new Date(p.createdAt).getTime() : NaN;
  const expired = !Number.isFinite(createdAtMs) || now.getTime() - createdAtMs > PV_PENDING_CREATE_RETENTION_MS;
  const scopeMismatch = Number(p.firmId) !== args.firmId || Number(p.userId) !== args.userId;
  const idsOk =
    Array.isArray(p.clientRequestIds)
    && p.clientRequestIds.length > 0
    && p.clientRequestIds.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 80);

  if (p.v !== 1 || expired || scopeMismatch || !idsOk || !isPendingCreatePhase(p.phase)) {
    try {
      storage.removeItem(PV_PENDING_CREATE_STORAGE_KEY);
    } catch {}
    return null;
  }

  return {
    v: 1,
    firmId: args.firmId,
    userId: args.userId,
    createdAt: String(p.createdAt),
    clientRequestIds: p.clientRequestIds as string[],
    phase: p.phase,
  };
}

export function restorePendingPaymentVoucherCreateFromSessionStorage(args: {
  firmId: number;
  userId: number;
  onRestore: (state: PaymentVoucherPendingCreateSessionStateV1) => void;
  now?: Date;
  storage?: Pick<Storage, "getItem" | "removeItem">;
}) {
  const state = loadPendingPaymentVoucherCreateSessionState({
    firmId: args.firmId,
    userId: args.userId,
    now: args.now,
    storage: args.storage,
  });
  if (state) args.onRestore(state);
  return state;
}

export type PaymentVoucherCreateStatus =
  | { status: "completed"; voucher: any }
  | { status: "processing"; clientRequestId: string }
  | { status: "failed"; clientRequestId: string; error: string | null }
  | { status: "stale"; clientRequestId: string; error: string | null; staleAfterMs?: number | null }
  | { status: "not_found"; clientRequestId: string };

export type PaymentVoucherSubmitUiPhase =
  | "idle"
  | "submitting"
  | "processing"
  | "completed"
  | "failed"
  | "unknown"
  | "stale";

export function derivePaymentVoucherSubmitUiState(args: {
  isSubmitting: boolean;
  isCheckingStatus: boolean;
  pendingClientRequestIds: string[];
  unresolvedPhase: Exclude<PaymentVoucherSubmitUiPhase, "idle" | "submitting" | "completed"> | null;
}) {
  const hasPending = args.pendingClientRequestIds.length > 0;
  const phase: PaymentVoucherSubmitUiPhase =
    args.isSubmitting
      ? "submitting"
      : args.unresolvedPhase ?? (hasPending ? "processing" : "idle");

  const submitDisabled = args.isSubmitting || args.isCheckingStatus || hasPending;
  const showCheckStatus = hasPending;
  const submitLabel =
    phase === "submitting"
      ? "Creating…"
      : phase === "processing"
        ? "Awaiting confirmation…"
        : phase === "unknown"
          ? "Confirmation pending…"
          : phase === "stale"
            ? "Status stale…"
            : "Submit";

  return { phase, submitDisabled, showCheckStatus, submitLabel };
}

export class PaymentVoucherConfirmationPendingError extends Error {
  readonly clientRequestIds: string[];
  readonly completedVouchers: any[];

  constructor(clientRequestIds: string[], completedVouchers: any[] = []) {
    super("Payment Voucher submission is still being confirmed. Please do not submit again.");
    this.name = "PaymentVoucherConfirmationPendingError";
    this.clientRequestIds = clientRequestIds;
    this.completedVouchers = completedVouchers;
  }
}

export class PaymentVoucherConfirmationUnknownError extends Error {
  readonly clientRequestIds: string[];

  constructor(clientRequestIds: string[]) {
    super("Outcome unknown — Check Status");
    this.name = "PaymentVoucherConfirmationUnknownError";
    this.clientRequestIds = clientRequestIds;
  }
}

export class PaymentVoucherConfirmationStaleError extends Error {
  readonly clientRequestIds: string[];

  constructor(clientRequestIds: string[]) {
    super("Payment Voucher submission confirmation is stale. Please check status again before submitting again.");
    this.name = "PaymentVoucherConfirmationStaleError";
    this.clientRequestIds = clientRequestIds;
  }
}

export class PaymentVoucherNotFoundError extends Error {
  readonly clientRequestIds: string[];

  constructor(clientRequestIds: string[]) {
    super("No Payment Voucher request was recorded. You may submit again.");
    this.name = "PaymentVoucherNotFoundError";
    this.clientRequestIds = clientRequestIds;
  }
}

export class PaymentVoucherStatusCheckFailedError extends Error {
  readonly clientRequestIds: string[];

  constructor(clientRequestIds: string[]) {
    super("Status check failed.");
    this.name = "PaymentVoucherStatusCheckFailedError";
    this.clientRequestIds = clientRequestIds;
  }
}

export class PaymentVoucherPreflightWarningShown extends Error {
  constructor(message = "Unclaimed quotation item warnings shown") {
    super(message);
    this.name = "PaymentVoucherPreflightWarningShown";
  }
}

export async function getPaymentVoucherCreateStatus(clientRequestId: string): Promise<PaymentVoucherCreateStatus> {
  try {
    const res = await apiRequest(`/payment-vouchers/by-client-request/${encodeURIComponent(clientRequestId)}`, {
      timeoutMs: 12000,
      allowStatuses: [202, 404, 409, 503],
    });

    if (res.status === 503) {
      return { status: "failed", clientRequestId, error: "STATUS_CHECK_UNAVAILABLE" };
    }

    if (res.status === 404) {
      return { status: "not_found", clientRequestId };
    }

    const body = await res.json();
    if (res.status === 202) {
      return {
        status: "processing",
        clientRequestId: String(body?.clientRequestId ?? clientRequestId),
      };
    }

    if (res.status === 409) {
      if (body?.status === "stale") {
        return {
          status: "stale",
          clientRequestId: String(body?.clientRequestId ?? clientRequestId),
          error: typeof body?.error === "string" ? body.error : null,
          staleAfterMs: typeof body?.staleAfterMs === "number" ? body.staleAfterMs : null,
        };
      }
      return {
        status: "failed",
        clientRequestId: String(body?.clientRequestId ?? clientRequestId),
        error: typeof body?.error === "string" ? body.error : null,
      };
    }

    return {
      status: "completed",
      voucher: body?.voucher ?? body,
    };
  } catch (err) {
    const isTimeout =
      err instanceof RequestTimeoutError ||
      (err && typeof err === "object" && (err as any).name === "RequestTimeoutError");
    if (isTimeout) {
      return { status: "failed", clientRequestId, error: "STATUS_CHECK_TIMEOUT" };
    }
    return { status: "failed", clientRequestId, error: "STATUS_CHECK_UNAVAILABLE" };
  }
}

export async function submitPaymentVoucherWithRecovery(payload: unknown, clientRequestId: string): Promise<any> {
  const resolvePendingStatus = async (): Promise<any> => {
    const status = await getPaymentVoucherCreateStatus(clientRequestId);
    if (status.status === "completed") return status.voucher;
    if (status.status === "failed") {
      if (status.error === "STATUS_CHECK_UNAVAILABLE" || status.error === "STATUS_CHECK_TIMEOUT") {
        throw new PaymentVoucherStatusCheckFailedError([clientRequestId]);
      }
      throw new Error(status.error || "Payment Voucher submission failed");
    }
    if (status.status === "stale") {
      throw new PaymentVoucherConfirmationStaleError([clientRequestId]);
    }
    if (status.status === "not_found") {
      throw new PaymentVoucherNotFoundError([clientRequestId]);
    }
    throw new PaymentVoucherConfirmationPendingError([clientRequestId]);
  };

  try {
    const res = await apiRequest("/payment-vouchers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 20000,
    });
    const body = await res.json();
    if (res.status === 202 || body?.status === "processing") {
      return await resolvePendingStatus();
    }
    return body?.voucher ?? body;
  } catch (err) {
    const isTimeout =
      err instanceof RequestTimeoutError ||
      (err && typeof err === "object" && (err as any).name === "RequestTimeoutError");
    if (!isTimeout) throw err;
    throw new PaymentVoucherConfirmationUnknownError([clientRequestId]);
  }
}

export function blockRepeatedEnterWhenDisabled(args: {
  event: React.KeyboardEvent<HTMLFormElement | HTMLButtonElement>;
  disabled: boolean;
}): boolean {
  if (args.event.key !== "Enter") return true;
  if (args.disabled) {
    args.event.preventDefault();
    args.event.stopPropagation();
    return false;
  }
  return true;
}
