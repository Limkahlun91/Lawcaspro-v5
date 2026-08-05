import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { PaymentVouchersTab } from "./index";

(globalThis as any).React = React;

let locationValue = "/app/accounting?tab=payment-vouchers&openCreate=1";
const setLocationMock = vi.fn();

vi.mock("wouter", async () => {
  return {
    useLocation: () => [locationValue, setLocationMock],
    useSearch: () => locationValue.includes("?") ? locationValue.slice(locationValue.indexOf("?")) : "",
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
  };
});

vi.mock("@/lib/auth-context", () => {
  return {
    useAuth: () => ({
      user: {
        id: 2,
        firmId: 1,
        userType: "firm_user",
        roleName: "Partner",
        permissions: [
          { module: "accounting", action: "read" },
          { module: "accounting", action: "create" },
        ],
      },
    }),
  };
});

vi.mock("@/hooks/use-toast", () => {
  return {
    useToast: () => ({ toast: vi.fn() }),
  };
});

vi.mock("@/components/re-auth-dialog", () => {
  return {
    useReAuth: () => ({ wrapWithReAuth: async (fn: any) => await fn() }),
  };
});

const apiFetchJsonMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
  };
});

describe("PaymentVouchersTab", () => {
  it("does not request payment voucher list/dashboard while create form is open via openCreate=1", async () => {
    locationValue = "/app/accounting?tab=payment-vouchers&openCreate=1";
    setLocationMock.mockReset();
    apiFetchJsonMock.mockReset();
    apiFetchJsonMock.mockResolvedValue({});

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <PaymentVouchersTab />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(setLocationMock).toHaveBeenCalled(), { timeout: 2000 });
    const paths = apiFetchJsonMock.mock.calls.map((c) => String(c[0] ?? ""));
    expect(paths.some((p) => p.startsWith("/payment-vouchers?page="))).toBe(false);
    expect(paths.some((p) => p === "/payment-vouchers/dashboard")).toBe(false);
  });
});
