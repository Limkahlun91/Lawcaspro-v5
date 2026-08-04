import { API_BASE, apiUrl } from "@/lib/api-base";
import { clearStoredAuthToken, getStoredAuthToken } from "@/lib/auth-token";
import { emitAuthUnauthorized } from "@/lib/auth-events";
import { unwrapApiData } from "@/lib/api-contract";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { apiErrorFromResponse } from "@/lib/http-error";
import { getSupportSessionId } from "@/lib/support-session";

type ApiResponseType = "json" | "text" | "blob";

export type ApiFetchOptions = Omit<RequestInit, "headers"> & {
  timeoutMs?: number;
  responseType?: ApiResponseType;
  headers?: HeadersInit;
  allowStatuses?: number[];
  skipAuthConfirm?: boolean;
};

function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  if (p === "/api" || p.startsWith("/api/")) return apiUrl(p);
  return `${API_BASE}${p}`;
}

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function isPlainObject(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== "object") return false;
  const proto = Object.getPrototypeOf(body);
  return proto === Object.prototype || proto === null;
}

function looksLikeJson(body: unknown): boolean {
  if (typeof body !== "string") return false;
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const h = new Headers();
  for (const src of sources) {
    if (!src) continue;
    new Headers(src).forEach((value, key) => h.set(key, value));
  }
  return h;
}

function isSameOriginUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  if (!/^https?:\/\//i.test(url)) return true;
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}

function handleUnauthorized(): void {
  clearStoredAuthToken();
  emitAuthUnauthorized();
}

let authConfirmInFlight: Promise<boolean> | null = null;

async function confirmAuthStillValid(headers: Headers, timeoutMs: number): Promise<boolean> {
  if (authConfirmInFlight) return await authConfirmInFlight;
  authConfirmInFlight = (async () => {
    try {
      const res = await fetchWithTimeout(resolveApiUrl("/auth/me"), {
        method: "GET",
        timeoutMs: Math.min(8000, Math.max(2000, Math.trunc(timeoutMs / 2))),
        credentials: "include",
        headers,
      });
      return res.status !== 401;
    } catch {
      return true;
    } finally {
      authConfirmInFlight = null;
    }
  })();
  return await authConfirmInFlight;
}

export async function apiRequest(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const url = resolveApiUrl(path);
  const timeoutMs = options.timeoutMs ?? 15000;
  const token = getStoredAuthToken();
  const headers = mergeHeaders(options.headers);
  const shouldAttachBearer = Boolean(token) && !headers.has("authorization") && isSameOriginUrl(url);
  if (shouldAttachBearer) headers.set("authorization", `Bearer ${token}`);
  const supportSessionId = getSupportSessionId();
  if (supportSessionId && !headers.has("x-support-session-id")) {
    headers.set("x-support-session-id", supportSessionId);
  }

  const body = options.body;
  const shouldJsonStringify = Array.isArray(body) || isPlainObject(body);
  const requestBody = shouldJsonStringify ? JSON.stringify(body) : body;
  if (requestBody != null && !isFormData(requestBody) && !headers.has("content-type")) {
    if (typeof requestBody === "string" && looksLikeJson(requestBody)) headers.set("content-type", "application/json");
    else headers.set("content-type", "application/json");
  }

  const credentials = options.credentials ?? "include";
  const requestInit: RequestInit = {
    ...options,
    body: requestBody as any,
    timeoutMs,
    credentials,
    headers,
  } as any;
  let res = await fetchWithTimeout(url, requestInit);
  if (res.status === 401 && shouldAttachBearer && credentials === "include") {
    clearStoredAuthToken();
    const retryHeaders = mergeHeaders(options.headers);
    const retryInit: RequestInit = {
      ...options,
      timeoutMs,
      credentials,
      headers: retryHeaders,
    } as any;
    res = await fetchWithTimeout(url, retryInit);
  }

  const allow = new Set(options.allowStatuses ?? []);
  if (res.status === 401 && !allow.has(401)) {
    const p = path.startsWith("/") ? path : `/${path}`;
    const isAuthEndpoint =
      p === "/auth/me" ||
      p === "/auth/login" ||
      p.startsWith("/auth/") ||
      p === "/api/auth/me" ||
      p === "/api/auth/login" ||
      p.startsWith("/api/auth/");
    if (isAuthEndpoint || options.skipAuthConfirm) {
      handleUnauthorized();
    } else {
      const ok = await confirmAuthStillValid(headers, timeoutMs);
      if (!ok) handleUnauthorized();
    }
  }
  if (!res.ok && !allow.has(res.status)) throw await apiErrorFromResponse(res);
  return res;
}

export async function apiFetchJson<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const res = await apiRequest(path, { ...options, responseType: "json" });
  if (res.status === 204) return null as T;
  const body = (await res.json()) as unknown;
  return unwrapApiData<T>(body);
}

export async function apiFetchText(path: string, options: ApiFetchOptions = {}): Promise<string> {
  const res = await apiRequest(path, { ...options, responseType: "text" });
  return await res.text();
}

export async function apiFetchBlob(path: string, options: ApiFetchOptions = {}): Promise<Blob> {
  const res = await apiRequest(path, { ...options, responseType: "blob" });
  return await res.blob();
}
