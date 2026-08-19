import React from "react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import { AuthProvider } from "@/lib/auth-context";
import { useEffectiveUserFeaturesMap } from "@/lib/feature-guards";
import { SidebarBody } from "@/components/layout/sidebar-body";
import { ME_QUERY_KEY, userPermissionsQueryKey, effectiveFeaturesQueryKey } from "@/lib/query-keys";

type EffectiveUserFeaturesMap = ReturnType<typeof useEffectiveUserFeaturesMap>;

vi.mock("@/lib/feature-guards", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/feature-guards");
  return {
    ...actual,
    useEffectiveUserFeaturesMap: () => {
      return (globalThis as any).__lawcaspro_hr_test_features ?? actual.buildFeaturesPlaceholder;
    },
  };
});

vi.mock("@/hooks/use-notification-counts", () => ({
  useNotificationCounts: () => ({ workUnread: 0, notifUnread: 0, monitorCount: 0, urgentCount: 0, overdueCount: 0, escalatedCount: 0 }),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetchJson: vi.fn(async () => ({ count: 0 })),
  apiRequest: vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}) })),
}));

vi.mock("wouter", () => {
  return {
    useLocation: () => ["/app", vi.fn()],
    Link: ({ children, href }: any) =>
      React.createElement(
        "a",
        { "data-testid": `sidebar-link-${String(href).replace(/[^a-z0-9]+/gi, "-")}`, href },
        children
      ),
  };
});

vi.mock("lucide-react", () => {
  const ICON_NAMES_INLINE = [
    "LayoutDashboard","ListTodo","Briefcase","Building2","HardHat","MessageSquare","Calculator","BarChart",
    "ScrollText","Settings","FileText","Bell","LogOut","ChevronDown","ChevronRight","AlertTriangle","Clock",
    "ArrowUpRight","Flag","UserCog","Users","Shield","FileSpreadsheet","Mail","Calendar","PlaneTakeoff",
    "FileKey","WalletCards",
  ];
  const m: Record<string, any> = {};
  for (const n of ICON_NAMES_INLINE) {
    m[n] = (props: any) => React.createElement("span", { "data-icon": n, ...props });
  }
  return m;
});
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children }: any) => React.createElement("span", { "data-testid": "ui-badge" }, children) }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: any) =>
    React.createElement("button", { "data-testid": "ui-button", onClick }, children),
}));

type FeaturesSpec = {
  moduleHr?: boolean;
  hrEnabled?: boolean;
  hrDashboard?: boolean;
  hrEmployees?: boolean;
  hrAttendance?: boolean;
  hrLeave?: boolean;
  hrClaims?: boolean;
  hrPayroll?: boolean;
  hrSelfService?: boolean;
  docsHub?: boolean;
  docsVars?: boolean;
  accountingDashboard?: boolean;
  communicationsEmail?: boolean;
};

function buildFeatures(spec: FeaturesSpec): EffectiveUserFeaturesMap {
  const entries: Array<[string, boolean]> = [
    ["module.hr", spec.moduleHr ?? true],
    ["documents.hub", spec.docsHub ?? false],
    ["documents.variables", spec.docsVars ?? false],
    ["accounting.dashboard", spec.accountingDashboard ?? false],
    ["communications.email", spec.communicationsEmail ?? false],
    ["hr.self_service", spec.hrSelfService ?? true],
  ];
  const parentModuleHrOn = (spec.moduleHr ?? true) !== false;
  const hrChildrenOn = spec.hrEnabled !== false && parentModuleHrOn;
  if (hrChildrenOn) {
    entries.push(["hr.dashboard", spec.hrDashboard ?? true]);
    entries.push(["hr.employees", spec.hrEmployees ?? true]);
    entries.push(["hr.attendance", spec.hrAttendance ?? true]);
    entries.push(["hr.leave", spec.hrLeave ?? true]);
    entries.push(["hr.claims", spec.hrClaims ?? true]);
    entries.push(["hr.payroll", spec.hrPayroll ?? true]);
  } else {
    entries.push(["hr.dashboard", false]);
    entries.push(["hr.employees", false]);
    entries.push(["hr.attendance", false]);
    entries.push(["hr.leave", false]);
    entries.push(["hr.claims", false]);
    entries.push(["hr.payroll", false]);
  }
  const map = Object.fromEntries(entries);
  return {
    enabled: (k: string) => (k in map ? !!map[k] : false),
    transientError: false,
    effective: Object.fromEntries(
      entries.map(([k, v]) => [k, { effectiveEnabled: !!v, firmEnabled: !!v, userEnabled: !!v, source: "hr_sidebar_test" }])
    ),
    explicitOverrides: [],
  } as unknown as EffectiveUserFeaturesMap;
}

function makeQc() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 1,
        staleTime: 0,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchInterval: 0,
      },
    },
  });
}

function setFeatures(spec: FeaturesSpec) {
  (globalThis as any).__lawcaspro_hr_test_features = buildFeatures(spec);
}

const HR_DASHBOARD_LINK = "sidebar-link-app-hr-dashboard";
const HR_EMPLOYEES_LINK = "sidebar-link-app-hr-employees";
const HR_ATTENDANCE_LINK = "sidebar-link-app-hr-attendance";
const MY_HR_LINK = "sidebar-link-app-my-dashboard";
// Sidebar only renders navigation items with /app/<something>; we also check via the label text directly as a fallback.
function linkExists(testId: string, labelFallback?: string) {
  try {
    return !!screen.getByTestId(testId);
  } catch {
    if (labelFallback) {
      try {
        return !!screen.getByText(labelFallback);
      } catch {
        return false;
      }
    }
    return false;
  }
}

beforeAll(() => {
  (globalThis as any).__lawcaspro_hr_test_features = null;
  (globalThis as any).React = React;
});

afterEach(() => {
  cleanup();
  (globalThis as any).__lawcaspro_hr_test_features = null;
});

type MinimalAuthUser = {
  id: number;
  firmId: number;
  email: string;
  userType: "firm_user";
  name: string;
  roleId: number;
  roleName: string;
  permissions?: Array<{ module: string; action: string }>;
};

function makeUser(roleName: string, perms: Array<{ module: string; action: string }>, overrides: Partial<MinimalAuthUser> = {}): MinimalAuthUser {
  return {
    id: 1001,
    firmId: 1,
    email: "hrtest@lawcaspro.test",
    userType: "firm_user",
    name: "HR Runtime User",
    roleId: 1,
    roleName,
    permissions: perms,
    ...overrides,
  };
}

function renderAuth(user: MinimalAuthUser | null) {
  const qc = makeQc();
  qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], user);
  if (user) {
    qc.setQueryData(
      userPermissionsQueryKey(user.firmId, user.id) as unknown as readonly unknown[],
      { permissions: user.permissions ?? [] }
    );
    qc.setQueryData(
      effectiveFeaturesQueryKey(user.firmId, user.id) as unknown as readonly unknown[],
      { effective: {}, explicitOverrides: [], transientError: false }
    );
  }
  const providers = React.createElement(
    QueryClientProvider,
    { client: qc },
    React.createElement(AuthProvider, { children: React.createElement(SidebarBody, { isMobile: false }) })
  );
  render(providers);
  return qc;
}

describe("R2A HR SIDEBAR PERMISSION RENDER PROOF (SidebarBody production component)", () => {
  it("HR-1 Partner READY hr:read=true module.hr=true hr.dashboard=true hr.employees=true → HR Dashboard + Employees visible", async () => {
    setFeatures({ moduleHr: true, hrEnabled: true, hrDashboard: true, hrEmployees: true });
    renderAuth(makeUser("Partner", [{ module: "hr", action: "read" }, { module: "dashboard", action: "read" }, { module: "cases", action: "read" }]));
    expect(linkExists(HR_DASHBOARD_LINK, "HR Dashboard")).toBe(true);
    expect(linkExists(HR_EMPLOYEES_LINK, "Employees")).toBe(true);
  });

  it("HR-2 same Partner explicit hr:read=false → HR admin hidden/denied; READY deny defeats Partner fallback", async () => {
    setFeatures({ moduleHr: true, hrEnabled: true, hrDashboard: true, hrEmployees: true, hrSelfService: false });
    renderAuth(makeUser("Partner", [], { id: 7702 }));
    expect(linkExists(HR_DASHBOARD_LINK, "HR Dashboard")).toBe(false);
    expect(linkExists(HR_EMPLOYEES_LINK, "Employees")).toBe(false);
    expect(linkExists(MY_HR_LINK, "My HR")).toBe(false);
  });

  it("HR-3 module.hr=false children=true → entire HR admin group hidden", async () => {
    setFeatures({ moduleHr: false, hrEnabled: true, hrDashboard: true, hrEmployees: true, hrSelfService: true });
    renderAuth(makeUser("Partner", [{ module: "hr", action: "read" }, { module: "dashboard", action: "read" }], { id: 7703 }));
    expect(linkExists(HR_DASHBOARD_LINK, "HR Dashboard")).toBe(false);
    expect(linkExists(HR_EMPLOYEES_LINK, "Employees")).toBe(false);
    expect(linkExists(MY_HR_LINK, "My HR")).toBe(false);
  });

  it("HR-4 normal Clerk/Staff HR admin absent, hr.self_service=true → HR admin hidden; My HR visible", async () => {
    setFeatures({ moduleHr: true, hrEnabled: true, hrDashboard: true, hrEmployees: true, hrSelfService: true });
    renderAuth(makeUser("Clerk", [{ module: "cases", action: "read" }, { module: "hr", action: "read" }], { id: 7704, roleName: "Clerk" }));
    expect(linkExists(HR_DASHBOARD_LINK, "HR Dashboard")).toBe(false);
    expect(linkExists(HR_EMPLOYEES_LINK, "Employees")).toBe(false);
    expect(linkExists(MY_HR_LINK, "My HR")).toBe(true);
  });
});
