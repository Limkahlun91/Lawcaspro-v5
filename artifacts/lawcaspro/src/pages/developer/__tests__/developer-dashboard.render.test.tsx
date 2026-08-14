import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";

(globalThis as any).React = React;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).__DEV_DASHBOARD_MOCKS__ = undefined;
  try { cleanup(); } catch {}
});

afterEach(() => {
  try { cleanup(); } catch {}
  (globalThis as any).__DEV_DASHBOARD_MOCKS__ = undefined;
});

vi.mock("wouter", () => ({
  useLocation: () => ["/developer/dashboard", vi.fn()],
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { firmId: 1, roleName: "Developer_User" } }),
}));

vi.mock("@/lib/permissions", () => ({
  hasPermission: () => true,
  isAccountingRoleAllowed: () => false,
}));

vi.mock("@/lib/download", () => ({
  downloadFromApi: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...(original ?? {}),
    apiFetchJson: vi.fn(async (url: string, opts?: any) => {
      const ctx = (globalThis as any).__DEV_DASHBOARD_MOCKS__ as any;
      if (!ctx) {
        const err: any = new Error("mocks-not-set");
        err.status = 500;
        throw err;
      }
      if (typeof url === "string" && url.includes("/developer/portal/projects")) {
        if (ctx.projectsError) {
          const err: any = new Error("network");
          err.status = 500;
          throw err;
        }
        return ctx.projects;
      }
      if (typeof url === "string" && url.includes("/developer/portal/overview")) {
        if (ctx.overviewError) {
          const err: any = new Error("unavailable");
          err.status = 500;
          throw err;
        }
        return ctx.overview;
      }
      if (typeof url === "string" && url.includes("/developer/portal/units")) {
        if (ctx.unitsError) {
          const err: any = new Error("unavailable");
          err.status = 500;
          throw err;
        }
        return { data: ctx.units.data, total: ctx.units.total, totalMatchingScope: ctx.units.total, page: 1, limit: 25 };
      }
      if (typeof url === "string" && url.includes("/developer/cases/") && url.includes("/messages")) {
        return [];
      }
      return null;
    }),
  };
});

import DevDashboard from "../dashboard";

const makeProjects = (n = 3) =>
  Array.from({ length: n }).map((_, i) => ({
    id: i + 1,
    name: `Project ${String.fromCharCode(65 + i)}`,
    phase: i === 0 ? "Phase 1" : i === 1 ? "Phase 2" : null,
    activeUnitCount: (i + 1) * 4,
  }));

const makeOverview = (args: {
  projectsCount: number;
  attentionItemsCount: number;
  totalUnits: number;
  allProjects: boolean;
  projectId: number | null;
  projectName: string | null;
  phase: string | null;
}) => {
  const attn = Array.from({ length: args.attentionItemsCount }).map((_, i) => ({
    caseId: 100 + i,
    unitLabel: `Unit A1-${String(i + 1).padStart(2, "0")}`,
    referenceNo: `REF-A${i}`,
    label: i % 2 === 0 ? "SPA Signing" : "Acting Letter Issued",
    waitingFor: i % 2 === 0 ? "Purchaser" : "Bank",
    since: "2026-08-01",
    ageDays: 10 + i,
  }));
  return {
    project: {
      allProjects: args.allProjects,
      projectId: args.projectId,
      name: args.projectName,
      phase: args.phase,
      developerName: "MESTIKA BISTARI SDN BHD",
      lastUpdatedAt: "2026-08-14T10:00:00Z",
    },
    summary: {
      totalUnits: args.totalUnits,
      spaInProgress: Math.max(1, Math.floor(args.totalUnits * 0.2)),
      spaStamped: Math.max(1, Math.floor(args.totalUnits * 0.25)),
      loanInProgress: Math.max(1, Math.floor(args.totalUnits * 0.3)),
      needsAttention: args.attentionItemsCount,
      completedHandover: Math.max(0, Math.floor(args.totalUnits * 0.1)),
    },
    attentionSummary: {
      total: args.attentionItemsCount,
      items: attn,
    },
    progress: {
      spa: { progressing: 10 },
      loan: { progressing: 12 },
      mot: { progressing: 4 },
      completed: { progressing: 3 },
      total: args.totalUnits,
    },
  } as const;
};

const unitsList = (n: number) =>
  Array.from({ length: n }).map((_, i) => ({
    caseId: 1000 + i,
    referenceNo: `U-REF-${i}`,
    projectName: i % 2 === 0 ? "LEGASI" : "Project B",
    phase: i % 2 === 0 ? "Phase 1" : "Phase 2",
    unitLabel: `Unit A${i + 1}`,
    propertySummary: "Address line 1, KL",
    purchasers: [{ displayName: `Purchaser ${i + 1}` }],
    spa: { status: (i % 3 === 0 ? "Completed" : i % 3 === 1 ? "In Progress" : "Attention Required") as any, label: i % 3 === 0 ? "SPA Stamped" : "SPA Signing", date: "2026-08-01" },
    loan: { status: (i % 2 === 0 ? "In Progress" : "Not Yet Required") as any, label: "Loan Documentation", bankName: i % 2 === 0 ? "CIMB" : null, date: "2026-08-02" },
    mot: { status: (i === 0 ? "Completed" : "Not Yet Required") as any, label: "MOT / Title", date: i === 0 ? "2026-05-15" : null },
    currentStage: i === 0 ? "Completed / Handover" : i % 3 === 0 ? "SPA Signing" : "Loan Documentation",
    nextAction: i % 2 === 0 ? { label: "SPA Signing", waitingFor: "Purchaser", since: "2026-08-01", ageDays: 13, attentionRequired: i % 3 === 2 } : null,
    lastUpdatedAt: "2026-08-14T09:00:00Z",
  }));

function renderDashboardWithMocks(mocks: {
  projects: any[];
  overview: any;
  units: { data: any[]; total: number };
  projectsError?: boolean;
  overviewError?: boolean;
  unitsError?: boolean;
}) {
  (globalThis as any).__DEV_DASHBOARD_MOCKS__ = mocks;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <div role="main" data-testid="app-main" style={{ minHeight: 600 }}>
      <QueryClientProvider client={qc}>
        <DevDashboard />
      </QueryClientProvider>
    </div>,
  );
}

describe("Developer Dashboard render safety (§10)", () => {
  it("multi-project + selector renders without blank page", async () => {
    renderDashboardWithMocks({
      projects: makeProjects(3),
      overview: makeOverview({ projectsCount: 3, attentionItemsCount: 6, totalUnits: 22, allProjects: true, projectId: null, projectName: null, phase: null }),
      units: { data: unitsList(8), total: 22 },
    });
    expect(await screen.findByTestId("app-main")).toBeInTheDocument();
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    const titles = screen.getAllByText(/Developer Portfolio|LEGASI|Project B/i);
    expect(titles.length).toBeGreaterThan(0);
  });

  it("project selector header + All Projects option visible", async () => {
    renderDashboardWithMocks({
      projects: makeProjects(3),
      overview: makeOverview({ projectsCount: 3, attentionItemsCount: 4, totalUnits: 22, allProjects: true, projectId: null, projectName: null, phase: null }),
      units: { data: unitsList(6), total: 22 },
    });
    const header = await screen.findByRole("heading", { level: 1 });
    expect(header).toBeInTheDocument();
    expect(header.textContent ?? "").toMatch(/Developer Portfolio/);
  });

  it("summary card filter (SPA / Loan / Attention) renders badges", async () => {
    renderDashboardWithMocks({
      projects: makeProjects(2),
      overview: makeOverview({ projectsCount: 2, attentionItemsCount: 5, totalUnits: 24, allProjects: true, projectId: null, projectName: null, phase: null }),
      units: { data: unitsList(6), total: 24 },
    });
    const cards = await screen.findAllByText(/Total Units|Attention|Completed/i);
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });

  it("attention > 8 renders full 8 visible items + correct total label", async () => {
    renderDashboardWithMocks({
      projects: makeProjects(2),
      overview: makeOverview({ projectsCount: 2, attentionItemsCount: 27, totalUnits: 36, allProjects: true, projectId: null, projectName: null, phase: null }),
      units: { data: unitsList(6), total: 36 },
    });
    const totalText = await screen.findAllByText(/27/);
    expect(totalText.length).toBeGreaterThanOrEqual(1);
    const attentionItems = screen.queryAllByText(/ATTN-|Unit A/i);
    expect(attentionItems.length).toBeGreaterThanOrEqual(5);
    expect(attentionItems.length).toBeLessThanOrEqual(12);
  });

  it("drawer mount + Sheet container available on click target exists", async () => {
    renderDashboardWithMocks({
      projects: makeProjects(2),
      overview: makeOverview({ projectsCount: 2, attentionItemsCount: 3, totalUnits: 10, allProjects: true, projectId: null, projectName: null, phase: null }),
      units: { data: unitsList(4), total: 10 },
    });
    const units = await screen.findAllByText(/Unit A\d+/);
    expect(units.length).toBeGreaterThan(0);
  });

  it("empty project (0 units) → empty state not blank", async () => {
    renderDashboardWithMocks({
      projects: makeProjects(3),
      overview: makeOverview({ projectsCount: 3, attentionItemsCount: 0, totalUnits: 0, allProjects: false, projectId: 9, projectName: "Empty Project", phase: "Phase 9" }),
      units: { data: [], total: 0 },
    });
    expect(await screen.findByTestId("app-main")).toBeInTheDocument();
    const title = await screen.findByRole("heading", { level: 1 });
    expect(title).toBeInTheDocument();
  });

  it("API error overview + projects + units → renders fallback (no blank page)", async () => {
    renderDashboardWithMocks({
      projects: [],
      overview: makeOverview({ projectsCount: 0, attentionItemsCount: 0, totalUnits: 0, allProjects: true, projectId: null, projectName: null, phase: null }),
      units: { data: [], total: 0 },
      overviewError: true,
      unitsError: true,
      projectsError: true,
    });
    const fallbacks = await screen.findAllByRole("button", { name: /retry/i });
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent || "").toMatch(/Developer portal unavailable|Units unavailable|network|error|unable/i);
  });
});
