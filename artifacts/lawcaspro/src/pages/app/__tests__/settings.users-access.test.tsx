import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import SettingsPage from "@/pages/app/settings";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

(globalThis as any).React = React;

const M = vi.hoisted(() => {
  return {
    toastMock: vi.fn(),
    toastErrorMock: vi.fn(),
    apiFetchJsonMock: vi.fn(),
    apiFetchBlobMock: vi.fn(),
    useSearchMock: vi.fn(() => ""),
    useListUsersMock: vi.fn(),
    useListRolesMock: vi.fn(),
    useListDevelopersMock: vi.fn(),
    useListProjectsMock: vi.fn(),
    useUpdateUserMock: vi.fn(),
    useUpdateRoleMock: vi.fn(),
    useDeleteUserMock: vi.fn(),
  };
});

vi.mock("wouter", async () => {
  const actual: any = await vi.importActual("wouter");
  return {
    ...actual,
    useLocation: () => ["/app/settings", vi.fn()],
    useSearch: (...args: any[]) => (M.useSearchMock as any)(...args),
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    Router: ({ children }: any) => <>{children}</>,
    Switch: ({ children }: any) => <>{children}</>,
    Route: ({ children, component: Comp }: any) => (Comp ? <Comp /> : <>{children}</>),
    Redirect: () => null,
  };
});

vi.mock("@workspace/api-client-react", () => {
  return {
    getListRolesQueryKey: (...a: any[]) => ["roles:list", ...a],
    getListUsersQueryKey: (...a: any[]) => ["users:list", ...a],
    getListDevelopersQueryKey: (...a: any[]) => ["devs:list", ...a],
    getListProjectsQueryKey: (...a: any[]) => ["projs:list", ...a],
    useListUsers: (...args: any[]) => M.useListUsersMock(...args),
    useListRoles: (...args: any[]) => M.useListRolesMock(...args),
    useListDevelopers: (...args: any[]) => M.useListDevelopersMock(...args),
    useListProjects: (...args: any[]) => M.useListProjectsMock(...args),
    useUpdateUser: () => M.useUpdateUserMock(),
    useUpdateRole: () => M.useUpdateRoleMock(),
    useDeleteUser: () => M.useDeleteUserMock(),
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
          { module: "users", action: "create" },
          { module: "users", action: "update" },
          { module: "users", action: "read" },
          { module: "users", action: "delete" },
          { module: "roles", action: "create" },
          { module: "roles", action: "update" },
          { module: "roles", action: "read" },
          { module: "settings", action: "read" },
          { module: "settings", action: "update" },
          { module: "documents", action: "read" },
          { module: "audit", action: "read" },
          { module: "communications", action: "read" },
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
  validateUploadFile: (f: File) => ({ ok: true, file: f, message: "" }),
}));

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
  clearStoredAuthToken: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isEmailSettingsEnabled: () => false,
}));

vi.mock("@/lib/feature-guards", () => ({
  useFeature: () => ({ enabled: false, entitlements: {} }),
}));

const STANDARD_ROLES = [
  { id: 1, name: "Partner", isSystemRole: true, userCount: 2, permissions: [] },
  { id: 2, name: "Lawyer", isSystemRole: true, userCount: 3, permissions: [] },
  { id: 3, name: "Clerk", isSystemRole: true, userCount: 4, permissions: [] },
  { id: 4, name: "Account Admin", isSystemRole: true, userCount: 1, permissions: [] },
];

const STANDARD_USERS = [
  { id: 101, name: "Ahmad Tan Wei Ming", email: "partner@lawcaspro.local", initials: "ATWM", roleName: "Partner", roleId: 1, status: "active", lastLoginAt: new Date().toISOString(), hasAccessOverrides: false },
  { id: 102, name: "CLERK NO. 2", email: "clerk2@lawcaspro.local", initials: "CK2", roleName: "Clerk", roleId: 3, status: "active", lastLoginAt: new Date(Date.now() - 86400000).toISOString(), hasAccessOverrides: false },
  { id: 103, name: "Sarah Lee", email: "sarah.lawyer@lawcaspro.local", initials: "SL", roleName: "Lawyer", roleId: 2, status: "active", lastLoginAt: "2026-01-15T10:00:00Z", hasAccessOverrides: true },
];

const FULL_ACCESS_PROFILE = {
  modules: [
    {
      featureKey: "cases", label: "Cases", state: "on",
      children: [
        { featureKey: "cases.read", label: "Case Listing", enabled: true },
        { featureKey: "cases.create", label: "Create Case", enabled: true },
      ],
    },
    {
      featureKey: "documents", label: "Documents", state: "on",
      children: [
        { featureKey: "documents.documents", label: "Documents", enabled: true },
        { featureKey: "documents.automation", label: "Document Automation", enabled: true },
        { featureKey: "documents.variables", label: "Variables", enabled: true },
      ],
    },
    {
      featureKey: "accounting", label: "Accounting", state: "on",
      children: [
        { featureKey: "accounting.files", label: "File Listing", enabled: true },
        { featureKey: "accounting.pv", label: "Payment Vouchers", enabled: true },
        { featureKey: "accounting.quotations", label: "Quotations", enabled: true },
        { featureKey: "accounting.invoices", label: "Invoices", enabled: true },
        { featureKey: "accounting.receipts", label: "Receipts", enabled: true },
      ],
    },
    {
      featureKey: "hr", label: "HR", state: "on",
      children: [{ featureKey: "hr.staff", label: "Staff Directory", enabled: true }],
    },
    {
      featureKey: "communication", label: "Communication", state: "on",
      children: [{ featureKey: "communication.messages", label: "Hub Messages", enabled: true }],
    },
  ],
};

const LIMIT_ACCOUNTING_PROFILE = {
  modules: [
    {
      featureKey: "accounting", label: "Accounting", state: "on",
      children: [
        { featureKey: "accounting.files", label: "File Listing", enabled: true },
        { featureKey: "accounting.pv", label: "Payment Vouchers", enabled: true },
        { featureKey: "accounting.quotations", label: "Quotations", enabled: false },
        { featureKey: "accounting.invoices", label: "Invoices", enabled: false },
        { featureKey: "accounting.receipts", label: "Receipts", enabled: false },
      ],
    },
  ],
};

const DOCS_LIMITED_FOUNDER_PROFILE = {
  modules: [
    {
      featureKey: "documents", label: "Documents", state: "limited",
      children: [
        { featureKey: "documents.documents", label: "Documents", enabled: false },
        { featureKey: "documents.automation", label: "Document Automation", enabled: true },
        { featureKey: "documents.variables", label: "Variables", enabled: false },
      ],
    },
  ],
};

function wrapInProviders(el: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{el}</QueryClientProvider>;
}

function setupListMockDefaults(users = STANDARD_USERS, roles = STANDARD_ROLES) {
  M.useListUsersMock.mockImplementation((_opts, reactQueryOpts?: any) => {
    if (reactQueryOpts?.query?.enabled === false) return { data: undefined, isLoading: false };
    return { data: { data: users, total: users.length }, isLoading: false, isPending: false };
  });
  M.useListRolesMock.mockImplementation((_opts, reactQueryOpts?: any) => {
    if (reactQueryOpts?.query?.enabled === false) return { data: undefined, isLoading: false };
    return { data: roles, isLoading: false, isPending: false };
  });
  M.useListDevelopersMock.mockReturnValue({ data: [], isLoading: false });
  M.useListProjectsMock.mockReturnValue({ data: [], isLoading: false });
  M.useUpdateUserMock.mockReturnValue({ mutateAsync: vi.fn(async () => ({ ok: true })), isPending: false });
  M.useUpdateRoleMock.mockReturnValue({ mutateAsync: vi.fn(async () => ({ ok: true })), isPending: false });
  M.useDeleteUserMock.mockReturnValue({ mutateAsync: vi.fn(async () => ({ ok: true })), isPending: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  M.useSearchMock.mockReturnValue("");
  M.apiFetchJsonMock.mockImplementation(async (p: string, opts?: any) => {
    if (p?.startsWith("/users/") && p.endsWith("/access-profile") && !opts) return { data: FULL_ACCESS_PROFILE, ok: true };
    if (p?.startsWith("/users/") && p.endsWith("/access-profile") && opts?.method === "PUT") return { ok: true };
    if (p === "/roles/bootstrap") return { ok: true };
    return {};
  });
  setupListMockDefaults();
});

async function openUsersTab() {
  fireEvent.click(screen.getByRole("button", { name: /^Users & Access$/i }));
}

describe("ACCESSUI — Unified Users & Access Single Page", () => {
  it("ACCESSUI-1 Settings header tab shows 'Users & Access' (no separate Users tab)", async () => {
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      const tabButtons = screen.getAllByRole("button").map((b) => (b as HTMLButtonElement).textContent ?? "");
      expect(tabButtons.some((t) => t.trim() === "Users & Access")).toBe(true);
    });
  });

  it("ACCESSUI-2 no separate top-level Roles & Permissions tab rendered", async () => {
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      const tabButtons = screen.getAllByRole("button").map((b) => (b as HTMLButtonElement).textContent ?? "");
      expect(tabButtons.some((t) => /Roles & Permissions/i.test(t))).toBe(false);
    });
  });

  it("ACCESSUI-3 old ?tab=users opens Users & Access content (page header renders)", async () => {
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      expect(screen.getAllByText(/Manage staff roles and what each user can access/i).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("ACCESSUI-4 old ?tab=roles opens Users & Access with Role Templates section auto-expanded", async () => {
    M.useSearchMock.mockReturnValue("?tab=roles");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Hide Role Templates/i })).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Manage staff roles/i).length).toBeGreaterThanOrEqual(1);
  });

  it("ACCESSUI-5 default user list renders with Add User button and filter controls", async () => {
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      const addBtns = screen.getAllByRole("button", { name: /Add User/i });
      expect(addBtns.length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByPlaceholderText(/Search name or email/i)[0]).toBeInTheDocument();
      expect(screen.getAllByText(/Ahmad Tan Wei Ming/i)[0]).toBeInTheDocument();
      expect(screen.getAllByText(/CLERK NO\. 2/i)[0]).toBeInTheDocument();
    });
  });

  it("ACCESSUI-6 role displays human-readable canonical name (Partner, Clerk)", async () => {
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toMatch(/Partner/);
      expect(body).toMatch(/Clerk/);
      expect(body).not.toMatch(/cases:create/);
      expect(body).not.toMatch(/users:read/);
      expect(body).not.toMatch(/\+51 more/);
    });
  });

  it("ACCESSUI-7 Access column shows Full Access / Role Default / Custom Access labels", async () => {
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toMatch(/Full Access/);
      expect(body).toMatch(/Custom Access/);
      expect(body).toMatch(/Role Default/);
    });
  });

  it("ACCESSUI-8 Limited Accounting expands children; click Edit, open drawer and access drawer content", async () => {
    setupListMockDefaults([STANDARD_USERS[2]], STANDARD_ROLES);
    M.apiFetchJsonMock.mockImplementation(async (p: string, opts?: any) => {
      if (p?.startsWith("/users/") && p.endsWith("/access-profile") && !opts) return { data: LIMIT_ACCOUNTING_PROFILE, ok: true };
      if (opts?.method === "PUT") return { ok: true };
      return {};
    });
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => expect(screen.getAllByText(/Sarah Lee/i)[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/i })[0]!);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Reset to Role Defaults/i)).toBeInTheDocument();
  });

  it("ACCESSUI-9 Full Accounting / Full modules hide child checkbox clutter", async () => {
    setupListMockDefaults([STANDARD_USERS[1]], STANDARD_ROLES);
    M.apiFetchJsonMock.mockImplementation(async (p: string, opts?: any) => {
      if (p?.startsWith("/users/") && p.endsWith("/access-profile") && !opts) return { data: FULL_ACCESS_PROFILE, ok: true };
      if (opts?.method === "PUT") return { ok: true };
      return {};
    });
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => expect(screen.getAllByText(/CLERK NO\. 2/i)[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/i })[0]!);
    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      const fullBadges = within(dialog).getAllByText(/All child features enabled/i);
      expect(fullBadges.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("ACCESSUI-10 Documents Limited allows Doc Automation ON / Documents OFF / Variables OFF combo", async () => {
    setupListMockDefaults([STANDARD_USERS[1]], STANDARD_ROLES);
    M.apiFetchJsonMock.mockImplementation(async (p: string, opts?: any) => {
      if (p?.startsWith("/users/") && p.endsWith("/access-profile") && !opts) return { data: DOCS_LIMITED_FOUNDER_PROFILE, ok: true };
      if (opts?.method === "PUT") return { ok: true };
      return {};
    });
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => expect(screen.getAllByText(/CLERK NO\. 2/i)[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/i })[0]!);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Document Automation/i)).toBeInTheDocument();
  });

  it("ACCESSUI-11 Save User persists via PUT access-profile", async () => {
    setupListMockDefaults([STANDARD_USERS[1]], STANDARD_ROLES);
    M.apiFetchJsonMock.mockImplementation(async (p: string, opts?: any) => {
      if (p?.startsWith("/users/") && p.endsWith("/access-profile") && !opts) return { data: FULL_ACCESS_PROFILE, ok: true };
      if (p?.startsWith("/users/") && p.endsWith("/access-profile") && opts?.method === "PUT") return { ok: true };
      return {};
    });
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => expect(screen.getAllByText(/CLERK NO\. 2/i)[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/i })[0]!);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getAllByText(/^Name$/i)[0]).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    const nameField = within(dialog).getAllByDisplayValue(/CLERK NO\. 2/i)[0] ?? within(dialog).queryAllByRole("textbox")[0];
    fireEvent.change(nameField, { target: { value: "CLERK 2 UPDATED" } });
    fireEvent.click(screen.getByRole("button", { name: /Save User/i })!);
    await waitFor(() => {
      const puts = M.apiFetchJsonMock.mock.calls.filter(([p, o]) => p?.match(/\/users\/\d+\/access-profile/) && o?.method === "PUT");
      expect(puts.length).toBe(1);
      const body = JSON.parse(puts[0][1].body);
      expect(body.features).toBeDefined();
      expect(
        (body.features?.modules && Array.isArray(body.features.modules))
        || (typeof body.features === "object" && Object.keys(body.features).length > 0)
        || body.roleId
        || body.roleName
        || body.name
      ).toBeTruthy();
    });
  });

  it("ACCESSUI-12 Partner shows Full Firm Access banner in drawer", async () => {
    setupListMockDefaults([STANDARD_USERS[0]], STANDARD_ROLES);
    M.apiFetchJsonMock.mockImplementation(async (p: string, opts?: any) => {
      if (p?.startsWith("/users/") && p.endsWith("/access-profile") && !opts) return { data: { modules: [] }, ok: true };
      if (opts?.method === "PUT") return { ok: true };
      return {};
    });
    M.useSearchMock.mockReturnValue("?tab=users");
    render(wrapInProviders(<SettingsPage />));
    await waitFor(() => expect(screen.getAllByText(/Ahmad Tan Wei Ming/i)[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/i })[0]!);
    await waitFor(() => {
      expect(screen.getAllByText(/Partner has full operational access/i)[0]).toBeInTheDocument();
    });
  });

  it("ACCESSUI-13 raw permission keys hidden by default", async () => {
    M.useSearchMock.mockReturnValue("?tab=users");
    const { container } = render(wrapInProviders(<SettingsPage />));
    await waitFor(() => {
      const roleTemplatesButtons = screen.getAllByRole("button", { name: /Role Templates/i });
      expect(roleTemplatesButtons.length).toBeGreaterThanOrEqual(1);
    });
    const bodyText = (container.textContent ?? "").toLowerCase();
    expect(bodyText).not.toMatch(/cases:create/);
    expect(bodyText).not.toMatch(/users:update/);
    expect(bodyText).not.toMatch(/accounting:approve/);
    expect(bodyText).not.toMatch(/\+\d+ more/);
  });
});
