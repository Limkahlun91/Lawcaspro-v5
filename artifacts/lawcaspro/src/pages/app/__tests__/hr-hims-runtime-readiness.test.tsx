import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
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

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  (globalThis as any).React = React;
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

const M = vi.hoisted(() => {
  return {
    apiFetchJsonMock: vi.fn(),
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

vi.mock("@workspace/api-client-react", () => ({
  setAuthTokenGetter: () => undefined,
  setBaseUrl: () => undefined,
}));

vi.mock("@/lib/auth-context", () => ({
  AuthProvider: ({ children }: any) => <>{children}</>,
  useAuth: () => M.getAuthMock(),
}));

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => M.apiFetchJsonMock(...args),
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
        <div data-testid="permission-guard-deny">
          Permission required: {module}.{action}
        </div>
      );
    },
  };
});

type Meta = { request_id: string; timestamp: string; duration_ms: number };
const META = (id: string): Meta => ({ request_id: id, timestamp: new Date().toISOString(), duration_ms: 1 });
function ok<T>(data: T, id = "req_x") {
  return { ok: true as const, data, meta: META(id) };
}

function newQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: 0,
        staleTime: 0,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        throwOnError: false,
      },
      mutations: { retry: 0 },
    },
  });
  return client;
}

function wrap<Q extends object = {}>(Comp: React.FC<Q>, queryClient?: QueryClient) {
  const client = queryClient ?? newQueryClient();
  return function Wrapped(props: Q) {
    return (
      <QueryClientProvider client={client}>
        <Comp {...props} />
      </QueryClientProvider>
    );
  };
}

const EFFECTIVE_ON = {
  userId: 2,
  firmId: 1,
  explicitOverrides: [],
  effective: {
    "hr.dashboard": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.employees": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.attendance": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.leave": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.claims": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.payroll": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.recruitment": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.performance": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.training": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.assets": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.documents": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.onboarding": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.offboarding": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.departments": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.positions": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.reports": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hr.settings": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hims.tracker": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
    "hims.status_check": { firmEnabled: true, userEnabled: true, effectiveEnabled: true, source: "partner_allow" },
  },
};

const EFFECTIVE_PAYROLL_OFF: typeof EFFECTIVE_ON = {
  ...EFFECTIVE_ON,
  effective: {
    ...EFFECTIVE_ON.effective,
    "hr.payroll": {
      firmEnabled: false,
      userEnabled: false,
      effectiveEnabled: false,
      source: "firm_entitlement_denied",
    } as any,
  },
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  M.hasPermissionMock.mockImplementation((p: any) => {
    if (p?.module === "hr" && p?.action === "read") return true;
    if (p?.module === "hr" && p?.action === "write") return true;
    if (p?.module === "cases" && p?.action === "read") return true;
    return true;
  });
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
  M.apiFetchJsonMock.mockImplementation(async (url: string) => {
    const u = String(url).split("?")[0];
    if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_default");
    if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_default");
    const err: any = new Error(`Unhandled url ${String(url)}`);
    err.status = 404;
    err.code = "ROUTE_NOT_FOUND";
    throw err;
  });
});

afterEach(() => {
  cleanup();
});

// Load page modules DYNAMICALLY inside each test to apply fresh mockbag, React global set above before mocks applied before

describe("HR Dashboard fallback rules — §2 §3", () => {
  it("HR-1 canonical 200 → no fallback request & cards render", async () => {
    const calls: string[] = [];
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      calls.push(u);
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_1");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_1");
      if (u === "/hr/dashboard/summary") {
        return ok(
          { totalEmployees: 5, activeToday: 4, onLeaveToday: 1, pendingLeave: 2, pendingClaims: 1 },
          "hr_hr_1",
        );
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      err.code = "ROUTE_NOT_FOUND";
      throw err;
    });
    const mod = await import("@/pages/app/hr/dashboard/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/HR Dashboard/i)).toBeInTheDocument();
        expect(screen.getByText(/Total Employees/i)).toBeInTheDocument();
        expect(screen.getByText("5")).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    expect(calls).toContain("/hr/dashboard/summary");
    expect(calls).not.toContain("/hr/me/dashboard");
    expect(calls).not.toContain("/hr/dashboard/stats");
  });

  it("HR-2 canonical 404 → falls back to deprecated alias then legacy", async () => {
    const calls: string[] = [];
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      calls.push(u);
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_2");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_2");
      if (u === "/hr/dashboard/summary") {
        const err: any = new Error("not found summary");
        err.status = 404;
        err.code = "ROUTE_NOT_FOUND";
        throw err;
      }
      if (u === "/hr/me/dashboard") {
        const err: any = new Error("not found deprecated");
        err.status = 404;
        err.code = "ROUTE_NOT_FOUND";
        throw err;
      }
      if (u === "/hr/dashboard/stats") {
        return ok({ headcount: 3, pendingLeaves: 0, pendingClaims: 0 }, "hr_legacy_2");
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      err.code = "ROUTE_NOT_FOUND";
      throw err;
    });
    const mod = await import("@/pages/app/hr/dashboard/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/Total Employees/i)).toBeInTheDocument();
        expect(screen.getByText("3")).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    expect(calls).toContain("/hr/dashboard/summary");
    expect(calls).toContain("/hr/me/dashboard");
    expect(calls).toContain("/hr/dashboard/stats");
  });

  it("HR-3 canonical 500 → ERROR UI fallbacks NOT called", async () => {
    const calls: string[] = [];
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      calls.push(u);
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_3");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_3");
      if (u === "/hr/dashboard/summary") {
        const err: any = new Error("DB down");
        err.status = 500;
        err.code = "INTERNAL_ERROR";
        err.requestId = "req_abcdef1234";
        err.data = {
          ok: false,
          error: { code: "INTERNAL", message: "DB down", retryable: true },
          meta: { request_id: "req_abcdef1234" },
        };
        throw err;
      }
      if (u === "/hr/me/dashboard") {
        const err2: any = new Error("FORBIDDEN CALL deprecated");
        err2.status = 500;
        throw err2;
      }
      if (u === "/hr/dashboard/stats") {
        const err3: any = new Error("FORBIDDEN CALL legacy");
        err3.status = 500;
        throw err3;
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hr/dashboard/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/Unable to load HR Dashboard/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Retry/i);
    expect(body).toMatch(/reqabcdef12/i);
    expect(calls).not.toContain("/hr/me/dashboard");
    expect(calls).not.toContain("/hr/dashboard/stats");
  });

  it("HR-4 all three routes fail → explicit error not zeros", async () => {
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_4");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_4");
      if (u === "/hr/dashboard/summary") {
        const err: any = new Error("nf sum");
        err.status = 404;
        throw err;
      }
      if (u === "/hr/me/dashboard") {
        const err: any = new Error("nf alias");
        err.status = 404;
        throw err;
      }
      if (u === "/hr/dashboard/stats") {
        const err: any = new Error("down");
        err.status = 503;
        err.requestId = "legacy_down_42";
        throw err;
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hr/dashboard/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/Unable to load HR Dashboard/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/legacydown42/i);
    expect(screen.queryByText(/Total Employees/i)).toBeNull();
  });

  it("HR-5 zero employees → empty state Add Employee visible", async () => {
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_5");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_5");
      if (u === "/hr/dashboard/summary") {
        return ok(
          { totalEmployees: 0, activeToday: 0, onLeaveToday: 0, pendingLeave: 0, pendingClaims: 0, payroll: null },
          "hr_5",
        );
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hr/dashboard/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/No employees yet/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Start by adding your first employee/i);
    expect(screen.getByText(/Add Employee/i)).toBeInTheDocument();
    expect(body.trim().length).toBeGreaterThan(0);
  });
});

describe("HR access-aware quick actions — §8", () => {
  it("HR-6 hr.payroll OFF → Payroll Quick Action absent", async () => {
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_PAYROLL_OFF, "eff_hr6");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_hr6");
      if (u === "/hr/dashboard/summary") {
        return ok(
          {
            totalEmployees: 5,
            activeToday: 4,
            onLeaveToday: 1,
            pendingLeave: 2,
            pendingClaims: 1,
            payroll: { label: "Draft", period: "August 2026" },
          },
          "hr_hr6",
        );
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hr/dashboard/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/Quick Actions/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const buttons = screen
      .getAllByRole("button")
      .map((b) => (b.textContent ?? "").trim())
      .filter(Boolean);
    expect(buttons).not.toContain("Payroll");
  });

  it("HR-7 hr.employees ON → all six admin actions visible", async () => {
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_hr7");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_hr7");
      if (u === "/hr/dashboard/summary") {
        return ok(
          { totalEmployees: 5, activeToday: 4, onLeaveToday: 1, pendingLeave: 0, pendingClaims: 0 },
          "hr_hr7",
        );
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hr/dashboard/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/Quick Actions/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const buttons = screen
      .getAllByRole("button")
      .map((b) => (b.textContent ?? "").trim())
      .filter(Boolean);
    expect(buttons).toContain("Employees");
    expect(buttons).toContain("Attendance");
    expect(buttons).toContain("Leave");
    expect(buttons).toContain("Claims");
    expect(buttons).toContain("Payroll");
    expect(buttons).toContain("Recruitment");
  });
});

describe("HIMS page states — §10 §13 §14 §15 §17 §18", () => {
  function configuredResponse() {
    return ok(
      {
        configurationStatus: "configured",
        items: [
          {
            caseId: 1,
            caseReference: "CIV-2026-001",
            purchaser: "Ahmad Bin Ali",
            project: "Sunrise Residences",
            phase: "Phase 1",
            unitLotTitle: "A-10-02",
            himsStatus: "Submitted",
            espaStatus: "Stamped",
            dataMatch: true,
            lastChecked: "2026-08-17T10:30:00Z",
          },
          {
            caseId: 2,
            caseReference: "CIV-2026-002",
            purchaser: "Siti Aminah",
            project: "Lakeview Towers",
            phase: "Tower B",
            unitLotTitle: "B-3-14",
            himsStatus: "Data Error",
            espaStatus: "Pending",
            dataMatch: false,
            lastChecked: "2026-08-17T09:10:00Z",
          },
        ],
      },
      "hims_1",
    );
  }

  it("HIMS-1 configured → cards table read-only tracker", async () => {
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h1");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h1");
      if (u === "/hims/cases") return configuredResponse();
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/HIMS \/ eSPA Tracker/i)).toBeInTheDocument();
        expect(screen.getByText("CIV-2026-001")).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Read-only tracker/i);
    expect(body).toMatch(/does NOT create or submit eSPA/i);
    expect(body).toMatch(/Tracked Cases/i);
    expect(body).toMatch(/Needs Attention/i);
    expect(body).toMatch(/Matched/i);
    expect(body).toMatch(/Last Checked/i);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it("HIMS-2 no_connections Partner → Configure HIMS", async () => {
    M.getAuthMock.mockReturnValue({
      user: { id: 2, firmId: 1, userType: "firm_user", roleName: "Partner", roleId: 1, permissions: [] },
      isLoading: false,
      authStatus: "authenticated",
    });
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h2");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h2");
      if (u === "/hims/cases") return ok({ configurationStatus: "no_connections", items: [] }, "hims_h2");
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/HIMS not configured/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    expect(screen.getByText(/Configure HIMS/i)).toBeInTheDocument();
  });

  it("HIMS-3 no_mappings Partner → Configure Project Mapping", async () => {
    M.getAuthMock.mockReturnValue({
      user: { id: 2, firmId: 1, userType: "firm_user", roleName: "Partner", roleId: 1, permissions: [] },
      isLoading: false,
      authStatus: "authenticated",
    });
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h3");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h3");
      if (u === "/hims/cases") return ok({ configurationStatus: "no_mappings", items: [] }, "hims_h3");
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/Projects are not mapped to HIMS yet/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    expect(screen.getByText(/Configure Project Mapping/i)).toBeInTheDocument();
  });

  it("HIMS-4 no_data state + hims.status_check ON → Check Status visible", async () => {
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h4");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h4");
      if (u === "/hims/cases") return ok({ configurationStatus: "no_data", items: [] }, "hims_h4");
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/No HIMS status checks yet/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/after their first tracker check/i);
    expect(screen.getByText(/Check Status/i)).toBeInTheDocument();
  });

  it("HIMS-5 API 500 → error Retry + requestId", async () => {
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h5");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h5");
      if (u === "/hims/cases") {
        const err: any = new Error("DB fail");
        err.status = 500;
        err.requestId = "req_hims_8064a0db";
        err.data = {
          ok: false,
          error: { code: "INTERNAL", message: "Server failed", retryable: true },
          meta: { request_id: "req_hims_8064a0db" },
        };
        throw err;
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/Unable to load HIMS status/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Retry/i);
    expect(body).toMatch(/reqhims8064a/i);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it("HIMS-6 Staff Clerk role no_connections → Configure HIMS absent", async () => {
    M.getAuthMock.mockReturnValue({
      user: { id: 99, firmId: 1, userType: "firm_user", roleName: "Clerk", roleId: 10, permissions: [] },
      isLoading: false,
      authStatus: "authenticated",
    });
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h6");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h6");
      if (u === "/hims/cases") return ok({ configurationStatus: "no_connections", items: [] }, "hims_h6");
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/HIMS not configured/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Contact your Partner to configure HIMS/i);
    const buttons = screen
      .queryAllByRole("button")
      .map((b) => (b.textContent ?? "").trim())
      .filter(Boolean);
    expect(buttons.filter((t) => t.includes("Configure HIMS"))).toEqual([]);
  });

  it("HIMS-7 Partner no_connections → Configure HIMS present", async () => {
    M.getAuthMock.mockReturnValue({
      user: { id: 2, firmId: 1, userType: "firm_user", roleName: "Partner", roleId: 1, permissions: [] },
      isLoading: false,
      authStatus: "authenticated",
    });
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h7");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h7");
      if (u === "/hims/cases") return ok({ configurationStatus: "no_connections", items: [] }, "hims_h7");
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await waitFor(
      () => {
        expect(screen.getByText(/HIMS not configured/i)).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    expect(screen.getByText(/Configure HIMS/i)).toBeInTheDocument();
  });

  it("HIMS-8 Loading → non-blank root with Loading HIMS tracker", async () => {
    const pending: Promise<never> = new Promise(() => {});
    M.apiFetchJsonMock.mockImplementation(async (url: string) => {
      const u = String(url).split("?")[0];
      if (u === "/users/_self/effective-features") return ok(EFFECTIVE_ON, "eff_h8");
      if (u === "/entitlements/platform/feature-registry") return ok({ version: 1, features: [] }, "reg_h8");
      if (u === "/hims/cases") {
        await pending;
        return ok({ configurationStatus: "configured", items: [] }, "hims_h8_pending");
      }
      const err: any = new Error(`bad:${String(url)}`);
      err.status = 404;
      throw err;
    });
    const mod = await import("@/pages/app/hims/index");
    const Page: any = (mod as any).default ?? mod;
    render(wrap(Page as React.FC)());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/HIMS \/ eSPA Tracker/i);
    expect(body).toMatch(/Loading HIMS tracker/i);
    expect(body.trim().length).toBeGreaterThan(0);
  });
});
