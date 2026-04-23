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

function handleUnauthorized(): void {
  clearStoredAuthToken();
  emitAuthUnauthorized();
}

export async function apiRequest(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const url = resolveApiUrl(path);
  const timeoutMs = options.timeoutMs ?? 15000;
  const token = getStoredAuthToken();
  const baseHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
  const headers = mergeHeaders(baseHeaders, options.headers);
  const supportSessionId = getSupportSessionId();
  if (supportSessionId && !headers.has("x-support-session-id")) {
    headers.set("x-support-session-id", supportSessionId);
  }

  const body = options.body;
  if (body != null && !isFormData(body) && !headers.has("content-type")) {
    if (typeof body === "string" && looksLikeJson(body)) headers.set("content-type", "application/json");
    else headers.set("content-type", "application/json");
  }

  const res = await fetchWithTimeout(url, {
    ...options,
    timeoutMs,
    credentials: options.credentials ?? "include",
    headers,
  });

  const allow = new Set(options.allowStatuses ?? []);
  if (res.status === 401) handleUnauthorized();
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
