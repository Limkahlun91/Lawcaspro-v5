import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Login from "./login";
import { AuthProvider } from "@/lib/auth-context";
import { ME_QUERY_KEY } from "@/lib/query-keys";

(globalThis as any).React = React;

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => {
  return { useToast: () => ({ toast: toastMock }) };
});

vi.mock("@/lib/toast-error", () => {
  return { toastError: () => null };
});

const setLocationMock = vi.fn();
let locationValue = "/auth/login";

vi.mock("wouter", async () => {
  return {
    useLocation: () => [locationValue, setLocationMock],
  };
});

const apiFetchJsonMock = vi.fn();
const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
    apiRequest: (...args: any[]) => apiRequestMock(...args),
  };
});

function createResponse(status: number, jsonBody: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
  } as any;
}

function renderWithProviders() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <Login />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { qc, view };
}

beforeEach(() => {
  locationValue = "/auth/login";
  setLocationMock.mockReset();
  apiFetchJsonMock.mockReset();
  apiRequestMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("Login flow", () => {
  it("awaits /api/auth/me and navigates once on success", async () => {
    const loginUser = {
      token: "t",
      id: 1,
      email: "test@example.com",
      name: "Test",
      userType: "firm_user",
      status: "active",
      firmId: 1,
      roleId: 1,
    };
    const meUser = {
      id: 1,
      email: "test@example.com",
      name: "Test",
      userType: "firm_user",
      status: "active",
      firmId: 1,
      roleId: 1,
    };
    apiFetchJsonMock.mockResolvedValue({ user: loginUser, token: "t" });
    apiRequestMock.mockResolvedValue(createResponse(200, { ok: true, data: meUser, meta: { request_id: "r", timestamp: "t", duration_ms: 1 } }));

    const { qc } = renderWithProviders();
    qc.setQueryData(ME_QUERY_KEY, null);

    fireEvent.change(screen.getAllByPlaceholderText("name@firm.com")[0], { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    await waitFor(() => expect(setLocationMock).toHaveBeenCalledTimes(1));
    expect(setLocationMock).toHaveBeenCalledWith("/app/dashboard");

    expect(qc.getQueryData(ME_QUERY_KEY)).toMatchObject({ id: 1, email: "test@example.com" });
    expect(toastMock).toHaveBeenCalledTimes(0);
  });

  it("keeps user on login when /api/auth/me returns 401", async () => {
    const loginUser = {
      token: "t",
      id: 1,
      email: "test@example.com",
      name: "Test",
      userType: "firm_user",
      status: "active",
      firmId: 1,
      roleId: 1,
    };
    apiFetchJsonMock.mockResolvedValue(loginUser);
    apiRequestMock.mockResolvedValue(createResponse(401, { ok: false }));

    renderWithProviders();

    fireEvent.change(screen.getAllByPlaceholderText("name@firm.com")[0], { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    expect(setLocationMock).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
  });

  it("rejects malformed 200 /api/auth/me payload", async () => {
    const loginUser = {
      token: "t",
      id: 1,
      email: "test@example.com",
      name: "Test",
      userType: "firm_user",
      status: "active",
      firmId: 1,
      roleId: 1,
    };
    apiFetchJsonMock.mockResolvedValue(loginUser);
    apiRequestMock.mockResolvedValue(createResponse(200, { ok: true, data: { nope: true }, meta: { request_id: "r", timestamp: "t", duration_ms: 1 } }));

    renderWithProviders();

    fireEvent.change(screen.getAllByPlaceholderText("name@firm.com")[0], { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(setLocationMock).toHaveBeenCalledTimes(0);
  });

  it("does not get trapped by permissions abort after successful login", async () => {
    const loginUser = {
      token: "t",
      id: 1,
      email: "test@example.com",
      name: "Test",
      userType: "firm_user",
      status: "active",
      firmId: 1,
      roleId: 1,
    };
    const meUser = {
      id: 1,
      email: "test@example.com",
      name: "Test",
      userType: "firm_user",
      status: "active",
      firmId: 1,
      roleId: 1,
    };
    apiFetchJsonMock.mockResolvedValue(loginUser);
    apiRequestMock.mockImplementation(async (path: string) => {
      if (String(path).includes("/api/auth/me")) {
        return createResponse(200, { ok: true, data: meUser, meta: { request_id: "r", timestamp: "t", duration_ms: 1 } });
      }
      if (String(path).includes("/api/auth/permissions")) {
        const e = new Error("aborted") as Error & { name?: string };
        e.name = "AbortError";
        throw e;
      }
      return createResponse(200, { ok: true, data: {}, meta: { request_id: "r", timestamp: "t", duration_ms: 1 } });
    });

    renderWithProviders();

    fireEvent.change(screen.getAllByPlaceholderText("name@firm.com")[0], { target: { value: "test@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(setLocationMock).toHaveBeenCalledTimes(1));
    expect(setLocationMock).toHaveBeenCalledWith("/app/dashboard");
  });
});
