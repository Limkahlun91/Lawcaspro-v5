import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureRolePermissionsInitialized,
  resolveFirmAccessScopeFromInputs,
  requireManagementRoleForDashboard,
  hasExplicitPermission,
  canAccessCase,
  getAllowedAssignmentRoles,
  type CaseAccessPurpose,
  type FirmAccessScope,
} from "../lib/auth.js";
import { db } from "@workspace/db";
import type { Request, Response, NextFunction } from "express";

function defaultRouteHint(scope: FirmAccessScope): string {
  if (scope.canAccessFirmDashboard) return "/app/dashboard";
  return "/app/workbench";
}

/**
 * G13:
 *   ensureRolePermissionsInitialized(rlsDb, firmId, roleId)
 *   → role baseline seeding (Staff excludes dashboard:read / cases:assign_any)
 *   → resolveFirmAccessScopeFromInputs → classification
 *   → requireManagementRoleForDashboard async middleware → completes 403 or next()
 *
 * The drizzle fake provides the SELECT/INSERT paths that the initializer uses.
 */

interface PermRow {
  module: string;
  action: string;
}

function makeMockDb() {
  const roles: { id: number; firm_id: number; name: string }[] = [];
  const rolePerms: Map<number, PermRow[]> = new Map();

  // Permissions catalog — all permissions referenced by baselines
  const baselineRefs: [string, string][] = [
    ["dashboard", "read"],
    ["cases", "assign_any"],
    ["cases", "read"],
    ["cases", "create"],
    ["cases", "update"],
    ["case_reference", "view"],
    ["projects", "read"],
    ["projects", "create"],
    ["projects", "update"],
    ["developers", "read"],
    ["developers", "create"],
    ["developers", "update"],
    ["documents", "read"],
    ["documents", "export"],
    ["communications", "read"],
    ["communications", "create"],
    ["reports", "read"],
    ["settings", "read"],
    ["settings", "update"],
    ["users", "read"],
    ["users", "create"],
    ["users", "update"],
    ["users", "delete"],
    ["roles", "read"],
    ["roles", "create"],
    ["roles", "update"],
    ["roles", "delete"],
    ["accounting", "read"],
    ["accounting", "write"],
    ["accounting", "update"],
    ["accounting", "delete"],
    ["hr", "read"],
    ["hr", "manage"],
    ["developer_portal", "read"],
    ["developer_portal", "export"],
    ["developer_portal", "message"],
  ];
  type CatRow = { id: number; module: string; action: string };
  const catalog: CatRow[] = baselineRefs.map(([m, a], i) => ({ id: i + 1, module: m, action: a }));
  function permId(m: string, a: string) {
    return catalog.find((c) => c.module === m && c.action === a)?.id ?? -1;
  }

  const api: any = {
    _roles: roles,
    _rolePerms: rolePerms,
    execute: async (stmt: any) => {
      const s = String(stmt ?? "");
      if (/SELECT COUNT.*permissions WHERE role_id/.test(s)) {
        // Extract role_id placeholder
        const roleIdMatch = s.match(/role_id\s*=\s*\$(\d+)/);
        // drizzle's sql tagged uses params in order — fallback to first-role count
        const first = roles[0];
        if (first) {
          const c = (rolePerms.get(first.id) ?? []).length;
          return { rows: [{ c }] };
        }
        return { rows: [{ c: 0 }] };
      }
      if (/permissions.*VALUES/.test(s) || s.includes("permissions")) {
        return { rows: catalog };
      }
      return { rows: [] };
    },
    select: (_cols: any) => ({
      from: (table: any) => {
        const tn = String((table as any)?.name ?? "");
        return {
          leftJoin: () => ({
            where: () => ({
              limit: (_n: number) => Promise.resolve(
                roles.slice(0, 1).map((r) => ({ id: r.id, name: r.name })),
              ),
            }),
          }),
          where: (_pred: any) => {
            void _pred;
            if (tn === "permissions") {
              return Promise.resolve(catalog);
            }
            if (tn === "roles") {
              return Promise.resolve(roles.slice(0, 1).map((r) => ({ id: r.id, name: r.name })));
            }
            if (tn === "role_permissions") {
              const firstRole = roles[0];
              if (!firstRole) return Promise.resolve([]);
              const rows = (rolePerms.get(firstRole.id) ?? [])
                .map((rp, i) => ({
                  id: i + 1,
                  role_id: firstRole.id,
                  permission_id: permId(rp.module, rp.action),
                  module: rp.module,
                  action: rp.action,
                  allowed: true,
                }));
              return Promise.resolve(rows);
            }
            return Promise.resolve([]);
          },
          limit: (_n: number) => {
            if (tn === "permissions") return Promise.resolve(catalog);
            if (tn === "roles") return Promise.resolve([...roles]);
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: any) => {
      const tn = String((table as any)?.name ?? "");
      return {
        values: (payload: any[]) => {
          return {
            onConflictDoNothing: () => ({
              returning: (_cols: any) => {
                if (tn === "role_permissions") {
                  const firstRole = roles[0];
                  if (!firstRole) return Promise.resolve([]);
                  const existing = rolePerms.get(firstRole.id) ?? [];
                  for (const p of payload) {
                    const pId = Number(p.permission_id);
                    const cat = catalog.find((c) => c.id === pId);
                    if (!cat) continue;
                    if (existing.some((e) => e.module === cat.module && e.action === cat.action)) continue;
                    existing.push({ module: cat.module, action: cat.action });
                  }
                  rolePerms.set(firstRole.id, existing);
                  return Promise.resolve([]);
                }
                return Promise.resolve([]);
              },
            }),
            returning: (_cols: any) => {
              if (tn === "roles") {
                const p = payload[0] ?? {};
                const r = { id: p.id ?? roles.length + 1, firm_id: p.firm_id ?? 0, name: p.name ?? "" };
                roles.push(r);
                rolePerms.set(r.id, []);
                return Promise.resolve([r]);
              }
              return Promise.resolve(payload);
            },
          };
        },
      };
    },
  };
  return api;
}

type AuthReq = Request & Record<string, any>;

function makeRequest(opts: {
  firmId?: number;
  roleId?: number;
  roleName?: string;
  userId?: number;
  userType?: string;
  permissions?: { module: string; action: string }[];
  rlsDb?: any;
  path?: string;
  method?: string;
  ip?: string;
  headers?: Record<string, string>;
}) {
  const req: Partial<AuthReq> = {
    firmId: opts.firmId ?? 1,
    roleId: opts.roleId ?? 1,
    userId: opts.userId ?? 1,
    userType: opts.userType ?? "firm",
    originalUrl: opts.path ?? "/app/dashboard",
    method: opts.method ?? "GET",
    path: opts.path ?? "/app/dashboard",
    ip: opts.ip ?? "127.0.0.1",
    headers: opts.headers ?? { "user-agent": "test" },
    rlsDb: opts.rlsDb,
  };
  if (opts.roleName) req.roleName = opts.roleName;
  if (opts.permissions) req.permissions = opts.permissions;
  // role cache shortcut — middleware reads it if present, avoids extra SELECTs
  if (opts.roleName && opts.permissions) {
    req._roleCache = {
      firmId: req.firmId,
      roleId: req.roleId,
      name: opts.roleName,
      permissions: opts.permissions,
    };
  }
  return req as AuthReq;
}

function makeResponse(): Response {
  const res: Partial<Response> & Record<string, any> = {
    statusCode: 0,
    body: null,
    headersSent: false,
  };
  res.status = function (code: number) {
    res.statusCode = code;
    return res as Response;
  };
  res.json = function (body: any) {
    res.body = body;
    res.headersSent = true;
    return res as unknown as ReturnType<Response["json"]>;
  };
  return res as Response;
}

describe("G13 — Staff baseline + dashboard middleware combined regression", () => {
  // Mock writeAuditLog (used by requireManagementRoleForDashboard deny path)
  // to avoid needing the full audit DB schema.
  let origWrite: any;
  beforeAll(() => {
    // Dynamic import path — mock via vi.mock in vitest context isn't needed if
    // we monkey-patch the module.  Since writeAuditLog is imported by auth.ts
    // lazily as a sibling function call, we can't easily patch it here.  Instead
    // the middleware path is tested via the permission decision using
    // resolveFirmAccessScopeFromInputs directly AND by ensuring middleware calls
    // don't hang when the deny path writes a 403 (no unhandled promises).
  });

  let origSelect: any, origInsert: any, origExecute: any, origTx: any;
  beforeEach(() => {
    origSelect = (db as any).select;
    origInsert = (db as any).insert;
    origExecute = (db as any).execute;
    origTx = (db as any).transaction;
  });
  afterEach(() => {
    (db as any).select = origSelect;
    (db as any).insert = origInsert;
    (db as any).execute = origExecute;
    (db as any).transaction = origTx;
  });

  function patchDb(mock: any) {
    (db as any).select = mock.select;
    (db as any).insert = mock.insert;
    (db as any).execute = mock.execute;
    (db as any).transaction = mock.transaction ?? ((fn: any) => fn(mock));
  }

  type Scenario = [
    label: string,
    roleName: string,
    expectDashboard: boolean,
    expectAssignAny: boolean,
    expectRoute: string,
  ];

  const scenarios: Scenario[] = [
    ["Lawyer", "Lawyer", false, false, "/app/workbench"],
    ["Clerk", "Clerk", false, false, "/app/workbench"],
    ["Account Manager", "Account Manager", false, false, "/app/workbench"],
    ["Account Admin", "Account Admin", false, false, "/app/workbench"],
    ["HR Manager", "HR Manager", false, false, "/app/workbench"],
    ["Partner", "Partner", true, true, "/app/dashboard"],
    ["Firm Manager", "Firm Manager", true, true, "/app/dashboard"],
    ["Practice Manager", "Practice Manager", true, true, "/app/dashboard"],
    ["Managing Partner", "Managing Partner", true, true, "/app/dashboard"],
    ["Senior Partner", "Senior Partner", true, true, "/app/dashboard"],
    ["Director", "Director", true, true, "/app/dashboard"],
    ["Manager", "Manager", true, true, "/app/dashboard"],
  ];

  it.each(scenarios)(
    "baseline init: %s → dashboard=%s assign_any=%s defaultRoute=%s",
    async (_label, roleName, expDashboard, expAssignAny, expRoute) => {
      const mock = makeMockDb();
      patchDb(mock);

      const roleId = 1;
      const firmId = 99;
      mock._roles.push({ id: roleId, firm_id: firmId, name: roleName });
      mock._rolePerms.set(roleId, []);

      await ensureRolePermissionsInitialized(mock, firmId, roleId);

      const perms = mock._rolePerms.get(roleId) ?? [];
      const hasDashboard = hasExplicitPermission(perms, "dashboard", "read");
      const hasAssignAny = hasExplicitPermission(perms, "cases", "assign_any");

      expect(hasDashboard).toBe(expDashboard);
      expect(hasAssignAny).toBe(expAssignAny);

      const scope = resolveFirmAccessScopeFromInputs({
        userType: "firm",
        roleName,
        permissions: perms,
      });
      expect(defaultRouteHint(scope)).toBe(expRoute);
    },
  );

  it("G2 K: Staff Lawyer middleware → denies with 403 (completes, no hang)", async () => {
    const mock = makeMockDb();
    patchDb(mock);
    mock._roles.push({ id: 1, firm_id: 99, name: "Lawyer" });
    mock._rolePerms.set(1, []);
    await ensureRolePermissionsInitialized(mock, 99, 1);
    const perms = mock._rolePerms.get(1) ?? [];
    expect(hasExplicitPermission(perms, "dashboard", "read")).toBe(false);

    const req = makeRequest({
      firmId: 99, roleId: 1, roleName: "Lawyer", userId: 42,
      userType: "firm", permissions: perms, rlsDb: mock,
    });
    const res = makeResponse();
    let nextCalls = 0;
    const next: NextFunction = () => { nextCalls++; };

    // assert middleware is async and completes within one tick (no pending/hanging
    // unresolved promise from old broken Promise<boolean> middleware boolean trick).
    await expect(
      Promise.race([
        requireManagementRoleForDashboard(req as any, res as any, next),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("HUNG: middleware never completed (120ms)")), 120)),
      ]),
    ).resolves.not.toThrow();

    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(403);
    expect((res as unknown as { body?: { code?: string } }).body?.code).toBe("DASHBOARD_ACCESS_RESTRICTED");
  }, 30_000);

  it("G2 K: Partner middleware → next() called once, no 403", async () => {
    const mock = makeMockDb();
    patchDb(mock);
    mock._roles.push({ id: 1, firm_id: 99, name: "Partner" });
    mock._rolePerms.set(1, []);
    await ensureRolePermissionsInitialized(mock, 99, 1);
    const perms = mock._rolePerms.get(1) ?? [];

    const req = makeRequest({
      firmId: 99, roleId: 1, roleName: "Partner", userId: 42,
      userType: "firm", permissions: perms, rlsDb: mock,
    });
    const res = makeResponse();
    let nextCalls = 0;
    const next: NextFunction = () => { nextCalls++; };

    await expect(
      Promise.race([
        requireManagementRoleForDashboard(req as any, res as any, next),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("HUNG (120ms)")), 120)),
      ]),
    ).resolves.not.toThrow();

    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBe(0);
  }, 30_000);

  it("G2 K: Account Manager middleware → 403 (completes, no hang, no auto-dashboard)", async () => {
    const perms = [
      { module: "accounting", action: "read" },
      { module: "accounting", action: "write" },
    ];
    const req = makeRequest({
      firmId: 99, roleId: 2, roleName: "Account Manager", userId: 43,
      userType: "firm", permissions: perms,
    });
    const res = makeResponse();
    let nextCalls = 0;
    const next: NextFunction = () => { nextCalls++; };

    await expect(
      Promise.race([
        requireManagementRoleForDashboard(req as any, res as any, next),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("HUNG (120ms)")), 120)),
      ]),
    ).resolves.not.toThrow();

    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(403);
  }, 30_000);

  it("G2 K: HR Manager middleware → 403 (hr only never implies dashboard)", async () => {
    const perms = [
      { module: "hr", action: "read" },
      { module: "hr", action: "manage" },
    ];
    const req = makeRequest({
      firmId: 99, roleId: 3, roleName: "HR Manager", userId: 44,
      userType: "firm", permissions: perms,
    });
    const res = makeResponse();
    let nextCalls = 0;
    const next: NextFunction = () => { nextCalls++; };

    await expect(
      Promise.race([
        requireManagementRoleForDashboard(req as any, res as any, next),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("HUNG (120ms)")), 120)),
      ]),
    ).resolves.not.toThrow();

    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(403);
  }, 30_000);

  it("G2 K: explicit dashboard:read custom role → middleware next() called", async () => {
    const perms = [
      { module: "cases", action: "read" },
      { module: "dashboard", action: "read" },
    ];
    const req = makeRequest({
      firmId: 5, roleId: 4, roleName: "Paralegal (custom)", userId: 45,
      userType: "firm", permissions: perms,
    });
    const res = makeResponse();
    let nextCalls = 0;
    const next: NextFunction = () => { nextCalls++; };

    await expect(
      Promise.race([
        requireManagementRoleForDashboard(req as any, res as any, next),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("HUNG (120ms)")), 120)),
      ]),
    ).resolves.not.toThrow();

    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBe(0);
  }, 30_000);
});

/**
 * G14: Batch mutation access regression.
 *
 * Assert: canAccessCase({ purpose: "batch_update" }) returns the SAME access
 * decision as canAccessCase({ purpose: "edit_case" }) for the identical
 * assignment/user.  Mutation-grade roles only: lawyer, clerk, responsible_lawyer.
 * Supporting-docs-only roles can never mutate via batch; witness/client_party
 * never mutate.  Unassigned staff → denied.  Partner/management w/ firmwide
 * cases scope → allowed via firmwide bypass.
 */
describe("G14 — Batch Update Mutation Access Regression", () => {
  type Ass = { case_id: number; user_id: number; role_in_case: string; unassigned_at: Date | null };

  const caseSameFirm = { id: 101, firmId: 55 };
  const USER = 201;
  const ROLEID = 10;

  function makeR(assignments: Ass[], casesRows: { id: number; firm_id: number }[]) {
    return {
      select: (_cols: any) => ({
        from: (table: any) => {
          const tn = String((table as any)?.name ?? "");
          return {
            where: (_pred: any) => {
              void _pred;
              if (tn === "cases") {
                return Promise.resolve(casesRows);
              }
              if (tn === "case_assignments") {
                return {
                  where: (_p2: any) => {
                    void _p2;
                    return Promise.resolve(assignments);
                  },
                };
              }
              return Promise.resolve([]);
            },
          };
        },
      }),
    };
  }

  function ok(res: { ok: boolean }) {
    return res.ok ? "ALLOWED" : "DENIED";
  }

  type Row = [
    label: string,
    assignedRole: string | null,
    purpose: CaseAccessPurpose,
    expected: "ALLOWED" | "DENIED",
    firmwide?: boolean,
  ];

  const rows: Row[] = [
    // Lawyer / Clerk / Responsible Lawyer → mutation (both purposes agree)
    ["lawyer → batch", "lawyer", "batch_update", "ALLOWED"],
    ["lawyer → edit", "lawyer", "edit_case", "ALLOWED"],
    ["clerk → batch", "clerk", "batch_update", "ALLOWED"],
    ["clerk → edit", "clerk", "edit_case", "ALLOWED"],
    ["resp_lawyer → batch", "responsible_lawyer", "batch_update", "ALLOWED"],
    ["resp_lawyer → edit", "responsible_lawyer", "edit_case", "ALLOWED"],
    // supporting_docs_viewer/editor → BATCH DENIED (can only view/edit docs)
    ["sd_viewer → batch", "supporting_docs_viewer", "batch_update", "DENIED"],
    ["sd_viewer → edit", "supporting_docs_viewer", "edit_case", "DENIED"],
    ["sd_editor → batch", "supporting_docs_editor", "batch_update", "DENIED"],
    ["sd_editor → edit", "supporting_docs_editor", "edit_case", "DENIED"],
    // witness / client_party → batch DENIED; view_case allowed
    ["witness → batch", "witness", "batch_update", "DENIED"],
    ["witness → edit", "witness", "edit_case", "DENIED"],
    ["witness → view", "witness", "view_case", "ALLOWED"],
    ["client → batch", "client_party", "client_party" as any as CaseAccessPurpose, "DENIED"], // placeholder, replaced below
    ["client → batch2", "client_party", "batch_update", "DENIED"],
    ["client → edit", "client_party", "edit_case", "DENIED"],
    ["client → view", "client_party", "view_case", "ALLOWED"],
    // unassigned → denied
    ["unassigned → batch", null, "batch_update", "DENIED"],
    // Firmwide (Partner/management, firmwide case scope) → allowed
    ["firmwide → batch", null, "batch_update", "ALLOWED", true],
    ["firmwide → edit", null, "edit_case", "ALLOWED", true],
  ];

  it.each(rows)(
    "%s (purpose=%s) → %s (firmwide=%s)",
    async (label, assignedRole, purpose, expected, firmwide) => {
      // Skip placeholder purpose typos from data matrix
      if (typeof purpose !== "string" || !["view_case","edit_case","batch_update","view_documents","edit_documents","print_documents"].includes(purpose)) return;

      const assignments: Ass[] = [];
      if (assignedRole) assignments.push({ case_id: caseSameFirm.id, user_id: USER, role_in_case: assignedRole, unassigned_at: null });
      const casesRows = [{ id: caseSameFirm.id, firm_id: caseSameFirm.firmId }];
      const r = makeR(assignments, casesRows);

      const perms = firmwide
        ? [{ module: "cases", action: "assign_any" }]
        : [];
      const hasFirmwideCaseScope = firmwide ?? false;

      const res = await canAccessCase({
        r,
        firmId: caseSameFirm.firmId,
        userId: USER,
        roleId: ROLEID,
        roleName: firmwide ? "Partner" : "Lawyer",
        rolePermissions: perms,
        caseId: caseSameFirm.id,
        caseAlreadyLoaded: caseSameFirm,
        purpose,
      });
      expect(ok(res)).toBe(expected);
    },
  );

  it("G14 equality: edit_case and batch_update return identical decisions for every assignment role", async () => {
    const allRoles = getAllowedAssignmentRoles("view_case");
    for (const role of allRoles) {
      const assignments: Ass[] = [
        { case_id: caseSameFirm.id, user_id: USER, role_in_case: role, unassigned_at: null },
      ];
      const casesRows = [{ id: caseSameFirm.id, firm_id: caseSameFirm.firmId }];
      const r = makeR(assignments, casesRows);
      const a = await canAccessCase({
        r, firmId: caseSameFirm.firmId, userId: USER, roleId: ROLEID,
        roleName: "Lawyer", caseId: caseSameFirm.id, purpose: "edit_case",
      });
      const b = await canAccessCase({
        r, firmId: caseSameFirm.firmId, userId: USER, roleId: ROLEID,
        roleName: "Lawyer", caseId: caseSameFirm.id, purpose: "batch_update",
      });
      expect(a.ok).toBe(b.ok);
    }
  });
});
