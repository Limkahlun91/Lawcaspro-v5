import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";

(globalThis as any).React = React;

vi.mock("wouter", () => ({
  useLocation: () => ["/app/dashboard", vi.fn()],
}));

vi.mock("@/lib/api-client", () => ({
  apiFetchJson: async () => ({
    ok: false,
    degraded: true,
    error: "Dashboard partially unavailable",
    dashboard: {
      totalCases: 0,
      activeCases: 0,
      completedCases: 0,
      totalClients: 0,
      totalDevelopers: 0,
      totalProjects: 0,
      milestoneSections: [],
      recentCases: [],
      alerts: [],
    },
    stats: {
      totalCases: 0,
      activeCases: 0,
      completedCases: 0,
      totalClients: 0,
      totalDevelopers: 0,
      totalProjects: 0,
      totalOutstanding: 0,
      pendingMilestones: [],
      milestoneSections: [],
      recentCases: [],
      alerts: [],
      charts: {},
    },
  }),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { firmId: 1, roleName: "Partner" } }),
}));

vi.mock("@/lib/permissions", () => ({
  hasPermission: () => false,
  isAccountingRoleAllowed: () => false,
}));

import AppDashboard from "../dashboard";

describe("dashboard degraded UI", () => {
  it("renders banner and layout (no full-page unavailable) on degraded payload", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AppDashboard />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    expect(await screen.findByText("Dashboard partially unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard unavailable")).not.toBeInTheDocument();
  });
});
