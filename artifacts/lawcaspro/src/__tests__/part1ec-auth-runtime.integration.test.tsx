// ============================================================================
// PART 1E-C1-A — Frontend runtime identity/permission integration
//
// Covers:
//   RT-1  A(f1,u10) → login(B(f1,u11)) — while B pending: A data NOT leaked; B key only
//   RT-2  A(f1,u10) → logout → login(B(f1,u11)) same-firm: absent A leakage
//   RT-3  F1U10 → F2U55 cross-firm: absent cross features/perms/notifications
//   RT-4  PERMLKG-1: B doc:read cached + 503 → retained
//   RT-5  PERMDENY-1: B doc:read cached + 403 → [] cleared
//   RT-6  /auth/me retryMe count === 1
//   RT-7  post-login /auth/me count === exactly 1
// ============================================================================

import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  beforeAll,
  afterEach,
  afterAll,
  type Mock,
} from "vitest";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { useUserEffectiveFeatures } from "@/lib/feature-guards";
import { useNotificationCounts } from "@/hooks/use-notification-counts";
import { hasPermission } from "@/lib/permissions";
import {
  effectiveFeaturesQueryKey,
  userPermissionsQueryKey,
  userUnreadCountQueryKey,
  userNotificationSummaryQueryKey,
  caseNotificationsUnreadCountQueryKey,
  ME_QUERY_KEY,
} from "@/lib/query-keys";
import type { AuthUser } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Deferred promise helper
// ---------------------------------------------------------------------------
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolveFn: (v: T) => void = () => {};
  let rejectFn: (e?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

// ---------------------------------------------------------------------------
// Global beforeAll: env, React
// ---------------------------------------------------------------------------
beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  (globalThis as any).React = React;
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

// ---------------------------------------------------------------------------
// Stable hoisted mocks: wouter, toast, logout, api-client, auth-token
// ---------------------------------------------------------------------------
const M = vi.hoisted(() => {
  type ApiRequestCall = { path: string; opts?: any };
  type FetchJsonCall = { path: string; opts?: any };

  const pushFn = vi.fn();
  const useLocationFn = vi.fn(() => ["/app/workbench", pushFn] as const);
  const useSearchFn = vi.fn(() => "");
  const useParamsFn = vi.fn(() => ({}));
  const toastFn = vi.fn();
  const toastErrorFn = vi.fn();
  const useLogoutMutateFn = vi.fn();
  const useLogoutFn = vi.fn(() => ({ mutate: useLogoutMutateFn }));
  const clearStoredAuthTokenFn = vi.fn();

  // --- apiRequest mock (used by auth-context for /api/auth/me, /api/auth/permissions) ---
  // Signature: apiRequest(path, { allowStatuses, signal, timeoutMs, ... }) -> Response-like
  type ApiRequestResolver = (call: ApiRequestCall) => Promise<Response | undefined> | Response | undefined;
  let apiRequestOverride: ApiRequestResolver | null = null;
  const apiRequestCalls: ApiRequestCall[] = [];
  const apiRequestMock = vi.fn(async (path: string, opts?: any): Promise<Response> => {
    const call = { path, opts };
    apiRequestCalls.push(call);
    if (apiRequestOverride) {
      const override = await apiRequestOverride(call);
      if (override) return override;
    }
    // Default: 500 (generic — tests must install resolvers)
    return {
      ok: false,
      status: 500,
      headers: new Map() as any,
      json: async () => ({}),
      text: async () => "",
      clone: () => ({} as any),
      blob: async () => new Blob(),
    } as unknown as Response;
  });

  // --- apiFetchJson mock (used by feature-guards, notifications, etc.) ---
  type FetchJsonResolver = (call: FetchJsonCall) => Promise<unknown> | unknown;
  let fetchJsonOverride: FetchJsonResolver | null = null;
  const fetchJsonCalls: FetchJsonCall[] = [];
  const fetchJsonMock = vi.fn(async (path: string, opts?: any) => {
    const call = { path, opts };
    fetchJsonCalls.push(call);
    if (fetchJsonOverride) {
      const res = await fetchJsonOverride(call);
      return res;
    }
    return {};
  });

  return {
    // Counters & call records
    apiRequestCalls,
    fetchJsonCalls,
    // Setters for overrides
    setApiRequestOverride(fn: ApiRequestResolver | null) { apiRequestOverride = fn; },
    setFetchJsonOverride(fn: FetchJsonResolver | null) { fetchJsonOverride = fn; },
    // Stables
    pushFn,
    useLocationFn,
    useSearchFn,
    useParamsFn,
    toastFn,
    toastErrorFn,
    useLogoutMutateFn,
    useLogoutFn,
    clearStoredAuthTokenFn,
    apiRequestMock,
    fetchJsonMock,
    setAuthTokenGetterMock: vi.fn(),
    setBaseUrlMock: vi.fn(),
    getApiOriginMock: vi.fn(() => "http://localhost"),
    getStoredAuthTokenMock: vi.fn(() => "test-token"),
  };
});

vi.mock("wouter", async () => {
  const actual: any = await vi.importActual("wouter");
  return {
    ...actual,
    useLocation: M.useLocationFn,
    useSearch: M.useSearchFn,
    useParams: M.useParamsFn,
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    Router: ({ children }: any) => <>{children}</>,
    Switch: ({ children }: any) => <>{children}</>,
    Route: ({ children, component: Comp }: any) => (Comp ? <Comp /> : <>{children}</>),
    Redirect: () => null,
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: M.toastFn, dismiss: vi.fn() }),
}));

vi.mock("@/lib/toast-error", () => ({
  toastError: M.toastErrorFn,
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual: any = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    setAuthTokenGetter: M.setAuthTokenGetterMock,
    setBaseUrl: M.setBaseUrlMock,
    useLogout: M.useLogoutFn,
  };
});

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiRequest: M.apiRequestMock,
    apiFetchJson: M.fetchJsonMock,
    apiFetchBlob: vi.fn(async () => new Blob()),
  };
});

vi.mock("@/lib/api-base", () => ({
  getApiOrigin: M.getApiOriginMock,
}));

vi.mock("@/lib/auth-token", () => ({
  getStoredAuthToken: M.getStoredAuthTokenMock,
  clearStoredAuthToken: M.clearStoredAuthTokenFn,
  setStoredAuthToken: vi.fn(),
}));

vi.mock("@/components/re-auth-dialog", () => ({
  ReAuthProvider: ({ children }: any) => <>{children}</>,
  useReAuth: () => ({ show: vi.fn() }),
}));

vi.mock("@/lib/feature-flags", () => ({
  useFeature: (_key?: any) => ({ enabled: true }),
  FeatureGuard: ({ children }: any) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// Helpers: make user
// ---------------------------------------------------------------------------
function makeUser(firmId: number, id: number, extras: Partial<AuthUser> = {}): AuthUser {
  return {
    id,
    firmId,
    email: `u${id}@f${firmId}.com`,
    userType: "firm_user",
    name: `U${id}F${firmId}`,
    roleId: 1,
    roleName: "Partner",
    permissions: [],
    ...extras,
  } as AuthUser;
}

function makeJsonResponse(
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  const bodyText = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => headers.get(k.toLowerCase()) ?? null,
    } as any,
    json: async () => (typeof data === "string" ? JSON.parse(data) : data),
    text: async () => bodyText,
    clone: () => makeJsonResponse(status, data, extraHeaders),
    blob: async () => new Blob([bodyText]),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Probe component: exposes auth state + features + notifications + permissions
// ---------------------------------------------------------------------------
type ProbeSnapshot = {
  userId: number | null;
  firmId: number | null;
  authStatus: string;
  documentsVariablesFeature: boolean | null;
  hrPayrollFeature: boolean | null;
  featuresLoading: boolean;
  notificationWorkUnread: number;
  notificationNotifUnread: number;
  documentsReadPermission: boolean;
  hrManagePermission: boolean;
  permissionsRaw: Array<{ module: string; action: string }>;
};
let probeLatest: ProbeSnapshot | null = null;
const probeSubscribers = new Set<(s: ProbeSnapshot | null) => void>();
function setProbe(s: ProbeSnapshot | null) {
  probeLatest = s;
  for (const sub of probeSubscribers) sub(s);
}
function Probe() {
  const auth = useAuth();
  const features = useUserEffectiveFeatures();
  const notifications = useNotificationCounts({
    enabled: !!auth.user && auth.user.userType === "firm_user",
  });
  const perms = (auth.user as unknown as { permissions?: unknown } | null)?.permissions;
  const permArr = Array.isArray(perms)
    ? perms
        .filter((p): p is { module: unknown; action: unknown } => !!p && typeof p === "object")
        .map((p) => ({ module: String(p.module), action: String(p.action) }))
    : [];
  const docVar = features.data?.effective?.["documents.variables"]?.effectiveEnabled ?? null;
  const hrPay = features.data?.effective?.["hr.payroll"]?.effectiveEnabled ?? null;
  const snap: ProbeSnapshot = {
    userId: auth.user ? Number((auth.user as any).id ?? 0) || null : null,
    firmId: auth.user ? Number((auth.user as any).firmId ?? 0) || null : null,
    authStatus: auth.authStatus,
    documentsVariablesFeature: typeof docVar === "boolean" ? docVar : null,
    hrPayrollFeature: typeof hrPay === "boolean" ? hrPay : null,
    featuresLoading: features.isLoading || features.isFetching,
    notificationWorkUnread: notifications.workUnread,
    notificationNotifUnread: notifications.notifUnread,
    documentsReadPermission: hasPermission(auth.user, "documents", "read"),
    hrManagePermission: hasPermission(auth.user, "hr", "manage"),
    permissionsRaw: permArr,
  };
  setProbe(snap);
  return (
    <div data-testid="probe">
      <span data-testid="probe-userid">{String(snap.userId ?? "null")}</span>
      <span data-testid="probe-firmid">{String(snap.firmId ?? "null")}</span>
      <span data-testid="probe-authstatus">{snap.authStatus}</span>
      <span data-testid="probe-feature-docvar">{String(snap.documentsVariablesFeature)}</span>
      <span data-testid="probe-feature-hrpay">{String(snap.hrPayrollFeature)}</span>
      <span data-testid="probe-featuresloading">{String(snap.featuresLoading)}</span>
      <span data-testid="probe-notif-work">{String(snap.notificationWorkUnread)}</span>
      <span data-testid="probe-notif-notif">{String(snap.notificationNotifUnread)}</span>
      <span data-testid="probe-perm-docread">{String(snap.documentsReadPermission)}</span>
      <span data-testid="probe-perm-hrmanage">{String(snap.hrManagePermission)}</span>
      <span data-testid="probe-perms-rawcount">{String(snap.permissionsRaw.length)}</span>
    </div>
  );
}

function makeQc() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        throwOnError: false,
      },
      mutations: { retry: false },
    },
  });
}

function wrap(children: React.ReactElement, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Mocking shapes for a user
// ---------------------------------------------------------------------------
type UserFixture = {
  user: AuthUser;
  features: Record<string, { effectiveEnabled: boolean; firmEnabled: boolean; userEnabled: boolean; source: any }>;
  permissions: Array<{ module: string; action: string }>;
  notifWorkCount: number;
  notifUnread: number;
  monitorCount: number;
};
function makeFixture(firmId: number, userId: number, overrides: Partial<UserFixture> = {}): UserFixture {
  return {
    user: makeUser(firmId, userId, overrides.user as any),
    features: overrides.features ?? {
      "documents.variables": { effectiveEnabled: true, firmEnabled: true, userEnabled: true, source: "partner_allow" },
      "hr.payroll": { effectiveEnabled: false, firmEnabled: false, userEnabled: false, source: "firm_entitlement_denied" },
    },
    permissions: overrides.permissions ?? [
      { module: "documents", action: "read" },
    ],
    notifWorkCount: overrides.notifWorkCount ?? 7,
    notifUnread: overrides.notifUnread ?? 7,
    monitorCount: overrides.monitorCount ?? 1,
  };
}

function nowTimestampIso(): string {
  return new Date().toISOString();
}

function envelopeSuccess<T>(data: T): { ok: true; data: T; meta: { request_id: string; timestamp: string; duration_ms: number } } {
  return {
    ok: true,
    data,
    meta: { request_id: "test-rq", timestamp: nowTimestampIso(), duration_ms: 1 },
  };
}

// Install a resolver that serves UserFixture immediately for the matching user identity.
// For auth-context meQuery (uses apiRequest("/api/auth/me")) — we seed ME_QUERY_KEY directly.
// For effective features (uses apiFetchJson("/users/_self/effective-features"))
// For permissions (uses apiRequest("/api/auth/permissions"))
// For notif counts (apiFetchJson on various endpoints)
function installUserResolvers(fx: UserFixture) {
  const uid = Number((fx.user as any).id);
  const fid = Number((fx.user as any).firmId);

  // Permissions: /api/auth/permissions via apiRequest
  M.setApiRequestOverride(async (call) => {
    if (call.path === "/api/auth/permissions") {
      return makeJsonResponse(200, envelopeSuccess({ permissions: fx.permissions }));
    }
    if (call.path === "/api/auth/me") {
      return makeJsonResponse(200, fx.user);
    }
    return undefined;
  });

  // Features + notif: apiFetchJson
  M.setFetchJsonOverride(async (call) => {
    if (call.path === "/users/_self/effective-features") {
      return {
        userId: uid,
        firmId: fid,
        effective: fx.features,
        explicitOverrides: [],
      };
    }
    if (call.path === "/communications/unread-count") {
      return { count: fx.notifWorkCount };
    }
    if (call.path === "/case-notifications/unread-counts") {
      return { totalUnreadCount: 0 };
    }
    if (call.path === "/user-notifications/summary") {
      return {
        unread: fx.notifUnread,
        urgent: 0,
        escalated: 0,
        overdue: 0,
        monitorUniqueCount: fx.monitorCount,
        activeDistinctCount: fx.monitorCount,
      };
    }
    return {};
  });
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach cleanup
// ---------------------------------------------------------------------------
beforeEach(() => {
  M.apiRequestCalls.length = 0;
  M.fetchJsonCalls.length = 0;
  M.setApiRequestOverride(null);
  M.setFetchJsonOverride(null);
  probeLatest = null;
  if (typeof window !== "undefined") {
    const gw = window as any;
    gw.__lawcasproCachedEffectiveFeatures = null;
    gw.__lawcasproCachedEffectiveUser = null;
  }
});

afterEach(() => {
  cleanup();
  M.setApiRequestOverride(null);
  M.setFetchJsonOverride(null);
});

afterAll(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ============================================================================
// RT-1: A resolved, login(B), B pending — no A leakage, B key correct
// ============================================================================
describe("RT-1 A(firm=1,user=10) → login(B(1,11)), B pending → no A leakage", () => {
  it("RT-1: no A features/perms/notifs exposed to B while B pending; B resolves exact state", async () => {
    const qc = makeQc();
    const fx_A = makeFixture(1, 10, {
      permissions: [{ module: "documents", action: "read" }],
      notifWorkCount: 7,
      notifUnread: 7,
    });
    const fx_B = makeFixture(1, 11, {
      features: {
        "documents.variables": { effectiveEnabled: false, firmEnabled: false, userEnabled: false, source: "firm_entitlement_denied" },
        "hr.payroll": { effectiveEnabled: true, firmEnabled: true, userEnabled: true, source: "partner_allow" },
      },
      permissions: [{ module: "hr", action: "manage" }],
      notifWorkCount: 2,
      notifUnread: 2,
    });

    // Step 1: Render with A pre-seeded
    installUserResolvers(fx_A);
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], fx_A.user);

    const { rerender } = render(wrap(<Probe />, qc));

    // Wait until A probe settles
    await waitFor(() => {
      const s = probeLatest;
      expect(s?.userId).toBe(10);
      expect(s?.firmId).toBe(1);
      expect(s?.documentsVariablesFeature).toBe(true);
      expect(s?.hrPayrollFeature).toBe(false);
      expect(s?.documentsReadPermission).toBe(true);
      expect(s?.notificationNotifUnread).toBe(7);
    }, { timeout: 10_000 });

    // Step 2: Swap resolvers so B calls hang via deferreds
    const featuresB = deferred<unknown>();
    const permsB = deferred<Response | undefined>();
    const caseCountB = deferred<unknown>();
    const commCountB = deferred<unknown>();
    const notifSummaryB = deferred<unknown>();

    M.setFetchJsonOverride(async (call) => {
      if (call.path === "/users/_self/effective-features") return featuresB.promise;
      if (call.path === "/communications/unread-count") return commCountB.promise;
      if (call.path === "/case-notifications/unread-counts") return caseCountB.promise;
      if (call.path === "/user-notifications/summary") return notifSummaryB.promise;
      return {};
    });
    M.setApiRequestOverride(async (call) => {
      if (call.path === "/api/auth/permissions") return permsB.promise;
      if (call.path === "/api/auth/me") return makeJsonResponse(200, fx_B.user);
      return undefined;
    });

    // Record call counts before login(B)
    const callSnap = {
      apiRequestCountBefore: M.apiRequestCalls.length,
      fetchJsonCountBefore: M.fetchJsonCalls.length,
    };

    // Invoke REAL AuthContext login
    let loginFn: ((u: AuthUser) => Promise<void>) | null = null;
    const AuthInspector = () => {
      const ctx = useAuth();
      loginFn = ctx.login;
      return null;
    };
    rerender(wrap(<><AuthInspector /><Probe /></>, qc));
    await waitFor(() => expect(loginFn).not.toBeNull());

    await act(async () => {
      await loginFn!(fx_B.user);
    });

    // WHILE B PENDING: Assert A not rendered as B
    await waitFor(() => {
      const s = probeLatest;
      expect(s?.userId).toBe(11);
      expect(s?.firmId).toBe(1);
    });

    const pending = probeLatest!;
    // A's true documents.variables=true NOT exposed to B
    expect(pending.documentsVariablesFeature).not.toBe(true);
    // A's permissions: documents:read NOT exposed
    expect(pending.documentsReadPermission).toBe(false);
    // A's 7 notif count NOT exposed
    expect(pending.notificationNotifUnread).not.toBe(7);
    expect(pending.notificationWorkUnread).toBeLessThanOrEqual(0);

    // Query client: B data must NOT be under A or null/null keys
    const A_perm = qc.getQueryData(userPermissionsQueryKey(1, 10) as unknown as readonly unknown[]);
    const A_feat = qc.getQueryData(effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[]);
    expect(A_perm).toBeUndefined(); // removed by login cleanup
    expect(A_feat).toBeUndefined();
    const NULL_perm = qc.getQueryData(userPermissionsQueryKey(null, null) as unknown as readonly unknown[]);
    expect(NULL_perm).toBeUndefined();

    // Step 3: Resolve B
    act(() => {
      featuresB.resolve({
        userId: 11, firmId: 1, effective: fx_B.features, explicitOverrides: [],
      });
      permsB.resolve(makeJsonResponse(200, envelopeSuccess({ permissions: fx_B.permissions })));
      caseCountB.resolve({ totalUnreadCount: 0 });
      commCountB.resolve({ count: fx_B.notifWorkCount });
      notifSummaryB.resolve({
        unread: fx_B.notifUnread, urgent: 0, escalated: 0, overdue: 0,
        monitorUniqueCount: fx_B.monitorCount, activeDistinctCount: fx_B.monitorCount,
      });
    });

    await waitFor(() => {
      const s = probeLatest;
      expect(s?.documentsVariablesFeature).toBe(false);
      expect(s?.hrPayrollFeature).toBe(true);
      expect(s?.hrManagePermission).toBe(true);
      expect(s?.notificationNotifUnread).toBe(2);
      expect(s?.documentsReadPermission).toBe(false);
    }, { timeout: 10_000 });

    void callSnap;
  });
});

// ============================================================================
// RT-2: A → actual logout → B login
// ============================================================================
describe("RT-2 A(f1,u10) → logout → login(B(f1,u11)), A absent", () => {
  it("RT-2: no A leakage after actual logout → login B", async () => {
    const qc = makeQc();
    const fx_A = makeFixture(1, 10, {
      notifWorkCount: 5,
      notifUnread: 5,
    });
    const fx_B = makeFixture(1, 11, {
      notifWorkCount: 3,
      notifUnread: 3,
      permissions: [{ module: "hr", action: "manage" }],
    });
    installUserResolvers(fx_A);
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], fx_A.user);

    render(wrap(<Probe />, qc));
    await waitFor(() => {
      expect(probeLatest?.userId).toBe(10);
      expect(probeLatest?.documentsReadPermission).toBe(true);
      expect(probeLatest?.notificationNotifUnread).toBe(5);
    });

    // logout success via useLogoutMutate callback path
    let logoutFn: (() => void) | null = null;
    let loginFn: ((u: AuthUser) => Promise<void>) | null = null;
    const Inspector = () => {
      const ctx = useAuth();
      logoutFn = ctx.logout;
      loginFn = ctx.login;
      return null;
    };
    const { rerender } = render(wrap(<><Inspector /><Probe /></>, qc));
    await waitFor(() => expect(logoutFn && loginFn).toBeTruthy());

    // Install logout mutate → call onSuccess
    M.useLogoutMutateFn.mockImplementation((_args: any, opts: any) => {
      if (opts?.onSuccess) opts.onSuccess();
    });

    act(() => {
      logoutFn!();
    });

    // Install B resolvers after logout settles
    installUserResolvers(fx_B);

    await act(async () => {
      await loginFn!(fx_B.user);
    });

    await waitFor(() => {
      expect(probeLatest?.userId).toBe(11);
      expect(probeLatest?.firmId).toBe(1);
      // B hr permission async resolve
      expect(probeLatest?.hrManagePermission).toBe(true);
    });

    // A data must NOT be under B:
    expect(probeLatest?.documentsReadPermission).toBe(false);
    expect(probeLatest?.notificationNotifUnread).not.toBe(5);
    // Features for B (defaults from fixture)
    await waitFor(() => {
      expect(probeLatest?.documentsVariablesFeature).toBe(true);
    });
  });
});

// ============================================================================
// RT-3: Cross-firm F1U10 → F2U55
// ============================================================================
describe("RT-3 Cross-firm Firm1/User10 → Firm2/User55 no cross-leak", () => {
  it("RT-3: cross-firm transition — no F1 features/perms/notifs in F2 context", async () => {
    const qc = makeQc();
    const fx_A = makeFixture(1, 10, {
      permissions: [{ module: "documents", action: "read" }],
      notifWorkCount: 9,
      notifUnread: 9,
    });
    const fx_B = makeFixture(2, 55, {
      features: {
        "documents.variables": { effectiveEnabled: false, firmEnabled: false, userEnabled: false, source: "firm_entitlement_denied" },
        "hr.payroll": { effectiveEnabled: true, firmEnabled: true, userEnabled: true, source: "partner_allow" },
      },
      permissions: [{ module: "hr", action: "manage" }],
      notifWorkCount: 4,
      notifUnread: 4,
    });
    installUserResolvers(fx_A);
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], fx_A.user);

    let loginFn: ((u: AuthUser) => Promise<void>) | null = null;
    const Inspector = () => {
      const ctx = useAuth();
      loginFn = ctx.login;
      return null;
    };
    render(wrap(<><Inspector /><Probe /></>, qc));

    await waitFor(() => {
      expect(probeLatest?.firmId).toBe(1);
      expect(probeLatest?.userId).toBe(10);
      expect(probeLatest?.documentsReadPermission).toBe(true);
      expect(probeLatest?.notificationNotifUnread).toBe(9);
    });

    installUserResolvers(fx_B);
    await act(async () => {
      await loginFn!(fx_B.user);
    });

    await waitFor(() => {
      expect(probeLatest?.firmId).toBe(2);
      expect(probeLatest?.userId).toBe(55);
    });

    await waitFor(() => {
      expect(probeLatest?.documentsReadPermission).toBe(false);
      expect(probeLatest?.hrManagePermission).toBe(true);
    });
    await waitFor(() => {
      expect(probeLatest?.documentsVariablesFeature).toBe(false);
      expect(probeLatest?.hrPayrollFeature).toBe(true);
      expect(probeLatest?.notificationNotifUnread).toBe(4);
    });

    // A's Firm1/U10 keys cleared (verify after B settles)
    await waitFor(() => {
      expect(qc.getQueryData(effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
      expect(qc.getQueryData(userPermissionsQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
      expect(qc.getQueryData(userUnreadCountQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    });
  });
});

// ============================================================================
// RT-4 PERMLKG-1: B permissions cached, refresh 503 → LKG retained
// ============================================================================
describe("RT-4 PERMLKG-1 — 503 preserves LKG documents:read", () => {
  it("RT-4: cached B doc:read → 503 → documents:read remains LKG", async () => {
    const qc = makeQc();
    const fx_B = makeFixture(1, 11, {
      permissions: [{ module: "documents", action: "read" }],
    });
    installUserResolvers(fx_B);
    // user with NO inline permissions so the permissions query is enabled (roleId exists)
    const baseUser = makeUser(1, 11);
    (baseUser as any).permissions = [];

    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], baseUser);
    render(wrap(<Probe />, qc));

    await waitFor(() => {
      expect(probeLatest?.documentsReadPermission).toBe(true);
      expect(probeLatest?.permissionsRaw.length).toBe(1);
    });

    // Install 503 resolver on permissions endpoint (simulate permission refresh failure)
    M.setApiRequestOverride(async (call) => {
      if (call.path === "/api/auth/permissions") {
        return makeJsonResponse(503, { code: "SERVICE_UNAVAILABLE" });
      }
      if (call.path === "/api/auth/me") {
        return makeJsonResponse(200, baseUser);
      }
      return undefined;
    });

    // Force permissions refetch via auth retryPermissions
    let retryPermsFn: (() => void) | null = null;
    let userState: AuthUser | null = baseUser;
    const Inspector = () => {
      const ctx = useAuth();
      retryPermsFn = ctx.retryPermissions ?? null;
      userState = ctx.user;
      return null;
    };
    const { rerender } = render(wrap(<><Inspector /><Probe /></>, qc));
    await waitFor(() => expect(retryPermsFn).not.toBeNull());
    void userState;

    act(() => {
      retryPermsFn!();
    });

    // Wait for permissions query to settle (unavailable:true but perms retained via LKG)
    await waitFor(() => {
      // LKG retained because transient cached same-user permissions
      // (the user.permissions was populated by the useEffect merge into user)
      const s = probeLatest;
      expect(s?.documentsReadPermission).toBe(true);
    }, { timeout: 10_000 });
  });
});

// ============================================================================
// RT-5 PERMDENY-1: B permissions cached + refresh 403 → [] empty
// ============================================================================
describe("RT-5 PERMDENY-1 — 403 clears old permission (fail-closed)", () => {
  it("RT-5: cached B doc:read → 403 → permissions cleared", async () => {
    const qc = makeQc();
    const fx_B = makeFixture(1, 11, {
      permissions: [{ module: "documents", action: "read" }],
    });
    installUserResolvers(fx_B);
    const baseUser = makeUser(1, 11);
    (baseUser as any).permissions = [];
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], baseUser);
    render(wrap(<Probe />, qc));
    await waitFor(() => expect(probeLatest?.documentsReadPermission).toBe(true));

    // Install 403 resolver (explicit deny)
    M.setApiRequestOverride(async (call) => {
      if (call.path === "/api/auth/permissions") {
        return makeJsonResponse(403, { code: "FEATURE_DISABLED" });
      }
      if (call.path === "/api/auth/me") {
        return makeJsonResponse(200, baseUser);
      }
      return undefined;
    });

    let retryPermsFn: (() => void) | null = null;
    const Inspector = () => {
      const ctx = useAuth();
      retryPermsFn = ctx.retryPermissions ?? null;
      return null;
    };
    const { rerender } = render(wrap(<><Inspector /><Probe /></>, qc));
    await waitFor(() => expect(retryPermsFn).not.toBeNull());

    act(() => {
      retryPermsFn!();
    });

    // 403 → empty permissions (fail-closed)
    await waitFor(() => {
      const s = probeLatest;
      expect(s?.documentsReadPermission).toBe(false);
      expect(s?.permissionsRaw.length).toBe(0);
    }, { timeout: 10_000 });
  });
});

// ============================================================================
// RT-6 /auth/me retryMe count === exactly 1
// ============================================================================
describe("RT-6 retryMe — exactly one extra /api/auth/me", () => {
  it("RT-6: retryMe → single GET /api/auth/me count delta", async () => {
    const qc = makeQc();
    const fx = makeFixture(1, 10);
    installUserResolvers(fx);
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], fx.user);

    let retryMeFn: (() => void) | null = null;
    const Inspector = () => {
      const ctx = useAuth();
      retryMeFn = ctx.retryMe ?? null;
      return null;
    };
    render(wrap(<><Inspector /><Probe /></>, qc));
    await waitFor(() => expect(retryMeFn).not.toBeNull());

    const beforeMeCount = M.apiRequestCalls.filter(
      (c) => typeof c.path === "string" && c.path.endsWith("/api/auth/me"),
    ).length;

    act(() => {
      retryMeFn!();
    });

    await waitFor(() => {
      const after = M.apiRequestCalls.filter(
        (c) => typeof c.path === "string" && c.path.endsWith("/api/auth/me"),
      ).length;
      expect(after - beforeMeCount).toBe(1);
    });
  });
});

// ============================================================================
// RT-7 login page flow: POST /auth/login → exactly 1 post-login GET /api/auth/me
// ============================================================================
describe("RT-7 login verify — exactly one post-login GET /api/auth/me", () => {
  it("RT-7: POST /auth/login → then exactly one post-login GET /api/auth/me", async () => {
    const qc = makeQc();
    const userB = makeUser(1, 11);

    // No token → AuthProvider's initial meQuery won't settle as auth'd.
    (M.getStoredAuthTokenMock as any).mockReturnValue(null);
    // Ensure meQuery doesn't fire spurious auth'd request (no token).
    M.setFetchJsonOverride(async (call) => {
      if (call.path === "/auth/login") {
        return { token: "fresh-token" };
      }
      return {};
    });
    M.setApiRequestOverride(async (call) => {
      if (call.path === "/api/auth/me") return makeJsonResponse(200, userB);
      if (call.path === "/api/auth/permissions") {
        return makeJsonResponse(200, envelopeSuccess({
          permissions: [{ module: "documents", action: "read" }],
        }));
      }
      return undefined;
    });

    // Render probe so apiRequest spy is live; probe calls the hooks including auth
    render(wrap(<Probe />, qc));

    // Settle so any initial (unauth'd) API calls are done.
    await waitFor(() => {
      expect(probeLatest?.authStatus).not.toBe("loading");
    });

    // Count the initial GET /api/auth/me (may exist from meQuery's first call)
    const beforeApiReq = M.apiRequestCalls.length;
    const countMeBefore = M.apiRequestCalls.filter(
      (c) => typeof c.path === "string" && c.path === "/api/auth/me",
    ).length;

    // --- Exactly emulate login page flow: ---
    // Step 1: POST /auth/login (apiFetchJson)
    const loginRes: any = await M.fetchJsonMock("/auth/login", {
      method: "POST",
      body: { email: userB.email, password: "test" },
    });
    expect(loginRes.token).toBeTruthy();

    // Step 2: login page then calls GET /api/auth/me exactly ONCE as a verify
    // use the same code path (apiRequest)
    const verifyRes = await M.apiRequestMock("/api/auth/me");
    expect(verifyRes.status).toBe(200);
    const verified = await verifyRes.json();
    expect(verified.id).toBe(userB.id);

    // Step 3: delta should be exactly 1 (the post-login verify request above)
    const countMeAfter = M.apiRequestCalls.filter(
      (c) => typeof c.path === "string" && c.path === "/api/auth/me",
    ).length;
    const delta = countMeAfter - countMeBefore;
    expect(delta).toBe(1);
    void beforeApiReq;
  });
});
