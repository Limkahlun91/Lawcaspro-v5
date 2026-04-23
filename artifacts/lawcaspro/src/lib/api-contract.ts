export type ApiMeta = {
  request_id: string;
  timestamp: string;
  duration_ms: number;
};

export type ApiWarning = { code: string; message: string };

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
  retryable: boolean;
  stage?: string;
  suggestion?: string;
};

export type ApiSuccess<T> = { ok: true; data: T; meta: ApiMeta; warnings?: ApiWarning[] };
export type ApiFailure = { ok: false; error: ApiErrorBody; meta: ApiMeta };

export function isApiSuccess<T = unknown>(v: unknown): v is ApiSuccess<T> {
  return !!v && typeof v === "object" && (v as any).ok === true && "data" in (v as any);
}

export function isApiFailure(v: unknown): v is ApiFailure {
  return !!v && typeof v === "object" && (v as any).ok === false && typeof (v as any).error === "object";
}

export function unwrapApiData<T>(v: unknown): T {
  if (isApiSuccess<T>(v)) return v.data;
  return v as T;
}

export function getApiFailureFromUnknown(v: unknown): ApiFailure | null {
  if (isApiFailure(v)) return v;
  if (isApiSuccess(v)) return null;
  return null;
}

