import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { getPermissions, hasPermission } from "@/lib/permissions";
import { QueryFallback } from "@/components/query-fallback";

export function PermissionGuard(props: { module: string; action: string; children: ReactNode }) {
  const { user, permissionsStatus, retryPermissions } = useAuth();
  const perms = getPermissions(user);
  if (user && user.userType === "firm_user" && perms.length === 0) {
    const roleName = String((user as unknown as { roleName?: unknown }).roleName ?? "");
    if (roleName !== "Partner" && roleName !== "Clerk") {
      if (permissionsStatus === "unavailable") {
        return (
          <div className="py-8">
            <QueryFallback
              title="Permissions unavailable"
              error={new Error("Permissions endpoint is unavailable (404). Deploy the API hotfix and retry.")}
              onRetry={retryPermissions}
              isRetrying={false}
            />
          </div>
        );
      }
      if (permissionsStatus === "error") {
        return (
          <div className="py-8">
            <QueryFallback
              title="Permissions unavailable"
              error={new Error("Failed to load permissions.")}
              onRetry={retryPermissions}
              isRetrying={false}
            />
          </div>
        );
      }
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
