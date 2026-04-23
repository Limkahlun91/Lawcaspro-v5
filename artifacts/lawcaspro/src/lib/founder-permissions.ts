import type { AuthUser } from "@workspace/api-client-react";

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function getFounderPermissions(user: AuthUser | null): string[] {
  if (!user || user.userType !== "founder") return [];
  const u = user as unknown as { founderPermissions?: unknown };
  return isStringArray(u.founderPermissions) ? u.founderPermissions : [];
}

export function hasFounderPermission(user: AuthUser | null, permissionCode: string): boolean {
  return getFounderPermissions(user).includes(permissionCode);
}

export function getFounderRoleLevel(user: AuthUser | null): string | null {
  if (!user || user.userType !== "founder") return null;
  const u = user as unknown as { founderRoleLevel?: unknown };
  return typeof u.founderRoleLevel === "string" ? u.founderRoleLevel : null;
}

