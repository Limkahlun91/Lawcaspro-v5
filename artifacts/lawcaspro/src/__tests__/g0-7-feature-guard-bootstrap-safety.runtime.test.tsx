// G0.7 Frontend BOOT Safety runtime regression test.
//
// Mounts the real useFeature + useFirmEntitlements hooks (feature-guards.tsx)
// under a mocked QueryClient + mocked auth-context + mocked api-client.
//
// Asserts for 4 scenarios:
//   A) effectiveEnabled:false in normal valid bundle → guard returns enabled:false safely
//   B) Feature key missing entirely from bundle → deny-by-default feature_not_found
//   C) Malformed effective bundle (effective is a string, not an object) →
//      boundary validator fails closed; real programming errors are NOT swallowed here
//      (but degraded API payload data is handled safely)
//   D) API error thrown in fetch → hook degrades to loading=false + enabled=false.
//
// Finally, NO window.onerror or unhandledrejection events should fire for any
// scenario above (no BOOT banner would show in production for these paths).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, cleanup } from "@testing-library/react";

// --- HOISTED VI.MOCKS: must capture before any real imports --------------
const mockBundle = vi.hoisted(() => ({
  current: null as
    | { kind: "ok"; bundle: unknown }
    | { kind: "throw"; err: unknown }
    | null,
}));

// 1. Mock useAuth (from auth-context)
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: 1, firmId: 101, role: "partner", roleName: "Partner", email: "p@test.com" },
    isAuthenticated: true,
    hasBootstrapped: true,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

// 2. Mock apiFetchJson (mirrors the actual module imported by feature-guards.tsx via import "@/lib/api-client")
vi.mock("@/lib/api-client", () => ({
  apiFetchJson: async (..._args: unknown[]) => {
    if (!mockBundle.current) return { ok: true, data: {} };
    if (mockBundle.current.kind === "throw") throw mockBundle.current.err;
    return { ok: true, data: mockBundle.current.bundle };
  },
  apiUploadFile: async () => ({ ok: true }),
}));

// Real imports AFTER all vi.mock
import { useFeature, useFirmEntitlements } from "../lib/feature-guards";

function mkClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false } },
  });
}

function Wrapper(props: { children: React.ReactNode; client?: QueryClient | null }) {
  return React.createElement(
    QueryClientProvider,
    { client: props.client ?? mkClient() },
    props.children,
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("G0.7 Frontend BOOT-Safety (Feature Guards runtime)", () => {
  let onErr: Array<{ ev: unknown }>;
  let onRej: Array<{ reason: unknown }>;
  const errFn = (e: any) => onErr.push({ ev: e });
  const rejFn = (e: any) => onRej.push({ reason: e?.reason ?? e });

  beforeEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
    cleanup();
    mockBundle.current = null;
    onErr = [];
    onRej = [];
    window.addEventListener("error", errFn);
    window.addEventListener("unhandledrejection", rejFn);
    // root element present like main.tsx BOOT-shield test precondition
    let root = document.getElementById("root");
    if (root) root.remove();
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    window.removeEventListener("error", errFn);
    window.removeEventListener("unhandledrejection", rejFn);
  });

  const assertNoBootBanner = () => {
    // No window error/unhandled rejection
    expect(onErr.length).toBe(0);
    expect(onRej.length).toBe(0);
    // DOM does not contain BOOT banner (Lawcaspro could not start)
    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("lawcaspro could not start");
    expect(text).not.toContain("BOOT-");
    expect(text).not.toContain("WIN-");
    expect(text).not.toContain("REJ-");
  };

  it("Scenario A: effectiveEnabled false in normal bundle → guard renders safe fallback enabled:false, denialCode set", async () => {
    mockBundle.current = {
      kind: "ok",
      bundle: {
        userId: 1,
        firmId: 101,
        effective: {
          "accounting.bank_account": {
            featureKey: "accounting.bank_account",
            firmEnabled: false,
            userEnabled: false,
            effectiveEnabled: false,
            source: "firm_entitlement_denied",
            denialCode: "FIRM_ENTITLEMENT_OFF",
            denialReason: "Firm entitlement OFF",
            parentKey: "module.accounting",
          },
        },
        explicitOverrides: [],
      },
    };
    const { result } = renderHook(() => useFeature("accounting.bank_account"), { wrapper: Wrapper as any });
    await act(async () => { await sleep(60); });
    expect(result.current.enabled).toBe(false);
    expect(typeof result.current.denialCode === "string" && result.current.denialCode.length > 0).toBe(true);
    assertNoBootBanner();
  });

  it("Scenario B: Missing feature key from bundle → deny by default feature_not_found", async () => {
    mockBundle.current = {
      kind: "ok",
      bundle: { userId: 2, firmId: 202, effective: {}, explicitOverrides: [] },
    };
    const { result } = renderHook(() => useFeature("feature.foo.bar.unregistered"), { wrapper: Wrapper as any });
    await act(async () => { await sleep(60); });
    expect(result.current.enabled).toBe(false);
    expect(result.current.denialCode).toBe("feature_not_found");
    assertNoBootBanner();
  });

  it("Scenario C: Malformed effective bundle (effective is string, not object) → boundary validator fail-closed safely", async () => {
    mockBundle.current = {
      kind: "ok",
      bundle: { userId: 3, firmId: 303, effective: "STRING-IS-NOT-AN-OBJECT", explicitOverrides: "not-an-array" },
    };
    const { result } = renderHook(
      () => ({ fe: useFeature("cases.create"), firm: useFirmEntitlements() }),
      { wrapper: Wrapper as any },
    );
    await act(async () => { await sleep(60); });
    // Firm entitlements malformed bundle → boundary validator degrades safely:
    // either items is empty object, or items is undefined (fail-closed). Both are acceptable.
    const items = result.current.firm.data?.items;
    const isObjectSafe = items == null || (typeof items === "object" && Object.keys(items ?? {}).length === 0);
    expect(isObjectSafe).toBe(true);
    // Guard resolves feature_not_found since effective bundle bad → feature disabled
    expect(result.current.fe.enabled).toBe(false);
    assertNoBootBanner();
  });

  it("Scenario D: API fetch error → hook degrades to enabled false safely; no uncaught BOOT banner trigger", async () => {
    mockBundle.current = { kind: "throw", err: new Error("API 500 upstream failure") };
    const { result } = renderHook(() => useFeature("module.accounting"), { wrapper: Wrapper as any });
    await act(async () => { await sleep(80); });
    expect(typeof result.current.enabled).toBe("boolean");
    expect(result.current.enabled).toBe(false);
    assertNoBootBanner();
  });
});
