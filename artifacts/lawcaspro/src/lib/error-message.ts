export type ApiErrorLike = {
  status?: unknown;
  data?: unknown;
  message?: unknown;
};

type ErrorLike = { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };

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
  const status = getHttpStatus(err);
  if (status === 401) return "Session expired. Please sign in again.";
  if (status === 403) return "You do not have permission to perform this action.";
  if (status === 404) return "File or template not found.";
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
  const status = getHttpStatus(err);
  if (status === 401) return "Not authenticated";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not found";
  return "Request failed";
}

