import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { getPermissions, hasPermission } from "@/lib/permissions";

export function PermissionGuard(props: { module: string; action: string; children: ReactNode }) {
  const { user } = useAuth();
  const perms = getPermissions(user);
  if (user && user.userType === "firm_user" && perms.length === 0) {
    const roleName = String((user as unknown as { roleName?: unknown }).roleName ?? "");
    if (roleName !== "Partner" && roleName !== "Clerk") {
      return (
        <div className="py-16 text-center">
          <div className="text-2xl font-bold text-slate-900">Loading</div>
          <div className="text-slate-500 mt-2">Fetching permissions…</div>
        </div>
      );
    }
  }
  const allowed = hasPermission(user, props.module, props.action);
  if (allowed) return props.children;
  return (
    <div className="py-16 text-center">
      <div className="text-2xl font-bold text-slate-900">Access denied</div>
      <div className="text-slate-500 mt-2">Missing permission: {props.module}:{props.action}</div>
    </div>
  );
}
