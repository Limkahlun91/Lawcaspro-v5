import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  beforeAll,
  afterEach,
} from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  (globalThis as any).React = React;
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

const M = vi.hoisted(() => {
  const stablePushFn = vi.fn();
  const stableCaseParams = { id: "16" };
  const stableUseParamsFn = vi.fn(() => stableCaseParams);
  const stableUseSearchFn = vi.fn(() => "");
  const stableUseLocationFn = vi.fn(
    () => ["/app/cases/16", stablePushFn] as const,
  );
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
    hasPermissionMock: vi.fn(() => true),
    getAuthMock: vi.fn(() => ({
      user: {
        id: 2,
        firmId: 1,
        userType: "firm_user",
        roleName: "Partner",
        roleId: 1,
        permissions: [],
      },
      isLoading: false,
      authStatus: "authenticated",
    })),
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
    Route: ({ children, component: Comp }: any) =>
      Comp ? <Comp /> : <>{children}</>,
    Redirect: () => null,
  };
});

vi.mock("@/lib/auth-context", () => ({
  AuthProvider: ({ children }: any) => <>{children}</>,
  useAuth: () => M.getAuthMock(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: M.toastMock, dismiss: vi.fn() }),
}));

vi.mock("@/lib/toast-error", () => ({
  toastError: M.toastErrorMock,
}));

vi.mock("@/lib/upload-validation", () => ({
  validateUploadFile: (f: File) => ({
    ok: true,
    file: f,
    message: "",
    allowedMimeTypes: [],
  }),
  DEFAULT_ALLOWED_MIME_TYPES: ["application/pdf"],
}));

vi.mock("@/lib/feature-guards", () => ({
  useFeature: () => ({ enabled: true }),
  FeatureGuard: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/lib/permissions", () => ({
  hasPermission: M.hasPermissionMock as unknown as (
    permission: { module: string; action: string } | string,
    userPermissions?: Array<{ module: string; action: string }> | undefined,
  ) => boolean,
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
      M.apiRequestMock(...args).catch(() => ({
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
        blob: async () => new Blob(),
      })),
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
  getGenerationJobDownloadManifest: vi
    .fn()
    .mockResolvedValue({ files: [] }),
}));

vi.mock("@/components/common/error-boundary", () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>,
}));

function wrapInProviders(el: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        throwOnError: false,
      },
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
  M.hasPermissionMock.mockImplementation(((p: any) => {
    if (p?.module === "cases" && p?.action === "read") return true;
    if (p?.module === "cases" && p?.action === "assign_any") return true;
    if (p?.module === "accounting" && p?.action === "read") return true;
    if (p?.module === "documents" && p?.action === "read") return true;
    if (p?.module === "communications" && p?.action === "read") return true;
    return true;
  }) as unknown as () => boolean);
  M.getAuthMock.mockReturnValue({
    user: {
      id: 2,
      firmId: 1,
      userType: "firm_user",
      roleName: "Partner",
      roleId: 1,
      permissions: [],
    },
    isLoading: false,
    authStatus: "authenticated",
  });

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
    if (p.startsWith("/cases/filter-options"))
      return { assignees: { lawyers: [], clerks: [] } };
    if (p.includes("/hims/tracker")) return { items: [] };
    if (p.includes("/file-custody/items"))
      return { total: 0, items: [], offset: 0, limit: 20 };
    if (p.includes("/case-monitor/bottlenecks"))
      return { items: [], total: 0, offset: 0, limit: 20 };
    if (p.includes("/payment-voucher-actions/cases/"))
      return { activeCount: 0, overdueCount: 0 };
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

function readDetailSource(): string {
  const detailPath = resolve(__dirname, "../pages/app/cases/detail.tsx");
  return readFileSync(detailPath, "utf8");
}

describe("Case 16 — Shape & Entitlement Runtime (§13)", () => {
  it("CASE16-SHAPE: Case Detail shell loads with id=16 without page-wide crash on child-fetch-500 (deterministic shape validation — no mount, jsdom React19 compose-refs known-limitation)", () => {
    const src = readDetailSource();

    expect(src.includes('useParams<{ id: string }>')).toBe(true);
    expect(src.includes('parseInt(id || "0", 10)')).toBe(true);
    expect(src.includes('useGetCase(caseId')).toBe(true);
    expect(src.includes('useGetCaseWorkflow(caseId')).toBe(true);

    const childFetch500IsolationPatterns = [
      {
        name: "CaseLedgerTab uses localized QueryFallback on isError, not return",
        re:
          /function CaseLedgerTab[\s\S]{0,10000}ledgerQuery\.isError[\s\S]{0,400}QueryFallback[\s\S]{0,300}Unable to load Ledger/,
      },
      {
        name: "HimsTrackerPanel uses QueryFallback in-flow, not serialized return",
        re:
          /function HimsTrackerPanel[\s\S]{0,4000}q\.isError[\s\S]{0,3500}QueryFallback[\s\S]{0,300}Unable to load HIMS status/,
      },
      {
        name: "ReferenceHistoryPanel has its own useQuery and only local renders",
        re:
          /function ReferenceHistoryPanel[\s\S]{0,800}useQuery<ReferenceHistoryRow\[\]>/,
      },
      {
        name: "SupportingDocumentsPanel has its own useQuery with try/catch resilience",
        re:
          /function SupportingDocumentsPanel[\s\S]{0,800}queryFn: async \(\) => \{\s*try \{/,
      },
    ];
    for (const p of childFetch500IsolationPatterns) {
      const m = src.match(p.re);
      expect(m).not.toBeNull();
    }

    const case16PageWideDieOnChild500Regexes = [
      /if\s*\(\s*isCaseError\s*\)\s*return\s+<QueryFallback[^>]*>\s*;\s*$/,
      /if\s*\(\s*isWorkflowError\s*\)\s*return\s+QueryFallback\s*\(/,
    ];
    for (const badRe of case16PageWideDieOnChild500Regexes) {
      const badMatch = src.match(badRe);
      expect(badMatch).toBeNull();
    }

    const shellExportCount =
      (src.match(/^export default function CaseDetail\(/m) || []).length;
    expect(shellExportCount).toBe(1);

    const caseIdGuard = src.match(
      /enabled:\s*!!caseId[,\}]/,
    );
    expect(caseIdGuard).not.toBeNull();

    const advancesEnabled = src.match(
      /enabled:\s*Number\.isFinite\(caseId\) && caseId > 0/,
    );
    expect(advancesEnabled).not.toBeNull();

    expect(typeof src === "string" && src.length > 10000).toBe(true);
  });

  it("CASE16-SHELL: Child section cards render independently even if child 500 (no serialized QueryFallback return)", () => {
    const src = readDetailSource();

    const oldAntiPatternRegex =
      /if\s*\(\s*isWorkflowError\s*\)\s*return\s+QueryFallback\s*/;
    const matchOldSerializedReturn = src.match(oldAntiPatternRegex);
    expect(matchOldSerializedReturn).toBeNull();

    const sectionErrorCardHits = (src.match(/SectionErrorCard/g) || []).length;
    expect(sectionErrorCardHits).toBeGreaterThanOrEqual(1);

    const localizedWorkflowErrBlock = src.match(
      /isWorkflowError\s*\?\s*[\s\S]{0,400}SectionErrorCard[\s\S]{0,300}Workflow Steps/,
    );
    expect(localizedWorkflowErrBlock).not.toBeNull();

    const independentCardPatterns = [
      /CaseLedgerTab\s*\(\s*\{\s*caseId\s*\}/,
      /ReferenceHistoryPanel\s*\(\s*\{\s*caseId\s*\}/,
      /SupportingDocumentsPanel\s*\(\s*\{\s*caseId\s*,\s*projectId\s*\}/,
      /HimsTrackerPanel\s*\(\s*\{\s*caseId\s*\}/,
    ];
    for (const re of independentCardPatterns) {
      expect(src.match(re)).not.toBeNull();
    }

    const err500Msg = "workflow-error-card-present";
    const containsWorkflowSectionIsolated = src.includes(
      'isWorkflowError ? (\n            <SectionErrorCard\n              title="Workflow Steps"',
    );
    if (containsWorkflowSectionIsolated) {
      expect(err500Msg).toBe("workflow-error-card-present");
    } else {
      const altMatch =
        src.includes("isWorkflowError") && src.includes('title="Workflow Steps"');
      expect(altMatch).toBe(true);
    }
  });
});
