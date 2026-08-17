export type ApiErrorLike = {
  status?: unknown;
  data?: unknown;
  message?: unknown;
  code?: unknown;
  requestId?: unknown;
  stage?: unknown;
  retryable?: unknown;
  suggestion?: unknown;
  source?: unknown;
  feature?: unknown;
  error?: unknown;
  details?: unknown;
};

type ErrorLike = { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };

type ApiFailureShape = {
  ok: false;
  error: { code: string; message: string; retryable: boolean; stage?: string; suggestion?: string };
  meta: { request_id: string };
};

function asApiFailure(data: unknown): ApiFailureShape | null {
  if (!data || typeof data !== "object") return null;
  const d = data as any;
  if (d.ok !== false) return null;
  if (!d.error || typeof d.error !== "object") return null;
  if (!d.meta || typeof d.meta !== "object") return null;
  if (typeof d.error.code !== "string" || typeof d.error.message !== "string") return null;
  if (typeof d.error.retryable !== "boolean") return null;
  if (typeof d.meta.request_id !== "string") return null;
  return d as ApiFailureShape;
}

function getErrorDataField(err: unknown, field: string): unknown {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as Record<string, unknown>;
  const data = rec.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (field in d) return d[field];
  }
  if (field in rec) return rec[field];
  const errorField = rec.error;
  if (errorField && typeof errorField === "object") {
    const ef = errorField as Record<string, unknown>;
    if (field in ef) return ef[field];
  }
  return undefined;
}

export function getErrorDenialCode(err: unknown): string | null {
  const code = getErrorDataField(err, "code");
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

export function getErrorDenialSource(err: unknown): string | null {
  const source = getErrorDataField(err, "source");
  return typeof source === "string" && source.trim() ? source.trim() : null;
}

const FIRM_ENTITLEMENT_CODES = new Set(["FIRM_ENTITLEMENT_OFF", "FEATURE_DISABLED", "PARENT_OFF"]);
const FIRM_ENTITLEMENT_SOURCES = new Set(["firm_entitlement_denied", "denial"]);

const USER_ACCESS_DENIED_CODES = new Set([
  "USER_OVERRIDE_OFF",
  "ROLE_PERMISSION_DENIED",
  "USER_FEATURE_ACCESS_REQUIRED",
  "ROLE_DENIED",
  "FEATURE_OFF",
  "UNKNOWN_FEATURE",
]);
const USER_ACCESS_DENIED_SOURCES = new Set([
  "user_row_false",
  "role_permission_denied",
  "user_feature_middleware",
  "unknown_feature_deny",
]);

export function isFirmEntitlementDenied(err: unknown): boolean {
  const code = getErrorDenialCode(err);
  const source = getErrorDenialSource(err);
  const status = getHttpStatus(err);
  if (code && FIRM_ENTITLEMENT_CODES.has(code)) return true;
  if (status === 403 && source && FIRM_ENTITLEMENT_SOURCES.has(source)) return true;
  return false;
}

export function isUserAccessDenied(err: unknown): boolean {
  if (isFirmEntitlementDenied(err)) return false;
  const code = getErrorDenialCode(err);
  const source = getErrorDenialSource(err);
  const status = getHttpStatus(err);
  if (code && USER_ACCESS_DENIED_CODES.has(code)) return true;
  if (status === 403 && source && USER_ACCESS_DENIED_SOURCES.has(source)) return true;
  if (status === 403 && !code && !source) return true;
  return false;
}

export function isGenericNetworkError(err: unknown): boolean {
  return (
    isRequestTimeoutError(err) ||
    isNetworkUnavailableError(err) ||
    isAbortError(err) ||
    (getHttpStatus(err) === null && !isApiErrorLike(err))
  );
}

export type ErrorDiscrimination =
  | { kind: "firm_entitlement_off" }
  | { kind: "user_access_denied" }
  | { kind: "network_error" }
  | { kind: "other" };

export function discriminateError(err: unknown): ErrorDiscrimination {
  if (isFirmEntitlementDenied(err)) return { kind: "firm_entitlement_off" };
  if (isUserAccessDenied(err)) return { kind: "user_access_denied" };
  if (isGenericNetworkError(err)) return { kind: "network_error" };
  return { kind: "other" };
}

export function getDiscriminatedErrorTitle(err: unknown, resourceLabel: string): string {
  const d = discriminateError(err);
  switch (d.kind) {
    case "firm_entitlement_off":
      return "This feature is not enabled for your firm.";
    case "user_access_denied":
      return "You do not have access to this feature.";
    case "network_error":
      return `Unable to load ${resourceLabel}.`;
    default:
      return `Unable to load ${resourceLabel}.`;
  }
}

export function getDiscriminatedErrorDetail(err: unknown, resourceLabel: string): string {
  const d = discriminateError(err);
  switch (d.kind) {
    case "firm_entitlement_off":
      return "Contact your firm Partner or administrator to enable this feature for your subscription.";
    case "user_access_denied":
      return "Contact your firm Partner or administrator to request access to this feature.";
    case "network_error":
      return `A network error prevented ${resourceLabel.toLowerCase()} from loading. Please check your connection and retry.`;
    default: {
      const specific = getErrorMessage(err);
      if (specific && specific !== "Something went wrong") return specific;
      return `We couldn't load the latest ${resourceLabel.toLowerCase()} information.`;
    }
  }
}

export function shouldShowRetryForError(err: unknown): boolean {
  const d = discriminateError(err);
  if (d.kind === "firm_entitlement_off") return false;
  if (d.kind === "user_access_denied") return false;
  return true;
}

export function isApiErrorLike(err: unknown): err is ApiErrorLike {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  return "status" in rec || "data" in rec;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  if (rec.name === "AbortError") return true;
  const msg = typeof rec.message === "string" ? rec.message.toLowerCase() : "";
  return msg.includes("signal is aborted") || msg.includes("aborted");
}

export function isRequestTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  return rec.name === "RequestTimeoutError";
}

export function isNetworkUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as ErrorLike;
  if (rec.name === "TypeError" && typeof rec.message === "string" && rec.message.toLowerCase().includes("failed to fetch")) return true;
  if (rec.code === "ERR_NETWORK") return true;
  return false;
}

export function getErrorMessage(err: unknown): string {
  if (isRequestTimeoutError(err)) return "Request timed out";
  if (isAbortError(err)) return "Request cancelled";
  if (isNetworkUnavailableError(err)) return "Network unavailable";
  if (isApiErrorLike(err)) {
    const failure = asApiFailure(err.data);
    if (failure) {
      const base = failure.error.message || "Request failed";
      const suggestion = failure.error.suggestion ? ` ${failure.error.suggestion}` : "";
      return `${base}${suggestion}`.trim();
    }
  }
  const apiCode = isApiErrorLike(err) && typeof err.code === "string" ? err.code.trim() : "";
  const apiMsg = isApiErrorLike(err) && typeof err.message === "string" ? err.message.trim() : "";
  const allowDetailedCodes = new Set([
    "TEMPLATE_NOT_CONFIGURED",
    "TEMPLATE_FILE_MISSING",
    "TEMPLATE_FILE_NOT_FOUND",
    "TEMPLATE_RENDER_FAILED",
    "PDF_RENDER_FAILED",
    "STORAGE_TIMEOUT",
    "STORAGE_NOT_CONFIGURED",
    "NO_LETTERHEAD",
    "LETTERHEAD_NOT_FOUND",
    "LETTERHEAD_INACTIVE",
    "PRINT_FAILED",
    "DATA_FETCH_TIMEOUT",
  ]);
  const status = getHttpStatus(err);
  if (status === 401) return "Session expired. Please sign in again.";
  if (status === 403) {
    if (isFirmEntitlementDenied(err)) {
      return "This feature is not enabled for your firm. Contact your Partner or administrator to enable it.";
    }
    if (isUserAccessDenied(err)) {
      return "You do not have access to this feature. Contact your Partner or administrator to request access.";
    }
    return "You do not have permission to perform this action.";
  }
  if (status === 404) {
    if (apiMsg && (allowDetailedCodes.has(apiCode) || apiMsg.includes("找不到"))) return apiMsg;
    return "File or template not found.";
  }
  if (status === 400) return "Request invalid. Please check your input and retry.";
  if (status === 422) {
    if (apiMsg && allowDetailedCodes.has(apiCode)) return apiMsg;
    return "Request invalid. Please check your input and retry.";
  }
  if (status === 503) {
    const raw = isApiErrorLike(err) && typeof err.message === "string" ? err.message.trim() : "";
    return raw || "Service temporarily unavailable. Please retry.";
  }
  if (status && status >= 500) {
    const raw = isApiErrorLike(err) && typeof err.message === "string" ? err.message : "";
    if (raw && !raw.toLowerCase().includes("internal server error")) return raw;
    if (!raw || raw.toLowerCase().includes("internal server error")) {
      return "Server failed to process the request. Please retry later.";
    }
  }
  if (err instanceof Error && typeof err.message === "string" && err.message.trim()) return err.message;
  if (isApiErrorLike(err) && typeof err.message === "string" && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Something went wrong";
}

export function getHttpStatus(err: unknown): number | null {
  if (isAbortError(err) || isRequestTimeoutError(err)) return null;
  if (!isApiErrorLike(err)) return null;
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : null;
}

export function getFriendlyErrorTitle(err: unknown): string {
  if (isRequestTimeoutError(err)) return "Request timeout";
  if (isAbortError(err)) return "Request cancelled";
  if (isNetworkUnavailableError(err)) return "Network unavailable";
  if (isApiErrorLike(err)) {
    const failure = asApiFailure(err.data);
    if (failure) {
      if (failure.error.code === "QUERY_TIMEOUT") return "Request timeout";
      if (failure.error.code === "FORBIDDEN" || failure.error.code === "FOUNDER_ROLE_REQUIRED") return "Forbidden";
      if (failure.error.code === "UNAUTHORIZED" || failure.error.code === "SESSION_EXPIRED") return "Not authenticated";
      if (failure.error.code.endsWith("_NOT_FOUND")) return "Not found";
      return "Request failed";
    }
  }
  const status = getHttpStatus(err);
  if (status === 401) return "Not authenticated";
  if (status === 403) {
    if (isFirmEntitlementDenied(err)) return "Feature not enabled for firm";
    if (isUserAccessDenied(err)) return "Feature access denied";
    return "Forbidden";
  }
  if (status === 404) return "Not found";
  if (status === 400 || status === 422) return "Invalid request";
  return "Request failed";
}

