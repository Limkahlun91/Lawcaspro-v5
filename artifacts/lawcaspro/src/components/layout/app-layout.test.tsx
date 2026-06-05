import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./app-layout";

(globalThis as any).React = React;

let store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  },
});

let locationValue = "/app/dashboard";

vi.mock("wouter", async () => {
  return {
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    useLocation: () => [locationValue, vi.fn()],
  };
});

vi.mock("@/lib/auth-context", () => {
  return {
    useAuth: () => ({
      logout: vi.fn(),
      user: {
        userType: "firm_user",
        id: 1,
        firmId: 1,
        firmName: "Test Firm",
        roleName: "Partner",
        name: "Test User",
        email: "test@example.com",
      },
    }),
  };
});

vi.mock("@/lib/permissions", () => {
  return {
    hasPermission: () => true,
    isAccountingRoleAllowed: () => true,
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

function renderLayout() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AppLayout>
        <div>Child</div>
      </AppLayout>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  locationValue = "/app/dashboard";
  localStorage.clear();
  apiFetchJsonMock.mockReset();
  apiFetchJsonMock.mockResolvedValue({ count: 0 });
});

describe("AppLayout sidebar groups", () => {
  it("toggles group items on title click", async () => {
    locationValue = "/app/settings";
    renderLayout();

    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MAIN" }));
    await waitFor(() => expect(screen.queryAllByText("Dashboard").length).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "MAIN" }));
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("restores group expanded state from localStorage", async () => {
    const view = renderLayout();
    expect((await screen.findAllByText("Variable Dictionary")).length).toBeGreaterThan(0);
    for (const btn of screen.getAllByRole("button", { name: "DOCUMENTS" })) fireEvent.click(btn);
    await waitFor(() => {
      const raw = localStorage.getItem("lawcaspro.sidebar.groups:1:1");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).documents).toBe(false);
    });
    view.unmount();

    renderLayout();
    for (const btn of screen.getAllByRole("button", { name: "DOCUMENTS" })) fireEvent.click(btn);
    await waitFor(() => {
      const raw = localStorage.getItem("lawcaspro.sidebar.groups:1:1");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).documents).toBe(true);
    });
  });

  it("keeps active route group expanded", async () => {
    localStorage.setItem(
      "lawcaspro.sidebar.groups:1:1",
      JSON.stringify({ main: true, documents: false, settings_system: true }),
    );
    locationValue = "/app/documents/variables";

    renderLayout();
    expect((await screen.findAllByText("Variable Dictionary")).length).toBeGreaterThan(0);
  });
});
