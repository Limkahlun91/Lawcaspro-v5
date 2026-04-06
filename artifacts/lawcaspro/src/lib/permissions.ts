import type { AuthUser } from "@workspace/api-client-react";

export type Permission = { module: string; action: string };

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
  return perms.some((p) => p.module === module && p.action === action);
}

