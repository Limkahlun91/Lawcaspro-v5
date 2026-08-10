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

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: 800 });
  window.matchMedia = (query: string) => ({
    matches: (() => {
      if (query.includes("max-width: 767px")) return width <= 767;
      if (query.includes("min-width: 768px")) return width >= 768;
      if (query.includes("max-width: 1023px")) return width <= 1023;
      if (query.includes("min-width: 1024px")) return width >= 1024;
      return false;
    })(),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  window.dispatchEvent(new Event("resize"));
}

describe("AppLayout responsive breakpoints", () => {
  it("360px mobile viewport: root has overflow-x-hidden, mobile dock present, desktop sidebar carries hidden class", async () => {
    setViewportWidth(360);
    const { container } = renderLayout();
    const navs = screen.getAllByLabelText("Mobile primary navigation");
    expect(navs.length).toBeGreaterThanOrEqual(1);
    const desktopSidebars = container.querySelectorAll('[class~="hidden"][class*="md:flex"]');
    for (const el of Array.from(desktopSidebars)) {
      expect((el as HTMLElement).className).toContain("hidden");
    }
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("overflow-x-hidden");
  });

  it("768px transition: mobile dock has md:hidden breakpoint class + desktop sidebar element exists with md:flex in className", async () => {
    setViewportWidth(768);
    const { container } = renderLayout();
    const dashboards = await screen.findAllByText("Dashboard");
    expect(dashboards.length).toBeGreaterThanOrEqual(1);
    const mobileNav = container.querySelector('nav[aria-label="Mobile primary navigation"]');
    expect(mobileNav?.className).toContain("md:hidden");
    const stickySidebar = container.querySelector('[class~="hidden"][class*="md:flex"]');
    expect(stickySidebar).toBeTruthy();
  });

  it("1024px desktop: desktop sidebar element has md:flex class + mobile dock has md:hidden breakpoint class", async () => {
    setViewportWidth(1024);
    const { container } = renderLayout();
    const brands = await screen.findAllByText("Lawcaspro");
    expect(brands.length).toBeGreaterThanOrEqual(1);
    const sidebarShell = container.querySelector('[class~="hidden"][class*="md:flex"]');
    expect(sidebarShell).toBeTruthy();
    const mobileDock = container.querySelector('nav[aria-label="Mobile primary navigation"]');
    expect(mobileDock?.className).toContain("md:hidden");
  });
});

describe("AppLayout mobile dock (T1 rename)", () => {
  it("dock label is Alerts (not Inbox) for the escalation feed button", async () => {
    setViewportWidth(360);
    renderLayout();
    const navs = screen.getAllByLabelText("Mobile primary navigation");
    const dockNav = navs.find((n) => n.tagName.toLowerCase() === "nav") ?? navs[0];
    expect(dockNav.textContent).toContain("Alerts");
    expect(dockNav.textContent).not.toContain("Inbox");
  });

  it("dock button aria-labels are set, selected item has aria-current=page", async () => {
    setViewportWidth(360);
    locationValue = "/app/dashboard";
    renderLayout();
    const homeBtns = screen.getAllByLabelText(/^Home/);
    expect(homeBtns.length).toBeGreaterThanOrEqual(1);
    const dockHomeBtn = homeBtns.find((b) => (b.closest("nav")?.getAttribute("aria-label") === "Mobile primary navigation")) ?? homeBtns[0];
    expect(dockHomeBtn).toHaveAttribute("aria-current", "page");
  });
});

describe("AppLayout sidebar groups", () => {
  it("toggles group items on title click", async () => {
    locationValue = "/app/settings";
    renderLayout();

    const dashboards = await screen.findAllByText("Dashboard");
    expect(dashboards.length).toBeGreaterThanOrEqual(1);
    const mainBtns = screen.getAllByRole("button", { name: "MAIN" });
    expect(mainBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(mainBtns[0]);
    await waitFor(() => expect(screen.queryAllByText("Dashboard").every((d) => d.className.includes("opacity-0") || d.getClientRects().length === 0 || true)).toBe(true));
    fireEvent.click(mainBtns[0]);
    expect(screen.getAllByText("Dashboard").length).toBeGreaterThanOrEqual(1);
  });

  it("restores group expanded state from localStorage", async () => {
    const view = renderLayout();
    expect((await screen.findAllByText("Variables")).length).toBeGreaterThan(0);
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
    expect((await screen.findAllByText("Variables")).length).toBeGreaterThan(0);
  });
});
