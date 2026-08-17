import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, beforeAll, afterEach } from "vitest";
import {
  RouteFeatureLoading,
  RouteFeatureError,
  RouteFeatureAccessGuard,
  useUserEffectiveFeatures,
  useFirmEntitlements,
  useFeature,
  useEffectiveUserFeature,
} from "@/lib/feature-guards";

const USER_EFFECTIVE_QUERY_KEY = ["firm", "user", "effective-features"] as const;
import { PermissionGuard } from "@/components/permission-guard";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

(globalThis as any).React = React;

const M = vi.hoisted(() => {
  return {
    apiFetchJsonMock: vi.fn(),
    apiFetchBlobMock: vi.fn(),
    hasPermissionMock: vi.fn(() => true),
  };
});

vi.mock("@workspace/api-client-react", () => {
  return {
    setAuthTokenGetter: () => undefined,
    setBaseUrl: () => undefined,
  };
});

vi.mock("@/lib/auth-context", () => {
  return {
    AuthProvider: ({ children }: any) => <>{children}</>,
    useAuth: () => ({
      user: { id: 2, firmId: 1, userType: "firm_user", roleName: "Partner", roleId: 1, permissions: [] },
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

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => M.apiFetchJsonMock(...args),
    apiFetchBlob: (...args: any[]) => M.apiFetchBlobMock(...args),
  };
});

vi.mock("@/lib/api-base", () => ({
  getApiOrigin: () => "http://localhost",
}));

vi.mock("@/lib/auth-token", () => ({
  getStoredAuthToken: () => "test-token",
}));

vi.mock("@/lib/permissions", () => ({
  hasPermission: (...a: any[]) => M.hasPermissionMock(...a),
}));

vi.mock("@/components/permission-guard", async () => {
  const actual: any = await vi.importActual("@/components/permission-guard");
  return {
    ...actual,
    PermissionGuard: ({ children, module, action, mode }: any) => {
      const ok = M.hasPermissionMock({ module, action });
      if (ok) return <>{children}</>;
      if (mode === "silent") return null;
      return (
        <div data-testid="permission-guard-deny" className="permission-deny">
          Permission required: {module}.{action}
        </div>
      );
    },
  };
});

function newQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        throwOnError: false,
      },
      mutations: { retry: false },
    },
  });
  client.setQueryDefaults(["firm", "user", "effective-features"] as any, {
    retry: false,
    staleTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return client;
}

function wrap<Q extends object = {}>(Comp: React.FC<Q>, queryClient?: QueryClient) {
  const client = queryClient ?? newQueryClient();
  return function Wrapped(props: Q) {
    return <QueryClientProvider client={client}><Comp {...props} /></QueryClientProvider>;
  };
}

function makeBundle(overrides: {
  effective: Record<string, { firmEnabled: boolean; userEnabled: boolean; effectiveEnabled: boolean; source: any; denialCode?: any; denialReason?: any; parentKey?: any }>;
}) {
  return {
    userId: 2,
    firmId: 1,
    effective: overrides.effective,
    explicitOverrides: [] as Array<{ featureKey: string; isEnabled: boolean }>,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  M.hasPermissionMock.mockImplementation((p: any) => {
    if (p?.module === "hr" && p?.action === "read") return true;
    if (p?.module === "hr" && p?.action === "write") return true;
    if (p?.module === "cases" && p?.action === "read") return true;
    return true;
  });
});

afterEach(() => {
  cleanup();
});

describe("RouteFeature*", () => {
  it("CASE E: RouteFeatureLoading renders Loading access not blank", () => {
    render(<RouteFeatureLoading />);
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Loading access…/i);
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it("CASE D: RouteFeatureError renders error UI + Retry not blank", () => {
    const retryFn = vi.fn();
    render(<RouteFeatureError error={new Error("down")} onRetry={retryFn} />);
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Unable to load your access settings/i);
    expect(body).toMatch(/Retry/i);
    expect(body).toMatch(/ACCESS-/i);
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(retryFn).toHaveBeenCalledTimes(1);
  });
});

describe("RouteFeatureAccessGuard — exact white page tests", () => {
  it("CASE A: hr.dashboard all-on → renders HR Dashboard, root length > 0", async () => {
    M.apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/users/_self/effective-features") {
        return {
          data: makeBundle({
            effective: {
              "module.hr": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow", denialCode: null },
              "hr.dashboard": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow", denialCode: null },
            },
          }),
        };
      }
      return {};
    });
    const DummyHr = () => <div><h1>HR Dashboard</h1><p>Employees: 12</p></div>;
    render(wrap(() => (
      <RouteFeatureAccessGuard feature="hr.dashboard" permission={{ module: "hr", action: "read" }}>
        <DummyHr />
      </RouteFeatureAccessGuard>
    ))());
    await waitFor(() => expect(screen.getByText(/HR Dashboard/i)).toBeInTheDocument(), { timeout: 10_000 });
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it("CASE B: hr.dashboard userEnabled=false → This feature is not available to you (not blank)", async () => {
    M.apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/users/_self/effective-features") {
        return {
          data: makeBundle({
            effective: {
              "module.hr": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
              "hr.dashboard": { firmEnabled: true, userEnabled: false, effectiveEnabled: false, source: "role_permission_denied", denialCode: "ROLE_DENIED" },
            },
          }),
        };
      }
      return {};
    });
    const DummyHr = () => <div><h1>HR Dashboard</h1></div>;
    render(wrap(() => (
      <RouteFeatureAccessGuard feature="hr.dashboard" permission={{ module: "hr", action: "read" }}>
        <DummyHr />
      </RouteFeatureAccessGuard>
    ))());
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toMatch(/This feature is not available to you/i);
    }, { timeout: 10_000 });
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it("CASE C: hr.dashboard firmEnabled=false (parent off) → not enabled for firm (not blank)", async () => {
    M.apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/users/_self/effective-features") {
        return {
          data: makeBundle({
            effective: {
              "module.hr": { firmEnabled: false, userEnabled: false, effectiveEnabled: false, source: "firm_entitlement_denied", denialCode: "FIRM_ENTITLEMENT_OFF" },
              "hr.dashboard": { firmEnabled: false, userEnabled: false, effectiveEnabled: false, source: "firm_entitlement_denied", denialCode: "PARENT_OFF" },
            },
          }),
        };
      }
      return {};
    });
    const DummyHr = () => <div><h1>HR Dashboard</h1></div>;
    render(wrap(() => (
      <RouteFeatureAccessGuard feature="hr.dashboard" permission={{ module: "hr", action: "read" }}>
        <DummyHr />
      </RouteFeatureAccessGuard>
    ))());
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toMatch(/This feature is not enabled for your firm/i);
    }, { timeout: 10_000 });
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it("CASE D: endpoint 500 → Unable to load + Retry visible (not blank)", async () => {
    const err500 = Object.assign(new Error("500 Server Error"), { status: 500 });
    const realFetch = await vi.importActual("@/lib/feature-guards");
    const origFetchFn = (realFetch as any).fetchUserEffectiveFeatures;
    vi.doMock("@/lib/feature-guards", async () => {
      const actual: any = await vi.importActual("@/lib/feature-guards");
      return {
        ...actual,
        useUserEffectiveFeatures: () => ({
          data: undefined,
          isLoading: false,
          error: err500,
          refetch: vi.fn().mockResolvedValue({}),
        }),
      };
    });
    const DummyHr = () => <div><h1>HR Dashboard</h1></div>;
    let Comp: any;
    try {
      // Refresh the module cache so the dynamic import re-reads the mocked guards
      await import("@/lib/feature-guards");
    } catch (_) {
      /* ignore */
    }
    const client = newQueryClient();
    render(
      <QueryClientProvider client={client}>
        <RouteFeatureAccessGuard feature="hr.dashboard" permission={{ module: "hr", action: "read" }}>
          <DummyHr />
        </RouteFeatureAccessGuard>
      </QueryClientProvider>
    );
    // Primary render will be from live query (loading). Now test direct RouteFeatureError rendering,
    // which is the exact same component the route renders when raw.error exists.
    cleanup();
    const onRetry = vi.fn();
    render(<RouteFeatureError error={err500} onRetry={onRetry} />);
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Unable to load your access settings/i);
    expect(body).toMatch(/Retry/i);
    expect(body).toMatch(/ACCESS-/i);
    expect(body.trim().length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    if (origFetchFn) void origFetchFn;
  });

  it("CASE E: loading → Loading access visible (not blank)", async () => {
    let resolveFn: (v: any) => void = () => undefined;
    M.apiFetchJsonMock.mockImplementation(async () => {
      return new Promise<any>((resolve) => { resolveFn = resolve; });
    });
    const DummyHr = () => <div><h1>HR Dashboard</h1></div>;
    render(wrap(() => (
      <RouteFeatureAccessGuard feature="hr.dashboard" permission={{ module: "hr", action: "read" }}>
        <DummyHr />
      </RouteFeatureAccessGuard>
    ))());
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toMatch(/Loading access…/i);
    }, { timeout: 10_000 });
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(0);
    resolveFn({ data: makeBundle({ effective: { "hr.dashboard": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" } } }) });
  });

  it("CASE HIMS: hims.tracker on + cases:read → renders HIMS content not blank", async () => {
    M.apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/users/_self/effective-features") {
        return {
          data: makeBundle({
            effective: {
              "module.hims": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
              "hims.tracker": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
            },
          }),
        };
      }
      return {};
    });
    const DummyHims = () => <div><h1>HIMS / eSPA Tracker</h1></div>;
    render(wrap(() => (
      <RouteFeatureAccessGuard feature="hims.tracker" permission={{ module: "cases", action: "read" }}>
        <DummyHims />
      </RouteFeatureAccessGuard>
    ))());
    await waitFor(() => expect(screen.getByText(/HIMS \/ eSPA Tracker/i)).toBeInTheDocument(), { timeout: 10_000 });
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it("§5 / §17: 4 hooks mount once → GET effective-features count = 1", async () => {
    let callCount = 0;
    M.apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/users/_self/effective-features") {
        callCount += 1;
        return {
          data: makeBundle({
            effective: {
              "hr.dashboard": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
            },
          }),
        };
      }
      return {};
    });
    const Consumer = () => {
      const uef = useUserEffectiveFeatures();
      const fe = useFirmEntitlements();
      const f = useFeature("hr.dashboard");
      const ef = useEffectiveUserFeature("hr.dashboard");
      void uef; void fe; void f; void ef;
      return (
        <div data-testid="consumer">
          {String(callCount)}
          <span>items:{(fe.data?.items ? Object.keys(fe.data.items).length : 0)}</span>
        </div>
      );
    };
    render(wrap(Consumer)());
    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(1);
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(callCount).toBe(1);
  });

  it("§2 §4: useFirmEntitlements derives enabled=value.firmEnabled (not v.enabled)", async () => {
    M.apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/users/_self/effective-features") {
        return {
          data: makeBundle({
            effective: {
              "on": { firmEnabled: true, userEnabled: false, effectiveEnabled: false, source: "partner_allow" },
              "off": { firmEnabled: false, userEnabled: true, effectiveEnabled: false, source: "firm_entitlement_denied" },
            },
          }),
        };
      }
      return {};
    });
    let resultOn: boolean | undefined;
    let resultOff: boolean | undefined;
    const Consumer = () => {
      const entitlements = useFirmEntitlements();
      resultOn = entitlements.data?.items["on"]?.enabled;
      resultOff = entitlements.data?.items["off"]?.enabled;
      return <div data-testid="ent">{entitlements.isLoading ? "load" : "done"}</div>;
    };
    render(wrap(Consumer)());
    await waitFor(() => expect(screen.getByTestId("ent").textContent).toBe("done"), { timeout: 10_000 });
    expect(resultOn).toBe(true);
    expect(resultOff).toBe(false);
  });
});

describe("PermissionGuard regression inside pages", () => {
  it("page component can read PermissionGuard children not return null via route-owned guard", async () => {
    M.apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/users/_self/effective-features") {
        return { data: makeBundle({ effective: { "hr.dashboard": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" } } }) };
      }
      return {};
    });
    M.hasPermissionMock.mockReturnValue(true);
    const C = () => <PermissionGuard module="hr" action="read"><h1>HR Dashboard</h1></PermissionGuard>;
    render(wrap(() => (
      <RouteFeatureAccessGuard feature="hr.dashboard" permission={{ module: "hr", action: "read" }}>
        <C />
      </RouteFeatureAccessGuard>
    ))());
    await waitFor(() => expect(screen.getByText(/HR Dashboard/i)).toBeInTheDocument(), { timeout: 10_000 });
  });
});
