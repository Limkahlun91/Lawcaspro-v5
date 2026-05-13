import type { AuthUser } from "@workspace/api-client-react";

export type Permission = { module: string; action: string };

export function isAccountingRoleAllowed(roleName: string | null | undefined): boolean {
  const rn = String(roleName ?? "").trim();
  const rnl = rn.toLowerCase();
  if (rnl === "partner") return true;
  if (rnl === "account" || rnl === "accounts" || rnl === "finance" || rnl === "accountant") return true;
  if (rnl.startsWith("manager") && rnl.includes("account")) return true;
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

export function hasPermission(user: AuthUser | null, module: string, action: string): boolean {
  const perms = getPermissions(user);
  if (perms.length > 0) {
    return perms.some((p) => p.module === module && p.action === action);
  }

  if (!user || user.userType !== "firm_user") return false;
  const roleName = String((user as unknown as { roleName?: unknown }).roleName ?? "");
  const key = `${module}:${action}`;

  const partner = new Set<string>([
    "dashboard:read",
    "cases:read", "cases:create", "cases:update", "cases:delete",
    "cases:assign_any",
    "projects:read", "projects:create", "projects:update", "projects:delete",
    "developers:read", "developers:create", "developers:update", "developers:delete",
    "documents:read", "documents:create", "documents:update", "documents:delete", "documents:generate", "documents:export",
    "communications:read", "communications:create", "communications:update", "communications:delete",
    "accounting:read", "accounting:write",
    "reports:read", "reports:export",
    "audit:read",
    "settings:read", "settings:update",
    "users:read", "users:create", "users:update", "users:delete",
    "roles:read", "roles:create", "roles:update", "roles:delete",
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

  if (roleName === "Partner") return partner.has(key);
  if (roleName === "Clerk") return clerk.has(key);
  if (roleName === "Developer_User") return developerUser.has(key);
  return false;
}
