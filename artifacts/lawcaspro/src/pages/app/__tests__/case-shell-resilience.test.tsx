import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, beforeAll, afterEach } from "vitest";
import CaseDetail from "../cases/detail";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

(globalThis as any).React = React;

const M = vi.hoisted(() => {
  const stablePushFn = vi.fn();
  const stableCaseParams = { id: "16" };
  const stableUseParamsFn = vi.fn(() => stableCaseParams);
  const stableUseSearchFn = vi.fn(() => "");
  const stableUseLocationFn = vi.fn(() => ["/app/cases/16", stablePushFn] as const);
  return {
    toastMock: vi.fn(),
    toastErrorMock: vi.fn(),
    apiFetchJsonMock: vi.fn(),
    apiFetchBlobMock: vi.fn(),
    apiRequestMock: vi.fn(),
    useGetCaseMock: vi.fn(),
    useGetCaseWorkflowMock: vi.fn(),
    useListUsersMock: vi.fn(),
    stablePushFn,
    stableCaseParams,
    stableUseParamsFn,
    stableUseSearchFn,
    stableUseLocationFn,
  };
});

vi.mock("wouter", async () => {
  const actual: any = await vi.importActual("wouter");
  const stableUseLocation = M.stableUseLocationFn as unknown as (
    options?: { ssrPath?: string } | undefined,
  ) => [string, (to: string | URL, opts?: { replace?: boolean; state?: any; transition?: boolean }) => void];
  const stableUseSearch = M.stableUseSearchFn as unknown as (
    options?: { ssrSearch?: string } | undefined,
  ) => string;
  const stableUseParams = M.stableUseParamsFn as unknown as <T = undefined>() => T;
  return {
    ...actual,
    useLocation: stableUseLocation,
    useSearch: stableUseSearch,
    useParams: stableUseParams,
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    Router: ({ children }: any) => <>{children}</>,
    Switch: ({ children }: any) => <>{children}</>,
    Route: ({ children, component: Comp }: any) => (Comp ? <Comp /> : <>{children}</>),
    Redirect: () => null,
  };
});

vi.mock("@/lib/auth-context", () => {
  return {
    AuthProvider: ({ children }: any) => <>{children}</>,
    useAuth: () => ({
      user: {
        id: 2,
        firmId: 1,
        userType: "firm_user",
        roleName: "Partner",
        roleId: 1,
        permissions: [
          { module: "cases", action: "read" },
          { module: "cases", action: "create" },
          { module: "cases", action: "assign_any" },
          { module: "accounting", action: "read" },
          { module: "documents", action: "read" },
          { module: "documents", action: "create" },
          { module: "documents", action: "update" },
          { module: "communications", action: "read" },
          { module: "case_reference", action: "view" },
          { module: "file_custody", action: "view" },
          { module: "case_monitor", action: "view" },
        ],
      },
      isLoading: false,
      authStatus: "authenticated",
      permissionsStatus: "ready",
      retryMe: vi.fn(),
      retryPermissions: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/use-toast", () => {
  return {
    useToast: () => ({ toast: M.toastMock, dismiss: vi.fn() }),
  };
});

vi.mock("@/lib/toast-error", () => {
  return {
    toastError: M.toastErrorMock,
  };
});

vi.mock("@/lib/upload-validation", () => ({
  validateUploadFile: (f: File) => ({ ok: true, file: f, message: "", allowedMimeTypes: [] }),
  DEFAULT_ALLOWED_MIME_TYPES: ["application/pdf"],
}));

vi.mock("@/lib/feature-guards", () => ({
  useFeature: () => ({ enabled: true }),
  FeatureGuard: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/lib/permissions", () => ({
  hasPermission: () => true,
  isAccountingRoleAllowed: () => true,
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual: any = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    setAuthTokenGetter: vi.fn(),
    setBaseUrl: vi.fn(),
    useLogout: () => ({ mutate: vi.fn() }),
    useListProjects: () => ({ data: { data: [] }, isLoading: false }),
    useListDevelopers: () => ({ data: { data: [] }, isLoading: false }),
    useListCases: () => ({ data: { data: [] }, isLoading: false }),
    useGetCase: (...args: any[]) => M.useGetCaseMock(...args),
    useGetCaseWorkflow: (...args: any[]) => M.useGetCaseWorkflowMock(...args),
    useListUsers: (...args: any[]) => M.useListUsersMock(...args),
    useUpdateWorkflowStep: () => ({ mutate: vi.fn(), isPending: false }),
    getListCasesQueryKey: (..._args: any[]) => ["cases-list"],
    getListProjectsQueryKey: (..._args: any[]) => ["projects-list"],
    getListDevelopersQueryKey: (..._args: any[]) => ["developers-list"],
    getGetCaseQueryKey: (..._args: any[]) => ["case-detail", _args[0]],
    getGetCaseWorkflowQueryKey: (..._args: any[]) => ["case-workflow", _args[0]],
    getListUsersQueryKey: (..._args: any[]) => ["users-list"],
  };
});

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => M.apiFetchJsonMock(...args),
    apiFetchBlob: (...args: any[]) => M.apiFetchBlobMock(...args),
    apiRequest: (...args: any[]) =>
      M.apiRequestMock(...args).catch(() => ({ ok: true, status: 200, json: async () => ({ data: {} }), blob: async () => new Blob() })),
  };
});

vi.mock("@/lib/api-base", () => ({
  getApiOrigin: () => "http://localhost",
}));

vi.mock("@/lib/auth-token", () => ({
  getStoredAuthToken: () => "test-token",
  clearStoredAuthToken: vi.fn(),
}));

vi.mock("@/components/re-auth-dialog", () => ({
  ReAuthProvider: ({ children }: any) => <>{children}</>,
  useReAuth: () => ({ show: vi.fn() }),
}));

vi.mock("@/lib/document-generation-client", () => ({
  getGenerationJobStatus: vi.fn().mockResolvedValue({ status: "completed" }),
  runNextGenerationJob: vi.fn().mockResolvedValue({ status: "completed" }),
  getGenerationJobDownloadManifest: vi.fn().mockResolvedValue({ files: [] }),
}));

vi.mock("@/components/common/error-boundary", () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>,
}));

function wrapInProviders(el: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnMount: false },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={qc}>{el}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  M.useGetCaseMock.mockReset();
  M.useGetCaseWorkflowMock.mockReset();
  M.useListUsersMock.mockReset();
  M.apiFetchJsonMock.mockReset();
  M.apiFetchBlobMock.mockReset();

  M.useListUsersMock.mockReturnValue({
    data: { data: [] },
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  });

  M.apiFetchJsonMock.mockImplementation(async (p: string) => {
    if (typeof p !== "string") return {};
    if (p.startsWith("/printable-config")) return [];
    if (p.startsWith("/cases/filter-options")) return { assignees: { lawyers: [], clerks: [] } };
    if (p.includes("/hims/tracker")) return { items: [] };
    if (p.includes("/file-custody/items")) return { total: 0, items: [], offset: 0, limit: 20 };
    if (p.includes("/case-monitor/bottlenecks")) return { items: [], total: 0, offset: 0, limit: 20 };
    if (p.includes("/payment-voucher-actions/cases/")) return { activeCount: 0, overdueCount: 0 };
    if (p.endsWith("/threads")) return [];
    return {};
  });

  M.useGetCaseWorkflowMock.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
});

describe("Case Details — Shell Resilience (§8 + §9)", () => {
  it("CASE-SHELL-1 — Primary 200, Messages 500: case data renders, messages show isolated error, no whole-page die", async () => {
    M.stableUseSearchFn.mockReturnValue("?tab=client-interaction");
    M.useGetCaseMock.mockReturnValue({
      data: {
        id: 16,
        referenceNo: "CV-2025-00016",
        status: "Active",
        caseType: "Conveyancing Purchase",
        case_type: "Conveyancing Purchase",
        proposedReferenceNo: null,
        projectId: 77,
        projectName: "Harmony Residences",
        developerName: "Acme Development Sdn Bhd",
        spaPrice: 500000,
        titleType: "master",
        trackingToken: "track-abc-16",
        assignments: [
          { roleInCase: "lawyer", userId: 2 },
          { roleInCase: "clerk", userId: 5 },
        ],
        purchasers: [],
        loanDetails: null,
      },
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    });

    M.apiFetchJsonMock.mockImplementation(async (p: any) => {
      const path = typeof p === "string" ? p : String(p);
      if (path.match(/\/cases\/16\/messages(\?|$)/)) {
        const err: any = new Error("Server failed to process messages request");
        err.status = 500;
        err.body = { error: "Server failed" };
        throw err;
      }
      if (path.startsWith("/printable-config")) return [];
      if (path.startsWith("/cases/filter-options")) return { assignees: { lawyers: [], clerks: [] } };
      if (path === "/cases/16/key-dates") return {};
      if (path === "/cases/16/advances") return { outstanding_advances: 0 };
      if (path === "/cases/16/workflow-documents") return [];
      if (path === "/cases/16/loan-stamping") return [];
      if (path === "/cases/16/supp-lo-documents") return [];
      if (path === "/cases/16/reference-history") return [];
      if (path === "/cases/16/ledger") return { summary: { total_billed: 0, total_received: 0, outstanding_balance: 0, trust_balance: 0 }, data: [] };
      if (path === "/cases/16/progress") return { sections: [], attachments: [], workflowSteps: [], stamping: { completed: 0, total: 0, missing: [] } };
      if (path === "/cases/16/threads") return [];
      if (path === "/cases/16/messages/unread-count") return { totalUnreadCount: 0, unreadCountByChannel: { client: 0, developer: 0 } };
      if (path.startsWith("/cases/16/print-documents")) return { ok: true, sections: { caseSupporting: { items: [] }, projectSupporting: { items: [] } } };
      if (path.includes("/hims/tracker")) return { items: [] };
      if (path.includes("/file-custody/items")) return { total: 0, items: [], offset: 0, limit: 20 };
      if (path.includes("/case-monitor/bottlenecks")) return { items: [], total: 0, offset: 0, limit: 20 };
      if (path.includes("/payment-voucher-actions/cases/")) return { activeCount: 0, overdueCount: 0 };
      return {};
    });

    const { container } = render(wrapInProviders(<CaseDetail />));

    await waitFor(() => {
      expect(screen.queryByText("Loading case details...")).not.toBeInTheDocument();
    }, { timeout: 10_000 });

    const refNodes = screen.getAllByText("CV-2025-00016");
    expect(refNodes.length).toBeGreaterThan(0);

    const statusBadges = screen.getAllByText((_content, el) => {
      if (!el) return false;
      const text = (el.textContent || "").trim();
      return text.toLowerCase() === "active";
    });
    expect(statusBadges.length).toBeGreaterThan(0);

    expect(screen.queryByText("Case unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Workflow unavailable")).not.toBeInTheDocument();

    await waitFor(() => {
      const unableToLoadMessagesNodes = screen.getAllByText((_content, el) => {
        if (!el) return false;
        return (el.textContent || "").includes("Unable to load Messages");
      });
      expect(unableToLoadMessagesNodes.length).toBeGreaterThan(0);
    }, { timeout: 8_000 });

    const retryButtons = screen.getAllByRole("button", { name: /Retry/i });
    expect(retryButtons.length).toBeGreaterThan(0);
  });

  it("CASE-SHELL-2 — Primary 500: shows Case unavailable banner, no case-specific data", async () => {
    M.stableUseSearchFn.mockReturnValue("");
    const serverError: any = new Error("Server failed");
    serverError.status = 500;
    serverError.body = { error: "Server failed" };

    M.useGetCaseMock.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      error: serverError,
      isFetching: false,
      refetch: vi.fn(),
    });

    M.apiFetchJsonMock.mockImplementation(async (p: any) => {
      const path = typeof p === "string" ? p : String(p);
      if (path.match(/^\/cases\/16(\/|$)/)) {
        const err: any = new Error("Server failed");
        err.status = 500;
        err.body = { error: "Server failed" };
        throw err;
      }
      return {};
    });

    render(wrapInProviders(<CaseDetail />));

    await waitFor(() => {
      expect(screen.queryByText("Loading case details...")).not.toBeInTheDocument();
    }, { timeout: 10_000 });

    expect(await screen.findByText("Case unavailable")).toBeInTheDocument();

    expect(screen.queryByText("CV-2025-00016")).not.toBeInTheDocument();
    expect(screen.queryByText((_content, el) => {
      if (!el) return false;
      return (el.textContent || "").includes("Case Reference");
    })).not.toBeInTheDocument();

    const retryCaseData = screen.getAllByRole("button", { name: /Retry/i });
    expect(retryCaseData.length).toBeGreaterThan(0);
  });
});
