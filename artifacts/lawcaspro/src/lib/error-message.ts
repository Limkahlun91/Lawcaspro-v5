export type ApiErrorLike = {
  status?: unknown;
  data?: unknown;
  message?: unknown;
};

export function isApiErrorLike(err: unknown): err is ApiErrorLike {
  return Boolean(err) && typeof err === "object" && ("status" in err || "data" in err);
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string" && err.message.trim()) return err.message;
  if (isApiErrorLike(err) && typeof err.message === "string" && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Something went wrong";
}

export function getHttpStatus(err: unknown): number | null {
  if (!isApiErrorLike(err)) return null;
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : null;
}

export function getFriendlyErrorTitle(err: unknown): string {
  const status = getHttpStatus(err);
  if (status === 401) return "Not authenticated";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not found";
  return "Request failed";
}

