import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import Workbench from "./workbench";

(globalThis as any).React = React;

let locationValue = "/app/workbench";
const setLocationMock = vi.fn();

vi.mock("wouter", async () => {
  return {
    useLocation: () => [locationValue, setLocationMock],
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
  };
});

vi.mock("@/lib/auth-context", () => {
  return {
    useAuth: () => ({
      user: { id: 2, firmId: 1, userType: "firm_user" },
    }),
  };
});

vi.mock("@/hooks/use-toast", () => {
  return {
    useToast: () => ({ toast: vi.fn() }),
  };
});

vi.mock("@/lib/toast-error", () => {
  return {
    toastError: vi.fn(),
  };
});

vi.mock("@/components/milestones-table", () => {
  return {
    MilestonesTable: ({ title }: any) => <div>{title}</div>,
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

describe("Workbench", () => {
  it("renders without throwing after initial loading", async () => {
    locationValue = "/app/workbench?tab=my-work";
    setLocationMock.mockReset();
    apiFetchJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/cases/workbench")) {
        return {
          staffUser: { id: 2, name: "Staff" },
          staffOptions: [],
          myWork: { cards: [], recent: [] },
          missingDates: { cards: [] },
          overdue: { cards: [] },
        };
      }
      if (path.startsWith("/cases/milestones-summary")) {
        return { milestoneSections: [], milestoneCards: [] };
      }
      if (path.startsWith("/payment-voucher-actions/my-work")) {
        return [];
      }
      if (path.startsWith("/cases/filter-options")) {
        return { assignees: { lawyers: [], clerks: [] } };
      }
      if (path.startsWith("/projects")) {
        return { data: [] };
      }
      return {};
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <Workbench />
      </QueryClientProvider>,
    );

    expect((await screen.findAllByText("My Work")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(apiFetchJsonMock).toHaveBeenCalled();
    });
  });

  it("does not fetch filter options or projects on My Work tab", async () => {
    locationValue = "/app/workbench?tab=my-work";
    setLocationMock.mockReset();
    apiFetchJsonMock.mockReset();
    apiFetchJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/cases/workbench")) {
        return {
          staffUser: { id: 2, name: "Staff" },
          staffOptions: [],
          myWork: { cards: [], recent: [] },
          missingDates: { cards: [] },
          overdue: { cards: [] },
        };
      }
      if (path.startsWith("/cases/milestones-summary")) return { milestoneSections: [], milestoneCards: [] };
      if (path.startsWith("/payment-voucher-actions/my-work")) return [];
      throw new Error(`Unexpected ${path}`);
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <Workbench />
      </QueryClientProvider>,
    );

    expect((await screen.findAllByText("My Work")).length).toBeGreaterThan(0);
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalled());
    const called = apiFetchJsonMock.mock.calls.map((c) => String(c[0] ?? ""));
    expect(called.some((p) => p.startsWith("/cases/filter-options"))).toBe(false);
    expect(called.some((p) => p.startsWith("/projects"))).toBe(false);
  });

  it("shows controlled retry state when Workbench API fails", async () => {
    locationValue = "/app/workbench?tab=my-work";
    setLocationMock.mockReset();
    apiFetchJsonMock.mockReset();
    apiFetchJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/cases/workbench")) throw new Error("boom");
      return {};
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <Workbench />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Workbench unavailable")).toBeInTheDocument();
    expect(await screen.findByText("Retry")).toBeInTheDocument();
  });

  it("renders main Workbench even when optional sections fail", async () => {
    locationValue = "/app/workbench?tab=my-work";
    setLocationMock.mockReset();
    apiFetchJsonMock.mockReset();
    apiFetchJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/cases/workbench")) {
        return {
          staffUser: { id: 2, name: "Staff" },
          staffOptions: [],
          myWork: { cards: [], recent: [] },
        };
      }
      if (path.startsWith("/cases/milestones-summary")) throw new Error("milestones down");
      if (path.startsWith("/payment-voucher-actions/my-work")) throw new Error("pv down");
      return {};
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <Workbench />
      </QueryClientProvider>,
    );

    expect((await screen.findAllByText("My Work")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("Milestones unavailable")).toBeInTheDocument(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText("Payment voucher actions unavailable")).toBeInTheDocument(), { timeout: 5000 });
  });
});
