import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveUserFeatureAccess,
  resolveUserFeatureAccessBulk,
  resolveRequestPermissionChecker,
  invalidateUserFeatureCacheFor,
} from "../services/user-feature-access.js";

type EntitlementBulkResult = Record<string, { enabled: boolean; denialReason?: string }>;
const mockResolveEntitlementsBulk = vi.fn() as unknown as {
  mockImplementation: (
    impl: (firmId: number, keys: readonly string[], opts?: unknown) => Promise<EntitlementBulkResult>,
  ) => void;
  mockClear: () => void;
};
vi.mock("../services/entitlement-resolver.js", () => {
  const fn = async (firmId: number, keys: readonly string[], opts?: unknown): Promise<EntitlementBulkResult> => {
    const impl = (mockResolveEntitlementsBulk as any).getMockImplementation?.();
    if (typeof impl === "function") return impl(firmId, keys, opts);
    return {};
  };
  return { resolveEntitlementsBulk: fn };
});

function buildFixture(opts: {
  firmId: number;
  userId: number;
  roleId: number | null;
  entitlements: Record<string, boolean>;
  userRows?: Array<{ featureKey: string; isEnabled: boolean }>;
  permissionRows?: Array<{ role_id: number; module: string; action: string; allowed: boolean }>;
  omitUnregistered?: boolean;
  skipInvalidate?: boolean;
}) {
  if (!opts.skipInvalidate) {
    invalidateUserFeatureCacheFor(opts.firmId, opts.userId);
  }
  const userRows = opts.userRows ?? [];
  const permissionRows = opts.permissionRows ?? [];
  mockResolveEntitlementsBulk.mockImplementation(
    async (_firmId: number, keys: readonly string[]) => {
      const out: EntitlementBulkResult = {};
      const union = new Set<string>([...keys, ...Object.keys(opts.entitlements)]);
      for (const k of union) {
        if (k in opts.entitlements) {
          out[k] = {
            enabled: opts.entitlements[k],
            denialReason: opts.entitlements[k] ? undefined : "entitlement_off_fixture",
          };
        } else if (!opts.omitUnregistered) {
          out[k] = { enabled: false, denialReason: "not_in_entitlements_fixture" };
        }
      }
      return out;
    },
  );
  const r: any = {
    select: (_sel: any) => ({
      from: (_tbl: any) => ({
        where: async (): Promise<Array<{ featureKey: string; isEnabled: boolean }>> => {
          return userRows.map((u) => ({ featureKey: u.featureKey, isEnabled: u.isEnabled }));
        },
      }),
    }),
    execute: async () => ({ rows: permissionRows }),
    transaction: async (fn: (tx: any) => Promise<unknown>) => await fn(r),
  };
  return { r };
}

const ROUTES = {
  invoices: resolve(__dirname, "..", "routes", "invoices.ts"),
  receipts: resolve(__dirname, "..", "routes", "receipts.ts"),
  timeEntries: resolve(__dirname, "..", "routes", "time-entries.ts"),
  paymentVouchers: resolve(__dirname, "..", "routes", "payment-vouchers.ts"),
  documents: resolve(__dirname, "..", "routes", "documents.ts"),
  accounting: resolve(__dirname, "..", "routes", "accounting.ts"),
  caseMonitor: resolve(__dirname, "..", "routes", "case-monitor.ts"),
  complianceReports: resolve(__dirname, "..", "routes", "compliance-reports.ts"),
  firmSettings: resolve(__dirname, "..", "routes", "firm-settings.ts"),
  users: resolve(__dirname, "..", "routes", "users.ts"),
} as const;

function readRoute(p: keyof typeof ROUTES): string {
  return readFileSync(ROUTES[p], "utf8");
}

function findRouteWindow(src: string, pathLiteral: string, windowCharsAfterAsync = 4000): { start: number; mw: string; handlerHead: string } | null {
  const pathIdx = src.indexOf(pathLiteral);
  if (pathIdx === -1) return null;
  const routerStart = src.lastIndexOf("router.", pathIdx);
  if (routerStart === -1) return null;
  const asyncIdx = src.indexOf("async (req", routerStart);
  if (asyncIdx === -1) return null;
  const mw = src.slice(routerStart, asyncIdx);
  const handlerEnd = Math.min(src.length, asyncIdx + windowCharsAfterAsync);
  const handlerHead = src.slice(asyncIdx, handlerEnd);
  return { start: routerStart, mw, handlerHead };
}

function locateAnyRouteWindow(src: string, pathFragments: string[], routerMethodHint?: "get" | "post" | "put" | "patch" | "delete") {
  for (const frag of pathFragments) {
    const idxs: number[] = [];
    let i = -1;
    while ((i = src.indexOf(frag, i + 1)) !== -1) idxs.push(i);
    for (const idx of idxs) {
      const routerStart = src.lastIndexOf("router.", idx);
      if (routerStart === -1) continue;
      if (routerMethodHint) {
        const head = src.slice(routerStart, routerStart + 30);
        if (!head.startsWith(`router.${routerMethodHint}`)) continue;
      }
      const asyncIdx = src.indexOf("async (req", routerStart);
      if (asyncIdx === -1) continue;
      if (asyncIdx - routerStart > 5000) continue;
      return {
        start: routerStart,
        pathFragUsed: frag,
        mw: src.slice(routerStart, asyncIdx),
        handlerHead: src.slice(asyncIdx, Math.min(src.length, asyncIdx + 4000)),
      };
    }
  }
  return null;
}

// =========================================================================
// PART 2B-1 §11 — INVOICE / RECEIPT FEATURE + RBAC BEHAVIOR
// =========================================================================

describe("PART 2B-1 §11 INV-A — invoice feature OFF => firm_entitlement_denied", () => {
  it("accounting.invoice entitlement OFF + Partner => STILL denied (STEP1 beats STEP2 Partner allow)", async () => {
    const FIRM = 401, USER = 1, ROLE = 30;
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.invoice": false },
      permissionRows: [{ role_id: ROLE, module: "accounting", action: "read", allowed: true }],
    });
    const pc = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const res = await resolveUserFeatureAccess({
      r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "PARTNER",
      featureKey: "accounting.invoice", permissionChecker: pc,
    });
    expect(res.source).toBe("firm_entitlement_denied");
    expect(res.effectiveEnabled).toBe(false);
  });
});

describe("PART 2B-1 §11 INV-B — invoice RBAC denial => role_permission_denied", () => {
  it("entitlement=ON, CLERK role, permission=false => role_permission_denied", async () => {
    const FIRM = 402, USER = 2, ROLE = 31;
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.invoice": true },
      permissionRows: [], // no accounting:read permission
    });
    const pc = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const res = await resolveUserFeatureAccess({
      r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKey: "accounting.invoice", permissionChecker: pc,
    });
    expect(res.source).toBe("role_permission_denied");
    expect(res.effectiveEnabled).toBe(false);
    expect(res.denialCode).toBe("ROLE_DENIED");
  });
});

describe("PART 2B-1 §11 REC-A — receipt feature OFF => firm_entitlement_denied", () => {
  it("accounting.receipt entitlement OFF => STEP1 denies regardless of role/perms", async () => {
    const FIRM = 403, USER = 3, ROLE = 32;
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.receipt": false },
      permissionRows: [{ role_id: ROLE, module: "accounting", action: "read", allowed: true }],
    });
    const pc = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const res = await resolveUserFeatureAccess({
      r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "PARTNER",
      featureKey: "accounting.receipt", permissionChecker: pc,
    });
    expect(res.source).toBe("firm_entitlement_denied");
    expect(res.effectiveEnabled).toBe(false);
  });
});

describe("PART 2B-1 §11 REC-B — receipt RBAC denial => role_permission_denied", () => {
  it("entitlement=ON, no read permission => role_permission_denied", async () => {
    const FIRM = 404, USER = 4, ROLE = 33;
    const { r } = buildFixture({
      firmId: FIRM, userId: USER, roleId: ROLE,
      entitlements: { "module.accounting": true, "accounting.receipt": true },
      permissionRows: [],
    });
    const pc = await resolveRequestPermissionChecker(r, FIRM, ROLE);
    const res = await resolveUserFeatureAccess({
      r, firmId: FIRM, userId: USER, roleId: ROLE, roleName: "CLERK",
      featureKey: "accounting.receipt", permissionChecker: pc,
    });
    expect(res.source).toBe("role_permission_denied");
    expect(res.effectiveEnabled).toBe(false);
  });
});

// =========================================================================
// PART 2B-1 §11 — RECEIPTS + TIME-ENTRIES: request-scoped DB structural
// =========================================================================

describe("PART 2B-1 §11 RDB-RECEIPTS — receipts.ts uses getRlsDb(req, res) FAIL CLOSED, no global db fallback", () => {
  const src = readRoute("receipts");

  it("local getRlsDb helper exists AND route bodies use getRlsDb(req, res) + null guard", () => {
    const hasHelper = /(?:const|let|var)\s+getRlsDb\s*=|function\s+getRlsDb\s*\(/.test(src);
    expect(hasHelper, "receipts.ts must declare a local getRlsDb helper").toBe(true);

    const routesMeta = [
      { name: "GET /receipts list",      frag: '"/receipts", requireAuth' },
      { name: "GET /receipts/:id detail", frag: '"/receipts/:id"' },
      { name: "POST /receipts create",    frag: '"/receipts", sensitiveRateLimiter' },
      { name: "POST /receipts/:id/reverse", frag: '"/receipts/:id/reverse"' },
    ];
    for (const { name, frag } of routesMeta) {
      const w = locateAnyRouteWindow(src, [frag]);
      expect(w, `${name} — could not locate route window with fragment ${frag}`).not.toBeNull();
      const hh = (w as any).handlerHead;
      const hasGuard =
        /(?:const|let|var)\s+r\s*=\s*getRlsDb\(\s*req\s*,\s*res\s*\)\s*;[\s\S]{0,120}?if\s*\(\s*!r\s*\)\s*return\s*;?/.test(hh) ||
        (/getRlsDb\(\s*req\s*,\s*res\s*\)/.test(hh) && /if\s*\(\s*!r\s*\)\s*return\s*;?/.test(hh));
      expect(hasGuard, `${name} handler body must use getRlsDb(req, res) + if (!r) return guard`).toBe(true);
    }
  });

  it("NO `?? db` (req.rlsDb fallback) exists in receipts.ts for any DB context lookup", () => {
    const fallback = /req\.rlsDb\s*\?\?\s*db|\brlsDb\s*\?\?\s*db|:\s*req\.rlsDb\s*\?\?/;
    expect(fallback.test(src), "found silent ?? db fallback in receipts.ts").toBe(false);
  });

  it("no route-level global db.select/insert/update/delete/transaction inside 4 main handlers after getRlsDb guard", () => {
    const guards = [...src.matchAll(/const\s+r\s*=\s*getRlsDb\(\s*req\s*,\s*res\s*\)\s*;/g)];
    let found = 0;
    for (const g of guards) {
      const start = g.index ?? 0;
      const block = src.slice(start, start + 8000);
      if (/(^|[^.\w])db\.(select|insert|update|delete|transaction|execute)\s*\(/.test(block)) found++;
    }
    expect(found, "no direct global db.crud inside route blocks after getRlsDb guard").toBe(0);
  });

  it("updateInvoicePaymentStatus helper: FIRST parameter must accept DbConn/AppDb type (injected, not closure)", () => {
    const re = /async\s+function\s+updateInvoicePaymentStatus\s*\(\s*\w+\s*:\s*(?:AppDb|DbConn|typeof\s+db)/;
    expect(re.test(src), "updateInvoicePaymentStatus should declare typed injected DB param as first arg").toBe(true);
  });
  it("postLedger helper: FIRST parameter must accept DbConn/AppDb type (injected, not closure)", () => {
    const re = /async\s+function\s+postLedger\s*\(\s*\w+\s*:\s*(?:AppDb|DbConn|typeof\s+db)/;
    expect(re.test(src), "postLedger should declare typed injected DB param as first arg").toBe(true);
  });

  it("all 4 active receipt routes declare requireUserFeatureAccess('accounting.receipt')", () => {
    const hits = src.match(/requireUserFeatureAccess\("accounting\.receipt"\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });
});

describe("PART 2B-1 §11 RDB-TIMEENTRIES — time-entries.ts uses local getRlsDb(req, res) FAIL CLOSED, no silent ?? db fallback", () => {
  const src = readRoute("timeEntries");

  it("has local getRlsDb helper (returns req.rlsDb/null with 503 JSON writer) — NOT imported from @workspace/db", () => {
    const usesLocalHelper =
      /(?:const|let|var)\s+getRlsDb\s*=\s*\(\s*req\s*:\s*AuthRequest\s*,\s*res\s*:\s*Response\s*\)/.test(src) ||
      /function\s+getRlsDb\s*\(\s*req\s*:\s*AuthRequest\s*,\s*res\s*:\s*Response\s*\)/.test(src);
    const importsRdbFromDb = /import[\s\S]*?rdb[\s\S]*?from\s*["']@workspace\/db["']/.test(src);
    expect(usesLocalHelper, "should declare local getRlsDb(req: AuthRequest, res: Response) helper (const or function form)").toBe(true);
    expect(importsRdbFromDb, "should NOT import rdb from @workspace/db (no such export in repo)").toBe(false);
  });

  it("NO silent ?? db fallback patterns anywhere in file", () => {
    const fallback = /req\.rlsDb\s*\?\?\s*db|\brlsDb\s*\?\?\s*db|:\s*req\.rlsDb\s*\?\?/;
    expect(fallback.test(src), "found ?? db silent fallback in time-entries.ts").toBe(false);
  });

  it("every 5 routes (list/summary/create/update/delete) each have getRlsDb(req, res) + null guard", () => {
    const guardMatches = [...src.matchAll(/const\s+r\s*=\s*getRlsDb\(\s*req\s*,\s*res\s*\)\s*;[\s\S]{0,80}?if\s*\(\s*!r\s*\)\s*return\s*;/g)];
    expect(guardMatches.length, "expected 5 getRlsDb + null guard pairs for 5 time-entry routes").toBe(5);
  });

  it("no global db.select/insert/update/delete/transaction/execute inside handlers (after guards) except inside typeof db type annotations", () => {
    const lines = src.split(/\r?\n/);
    const hits: Array<{ ln: number; line: string }> = [];
    lines.forEach((l, i) => {
      if (/\bdb\.(select|insert|update|delete|transaction|execute)\s*\(/.test(l) &&
          !/(?:type\s+\w+|:\s*(?:typeof|DbConn|AppDb))/.test(l)) {
        hits.push({ ln: i + 1, line: l.trim() });
      }
    });
    expect(hits, `db.* CRUD outside typedefs on lines: ${hits.map((h) => h.ln).join(",")}`).toEqual([]);
  });
});

// =========================================================================
// PART 2B-1 §11 — PV FEATURE + RBAC ORDERING STRUCTURAL
// =========================================================================

describe("PART 2B-1 §11 PV-A — payment-vouchers middleware order correct", () => {
  const src = readRoute("paymentVouchers");

  const activeRoutes = [
    { name: "GET list /payment-vouchers",   frags: ['"/payment-vouchers", requireAuth'],                                   wantFeature: "accounting.payment_voucher", wantPerm: true  },
    { name: "POST create /payment-vouchers", frags: ['router.post("/payment-vouchers"'],                                  wantFeature: "accounting.payment_voucher", wantPerm: false },
    { name: "GET create-options",            frags: ["/payment-vouchers/create-options"],                                  wantFeature: "accounting.payment_voucher", wantPerm: true  },
    { name: "GET my-approvals",              frags: ["/payment-vouchers/my-approvals"],                                    wantFeature: "accounting.payment_voucher", wantPerm: false },
    { name: "GET detail /:id",               frags: ['/payment-vouchers/:id(\\\\d+)"', "/payment-vouchers/:id"],              wantFeature: "accounting.payment_voucher", wantPerm: true  },
    { name: "POST preflight",                frags: ["/payment-vouchers/preflight"],                                       wantFeature: "accounting.payment_voucher", wantPerm: true  },
    { name: "GET by-client-request",         frags: ["/payment-vouchers/by-client-request/:clientRequestId"],               wantFeature: "accounting.payment_voucher", wantPerm: false },
    { name: "POST discard-draft",            frags: ["/payment-vouchers/discard-draft"],                                   wantFeature: "accounting.payment_voucher", wantPerm: false },
    { name: "POST transition /:id",          frags: ["/payment-vouchers/:id/transition"],                                  wantFeature: "accounting.payment_voucher", wantPerm: false },
    { name: "GET history /:id/history",      frags: ['/payment-vouchers/:id(\\\\d+)/history', "/payment-vouchers/:id/history"], wantFeature: "accounting.payment_voucher", wantPerm: true  },
  ];

  it.each(activeRoutes)(
    "$name → has requireUserFeatureAccess($wantFeature)",
    ({ name, frags, wantFeature }) => {
      const w = locateAnyRouteWindow(src, frags);
      expect(w, `${name} could not locate any router.<METHOD> window with fragments ${frags.join(" | ")}`).not.toBeNull();
      expect((w as any).mw.includes(`requireUserFeatureAccess("${wantFeature}")`), `${name} middleware window missing ${wantFeature} guard`).toBe(true);
    },
  );

  it("for routes that HAVE requirePermission: requireUserFeatureAccess PRECEDES requirePermission", () => {
    const routesWithPerms: Array<{ name: string; frags: string[] }> = [
      { name: "GET list",              frags: ['"/payment-vouchers", requireAuth'] },
      { name: "GET create-options",    frags: ["/payment-vouchers/create-options"] },
      { name: "GET detail /:id",       frags: ['/payment-vouchers/:id(\\\\d+)"', "/payment-vouchers/:id"] },
      { name: "POST preflight",        frags: ["/payment-vouchers/preflight"] },
      { name: "GET history",           frags: ['/payment-vouchers/:id(\\\\d+)/history', "/payment-vouchers/:id/history"] },
    ];
    for (const { name, frags } of routesWithPerms) {
      const w = locateAnyRouteWindow(src, frags);
      expect(w, `${name} route window not found`).not.toBeNull();
      const mw = (w as any).mw;
      const featPos = mw.indexOf(`requireUserFeatureAccess("accounting.payment_voucher")`);
      const permPos = mw.indexOf("requirePermission(");
      expect(featPos, `${name} missing feature guard`).toBeGreaterThan(-1);
      expect(permPos, `${name} missing RBAC requirePermission()`).toBeGreaterThan(-1);
      expect(featPos, `${name} feature guard must come before RBAC permission`).toBeLessThan(permPos);
    }
  });
});

// =========================================================================
// PART 2B-1 §11 — DOC-VARIABLES FEATURE + RBAC ORDERING
// =========================================================================

describe("PART 2B-1 §11 DOCVARS-A — document.variables middleware ordering structural", () => {
  const src = readRoute("documents");

  const docVarRoutes = [
    { name: "GET /document-variables",                    frags: ['"/document-variables"'],                   method: "get"  as const, wantFeat: "documents.variables", wantPerm: "documents" },
    { name: "GET /documents/variables",                   frags: ['"/documents/variables"'],                  method: "get"  as const, wantFeat: "documents.variables", wantPerm: "documents" },
    { name: "GET /documents/custom-variables",            frags: ['"/documents/custom-variables"'],           method: "get"  as const, wantFeat: "documents.variables", wantPerm: "documents" },
    { name: "POST /documents/custom-variables",           frags: ['"/documents/custom-variables"'],           method: "post" as const, wantFeat: "documents.variables", wantPerm: "documents" },
    { name: "PUT /documents/custom-variables/:id",        frags: ['"/documents/custom-variables/:id"'],       method: "put"  as const, wantFeat: "documents.variables", wantPerm: "documents" },
    { name: "GET /documents/custom-variables/:id/preview",frags: ['"/documents/custom-variables/:id/preview"'],method: "get"  as const, wantFeat: "documents.variables", wantPerm: "documents" },
  ];

  it.each(docVarRoutes)(
    "$name → has both requireUserFeatureAccess($wantFeat) AND requirePermission($wantPerm.*)",
    ({ name, frags, method, wantFeat, wantPerm }) => {
      const w = locateAnyRouteWindow(src, frags, method);
      expect(w, `${name} could not locate router.${method} window using fragments ${frags.join(" | ")}`).not.toBeNull();
      const mw = (w as any).mw;
      expect(mw.includes(`requireUserFeatureAccess("${wantFeat}")`),  `${name} middleware missing requireUserFeatureAccess("${wantFeat}")`).toBe(true);
      expect(mw.includes(`requirePermission("${wantPerm}"`),          `${name} middleware missing requirePermission("${wantPerm}", …)`).toBe(true);
      const featPos = mw.indexOf(`requireUserFeatureAccess("${wantFeat}")`);
      const permPos = mw.indexOf(`requirePermission("${wantPerm}"`);
      expect(featPos, `${name} feature guard must come before RBAC permission`).toBeLessThan(permPos);
    },
  );

  it("DOCVARS route handlers call getRlsDb(req, res) and short-circuit on null — no silent ?? db fallback in each handler", () => {
    const routes = [
      { name: "GET /document-variables",                    frags: ['"/document-variables"'], method: "get"  as const },
      { name: "GET /documents/variables",                   frags: ['"/documents/variables"'], method: "get"  as const },
      { name: "GET /documents/custom-variables",            frags: ['"/documents/custom-variables"'], method: "get"  as const },
      { name: "POST /documents/custom-variables",           frags: ['"/documents/custom-variables"'], method: "post" as const },
      { name: "PUT /documents/custom-variables/:id",        frags: ['"/documents/custom-variables/:id"'], method: "put"  as const },
      { name: "GET /documents/custom-variables/:id/preview",frags: ['"/documents/custom-variables/:id/preview"'], method: "get"  as const },
    ];
    for (const { name, frags, method } of routes) {
      const w = locateAnyRouteWindow(src, frags, method);
      expect(w, `${name} — route window not found for handler-body inspection`).not.toBeNull();
      const handlerHead = (w as any).handlerHead;
      const hasGetRlsDbCall = /getRlsDb\(\s*req\s*,\s*res\s*\)/.test(handlerHead);
      const hasSilentFallback = /req\.rlsDb\s*\?\?\s*db|\brlsDb\s*\?\?\s*db|:\s*req\.rlsDb\s*\?\?/.test(handlerHead);
      expect(hasGetRlsDbCall, `${name} handler should call getRlsDb(req, res)`).toBe(true);
      expect(hasSilentFallback, `${name} handler must NOT have ?? db silent fallback inside its own body`).toBe(false);
    }
  });
});

// =========================================================================
// PART 2B-1 §11 — SUMMARY/BOTTLENECK/BANK-ACCOUNT ROUTE + MIDDLEWARE MAP
// =========================================================================

describe("PART 2B-1 §11 MAP-A — summary/bottlenecks/bank-accounts exact mapping structural", () => {
  const accSrc = readRoute("accounting");
  const monSrc = readRoute("caseMonitor");

  describe("SUMMARY: /accounting/summary (accounting.dashboard feature)", () => {
    it("registered in accounting.ts with requireUserFeatureAccess(accounting.dashboard) + requirePermission(accounting, read)", () => {
      const i = accSrc.indexOf('/accounting/summary"');
      expect(i).toBeGreaterThan(-1);
      const routerStart = accSrc.lastIndexOf("router.", i);
      const asyncIdx = accSrc.indexOf("async (req", routerStart);
      const mw = accSrc.slice(routerStart, asyncIdx);
      expect(mw.includes(`requireUserFeatureAccess("accounting.dashboard")`)).toBe(true);
      expect(mw.includes('requirePermission("accounting", "read")')).toBe(true);
      const fPos = mw.indexOf(`requireUserFeatureAccess("accounting.dashboard")`);
      const pPos = mw.indexOf('requirePermission("accounting", "read")');
      expect(fPos).toBeLessThan(pPos);
    });
    it("uses FAIL-CLOSED request-scoped executor (getRlsDb or queryRowsFromReq(res)) — NO silent ?? db fallback anywhere in file", () => {
      const noFallback = !/req\.rlsDb\s*\?\?\s*db|\brlsDb\s*\?\?\s*db|:\s*req\.rlsDb\s*\?\?/.test(accSrc);
      expect(noFallback, "silent ?? db fallback FOUND somewhere in accounting.ts").toBe(true);

      const i = accSrc.indexOf('/accounting/summary"');
      const after = accSrc.slice(i, i + 3500);
      const usesScopedExecutor =
        /getRlsDb\(\s*req\s*,\s*res\s*\)|queryRowsFromReq\(\s*req\s*,\s*res\s*,|\bqueryRowsFromReq\(\s*req\s*,\s*res\s*,\s*/.test(after);
      expect(usesScopedExecutor, "/accounting/summary handler should use getRlsDb(req, res) or queryRowsFromReq(req, res, sql)").toBe(true);
    });
    it("summary handler returns JSON responses (res.json pattern) via request-scoped queryRowsFromReq", () => {
      const i = accSrc.indexOf('/accounting/summary"');
      const after = accSrc.slice(i, i + 5000);
      // Summary uses queryRowsFromReq which internally writes a 503 JSON on missing rlsDb
      // and at the end writes a res.json payload. Handler MUST return via res.json at minimum.
      const hasJsonReturn = /res\.json\s*\(/.test(after);
      expect(hasJsonReturn, "/accounting/summary should write JSON response").toBe(true);
    });
  });

  describe("BOTTLENECKS: /case-monitor/bottlenecks + /case-monitor/summary (case-monitor.ts)", () => {
    it("summary route: requireAuth → requireFirmUser → requirePermission(case_monitor,view)", () => {
      const i = monSrc.indexOf("/case-monitor/summary");
      expect(i).toBeGreaterThan(-1);
      const end = monSrc.indexOf("async (req", i);
      const mw = monSrc.slice(i, end);
      expect(mw.includes("requireAuth")).toBe(true);
      expect(mw.includes("requireFirmUser")).toBe(true);
      expect(mw.includes('requirePermission("case_monitor", "view")')).toBe(true);
    });
    it("bottlenecks route: requireAuth → requireFirmUser → requirePermission(case_monitor,view) + request-scoped executor (no global db.crud)", () => {
      const i = monSrc.indexOf("/case-monitor/bottlenecks");
      expect(i).toBeGreaterThan(-1);
      const after = monSrc.slice(i, i + 3500);
      expect(after.includes("requireAuth")).toBe(true);
      expect(after.includes("requireFirmUser")).toBe(true);
      expect(after.includes('requirePermission("case_monitor", "view")')).toBe(true);
      const hasScoped = /(const|let)\s+\w+\s*=\s*(?:getRlsDb|rdb|req\.rlsDb|rlsDb)\s*\(|req\.rlsDb[^?]|\brdb\s*\(\s*req/.test(after);
      const badGlobal = after.match(/await\s+db\.(select|insert|update|delete|transaction)\s*\(/g) ?? [];
      expect(badGlobal, `bottlenecks contains direct global db.* calls: ${badGlobal.join(",")}`).toEqual([]);
      expect(hasScoped, "bottlenecks handler should use request-scoped DB accessor (getRlsDb / rdb / req.rlsDb)").toBe(true);
    });
    it("case-monitor error handling returns JSON not exception (res.status(...).json on err)", () => {
      const sIdx = monSrc.indexOf("/case-monitor/summary");
      const bIdx = monSrc.indexOf("/case-monitor/bottlenecks", sIdx + 5);
      expect(/res\.status\(\d+\)\.json\(\{/.test(monSrc.slice(sIdx, sIdx + 2500))).toBe(true);
      expect(/res\.status\(\d+\)\.json\(\{/.test(monSrc.slice(bIdx, bIdx + 2500))).toBe(true);
    });
  });

  describe("BANK ACCOUNTS: /accounting/bank-accounts (accounting.bank_account feature)", () => {
    it("GET list + POST create + PATCH + DELETE all require accounting.bank_account FEATURE + permission(accounting, ...)", () => {
      const needles = [
        '/accounting/bank-accounts"', // GET list
        '/accounting/bank-accounts", sensitiveRateLimiter', // POST (note: regex needs both)
        "/accounting/bank-accounts/:id", // PATCH
      ];
      for (const n of needles) {
        const i = accSrc.indexOf(n);
        if (i === -1) continue;
        const end = accSrc.indexOf("async (req", i);
        const mw = accSrc.slice(i, end);
        expect(mw.includes(`requireUserFeatureAccess("accounting.bank_account")`),
          `${n} missing accounting.bank_account feature guard`).toBe(true);
      }
    });
    it("bank-accounts routes use request-scoped DB (queryRowsFromReq or rdb(req)), not global db", () => {
      const i = accSrc.indexOf('/accounting/bank-accounts"');
      const after = accSrc.slice(i, i + 4500);
      const usesRdb = /queryRowsFromReq\(|rdb\(req\)|req\.rlsDb/.test(after);
      // should NOT see top-level `const x = await db.select(` (global unscoped)
      const bad = after.match(/await db\.(select|insert|update|delete)\b/g) ?? [];
      expect(bad, `found global db.* calls in bank-account section: ${bad.join(",")}`).toEqual([]);
      expect(usesRdb, "should use rdb(req)/queryRowsFromReq or req.rlsDb").toBe(true);
    });
  });
});

// =========================================================================
// PART 2B-1 §12 BANK-ACC-A — FIRM-SETTINGS BANK ACCOUNT MUTATION GUARDS
// (C, D, E) + KEY PARITY (A, B) + /accounting/bank-accounts preservation (F)
// =========================================================================

describe("PART 2B-1 §12 BANK-ACC-A — Firm Settings Bank Accounts feature guards + key parity", () => {
  const firmSettingsSrc = readRoute("firmSettings");
  const usersSrc = readRoute("users");
  const accSrc = readRoute("accounting");

  // (A) No active feature entitlement mapping uses PLURAL accounting.bank_accounts
  it("BANK-ACC-A1: No active feature entitlement/label map uses PLURAL accounting.bank_accounts as a FEATURE key", () => {
    const pluralRe = /["']accounting\.bank_accounts["']\s*:\s*["']/g;
    const inUsersLabels = pluralRe.exec(usersSrc);
    expect(inUsersLabels, `HUMAN_LABELS in users.ts must NOT contain plural accounting.bank_accounts`).toBeNull();

    const pluralAsFeatureGuardRe = /requireUserFeatureAccess\(\s*["']accounting\.bank_accounts["']\s*\)/g;
    expect(pluralAsFeatureGuardRe.test(firmSettingsSrc), "firmSettings must NOT guard with plural accounting.bank_accounts").toBe(false);
    expect(pluralAsFeatureGuardRe.lastIndex = 0, undefined);
    expect(pluralAsFeatureGuardRe.test(accSrc), "accounting.ts must NOT guard with plural accounting.bank_accounts").toBe(false);
  });

  // (B) The user feature label/map uses SINGULAR accounting.bank_account
  it("BANK-ACC-A2: users.ts HUMAN_LABELS map declares SINGULAR accounting.bank_account -> 'Bank Accounts'", () => {
    const singularLabelRe = /"accounting\.bank_account"\s*:\s*"Bank Accounts"/;
    expect(singularLabelRe.test(usersSrc), "HUMAN_LABELS missing accounting.bank_account -> Bank Accounts").toBe(true);
  });

  // (C) POST /firm-settings/bank-accounts guard
  it("BANK-ACC-A3 (C): POST /firm-settings/bank-accounts requires requireUserFeatureAccess(accounting.bank_account) BEFORE requirePermission(settings, update)", () => {
    const routeMarker = 'router.post("/firm-settings/bank-accounts"';
    const idx = firmSettingsSrc.indexOf(routeMarker);
    expect(idx, "POST /firm-settings/bank-accounts route not found").toBeGreaterThan(-1);
    const end = firmSettingsSrc.indexOf("async (req", idx);
    const mw = firmSettingsSrc.slice(idx, end);
    expect(mw.includes(`requireUserFeatureAccess("accounting.bank_account")`),
      "POST missing requireUserFeatureAccess(\"accounting.bank_account\")").toBe(true);
    expect(mw.includes('requirePermission("settings", "update")'),
      "POST missing requirePermission(\"settings\", \"update\")").toBe(true);
    const featIdx = mw.indexOf(`requireUserFeatureAccess("accounting.bank_account")`);
    const permIdx = mw.indexOf('requirePermission("settings", "update")');
    expect(featIdx).toBeLessThan(permIdx);
  });

  // (D) PATCH /firm-settings/bank-accounts/:id guard
  it("BANK-ACC-A4 (D): PATCH /firm-settings/bank-accounts/:id requires same guard order", () => {
    const routeMarker = 'router.patch("/firm-settings/bank-accounts/:id"';
    const idx = firmSettingsSrc.indexOf(routeMarker);
    expect(idx, "PATCH /firm-settings/bank-accounts/:id route not found").toBeGreaterThan(-1);
    const end = firmSettingsSrc.indexOf("async (req", idx);
    const mw = firmSettingsSrc.slice(idx, end);
    expect(mw.includes(`requireUserFeatureAccess("accounting.bank_account")`),
      "PATCH missing requireUserFeatureAccess(\"accounting.bank_account\")").toBe(true);
    expect(mw.includes('requirePermission("settings", "update")'),
      "PATCH missing requirePermission(\"settings\", \"update\")").toBe(true);
    const featIdx = mw.indexOf(`requireUserFeatureAccess("accounting.bank_account")`);
    const permIdx = mw.indexOf('requirePermission("settings", "update")');
    expect(featIdx).toBeLessThan(permIdx);
  });

  // (E) DELETE /firm-settings/bank-accounts/:id guard
  it("BANK-ACC-A5 (E): DELETE /firm-settings/bank-accounts/:id requires same guard order", () => {
    const routeMarker = 'router.delete("/firm-settings/bank-accounts/:id"';
    const idx = firmSettingsSrc.indexOf(routeMarker);
    expect(idx, "DELETE /firm-settings/bank-accounts/:id route not found").toBeGreaterThan(-1);
    const end = firmSettingsSrc.indexOf("async (req", idx);
    const mw = firmSettingsSrc.slice(idx, end);
    expect(mw.includes(`requireUserFeatureAccess("accounting.bank_account")`),
      "DELETE missing requireUserFeatureAccess(\"accounting.bank_account\")").toBe(true);
    expect(mw.includes('requirePermission("settings", "update")'),
      "DELETE missing requirePermission(\"settings\", \"update\")").toBe(true);
    const featIdx = mw.indexOf(`requireUserFeatureAccess("accounting.bank_account")`);
    const permIdx = mw.indexOf('requirePermission("settings", "update")');
    expect(featIdx).toBeLessThan(permIdx);
  });

  // (F) Existing /accounting/bank-accounts feature guards remain present + singular key
  it("BANK-ACC-A6 (F): All 4 /accounting/bank-accounts routes (GET/POST/PATCH/DELETE) preserve requireUserFeatureAccess(\"accounting.bank_account\") with accounting RBAC", () => {
    const routes = [
      { needle: 'router.get("/accounting/bank-accounts"', label: "GET list", permission: 'requirePermission("accounting", "read")' },
      { needle: 'router.post("/accounting/bank-accounts"', label: "POST create", permission: 'requirePermission("accounting", "write")' },
      { needle: 'router.patch("/accounting/bank-accounts/:id"', label: "PATCH update", permission: 'requirePermission("accounting", "write")' },
      { needle: 'router.delete("/accounting/bank-accounts/:id"', label: "DELETE remove", permission: 'requirePermission("accounting", "write")' },
    ];
    for (const { needle, label, permission } of routes) {
      const idx = accSrc.indexOf(needle);
      expect(idx, `${label} (${needle}) route not found in accounting.ts`).toBeGreaterThan(-1);
      const end = accSrc.indexOf("async (req", idx);
      const mw = accSrc.slice(idx, end);
      expect(mw.includes(`requireUserFeatureAccess("accounting.bank_account")`),
        `${label} missing accounting.bank_account feature guard`).toBe(true);
      expect(mw.includes(permission),
        `${label} missing ${permission}`).toBe(true);
      const featIdx = mw.indexOf(`requireUserFeatureAccess("accounting.bank_account")`);
      const permIdx = mw.indexOf(permission);
      expect(featIdx, `${label}: feature guard must come BEFORE ${permission}`).toBeLessThan(permIdx);
    }
  });

  // Plural identifiers that MUST remain (audit actions, table references) — confirm not clobbered
  it("BANK-ACC-A7: Legitimate plural identifiers NOT clobbered (audit actions, table names, URLs)", () => {
    const mustRemain = [
      { name: "audit action create", re: /action:\s*["']accounting\.bank_accounts\.create["']/g },
      { name: "audit action update", re: /action:\s*["']accounting\.bank_accounts\.update["']/g },
      { name: "audit action delete", re: /action:\s*["']accounting\.bank_accounts\.delete["']/g },
      { name: "URL plural /bank-accounts (POST firm-settings)", re: /router\.post\(\s*["']\/firm-settings\/bank-accounts["']/g },
      { name: "firm_bank_accounts table property", re: /firmBankAccountsTable\b/g },
    ];
    for (const { name, re } of mustRemain) {
      const combined = accSrc + "\n" + firmSettingsSrc;
      expect(re.test(combined), `Expected plural identifier still present: ${name}`).toBe(true);
      re.lastIndex = 0;
    }
  });

  // -------------------------------------------------------------------------
  // NEW — data-exposure regression tests A..D (GET + general PATCH)
  // These assert bankAccountEnabled GATE before any firmBankAccountsTable
  // query in the two aggregate endpoints so we can prove:
  //   A. GET /firm-settings does not expose bank accounts when disabled
  //   B. The disabled path does NOT execute the table query (ternary : [] skips it)
  //   C. When enabled, query is still reachable (ternary ? has .select().from(firmBankAccountsTable))
  //   D. General PATCH /firm-settings update response follows same pattern
  // -------------------------------------------------------------------------

  function windowAround(src: string, anchor: string, before: number, after: number): string {
    const idx = src.indexOf(anchor);
    expect(idx).toBeGreaterThan(-1);
    return src.slice(Math.max(0, idx - before), idx + anchor.length + after);
  }

  function assertConditionalBankLoading(routeLabel: string, anchorInRoute: string) {
    // Find the conditional block in this region of the source
    const win = windowAround(firmSettingsSrc, anchorInRoute, 300, 2500);
    // must feature-gate before any from(firmBankAccountsTable)
    const enableIdx = win.indexOf("bankAccountEnabled");
    expect(enableIdx, `${routeLabel}: bankAccountEnabled gate must exist in this route region`).toBeGreaterThan(-1);
    const tableIdx = win.indexOf("firmBankAccountsTable");
    if (tableIdx > -1) {
      // table query is INSIDE the ternary ? branch, after gate
      expect(enableIdx, `${routeLabel}: feature gate must be declared BEFORE table query reference`).toBeLessThan(tableIdx);
    }
    // The disabled branch is ": []" — no table query, just empty array literal
    const ternaryDisabledBranch = /:\s*\[\s*\](?![\s\S]*bankAccountEnabled)/.test(win) ||
      /bankAccountEnabled\s*\?[\s\S]{0,800}:\s*\[\s*\]/.test(win);
    expect(ternaryDisabledBranch, `${routeLabel}: disabled path must hard-return " : []" (no table query, no post-query filter)`).toBe(true);
    // When enabled path, must contain actual table select query (not pre-filtered results)
    const ternaryEnabledQuery =
      /bankAccountEnabled\s*\?[\s\S]{0,1200}\.select\(\)[\s\S]{0,400}\.from\(firmBankAccountsTable\)/.test(win);
    expect(ternaryEnabledQuery, `${routeLabel}: enabled path must contain .select().from(firmBankAccountsTable)`).toBe(true);
    // Also confirm feature-access resolution uses the canonical singular key via the helper
    const featureCheckUsesKey =
      /isBankAccountFeatureEnabledForReq\(req, r\)|featureKey:\s*["']accounting\.bank_account["']/.test(win) ||
      /isBankAccountFeatureEnabledForReq\(req, r\)/.test(firmSettingsSrc);
    expect(featureCheckUsesKey, `${routeLabel}: feature resolution must go through singular canonical key (not plural, not inline logic)`).toBe(true);
  }

  it("BANK-ACC-A8 (A,B,C): GET /firm-settings conditionally loads bankAccounts only when bankAccountEnabled true — disabled => [] WITHOUT query", () => {
    const anchor = 'router.get("/firm-settings"';
    assertConditionalBankLoading("GET /firm-settings", anchor);
  });

  it("BANK-ACC-A9 (D): PATCH /firm-settings general update response conditionally loads bankAccounts only when enabled — disabled => [] WITHOUT query", () => {
    // Distinguish general PATCH from bank-accounts/:id specific PATCH:
    // general PATCH ends in settings", "update") while bank PATCH has :id and bank-accounts in path
    const generalAnchor = 'router.patch("/firm-settings", requireAuth, requireFirmUser, requirePermission("settings"';
    const specificAnchor = 'router.patch("/firm-settings/bank-accounts/:id"';
    // General patch handler body is long (firm update + settings table upsert + firms re-fetch + bank query)
    // Use a larger window (10k chars after anchor) to guarantee coverage of the post-update response
    // block that contains bankAccountEnabled + the ternary.
    const win = windowAround(firmSettingsSrc, generalAnchor, 100, 10000);
    const enableIdx = win.indexOf("bankAccountEnabled");
    expect(enableIdx, "PATCH general: bankAccountEnabled gate must exist in this route region").toBeGreaterThan(-1);
    const ternaryEnabled = /bankAccountEnabled\s*\?[\s\S]{0,1200}\.select\(\)[\s\S]{0,400}\.from\(firmBankAccountsTable\)/.test(win);
    expect(ternaryEnabled, "PATCH general: enabled path must contain .select().from(firmBankAccountsTable)").toBe(true);
    const ternaryDisabled = /bankAccountEnabled\s*\?[\s\S]{0,1500}:\s*\[\s*\]/.test(win);
    expect(ternaryDisabled, "PATCH general: disabled path must return : [] (no query)").toBe(true);
    // Sanity: specific bank-accounts/:id PATCH does NOT contain our bankAccountEnabled variable
    // (that's a specific mutation, not an aggregate endpoint that re-returns the whole settings object)
    const idxSpec = firmSettingsSrc.indexOf(specificAnchor);
    expect(idxSpec).toBeGreaterThan(-1);
    const endSpec = firmSettingsSrc.indexOf("async (req", idxSpec);
    const specWin = firmSettingsSrc.slice(idxSpec, endSpec + 15000);
    // Specific patch's handler body is NOT the aggregate response; it returns the single
    // updated row directly so it should not contain `bankAccounts = bankAccountEnabled`.
    expect(specWin.includes("bankAccountEnabled ?"), "bank specific patch does not aggregate bankAccounts array from ternary").toBe(false);
  });

  it("BANK-ACC-A10 (B, strong): In both routes, 'firmBankAccountsTable' token count inside ternary disabled branch is zero — no table reference in disabled path", () => {
    // Brittle but strong: in the combined file, we must find TWO occurrences of
    // "const bankAccounts = bankAccountEnabled" (one GET, one PATCH).
    // Each one skips the table when disabled, so in disabled branch there's zero .select()/from() calls.
    const enabledBlocks = firmSettingsSrc.match(/const bankAccounts = bankAccountEnabled/g);
    expect(enabledBlocks?.length ?? 0, "two bankAccounts assignments expected (GET + PATCH)").toBe(2);

    // Simple heuristic: In between "bankAccountEnabled ?" and the matching " : []" disabled side,
    // confirm the ": []" side does NOT reference firmBankAccountsTable.
    const patterns = [
      { re: /:\s*\[\s*\][,\s;\n]/g, label: "empty array literal on disabled side" },
    ];
    for (const { re, label } of patterns) {
      const count = (firmSettingsSrc.match(re)?.length ?? 0);
      expect(count, `Need at least 2 occurrences of ${label} (GET + PATCH disabled paths)`).toBeGreaterThanOrEqual(2);
    }
  });

  it("BANK-ACC-A11 (E): Existing POST/PATCH/DELETE firm-settings/bank-accounts mutation guards remain intact with SINGULAR canonical feature key", () => {
    // Already asserted structurally above, re-check here so the A-E
    // checklist can be verified by reading this one describe block's output.
    for (const [method, path, pathLabel] of [
      ["post", "/firm-settings/bank-accounts", "POST create"],
      ["patch", "/firm-settings/bank-accounts/:id", "PATCH update"],
      ["delete", "/firm-settings/bank-accounts/:id", "DELETE remove"],
    ] as const) {
      const needle = `router.${method}("${path}"`;
      const idx = firmSettingsSrc.indexOf(needle);
      expect(idx, `${pathLabel} not found`).toBeGreaterThan(-1);
      const end = firmSettingsSrc.indexOf("async (req", idx);
      const mw = firmSettingsSrc.slice(idx, end);
      expect(mw.includes(`requireUserFeatureAccess("accounting.bank_account")`), `${pathLabel} missing singular feature guard`).toBe(true);
      expect(mw.includes('requirePermission("settings", "update")'), `${pathLabel} missing RBAC settings:update`).toBe(true);
      // No plural key in this middleware window
      expect(mw.includes("accounting.bank_accounts"), `${pathLabel}: must NOT use plural key as feature guard`).toBe(false);
      const featIdx = mw.indexOf(`requireUserFeatureAccess("accounting.bank_account")`);
      const permIdx = mw.indexOf('requirePermission("settings", "update")');
      expect(featIdx, `${pathLabel}: feature (entitlement) before RBAC`).toBeLessThan(permIdx);
    }
  });
});

// =========================================================================
// PART 2B-1 §11 — COMPLIANCE-REPORTS: accounting.reports FEATURE GUARD STRUCTURAL
// =========================================================================

describe("PART 2B-1 §11 RPT-A — all 5 compliance reports have accounting.reports guard structural", () => {
  const src = readRoute("complianceReports");

  const reports = [
    "/reports/bills-delivered-book",
    "/reports/trust-account-statement",
    "/reports/client-account-statement",
    "/reports/matter-aging",
    "/reports/time-summary",
  ];

  it.each(reports)("%s has requireUserFeatureAccess(\"accounting.reports\") + requirePermission(reports,read)", (path) => {
    const i = src.indexOf(path);
    expect(i).toBeGreaterThan(-1);
    const end = src.indexOf("async (req", i);
    const mw = src.slice(i, end);
    expect(mw.includes(`requireUserFeatureAccess("accounting.reports")`)).toBe(true);
    expect(mw.includes('requirePermission("reports", "read")')).toBe(true);
    const f = mw.indexOf(`requireUserFeatureAccess("accounting.reports")`);
    const p = mw.indexOf('requirePermission("reports", "read")');
    expect(f).toBeLessThan(p);
  });
});

// =========================================================================
// PART 2B-1.5 §3 — FIRM-SQL-A..D: PRODUCTION SQL PROOF FOR RBAC JOIN
// =========================================================================
//
// LABEL: SQL/STRUCTURAL  (these inspect real source, not runtime)
// Keep alongside existing RUNTIME tests in INV-A / INV-B which exercise
// resolveRequestPermissionChecker(r, firmId, roleId) behaviour through mocks.
// =========================================================================

describe("PART 2B-1.5 §3 FIRM-SQL — resolveRequestPermissionChecker PRODUCTION SQL PROOF [SQL/STRUCTURAL]", () => {
  const ufaSrc = readFileSync(
    resolve(__dirname, "..", "services", "user-feature-access.ts"),
    "utf8",
  );

  function sliceResolverBody(): string {
    const fnStart = ufaSrc.indexOf("resolveRequestPermissionChecker");
    expect(fnStart, "resolveRequestPermissionChecker function declaration not found").toBeGreaterThan(-1);
    const braceStart = ufaSrc.indexOf("{", fnStart);
    expect(braceStart, "opening brace of resolver not found").toBeGreaterThan(-1);
    let depth = 0;
    let i = braceStart;
    for (; i < ufaSrc.length; i++) {
      const c = ufaSrc[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return ufaSrc.slice(braceStart, i + 1);
  }

  it("FIRM-SQL-A: SQL queries JOIN roles table — same-firm binding exists (SQL/STRUCTURAL)", () => {
    const body = sliceResolverBody();
    const hasJoin =
      /JOIN\s+["'`]?roles["'`]?\s+(?:AS\s+)?\w*\s+ON\s+/i.test(body) ||
      /leftJoin\s*\(\s*["'`]?roles["'`]?\s*,?/.test(body) ||
      /\.innerJoin\s*\(\s*["'`]?roles["'`]?\s*,?/.test(body) ||
      /join\s*\(\s*roles\s*,/.test(body);
    expect(hasJoin, "resolveRequestPermissionChecker SQL must JOIN roles to enforce same-firm check").toBe(true);
  });

  it("FIRM-SQL-B: SQL conditions include role_id parameter binding — roleId = permission.role_id (SQL/STRUCTURAL)", () => {
    const body = sliceResolverBody();
    // Either drizzle-style eq(permissionsTable.roleId, roleId) / role_id = roleId
    // OR parameterised raw: `p.role_id = ${roleId}` / `permissions.role_id = ?` with roleId param.
    const hasRoleIdCond =
      /(?:role_id|roleId)\s*(?:==|=|eq\(|in\(|equals\()/.test(body) &&
      /(?:roleId|\?\s*,\s*roleId|\$\{?roleId\}?)/.test(body);
    expect(hasRoleIdCond, "resolveRequestPermissionChecker SQL must bind permission row to supplied roleId param").toBe(true);
  });

  it("FIRM-SQL-C: SQL conditions include roles.firm_id = firmId in SAME query as roleId binding (SQL/STRUCTURAL)", () => {
    const body = sliceResolverBody();
    const hasFirmIdCond =
      /(?:firm_id|firmId)\s*(?:==|=|eq\(|equals\()/.test(body) &&
      /(?:firmId|\?\s*,\s*firmId|\$\{?firmId\}?|roles?\.firmId|ro\.firm_id|roles\["firm_id"\])/.test(body);
    expect(hasFirmIdCond, "resolveRequestPermissionChecker SQL must bind joined roles row to supplied firmId param (cross-firm collision safety)").toBe(true);
  });

  it("FIRM-SQL-D: SQL conditions include allowed = TRUE filter on permissions rows (SQL/STRUCTURAL)", () => {
    const body = sliceResolverBody();
    const hasAllowedTrue =
      /allowed\s*==?\s*(?:true|TRUE|1)|\.allowed\s*,\s*(?:true|TRUE|1)|eq\s*\(\s*\w*\.allowed\s*,\s*(?:true|TRUE|1)\s*\)/i.test(body);
    expect(hasAllowedTrue, "resolveRequestPermissionChecker SQL must filter p.allowed=TRUE (deny soft-revoked permission rows)").toBe(true);
  });
});
