import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchWithTimeoutMock = vi.fn();
vi.mock("@/lib/fetch-with-timeout", () => {
  return { fetchWithTimeout: (...args: any[]) => fetchWithTimeoutMock(...args) };
});

const getStoredAuthTokenMock = vi.fn();
const clearStoredAuthTokenMock = vi.fn();
vi.mock("@/lib/auth-token", () => {
  return {
    getStoredAuthToken: () => getStoredAuthTokenMock(),
    clearStoredAuthToken: () => clearStoredAuthTokenMock(),
  };
});

vi.mock("@/lib/auth-events", () => {
  return { emitAuthUnauthorized: () => null };
});

vi.mock("@/lib/http-error", () => {
  return { apiErrorFromResponse: async () => new Error("http") };
});

vi.mock("@/lib/support-session", () => {
  return { getSupportSessionId: () => null };
});

function makeOkResponse(): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, data: {}, meta: { request_id: "r", timestamp: "t", duration_ms: 1 } }) } as any;
}

describe("apiRequest auth propagation", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
    getStoredAuthTokenMock.mockReset();
    clearStoredAuthTokenMock.mockReset();
    (globalThis as any).window = { location: { origin: "https://example.test" } };
  });

  it("attaches Authorization: Bearer for same-origin /api/* when token exists", async () => {
    getStoredAuthTokenMock.mockReturnValue("token123");
    fetchWithTimeoutMock.mockResolvedValue(makeOkResponse());
    const { apiRequest } = await import("./api-client");
    await apiRequest("/api/auth/me");
    const init = fetchWithTimeoutMock.mock.calls[0]?.[1] as any;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer token123");
  });
});

