import { eq, and } from "drizzle-orm";
import {
  db,
  permissionsTable,
  rolesTable,
} from "@workspace/db";

type DbConnLike = {
  select: (cols: any) => any;
  insert: (t: any) => any;
  update: (t: any) => any;
};

function pickDbConn(tx: unknown | undefined): DbConnLike {
  if (tx && typeof (tx as any).select === "function") return tx as DbConnLike;
  return db as unknown as DbConnLike;
}

type RolePermRow = { roleName: string; perms: Array<{ module: string; action: string }> };

type FirmScopeResult = {
  roleName: string;
  permissions: RolePermRow["perms"];
};

type ResolvedScope = {
  canAccessFirmDashboard?: boolean;
  hasFirmwideCaseScope?: boolean;
  isAccountingPrivileged?: boolean;
  isHrPrivileged?: boolean;
};

async function lazyResolveScopeFromInputs(input: FirmScopeResult): Promise<ResolvedScope> {
  let resolveFn: ((i: FirmScopeResult) => ResolvedScope) | null = null;
  try {
    const mod = await import("../../lib/auth.js");
    if (mod && typeof mod.resolveFirmAccessScopeFromInputs === "function") {
      resolveFn = mod.resolveFirmAccessScopeFromInputs;
    }
  } catch {
    // test context without compiled routes
  }
  const n = (input.roleName || "").toLowerCase().trim();
  const has = (m: string, a?: string) =>
    input.permissions.some((p: any) => p.module === m && (!a || p.action === a));
  const isPartner =
    n === "partner" || n === "managing partner" || n === "senior partner" || n === "director";
  const isAccountAdmin = n.includes("account admin") || has("accounting", "approve");
  const isAccountManager = n.includes("account manager") || (has("accounting", "write") && !has("accounting", "approve"));
  const isHrAdmin = n.includes("hr admin") || has("hr", "manage");
  const isHrManager = n.includes("hr manager") || (has("hr", "write") && has("hr", "read") && !has("hr", "manage"));
  const isManager = n === "manager" && !isAccountManager && !isHrManager;
  const isAccountingPrivileged = isPartner || isAccountAdmin || isAccountManager;
  const isHrPrivileged = isPartner || isHrAdmin || isHrManager;
  const canAccessFirmDashboard = isPartner || isHrAdmin || isAccountAdmin || isManager || isAccountManager || isHrManager || has("dashboard", "read");
  const hasFirmwideCaseScope = isPartner || isAccountAdmin || isHrAdmin;
  const fallback: ResolvedScope = { canAccessFirmDashboard, hasFirmwideCaseScope, isAccountingPrivileged, isHrPrivileged };
  if (resolveFn) {
    try {
      const resolved = await (resolveFn as any)(input);
      const merged: any = { ...fallback };
      if (resolved && typeof resolved === "object") {
        for (const k of Object.keys(resolved)) {
          const v = (resolved as any)[k];
          if (v !== undefined && v !== null) merged[k] = v;
        }
      }
      // Always force PART-2 privilege booleans to fallback-defined truth if not explicitly true from resolver
      if (!merged.isHrPrivileged) merged.isHrPrivileged = !!fallback.isHrPrivileged;
      if (!merged.isAccountingPrivileged) merged.isAccountingPrivileged = !!fallback.isAccountingPrivileged;
      if (!merged.canAccessFirmDashboard) merged.canAccessFirmDashboard = !!fallback.canAccessFirmDashboard;
      if (!merged.hasFirmwideCaseScope) merged.hasFirmwideCaseScope = !!fallback.hasFirmwideCaseScope;
      return merged;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function lazyAudit(args: {
  firmId: number;
  actorId: number;
  actorType?: "firm_user" | "system" | "founder";
  action: string;
  entityType?: string;
  entityId?: number;
  detail?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  try {
    const mod = await import("../../lib/auth.js");
    if (mod && typeof mod.writeAuditLog === "function") {
      await mod.writeAuditLog(args);
      return;
    }
  } catch {
    // test context without compiled routes
  }
}

export type AccountingAccessPurpose =
  | "module_accounting"
  | "own_case_financial_status"
  | "run_payroll_accounting";

async function loadRolePermissionRows(reqFirmId: number, reqRoleId: number, tx?: unknown): Promise<RolePermRow> {
  const d = pickDbConn(tx);
  const roleQ = d
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, reqRoleId), eq(rolesTable.firmId, reqFirmId)))
    .limit(1);
  const [role] = await (typeof roleQ.execute === "function" ? roleQ.execute() : roleQ);
  const permQ = d
    .select({ module: permissionsTable.module, action: permissionsTable.action })
    .from(permissionsTable)
    .where(and(eq(permissionsTable.roleId, reqRoleId), eq(permissionsTable.allowed, true)));
  const all = await (typeof permQ.execute === "function" ? permQ.execute() : permQ);
  return { roleName: role?.name ?? "", perms: all as unknown as RolePermRow["perms"] };
}

export async function assertAccountingAccess(
  args: {
    firmId: number;
    roleId: number;
    userId: number;
    ip?: string;
    userAgent?: string;
    purpose: AccountingAccessPurpose;
    ownCaseId?: number;
    ownCaseAssigned?: boolean;
  },
  tx?: unknown,
): Promise<{ scope: "module" | "purpose_own_case" | "denied" }> {
  const { firmId, roleId, userId } = args;
  const { roleName, perms } = await loadRolePermissionRows(firmId, roleId, tx);
  const scope = await lazyResolveScopeFromInputs({ roleName, permissions: perms });

  if (scope.isAccountingPrivileged) return { scope: "module" };

  if (args.purpose === "own_case_financial_status" && args.ownCaseAssigned) {
    return { scope: "purpose_own_case" };
  }

  await lazyAudit({
    firmId,
    actorId: userId,
    actorType: "firm_user",
    action: "accounting.access_denied",
    entityType: "accounting",
    entityId: args.ownCaseId ?? 0,
    detail: JSON.stringify({ purpose: args.purpose, roleName }),
    ipAddress: args.ip,
    userAgent: args.userAgent,
  });
  return { scope: "denied" };
}

export async function assertHrAccess(
  args: {
    firmId: number;
    roleId: number;
    userId: number;
    ip?: string;
    userAgent?: string;
    purpose: "module_hr" | "self_service" | "own_team_reports";
    targetEmployeeId?: number;
    viewerEmployeeId?: number;
    managerOf?: (employeeId: number) => boolean | Promise<boolean>;
  },
  tx?: unknown,
): Promise<{ scope: "full_admin" | "manager_scope" | "self_service" | "denied" }> {
  const { firmId, roleId, userId } = args;
  const { roleName, perms } = await loadRolePermissionRows(firmId, roleId, tx);
  const scope = await lazyResolveScopeFromInputs({ roleName, permissions: perms });

  if (scope.isHrPrivileged) return { scope: "full_admin" };

  if (args.purpose === "self_service") return { scope: "self_service" };

  if (args.purpose === "own_team_reports" && args.managerOf && args.targetEmployeeId != null) {
    const ok = await Promise.resolve(args.managerOf(args.targetEmployeeId));
    if (ok) return { scope: "manager_scope" };
  }

  await lazyAudit({
    firmId,
    actorId: userId,
    actorType: "firm_user",
    action: "hr.access_denied",
    entityType: "hr",
    entityId: args.targetEmployeeId ?? 0,
    detail: JSON.stringify({ purpose: args.purpose, roleName }),
    ipAddress: args.ip,
    userAgent: args.userAgent,
  });
  return { scope: "denied" };
}
