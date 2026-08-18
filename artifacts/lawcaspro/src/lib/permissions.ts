import type { AuthUser } from "@workspace/api-client-react";

export type Permission = { module: string; action: string };

export type PermissionLoadState =
  | "NOT_LOADED"
  | "READY"
  | "TRANSIENT_ERROR"
  | "DENIED";

const ACCOUNTING_ACTIONS = new Set([
  "read",
  "write",
  "create",
  "edit",
  "review",
  "approve",
  "mark_received",
  "mark_paid",
  "cancel",
  "reopen",
  "export",
  "view_audit",
  "manage_settings",
  "override_sla",
]);

export function isAccountingRoleAllowed(roleName: string | null | undefined): boolean {
  const rn = String(roleName ?? "").trim();
  const rnl = rn.toLowerCase();
  if (rnl === "partner") return true;
  if (rnl === "account admin") return true;
  if (rnl === "account manager") return true;
  return false;
}

export function getPermissions(user: AuthUser | null): Permission[] {
  if (!user) return [];
  const u = user as unknown as { permissions?: unknown };
  if (!Array.isArray(u.permissions)) return [];
  return u.permissions
    .filter((p): p is { module: unknown; action: unknown } => !!p && typeof p === "object" && "module" in p && "action" in p)
    .map((p) => ({ module: String(p.module), action: String(p.action) }));
}

export function getPermissionLoadState(user: AuthUser | null): PermissionLoadState {
  if (!user) return "NOT_LOADED";
  const u = user as unknown as { permissions?: unknown };
  if (u.permissions === undefined) return "NOT_LOADED";
  if (!Array.isArray(u.permissions)) return "DENIED";
  return "READY";
}

export type PermissionErrorCategory =
  | "EXPLICIT_DENY_403"
  | "NOT_FOUND_404"
  | "UNAUTHORIZED_401"
  | "TRANSIENT_5XX"
  | "TRANSIENT_TIMEOUT"
  | "TRANSIENT_NETWORK"
  | "DB_BUSY"
  | "DB_UNAVAILABLE"
  | "CLIENT_OTHER"
  | "UNKNOWN";

export function classifyPermissionError(err: unknown): PermissionErrorCategory {
  if (!err || typeof err !== "object") return "UNKNOWN";
  const rec = err as Record<string, unknown>;
  const status = typeof rec.status === "number" ? rec.status : undefined;
  const code = typeof rec.code === "string" ? rec.code : undefined;
  const name = typeof rec.name === "string" ? rec.name : undefined;
  if (name === "RequestTimeoutError" || name === "TimeoutError" || name === "AbortError") {
    return "TRANSIENT_TIMEOUT";
  }
  const msg = typeof (rec as { message?: unknown }).message === "string" ? String((rec as { message?: unknown }).message).toLowerCase() : "";
  if (
    msg.includes("networkerror") ||
    msg.includes("failed to fetch") ||
    msg.includes("network error") ||
    msg.includes("load failed")
  ) {
    return "TRANSIENT_NETWORK";
  }
  if (typeof code === "string") {
    if (code === "DB_BUSY") return "DB_BUSY";
    if (code === "DB_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "DB_UNAVAILABLE";
  }
  if (typeof status === "number") {
    if (status === 401) return "UNAUTHORIZED_401";
    if (status === 403) return "EXPLICIT_DENY_403";
    if (status === 404) return "NOT_FOUND_404";
    if (status >= 500) return "TRANSIENT_5XX";
    if (status >= 400) return "CLIENT_OTHER";
  }
  return "UNKNOWN";
}

export function isTransientErrorCategory(cat: PermissionErrorCategory): boolean {
  return (
    cat === "TRANSIENT_5XX" ||
    cat === "TRANSIENT_TIMEOUT" ||
    cat === "TRANSIENT_NETWORK" ||
    cat === "DB_BUSY" ||
    cat === "DB_UNAVAILABLE"
  );
}

export function isHrRole(roleName: string | null | undefined): "manager" | "admin" | "employee" | null {
  const rn = String(roleName ?? "").trim().toLowerCase();
  if (rn === "hr manager") return "manager";
  if (rn === "hr admin") return "admin";
  if (rn === "hr employee") return "employee";
  return null;
}

export function hasPermission(user: AuthUser | null, module: string, action: string): boolean {
  if (!user || user.userType !== "firm_user") return false;
  const perms = getPermissions(user);
  const loadState = getPermissionLoadState(user);
  const key = `${module}:${action}`;

  if (loadState === "READY") {
    if (perms.length > 0) {
      const explicitAllow = perms.some((p) => p.module === module && p.action === action);
      if (explicitAllow) return true;
      return false;
    }
    return false;
  }

  if (loadState === "DENIED") {
    return false;
  }

  if (module === "accounting" && ACCOUNTING_ACTIONS.has(action)) {
    return false;
  }
  const roleName = String((user as unknown as { roleName?: unknown }).roleName ?? "");
  const roleLower = roleName.trim().toLowerCase();
  const isPartner = roleLower.includes("partner");
  const isLawyer = roleLower.includes("lawyer");
  const isClerk = roleLower.includes("clerk");
  const isAccountAdmin = roleLower === "account admin" || (roleLower.includes("account") && roleLower.includes("admin"));
  const isAccountManager = roleLower === "account manager" || (roleLower.includes("account") && roleLower.includes("manager"));
  const isStaff = roleLower === "staff";
  const isCoreStaff = isPartner || isLawyer || isClerk || isAccountAdmin || isAccountManager || isStaff;
  const isDeveloperUser = roleLower === "developer_user" || roleLower.includes("developer");
  const hrRole = isHrRole(roleName);
  const isHRManager = hrRole === "manager";
  const isHRAdmin = hrRole === "admin";
  const isHREmployee = hrRole === "employee";

  const coreStaffBypass = new Set<string>([
    "dashboard:read",
    "cases:read",
    "cases:create",
    "cases:update",
    "projects:read",
    "documents:read",
    "hr:read",
  ]);

  if (isCoreStaff && coreStaffBypass.has(key)) return true;

  const hrSelfServiceBypass = new Set<string>([
    "hr_self_service:view_profile",
    "hr_self_service:edit_profile",
    "hr_employee:view",
    "hr_attendance:clock",
    "hr_attendance:view_own",
    "hr_leave:apply",
    "hr_leave:view_own",
    "hr_leave:cancel_own",
    "hr_claim:submit",
    "hr_claim:view_own",
    "hr_claim:cancel_own",
    "hr_payslip:view_own",
    "hr_document:view_own",
    "hr_notification:view_own",
  ]);

  if (isHREmployee && hrSelfServiceBypass.has(key)) return true;

  const partner = new Set<string>([
    "dashboard:read",
    "hr:read",
    "hr:manage",
    "hims:read",
    "hims:manage",
    "case_monitor:view",
    "case_monitor:manage",
    "file_custody:view",
    "file_custody:release",
    "file_custody:receive",
    "file_custody:return",
    "file_custody:manage",
    "cases:read", "cases:create", "cases:update", "cases:delete",
    "cases:assign_any",
    "projects:read", "projects:create", "projects:update", "projects:delete",
    "developers:read", "developers:create", "developers:update", "developers:delete",
    "documents:read", "documents:create", "documents:update", "documents:delete", "documents:generate", "documents:export",
    "communications:read", "communications:create", "communications:update", "communications:delete",
    "accounting:read", "accounting:write", "accounting:create", "accounting:edit",
    "accounting:review", "accounting:approve", "accounting:mark_received", "accounting:mark_paid",
    "accounting:cancel", "accounting:reopen", "accounting:export", "accounting:view_audit",
    "accounting:manage_settings", "accounting:override_sla",
    "reports:read", "reports:export",
    "audit:read",
    "settings:read", "settings:update",
    "users:read", "users:create", "users:update", "users:delete",
    "roles:read", "roles:create", "roles:update", "roles:delete",
    "hr_enabled:view",
    "hr_dashboard:read", "hr_dashboard:export",
    "hr_settings:view",
    "hr_settings:manage_organisation",
    "hr_settings:manage_approval_flow",
    "hr_settings:manage_feature_flags",
    "hr_employee:list",
    "hr_employee:view", "hr_employee:create", "hr_employee:edit",
    "hr_employee:status_change", "hr_employee:terminate", "hr_employee:reactivate",
    "hr_employee:view_salary", "hr_employee:edit_salary",
    "hr_employee:view_bank", "hr_employee:edit_bank",
    "hr_identity_records:view", "hr_identity_records:edit",
    "hr_medical_records:view", "hr_medical_records:edit",
    "hr_disciplinary:view", "hr_disciplinary:create", "hr_disciplinary:close",
    "hr_attendance:view_all", "hr_attendance:manage", "hr_attendance:adjust", "hr_attendance:approve_exception",
    "hr_leave_balance:view_all", "hr_leave_balance:adjust",
    "hr_leave:view_all", "hr_leave:approve", "hr_leave:approve_final", "hr_leave:manage_balance",
    "hr_claim:view_all", "hr_claim:approve", "hr_claim:approve_final",
    "hr_claim:send_to_payroll", "hr_claim:send_to_accounting", "hr_claim:mark_paid",
    "hr_payroll:view", "hr_payroll:calculate", "hr_payroll:submit",
    "hr_payroll:approve", "hr_payroll:lock", "hr_payroll:request_payment",
    "hr_payroll:reverse", "hr_payroll:adjust", "hr_payroll:supplementary_create",
    "hr_payroll:manage_settings",
    "hr_assets:view", "hr_assets:manage", "hr_assets:assign", "hr_assets:receive_return",
    "hr_recruitment:view", "hr_recruitment:manage", "hr_recruitment:hire",
    "hr_performance:view", "hr_performance:view_all", "hr_performance:manage",
    "hr_training:view", "hr_training:manage",
    "hr_documents:view", "hr_documents:upload", "hr_documents:manage",
    "hr_documents:view_confidential", "hr_documents:view_sensitive",
    "hr_onboarding:manage",
    "hr_offboarding:initiate", "hr_offboarding:manage", "hr_offboarding:final_approve",
    "hr_approval:delegate", "hr_approval:reassign", "hr_approval:override",
    "hr_reports:view_headcount", "hr_reports:view_turnover",
    "hr_reports:view_leave_summary", "hr_reports:view_payroll_summary", "hr_reports:view_cost_analysis",
    "hr_notifications:view_overdue",
    ...Array.from(hrSelfServiceBypass),
  ]);

  const clerk = new Set<string>([
    "dashboard:read",
    "cases:read", "cases:create", "cases:update",
    "projects:read", "projects:create", "projects:update",
    "developers:read", "developers:create", "developers:update",
    "documents:read", "documents:export",
    "communications:read", "communications:create",
    "reports:read",
    "settings:read",
    "users:read",
  ]);

  const developerUser = new Set<string>([
    "developer_portal:read",
    "developer_portal:export",
    "developer_portal:message",
  ]);

  const staff = new Set<string>([
    "dashboard:read",
    "cases:read", "cases:create", "cases:update",
    "projects:read", "projects:create", "projects:update",
    "developers:read", "developers:create", "developers:update",
    "documents:read", "documents:export",
    "communications:read", "communications:create",
    "reports:read",
    "settings:read",
    "users:read",
    ...Array.from(hrSelfServiceBypass),
  ]);

  const hrFullAccessHROnly = new Set<string>([
    "dashboard:read",
    "hr:read",
    "hr:manage",
    "hims:read",
    "hr_enabled:view",
    "hr_dashboard:read", "hr_dashboard:export",
    "hr_settings:view",
    "hr_settings:manage_organisation",
    "hr_settings:manage_approval_flow",
    "hr_settings:manage_feature_flags",
    "hr_employee:list",
    "hr_employee:view", "hr_employee:create", "hr_employee:edit",
    "hr_employee:status_change", "hr_employee:terminate", "hr_employee:reactivate",
    "hr_employee:view_salary", "hr_employee:edit_salary",
    "hr_employee:view_bank", "hr_employee:edit_bank",
    "hr_identity_records:view", "hr_identity_records:edit",
    "hr_medical_records:view", "hr_medical_records:edit",
    "hr_disciplinary:view", "hr_disciplinary:create", "hr_disciplinary:close",
    "hr_attendance:view_all", "hr_attendance:manage", "hr_attendance:adjust", "hr_attendance:approve_exception",
    "hr_leave_balance:view_all", "hr_leave_balance:adjust",
    "hr_leave:view_all", "hr_leave:approve", "hr_leave:approve_final", "hr_leave:manage_balance",
    "hr_claim:view_all", "hr_claim:approve", "hr_claim:approve_final",
    "hr_claim:send_to_payroll", "hr_claim:send_to_accounting", "hr_claim:mark_paid",
    "hr_payroll:view", "hr_payroll:calculate", "hr_payroll:submit",
    "hr_payroll:approve", "hr_payroll:lock", "hr_payroll:request_payment",
    "hr_payroll:reverse", "hr_payroll:adjust", "hr_payroll:supplementary_create",
    "hr_payroll:manage_settings",
    "hr_assets:view", "hr_assets:manage", "hr_assets:assign", "hr_assets:receive_return",
    "hr_recruitment:view", "hr_recruitment:manage", "hr_recruitment:hire",
    "hr_performance:view", "hr_performance:view_all", "hr_performance:manage",
    "hr_training:view", "hr_training:manage",
    "hr_documents:view", "hr_documents:upload", "hr_documents:manage",
    "hr_documents:view_confidential", "hr_documents:view_sensitive",
    "hr_onboarding:manage",
    "hr_offboarding:initiate", "hr_offboarding:manage", "hr_offboarding:final_approve",
    "hr_approval:delegate", "hr_approval:reassign", "hr_approval:override",
    "hr_reports:view_headcount", "hr_reports:view_turnover",
    "hr_reports:view_leave_summary", "hr_reports:view_payroll_summary", "hr_reports:view_cost_analysis",
    "hr_notifications:view_overdue",
  ]);

  const hrManager = new Set<string>([
    ...Array.from(hrFullAccessHROnly),
    ...Array.from(hrSelfServiceBypass),
  ]);

  const hrAdmin = new Set<string>([
    ...Array.from(hrFullAccessHROnly),
    ...Array.from(hrSelfServiceBypass),
  ]);

  const hrEmployee = new Set<string>([
    "dashboard:read",
    "hr:read",
    ...Array.from(hrSelfServiceBypass),
  ]);

  if (isPartner) return partner.has(key);
  if (isHRManager) return hrManager.has(key);
  if (isHRAdmin) return hrAdmin.has(key);
  if (isHREmployee) return hrEmployee.has(key);
  if (isAccountAdmin || isAccountManager) return staff.has(key);
  if (isStaff) return staff.has(key);
  if (isClerk) return staff.has(key) || clerk.has(key);
  if (isLawyer) return staff.has(key);
  if (isDeveloperUser) return developerUser.has(key);
  return false;
}
