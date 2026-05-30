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
    warnings: [{ module: "cases.totalCases", code: "42501", message: "permission denied" }],
    unavailableFields: ["totalCases", "activeCases", "completedCases"],
    totalCases: 0,
    activeCases: 0,
    completedCases: 0,
    totalClients: 0,
    totalDevelopers: 0,
    totalProjects: 0,
    milestoneSections: [],
    milestoneCards: [],
    recentCases: [],
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

describe("dashboard unavailableFields UI", () => {
  it("shows '—' instead of misleading 0 for unavailableFields", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AppDashboard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Dashboard partially unavailable")).toBeInTheDocument();
    expect(await screen.findByText("cases.totalCases — 42501 — permission denied")).toBeInTheDocument();
    expect(await screen.findAllByText("—")).not.toHaveLength(0);
  });
});

