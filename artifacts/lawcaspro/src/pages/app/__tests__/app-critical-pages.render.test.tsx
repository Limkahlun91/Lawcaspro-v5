import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/fake";
    }
  }
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

(globalThis as any).React = React;

let locationValue = "/app/dashboard";
const setLocationMock = vi.fn();
const toastMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("wouter", async () => {
  const actual: any = await vi.importActual("wouter");
  return {
    ...actual,
    useLocation: () => [locationValue, setLocationMock],
    useSearch: () => "",
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
        roleName: "Managing Partner",
        roleId: 1,
        permissions: [
          { module: "dashboard", action: "read" },
          { module: "cases", action: "read" },
          { module: "cases", action: "create" },
          { module: "accounting", action: "read" },
          { module: "hr", action: "read" },
          { module: "documents", action: "read" },
          { module: "communications", action: "read" },
          { module: "audit", action: "read" },
          { module: "reports", action: "read" },
          { module: "settings", action: "read" },
          { module: "projects", action: "read" },
          { module: "developers", action: "read" },
          { module: "file_custody", action: "view" },
          { module: "developer_portal", action: "read" },
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
    useToast: () => ({ toast: toastMock, dismiss: vi.fn() }),
  };
});

vi.mock("@/lib/toast-error", () => {
  return {
    toastError: toastErrorMock,
  };
});

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
    useListQuotations: () => ({ data: { data: [] }, isLoading: false }),
    useGetCase: () => ({ data: null, isLoading: false }),
    useGetClient: () => ({ data: null, isLoading: false }),
    useCreateQuotation: () => ({ mutate: vi.fn(), isPending: false }),
    getListProjectsQueryKey: (..._args: any[]) => ["projects-list"],
    getListDevelopersQueryKey: (..._args: any[]) => ["developers-list"],
    getGetCaseQueryKey: (..._args: any[]) => ["case-detail"],
    getGetClientQueryKey: (..._args: any[]) => ["client-detail"],
  };
});

const apiFetchJsonMock = vi.fn();
const apiRequestMock = vi.fn();
const apiFetchBlobMock = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
    apiRequest: (...args: any[]) =>
      apiRequestMock(...args).catch(() => ({ ok: true, status: 200, json: async () => ({ data: {} }) })),
    apiFetchBlob: (...args: any[]) => apiFetchBlobMock(...args),
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

vi.mock("@/components/layout/app-layout", () => ({
  AppLayout: ({ children }: any) => <div data-testid="app-layout">{children}</div>,
}));
vi.mock("@/components/layout/platform-layout", () => ({
  PlatformLayout: ({ children }: any) => <div data-testid="platform-layout">{children}</div>,
}));
vi.mock("@/components/layout/developer-layout", () => ({
  DeveloperLayout: ({ children }: any) => <div data-testid="developer-layout">{children}</div>,
}));

vi.mock("@/components/GlobalCaseSearch", () => ({
  GlobalCaseSearch: () => <div data-testid="global-case-search" />,
}));

vi.mock("@/components/permission-guard", () => ({
  PermissionGuard: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/components/developer-guard", () => ({
  DeveloperGuard: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/lib/feature-guards", () => ({
  FeatureGuard: ({ children }: any) => <>{children}</>,
}));

function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnMount: false },
      mutations: { retry: false },
    },
  });
}

function wrapInProviders(node: React.ReactNode) {
  return <QueryClientProvider client={makeTestQueryClient()}>{node}</QueryClientProvider>;
}

describe("Critical Pages Render Smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocationMock.mockReset();
    toastMock.mockReset();
    toastErrorMock.mockReset();
    apiFetchJsonMock.mockReset();
    apiRequestMock.mockReset();
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (typeof p === "string" && p.startsWith("/cases/filter-options")) return { assignees: { lawyers: [], clerks: [] } };
      if (typeof p === "string" && p.startsWith("/legacy-case-imports/recent")) return { data: [] };
      if (typeof p === "string" && p.startsWith("/projects")) return { data: [] };
      if (typeof p === "string" && p.startsWith("/developers")) return { data: [] };
      if (typeof p === "string" && p.startsWith("/hr/")) return { items: [], data: [] };
      if (typeof p === "string" && p.startsWith("/accounting")) return {};
      if (typeof p === "string" && p.startsWith("/ledger")) return [];
      if (typeof p === "string" && p.startsWith("/invoices")) return [];
      if (typeof p === "string" && p.startsWith("/case-files")) return { data: [], total: 0, page: 1, limit: 50 };
      if (typeof p === "string" && p.startsWith("/file-custody")) return { items: [], total: 0 };
      if (typeof p === "string" && p.startsWith("/firm-users")) return { users: [] };
      if (typeof p === "string" && p.startsWith("/documents")) return { templates: [] };
      return {};
    });
    apiRequestMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: {} }),
    }));
  });

  it("App shell renders without throwing", async () => {
    locationValue = "/app/dashboard";
    const AppShell = await import("../dashboard").then((m) => m.default);
    expect(() => {
      render(wrapInProviders(<AppShell />));
    }).not.toThrow();
  });

  it("Legacy Import renders without throwing (TDZ regression guard)", async () => {
    locationValue = "/app/cases/import";
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (typeof p === "string" && p.startsWith("/projects")) return { data: [{ id: 1, name: "P1" }] };
      if (typeof p === "string" && p.startsWith("/developers")) return { data: [{ id: 1, name: "D1" }] };
      if (typeof p === "string" && p.startsWith("/legacy-case-imports/recent")) return { data: [] };
      return {};
    });
    const LegacyImportPage = await import("../cases/legacy-import").then((m) => m.default);
    expect(() => {
      render(wrapInProviders(<LegacyImportPage />));
    }).not.toThrow();
  });

  it("My Work / Workbench renders without throwing", async () => {
    locationValue = "/app/my-work";
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (typeof p === "string" && p.startsWith("/cases/workbench")) {
        return {
          staffUser: { id: 2, name: "Staff" },
          staffOptions: [],
          myWork: { cards: [], recent: [] },
          missingDates: { cards: [] },
          overdue: { cards: [] },
        };
      }
      if (typeof p === "string" && p.startsWith("/cases/milestones-summary")) {
        return { milestoneSections: [], milestoneCards: [] };
      }
      if (typeof p === "string" && p.startsWith("/payment-voucher-actions/my-work")) return [];
      if (typeof p === "string" && p.startsWith("/cases/filter-options")) return { assignees: { lawyers: [], clerks: [] } };
      if (typeof p === "string" && p.startsWith("/projects")) return { data: [] };
      return {};
    });
    const WorkbenchPage = await import("../workbench").then((m) => m.default);
    expect(() => {
      render(wrapInProviders(<WorkbenchPage />));
    }).not.toThrow();
  });
});
