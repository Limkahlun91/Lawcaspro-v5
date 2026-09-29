import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Accounting from "./index";

(globalThis as any).React = React;

let locationValue = "/app/accounting";
const setLocationMock = vi.fn();

vi.mock("wouter", async () => {
  return {
    useLocation: () => [locationValue, setLocationMock],
    useSearch: () => (locationValue.includes("?") ? locationValue.slice(locationValue.indexOf("?")) : ""),
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

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/re-auth-dialog", () => ({
  useReAuth: () => ({ wrapWithReAuth: async (fn: any) => await fn() }),
}));

const apiFetchJsonMock = vi.fn(
  async (url: string, _options?: any): Promise<any> => {
    if (typeof url === "string" && url.startsWith("/invoices")) return [];
    if (typeof url === "string" && url.startsWith("/receipts")) return [];
    if (typeof url === "string" && url.startsWith("/accounting/summary")) return {};
    if (
      typeof url === "string" &&
      url.startsWith("/payment-vouchers") &&
      !url.endsWith("/dashboard")
    ) {
      return { data: [], page: 1, limit: 50, total: 0 };
    }
    if (typeof url === "string" && url.endsWith("/payment-vouchers/dashboard")) return {};
    if (typeof url === "string" && url.startsWith("/quotations")) return [];
    return {} as any;
  },
);

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (url: string, options?: any) => apiFetchJsonMock(url, options),
  };
});

const nativeFetchMock = vi.fn(async (input: any): Promise<Response> => {
  const url = String(input?.url ?? input ?? "");
  if (url.endsWith("/api/accounting/summary")) {
    return new Response(JSON.stringify({ ok: true, data: {} }));
  }
  if (url.includes("/api/payment-vouchers/dashboard")) {
    return new Response(JSON.stringify({ ok: true, data: {} }));
  }
  if (url.includes("/api/payment-vouchers")) {
    return new Response(
      JSON.stringify({ ok: true, data: { data: [], page: 1, limit: 50, total: 0 } }),
    );
  }
  if (url.endsWith("/api/quotations") || url.includes("/api/quotations?")) {
    return new Response(JSON.stringify([]));
  }
  if (url.includes("/api/invoices")) {
    return new Response(JSON.stringify({ ok: true, data: [] }));
  }
  if (url.includes("/api/receipts")) {
    return new Response(JSON.stringify({ ok: true, data: [] }));
  }
  return new Response(JSON.stringify({}));
});
global.fetch = nativeFetchMock as typeof fetch;

const collectAllUrls = (): string[] => {
  const fromNative = nativeFetchMock.mock.calls.map((call) => {
    const input = call[0];
    return String(input?.url ?? input ?? "");
  });
  const fromLib = apiFetchJsonMock.mock.calls.map((call: any[]) => String(call[0] ?? ""));
  return [...fromNative, ...fromLib];
};

let queryClient: QueryClient | null = null;
const makeQC = () => {
  if (queryClient) {
    queryClient.clear();
  }
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return queryClient;
};

const findTabBarButton = (nameRegex: RegExp): HTMLElement => {
  const buttons = screen.getAllByRole("button", { name: nameRegex });
  const tabBarContainer = document.querySelector(
    ".flex.gap-1.border-b.border-gray-200.overflow-x-auto",
  );
  if (tabBarContainer) {
    for (const btn of buttons) {
      if (tabBarContainer.contains(btn)) return btn;
    }
  }
  return buttons[0];
};

beforeEach(() => {
  cleanup();
  setLocationMock.mockReset();
  nativeFetchMock.mockClear();
  apiFetchJsonMock.mockReset();
});

describe("Accounting page tab/navigation regression (V1/V2/V3)", () => {
  it("V1: ?tab=payment-vouchers triggers /payment-vouchers list + dashboard calls", async () => {
    locationValue = "/app/accounting?tab=payment-vouchers";
    render(
      <QueryClientProvider client={makeQC()}>
        <Accounting />
      </QueryClientProvider>,
    );

    await waitFor(
      () => {
        const urls = collectAllUrls();
        const hasList = urls.some(
          (u) => /\/payment-vouchers(\?|\/|$)/.test(u) && !u.endsWith("/dashboard"),
        );
        const hasDashboard = urls.some((u) => u.endsWith("/payment-vouchers/dashboard"));
        expect(hasList).toBe(true);
        expect(hasDashboard).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it("V2: ?tab=quotations triggers /quotations call", async () => {
    locationValue = "/app/accounting?tab=quotations";
    render(
      <QueryClientProvider client={makeQC()}>
        <Accounting />
      </QueryClientProvider>,
    );

    await waitFor(
      () => {
        const urls = collectAllUrls();
        const hasQuotations = urls.some(
          (u) =>
            u.endsWith("/api/quotations") ||
            u.includes("/api/quotations?") ||
            u.endsWith("/quotations"),
        );
        expect(hasQuotations).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it("V3a: clicking Quotations tab → setLocation to /app/accounting?tab=quotations", () => {
    locationValue = "/app/accounting";
    render(
      <QueryClientProvider client={makeQC()}>
        <Accounting />
      </QueryClientProvider>,
    );

    const urlsBefore = collectAllUrls();
    expect(urlsBefore.some((u) => u.includes("quotations"))).toBe(false);

    const btn = findTabBarButton(/^Quotations$/i);
    fireEvent.click(btn);

    expect(setLocationMock).toHaveBeenCalledWith("/app/accounting?tab=quotations");
  });

  it("V3b: clicking Payment Vouchers tab → setLocation to /app/accounting?tab=payment-vouchers", () => {
    locationValue = "/app/accounting";
    render(
      <QueryClientProvider client={makeQC()}>
        <Accounting />
      </QueryClientProvider>,
    );

    const btn = findTabBarButton(/^Payment Vouchers$/i);
    fireEvent.click(btn);

    expect(setLocationMock).toHaveBeenCalledWith("/app/accounting?tab=payment-vouchers");
  });
});
