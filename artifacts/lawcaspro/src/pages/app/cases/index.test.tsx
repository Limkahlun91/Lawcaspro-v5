import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CasesList from "./index";

(globalThis as any).React = React;

vi.mock("wouter", async () => {
  return {
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    useLocation: () => ["/app/cases", vi.fn()],
  };
});

vi.mock("@/hooks/use-toast", () => {
  return { useToast: () => ({ toast: vi.fn() }) };
});

vi.mock("@/lib/auth-context", () => {
  return {
    useAuth: () => ({ user: { id: 1, roleName: "Staff" } }),
  };
});

const useListCasesMock = vi.fn();
const useListProjectsMock = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const actual: any = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    useListCases: (params: any, opts: any) => useListCasesMock(params, opts),
    useListProjects: (params: any, opts: any) => useListProjectsMock(params, opts),
  };
});

const apiFetchJsonMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
    apiRequest: vi.fn(),
    apiFetchBlob: vi.fn(),
  };
});

function renderWithQueryClient() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CasesList />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiFetchJsonMock.mockReset();
  useListCasesMock.mockReset();
  useListProjectsMock.mockReset();
  window.history.pushState({}, "", "/app/cases");

  useListProjectsMock.mockReturnValue({ data: { data: [] } });
  useListCasesMock.mockReturnValue({
    data: { data: [], total: 0, page: 1, limit: 50 },
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  });

  apiFetchJsonMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/cases/filter-options")) return {};
    if (path.startsWith("/cases?approvalStatus=")) return { data: [], total: 0, page: 1, limit: 50 };
    return {};
  });
});

describe("/app/cases regressions", () => {
  it("renders approved list even when project/developer/milestones are missing", async () => {
    useListCasesMock.mockReturnValue({
      data: {
        data: [
          {
            id: 101,
            referenceNo: null,
            clientName: null,
            projectName: null,
            developerName: null,
            property: null,
            assignedLawyerName: null,
            assignedClerkName: null,
            spaStatus: null,
            loanStatus: null,
            milestones: null,
            updatedAt: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
      },
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    });

    renderWithQueryClient();

    expect(await screen.findByText("Approved Cases")).toBeInTheDocument();
    expect(screen.queryByText("No cases found.")).not.toBeInTheDocument();

    const table = screen.getByRole("table");
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders subsale approved case without crashing", async () => {
    useListCasesMock.mockReturnValue({
      data: {
        data: [
          {
            id: 201,
            referenceNo: "SUB-001",
            clientName: "Buyer A",
            projectName: "—",
            developerName: "—",
            property: "Parcel 1",
            assignedLawyerName: "Lawyer 1",
            assignedClerkName: "Clerk 1",
            spaStatus: "Pending",
            loanStatus: null,
            milestones: {},
            updatedAt: new Date().toISOString(),
            caseType: "subsale",
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
      },
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    });

    renderWithQueryClient();
    expect(await screen.findByText("SUB-001")).toBeInTheDocument();
  });

  it("renders perfection approved case without crashing", async () => {
    useListCasesMock.mockReturnValue({
      data: {
        data: [
          {
            id: 301,
            referenceNo: "PERF-001",
            clientName: "Buyer B",
            projectName: "—",
            developerName: "—",
            property: null,
            assignedLawyerName: null,
            assignedClerkName: null,
            spaStatus: "Pending",
            loanStatus: null,
            milestones: {},
            updatedAt: new Date().toISOString(),
            caseType: "perfection",
            perfectionType: "Transfer",
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
      },
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    });

    renderWithQueryClient();
    expect(await screen.findByText("PERF-001")).toBeInTheDocument();
  });

  it("renders pending approval list with View action", async () => {
    window.history.pushState({}, "", "/app/cases?approvalStatus=pending_approval");
    apiFetchJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/cases/filter-options")) return {};
      if (path.startsWith("/cases?approvalStatus=pending_approval")) {
        return {
          data: [
            {
              id: 401,
              approvalStatus: "pending_approval",
              submittedAt: new Date().toISOString(),
              submittedByName: "Clerk A",
              referenceNo: null,
              clientName: "Buyer C",
              projectName: null,
              developerName: null,
              property: null,
              caseType: "developer_sales",
              purchaseMode: "cash",
              titleType: "master",
              assignedLawyerName: null,
              assignedClerkName: null,
            },
          ],
          total: 1,
          page: 1,
          limit: 50,
        };
      }
      return {};
    });

    renderWithQueryClient();
    expect(await screen.findByRole("button", { name: "View" })).toBeInTheDocument();
  });

  it("renders rejected/amend list with Resubmit action", async () => {
    window.history.pushState({}, "", "/app/cases?approvalStatus=rejected");
    apiFetchJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/cases/filter-options")) return {};
      if (path.startsWith("/cases?approvalStatus=rejected")) {
        return {
          data: [
            {
              id: 501,
              approvalStatus: "rejected",
              submittedAt: new Date().toISOString(),
              approvedAt: new Date().toISOString(),
              approvalNote: "Fix details",
              caseType: "subsale",
              titleType: null,
              landCondition: null,
              encumbrances: null,
              actingFor: null,
            },
          ],
          total: 1,
          page: 1,
          limit: 50,
        };
      }
      return {};
    });

    renderWithQueryClient();
    expect(await screen.findByRole("button", { name: "Resubmit for Approval" })).toBeInTheDocument();
  });
});
