import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./app-layout";
import { parseSidebarGroupStorage } from "./sidebar-body";

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
  setViewportWidth(1024);
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

function desktopSidebar(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[class~="hidden"][class*="md:flex"]') as HTMLElement;
}

function findSidebarGroupButton(
  sidebar: HTMLElement,
  name: "Work" | "Cases" | "Documents" | "Accounting" | "HR" | "Communication" | "Administration",
) {
  const all = Array.from(sidebar.querySelectorAll<HTMLButtonElement>('button[type="button"]'));
  const byText = all.filter((b) => {
    const labelSpan = b.querySelector(":scope > span:first-child");
    const t = (labelSpan?.textContent ?? b.textContent ?? "").trim();
    return t === name;
  });
  const match = byText.find((b) => typeof b.getAttribute("aria-controls") === "string");
  return match ?? byText[0];
}

function sidebarGroupContainer(sidebar: HTMLElement, name: "Documents" | "Work" | "Accounting") {
  const btn = findSidebarGroupButton(sidebar, name);
  const controls = btn?.getAttribute("aria-controls");
  if (!controls) return null;
  return sidebarGroupContainerById(sidebar, controls);
}

function sidebarGroupContainerById(sidebar: HTMLElement, id: string) {
  return sidebar.querySelector<HTMLElement>(`[id="${id}"]`);
}

function sidebarGroupHasItemText(
  sidebar: HTMLElement,
  controls: string,
  needle: string,
) {
  const container = sidebarGroupContainerById(sidebar, controls);
  if (!container) return false;
  return Array.from(container.querySelectorAll("a")).some((el) => (el.textContent ?? "").trim().includes(needle));
}

describe("parseSidebarGroupStorage", () => {
  it("returns empty for null or empty", () => {
    expect(parseSidebarGroupStorage(null)).toEqual({});
    expect(parseSidebarGroupStorage("")).toEqual({});
  });

  it("restores legacy direct-object shape (backward compat)", () => {
    const raw = JSON.stringify({ documents: false, accounting: true });
    expect(parseSidebarGroupStorage(raw)).toEqual({ documents: false, accounting: true });
  });

  it("restores canonical versioned shape", () => {
    const raw = JSON.stringify({ version: 1, groups: { documents: false } });
    expect(parseSidebarGroupStorage(raw)).toEqual({ documents: false });
  });

  it("falls back to empty on invalid JSON", () => {
    expect(parseSidebarGroupStorage("not json{{{")).toEqual({});
  });
});

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
    const dockHomeBtn =
      homeBtns.find((b) => b.closest("nav")?.getAttribute("aria-label") === "Mobile primary navigation") ??
      homeBtns[0];
    expect(dockHomeBtn).toHaveAttribute("aria-current", "page");
  });
});

describe("AppLayout sidebar groups", () => {
  it("toggles Work group with aria-expanded attribute and actually hides/shows Dashboard/My Work links", async () => {
    locationValue = "/app/settings";
    const { container } = renderLayout();
    const sidebar = desktopSidebar(container);

    const dashboards = await screen.findAllByText("Dashboard");
    expect(dashboards.length).toBeGreaterThanOrEqual(1);

    const workBtn = findSidebarGroupButton(sidebar, "Work");
    expect(workBtn).toHaveAttribute("aria-expanded", "true");
    const workControls = workBtn.getAttribute("aria-controls") as string;
    expect(sidebarGroupHasItemText(sidebar, workControls, "Dashboard")).toBe(true);
    expect(sidebarGroupHasItemText(sidebar, workControls, "My Work")).toBe(true);

    fireEvent.click(workBtn);
    await waitFor(() => expect(workBtn).toHaveAttribute("aria-expanded", "false"));

    expect(sidebarGroupContainerById(sidebar, workControls)).toBeNull();
    const maybeDashboard = Array.from(sidebar.querySelectorAll("a")).filter(
      (a) => a.textContent?.trim() === "Dashboard",
    );
    expect(maybeDashboard.length).toBe(0);

    fireEvent.click(workBtn);
    await waitFor(() => expect(workBtn).toHaveAttribute("aria-expanded", "true"));

    expect(sidebarGroupHasItemText(sidebar, workControls, "Dashboard")).toBe(true);
    expect(sidebarGroupHasItemText(sidebar, workControls, "My Work")).toBe(true);
  });

  it("stores Documents collapse in canonical versioned shape and restores on remount", async () => {
    const view = renderLayout();
    const sidebar = desktopSidebar(view.container);
    expect((await screen.findAllByText("Variables")).length).toBeGreaterThan(0);

    const docBtn = findSidebarGroupButton(sidebar, "Documents");
    await act(async () => {
      fireEvent.click(docBtn);
    });
    await waitFor(() => expect(docBtn).toHaveAttribute("aria-expanded", "false"));

    const storageKey = "lawcaspro.sidebar.groups:1:1";
    let raw: string | null = null;
    await waitFor(() => {
      raw = localStorage.getItem(storageKey);
      expect(raw).toBeTruthy();
    });
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(1);
    expect(parsed.groups.documents).toBe(false);

    view.unmount();

    const view2 = renderLayout();
    const sidebar2 = desktopSidebar(view2.container);
    const restoredDocBtn = findSidebarGroupButton(sidebar2, "Documents");
    expect(restoredDocBtn).toHaveAttribute("aria-expanded", "false");
    const docsContainer = sidebarGroupContainer(sidebar2, "Documents");
    expect(docsContainer).toBeNull();
  });

  it("backward compat: legacy (pre-versioned) storage shape still restores collapsed groups", async () => {
    localStorage.setItem(
      "lawcaspro.sidebar.groups:1:1",
      JSON.stringify({ documents: false, accounting: true, bogus: "ignored" }),
    );
    locationValue = "/app/dashboard";
    const { container } = renderLayout();
    const sidebar = desktopSidebar(container);

    const docBtn = findSidebarGroupButton(sidebar, "Documents");
    const accBtn = findSidebarGroupButton(sidebar, "Accounting");

    expect(docBtn).toHaveAttribute("aria-expanded", "false");
    expect(accBtn).toHaveAttribute("aria-expanded", "true");

    expect(sidebarGroupContainer(sidebar, "Documents")).toBeNull();
    const accControls = accBtn.getAttribute("aria-controls") as string;
    expect(sidebarGroupHasItemText(sidebar, accControls, "Accounting")).toBe(true);
  });

  it("invalid JSON in storage falls back to default expanded state", async () => {
    localStorage.setItem("lawcaspro.sidebar.groups:1:1", "{{{NOT JSON");
    locationValue = "/app/dashboard";
    const { container } = renderLayout();
    const sidebar = desktopSidebar(container);

    const workBtn = findSidebarGroupButton(sidebar, "Work");
    const docBtn = findSidebarGroupButton(sidebar, "Documents");

    expect(workBtn).toHaveAttribute("aria-expanded", "true");
    expect(docBtn).toHaveAttribute("aria-expanded", "true");
    const workControls = workBtn.getAttribute("aria-controls") as string;
    const docControls = docBtn.getAttribute("aria-controls") as string;
    expect(sidebarGroupHasItemText(sidebar, workControls, "Dashboard")).toBe(true);
    expect(sidebarGroupHasItemText(sidebar, docControls, "Doc Automation")).toBe(true);
  });

  it("keeps active route group expanded even if stored collapsed", async () => {
    localStorage.setItem(
      "lawcaspro.sidebar.groups:1:1",
      JSON.stringify({ version: 1, groups: { documents: false, work: false, administration: true } }),
    );
    locationValue = "/app/documents/variables";

    const { container } = renderLayout();
    const sidebar = desktopSidebar(container);
    expect((await screen.findAllByText("Variables")).length).toBeGreaterThan(0);

    const docBtn = findSidebarGroupButton(sidebar, "Documents");
    const workBtn = findSidebarGroupButton(sidebar, "Work");

    expect(docBtn).toHaveAttribute("aria-expanded", "true");
    expect(workBtn).toHaveAttribute("aria-expanded", "false");
    const docControls = docBtn.getAttribute("aria-controls") as string;
    expect(sidebarGroupHasItemText(sidebar, docControls, "Variables")).toBe(true);
  });
});
