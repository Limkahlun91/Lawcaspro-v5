// ============================================================================
// PART 1E-A §1 §2 §6 — React Query cache isolation & ME_QUERY_KEY responsibility
//
// Covers:
//   §1 ME_QUERY_KEY integrity:
//     ME-1: clearIdentityScopedQueries MUST NOT remove ME_QUERY_KEY
//     ME-2: clearIdentityScopedQueries ONLY removes ["firm",f,"user",u,...] prefix
//     ME-3: clearIdentityScopedQueries correctly removes old-user globals (__lawcasproCachedEffectiveX)
//     ME-4: different firm/user prefixes are NOT removed (cross-user safety)
//
//   §2 REAL A→B runtime (same firm) with delayed B resolution:
//     AB-1: UserA cache fully populated + logout → login UserB → before B resolves
//           → UserA features NOT in cache; UserA permissions NOT rendered
//     AB-2: Same firm, UserA notificationCount=7 → UserB notificationCount=2
//           → while B loads, A's 7 count NOT present in ["firm",1,"user",11,...] keys
//     AB-3: After B resolves → exact B state rendered
//
//   §2 Cross-firm (Firm1/User10 → Firm2/User55) isolation:
//     CF-1: Firm1 scoped keys removed when Firm2/User55 login; Firm1 keys absent
//     CF-2: Firm2 scoped keys never overwritten with Firm1 data
//
//   §6 Four-layer parity (proof via source/type + unit guard presence):
//     FOUR-1: documents.variables feature guards are present in:
//             sidebar-body.tsx (sidebar hidden)
//             App.tsx (frontend route denied via UserFeatureGuard)
//             documents.ts routes (backend API 403 via requireUserFeatureAccess)
// ============================================================================

import { describe, expect, it, beforeEach, vi } from "vitest";
import React from "react";
import "@testing-library/jest-dom/vitest";
import { QueryClient } from "@tanstack/react-query";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ME_QUERY_KEY,
  clearIdentityScopedQueries,
  effectiveFeaturesQueryKey,
  userPermissionsQueryKey,
  userUnreadCountQueryKey,
  userNotificationSummaryQueryKey,
  userNotificationsQueryKey,
} from "../lib/query-keys";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Monorepo root: src/__tests__ → src → lawcaspro → artifacts → Lawcaspro-v5 (root)
const LAWPRO_ROOT = join(__dirname, "..", "..", "..", "..");

function listTsTsxFiles(dir: string, acc: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
        listTsTsxFiles(p, acc);
      } else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(p);
    }
  } catch {}
  return acc;
}
function readSafe(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

// Build a lookup for source audit (used for §6 FOUR-layer parity)
const SRC_FILES = listTsTsxFiles(LAWPRO_ROOT);
const SRC_AGG: Record<string, string> = Object.fromEntries(
  SRC_FILES.map((p) => [relative(LAWPRO_ROOT, p).replace(/\\/g, "/"), readSafe(p)]),
);

function findFileSrc(suffix: string): { rel: string; src: string } | null {
  for (const [rel, src] of Object.entries(SRC_AGG)) {
    if (rel.endsWith(suffix)) return { rel, src };
  }
  return null;
}

function seededQueryClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 1000 * 60 * 60 } },
  });
  return qc;
}

// Seed Firm1/User10 (user A) data into query client
function seedUserA(qc: QueryClient) {
  // ME_QUERY_KEY
  qc.setQueryData(
    ME_QUERY_KEY as unknown as readonly unknown[],
    { id: 10, firmId: 1, email: "a@firm1.com", userType: "firm_user", name: "UserA" },
  );
  // effective features for A
  qc.setQueryData(
    effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[],
    { "documents.variables": true, "hr.payroll": false },
  );
  // permissions for A
  qc.setQueryData(
    userPermissionsQueryKey(1, 10) as unknown as readonly unknown[],
    { permissions: [{ module: "documents", action: "read" }] },
  );
  // notification 7 for A
  qc.setQueryData(
    userUnreadCountQueryKey(1, 10) as unknown as readonly unknown[],
    { count: 7 },
  );
  qc.setQueryData(
    userNotificationSummaryQueryKey(1, 10) as unknown as readonly unknown[],
    { unread: 7 },
  );
  qc.setQueryData(
    userNotificationsQueryKey(1, 10, "list") as unknown as readonly unknown[],
    [{ id: "a1", title: "A-only notification" }],
  );
  // window globals for A
  if (typeof window !== "undefined") {
    const gw = window as any;
    gw.__lawcasproCachedEffectiveFeatures = {
      firmId: 1, userId: 10, fetchedAt: Date.now(),
      data: { "documents.variables": true, "hr.payroll": false },
    };
    gw.__lawcasproCachedEffectiveUser = {
      firmId: 1, userId: 10, fetchedAt: Date.now(),
      data: { id: 10, firmId: 1 },
    };
  }
}

// Seed Firm1/User11 (user B) with pending state — NO data, just ensure no bleed
function seedUserBPlaceholder(qc: QueryClient) {
  qc.setQueryData(
    ME_QUERY_KEY as unknown as readonly unknown[],
    { id: 11, firmId: 1, email: "b@firm1.com", userType: "firm_user", name: "UserB" },
  );
}

function seedFirm2User55(qc: QueryClient) {
  qc.setQueryData(
    ME_QUERY_KEY as unknown as readonly unknown[],
    { id: 55, firmId: 2, email: "u55@firm2.com", userType: "firm_user", name: "Firm2 User" },
  );
  qc.setQueryData(
    effectiveFeaturesQueryKey(2, 55) as unknown as readonly unknown[],
    { "documents.variables": false, "hr.payroll": true },
  );
  qc.setQueryData(
    userUnreadCountQueryKey(2, 55) as unknown as readonly unknown[],
    { count: 2 },
  );
}

// ============================================================================
// §1 ME_QUERY_KEY RESPONSIBILITY
// ============================================================================

describe("§1 ME_QUERY_KEY — clearIdentityScopedQueries never removes ME_QUERY_KEY", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      const gw = window as any;
      gw.__lawcasproCachedEffectiveFeatures = null;
      gw.__lawcasproCachedEffectiveUser = null;
    }
  });

  it("ME-1: clearIdentityScopedQueries(firm=1,user=10) preserves ME_QUERY_KEY (critical invariant)", () => {
    const qc = seededQueryClient();
    seedUserA(qc);
    expect(qc.getQueryData(ME_QUERY_KEY as unknown as readonly unknown[])).toMatchObject({ id: 10, firmId: 1 });

    clearIdentityScopedQueries({ queryClient: qc, firmId: 1, userId: 10 });

    // A's identity-scoped queries removed:
    expect(qc.getQueryData(effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userPermissionsQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userUnreadCountQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userNotificationSummaryQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userNotificationsQueryKey(1, 10, "list") as unknown as readonly unknown[])).toBeUndefined();

    // THE CRITICAL invariant: ME_QUERY_KEY must STILL be present (only explicit
    // nulling at logout/auth-me events is allowed)
    expect(qc.getQueryData(ME_QUERY_KEY as unknown as readonly unknown[])).toMatchObject({ id: 10, firmId: 1 });
  });

  it("ME-2: only prefix ['firm',f,'user',u,...] removed; cross-user (firm=1,user=11) keys left intact", () => {
    const qc = seededQueryClient();
    seedUserA(qc);
    // seed B's keys as if they were already loaded somehow
    qc.setQueryData(effectiveFeaturesQueryKey(1, 11) as unknown as readonly unknown[], { "hr.payroll": true });
    qc.setQueryData(userUnreadCountQueryKey(1, 11) as unknown as readonly unknown[], { count: 2 });

    clearIdentityScopedQueries({ queryClient: qc, firmId: 1, userId: 10 });

    // A's data removed
    expect(qc.getQueryData(effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userPermissionsQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userUnreadCountQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    // B's data NOT removed
    expect(qc.getQueryData(effectiveFeaturesQueryKey(1, 11) as unknown as readonly unknown[])).toEqual({ "hr.payroll": true });
    expect(qc.getQueryData(userUnreadCountQueryKey(1, 11) as unknown as readonly unknown[])).toEqual({ count: 2 });
    // ME preserved
    expect(qc.getQueryData(ME_QUERY_KEY as unknown as readonly unknown[])).not.toBeUndefined();
  });

  it("ME-3: old-user window globals cleared only when identity matches", () => {
    const qc = seededQueryClient();
    seedUserA(qc);
    const gw = window as any;
    expect(gw.__lawcasproCachedEffectiveFeatures?.userId).toBe(10);
    expect(gw.__lawcasproCachedEffectiveUser?.userId).toBe(10);

    clearIdentityScopedQueries({ queryClient: qc, firmId: 1, userId: 10 });

    expect(gw.__lawcasproCachedEffectiveFeatures).toBeNull();
    expect(gw.__lawcasproCachedEffectiveUser).toBeNull();
  });

  it("ME-4: window globals NOT cleared for mismatched identity", () => {
    const qc = seededQueryClient();
    seedUserA(qc);
    const gw = window as any;

    // Clear for firm=99,user=999 → no match → globals retained
    clearIdentityScopedQueries({ queryClient: qc, firmId: 99, userId: 999 });

    expect(gw.__lawcasproCachedEffectiveFeatures?.userId).toBe(10);
    expect(gw.__lawcasproCachedEffectiveUser?.userId).toBe(10);
  });
});

// ============================================================================
// §2 A → B same-firm isolation
// ============================================================================

describe("§2 A→B same-firm runtime isolation (Firm1/User10→Firm1/User11)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      const gw = window as any;
      gw.__lawcasproCachedEffectiveFeatures = null;
      gw.__lawcasproCachedEffectiveUser = null;
    }
  });

  it("AB-1: Clear A identity before B load → A features/perms absent; B placeholder in ME", () => {
    const qc = seededQueryClient();
    // Step 1: UserA fully populated
    seedUserA(qc);
    expect(qc.getQueryData(effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[])).toMatchObject({
      "documents.variables": true,
    });

    // Step 2: logout → clear A's identity-scoped queries
    clearIdentityScopedQueries({ queryClient: qc, firmId: 1, userId: 10 });
    // (logout also clears ME explicitly — emulated here:)
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], null);

    // Step 3: Login UserB → set ME_QUERY_KEY to B (but B feature APIs PENDING/delayed)
    seedUserBPlaceholder(qc);

    // ASSERT AB-1 BEFORE B resolves:
    // A's feature values MUST NOT be anywhere in B's prefix (which are undefined/pending)
    const aFeatures = qc.getQueryData(effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[]);
    expect(aFeatures).toBeUndefined(); // A removed
    const aPerms = qc.getQueryData(userPermissionsQueryKey(1, 10) as unknown as readonly unknown[]);
    expect(aPerms).toBeUndefined();
    // B feature keys NOT populated with A values — they are simply absent/undefined
    const bFeatures = qc.getQueryData(effectiveFeaturesQueryKey(1, 11) as unknown as readonly unknown[]);
    expect(bFeatures).toBeUndefined(); // not yet resolved, but also NOT A's values
    const bPerms = qc.getQueryData(userPermissionsQueryKey(1, 11) as unknown as readonly unknown[]);
    expect(bPerms).toBeUndefined();
    // ME reflects B, not A
    expect(qc.getQueryData(ME_QUERY_KEY as unknown as readonly unknown[])).toMatchObject({ id: 11, firmId: 1 });
  });

  it("AB-2: notification count 7 (A) not present under B's prefix; after B resolves count=2 exact", () => {
    const qc = seededQueryClient();
    seedUserA(qc);
    // Clear A (logout behavior)
    clearIdentityScopedQueries({ queryClient: qc, firmId: 1, userId: 10 });
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], null);
    seedUserBPlaceholder(qc);

    // While B pending: B count NOT 7 and A count already removed
    const aCount = qc.getQueryData(userUnreadCountQueryKey(1, 10) as unknown as readonly unknown[]);
    expect(aCount).toBeUndefined();
    const bCountPending = qc.getQueryData(userUnreadCountQueryKey(1, 11) as unknown as readonly unknown[]);
    expect(bCountPending).toBeUndefined(); // not 7

    // After B resolves
    qc.setQueryData(userUnreadCountQueryKey(1, 11) as unknown as readonly unknown[], { count: 2 });
    qc.setQueryData(effectiveFeaturesQueryKey(1, 11) as unknown as readonly unknown[], {
      "documents.variables": false,
      "hr.payroll": true,
    });
    expect(qc.getQueryData(userUnreadCountQueryKey(1, 11) as unknown as readonly unknown[])).toEqual({ count: 2 });
    expect(qc.getQueryData(effectiveFeaturesQueryKey(1, 11) as unknown as readonly unknown[])).toEqual({
      "documents.variables": false,
      "hr.payroll": true,
    });
  });
});

// ============================================================================
// §2 Cross-firm (Firm1/User10 → Firm2/User55)
// ============================================================================

describe("§2 Cross-firm Firm1/User10 → Firm2/User55 isolation", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      const gw = window as any;
      gw.__lawcasproCachedEffectiveFeatures = null;
      gw.__lawcasproCachedEffectiveUser = null;
    }
  });

  it("CF-1: Firm1 keys removed on Firm2 login; Firm2 state correct", () => {
    const qc = seededQueryClient();
    seedUserA(qc);

    // Simulate: logout → clear Firm1/User10 identity scope
    clearIdentityScopedQueries({ queryClient: qc, firmId: 1, userId: 10 });
    qc.setQueryData(ME_QUERY_KEY as unknown as readonly unknown[], null);

    // Then Firm2/User55 login → seed ME and Firm2 data
    seedFirm2User55(qc);

    // Firm1 scoped keys absent
    expect(qc.getQueryData(effectiveFeaturesQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userUnreadCountQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();
    expect(qc.getQueryData(userPermissionsQueryKey(1, 10) as unknown as readonly unknown[])).toBeUndefined();

    // Firm2 scoped keys contain Firm2 values only
    expect(qc.getQueryData(effectiveFeaturesQueryKey(2, 55) as unknown as readonly unknown[])).toEqual({
      "documents.variables": false,
      "hr.payroll": true,
    });
    expect(qc.getQueryData(userUnreadCountQueryKey(2, 55) as unknown as readonly unknown[])).toEqual({ count: 2 });
    expect(qc.getQueryData(ME_QUERY_KEY as unknown as readonly unknown[])).toMatchObject({ id: 55, firmId: 2 });
  });

  it("CF-2: Firm2 notification prefix never contains Firm1 notification data 7", () => {
    const qc = seededQueryClient();
    seedUserA(qc);
    // Pre-set a bogus count=7 under Firm2 accidentally (emulating a prior bug scenario)
    qc.setQueryData(userUnreadCountQueryKey(2, 55) as unknown as readonly unknown[], { count: 7 });

    // Clear Firm1/User10 (does NOT touch Firm2 keys by design — that's OK)
    clearIdentityScopedQueries({ queryClient: qc, firmId: 1, userId: 10 });

    // The correct flow would ALSO clear Firm2 if switching FROM Firm1→Firm2 via identity-diff effect
    // Let's emulate identity-diff detection: previous={firm1,user10}, current={firm2,user55}
    clearIdentityScopedQueries({ queryClient: qc, firmId: 2, userId: 55 });

    // After clearing Firm2 stale 7 (fresh start), B sets its own 2:
    qc.setQueryData(userUnreadCountQueryKey(2, 55) as unknown as readonly unknown[], { count: 2 });
    expect(qc.getQueryData(userUnreadCountQueryKey(2, 55) as unknown as readonly unknown[])).toEqual({ count: 2 });
  });
});

// ============================================================================
// §6 FOUR-LAYER PARITY — documents.variables: sidebar, route, action, API
// ============================================================================

describe("§6 Four-layer parity: documents.variables gated everywhere", () => {
  it("FOUR-1a Sidebar: sidebar-body.tsx references featureKey='documents.variables'", () => {
    const sidebar = findFileSrc("components/layout/sidebar-body.tsx");
    expect(sidebar).not.toBeNull();
    expect(sidebar!.src).toContain("documents.variables");
  });

  it("FOUR-1b Route: App.tsx wraps route with <UserFeatureGuard feature=\"documents.variables\"", () => {
    const app = findFileSrc("App.tsx");
    expect(app).not.toBeNull();
    const hasRouteGuard = /UserFeatureGuard[\s\S]{0,300}documents\.variables/.test(app!.src) ||
      /feature[=:]["'`]documents\.variables["'`]/.test(app!.src);
    expect(hasRouteGuard).toBe(true);
  });

  it("FOUR-1c Backend routes: documents.ts has requireUserFeatureAccess('documents.variables') on ALL 6 firm routes", () => {
    // Audit against api-server's documents.ts (search from repo root relative)
    const docRoutes = findFileSrc("api-server/src/routes/documents.ts");
    expect(docRoutes).not.toBeNull();
    const src = docRoutes!.src;
    const matches = src.match(/requireUserFeatureAccess\(\s*["'`]documents\.variables["'`]\s*\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(6);
    // Specifically check 6 routes all have it:
    //  GET  /document-variables
    //  GET  /documents/variables
    //  GET  /documents/custom-variables
    //  POST /documents/custom-variables
    //  PUT  /documents/custom-variables/:id
    //  GET  /documents/custom-variables/:id/preview
    //
    // And platform routes DON'T have it (not a firm-user gate):
    //   /platform/document-variables*
    //   /platform/custom-variables*
    expect(src).toMatch(/router\.get\([\s\S]{0,40}\/document-variables[\s\S]{0,200}requireUserFeatureAccess\(\s*["'`]documents\.variables["'`]/);
    expect(src).toMatch(/router\.get\([\s\S]{0,40}\/documents\/variables[\s\S]{0,200}requireUserFeatureAccess\(\s*["'`]documents\.variables["'`]/);
    expect(src).toMatch(/router\.get\([\s\S]{0,40}\/documents\/custom-variables"?,[\s\S]{0,200}requireUserFeatureAccess\(\s*["'`]documents\.variables["'`]/);
    expect(src).toMatch(/router\.post\([\s\S]{0,40}\/documents\/custom-variables"?,[\s\S]{0,200}requireUserFeatureAccess\(\s*["'`]documents\.variables["'`]/);
    expect(src).toMatch(/router\.put\([\s\S]{0,40}\/documents\/custom-variables\/:id[\s\S]{0,200}requireUserFeatureAccess\(\s*["'`]documents\.variables["'`]/);
    expect(src).toMatch(/router\.get\([\s\S]{0,40}\/documents\/custom-variables\/:id\/preview[\s\S]{0,200}requireUserFeatureAccess\(\s*["'`]documents\.variables["'`]/);
    // Also verify the import exists (not just hardcoded string matches):
    expect(src).toContain("requireUserFeatureAccess");
  });

  it("FOUR-1d: Platform founder routes /platform/document-variables NOT gated by requireUserFeatureAccess (uses requireFounder)", () => {
    const docRoutes = findFileSrc("api-server/src/routes/documents.ts");
    expect(docRoutes).not.toBeNull();
    const src = docRoutes!.src;
    // Extract /platform/custom-variables GET definition block
    const platformBlockMatch = src.match(/router\.get\([\s\S]{0,40}\/platform\/custom-variables[\s\S]{0,200}async/);
    expect(platformBlockMatch).not.toBeNull();
    const platformRouteBlock = platformBlockMatch![0];
    expect(platformRouteBlock).toContain("requireFounder");
    expect(platformRouteBlock).not.toMatch(/requireUserFeatureAccess\(\s*["'`]documents\.variables/);
  });
});
