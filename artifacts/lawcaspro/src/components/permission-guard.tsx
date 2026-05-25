import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { getPermissions, hasPermission } from "@/lib/permissions";
import { QueryFallback } from "@/components/query-fallback";
import { Button } from "@/components/ui/button";

export function PermissionGuard(props: { module: string; action: string; children: ReactNode; mode?: "block" | "silent" }) {
  const { user, permissionsStatus, retryPermissions } = useAuth();
  const [, setLocation] = useLocation();
  const perms = getPermissions(user);
  const autoRetryRef = useRef(false);
  const [canForceRepair, setCanForceRepair] = useState(false);
  const silent = props.mode === "silent";
  useEffect(() => {
    if (autoRetryRef.current) return;
    if (!user || user.userType !== "firm_user") return;
    if (permissionsStatus === "unavailable" || permissionsStatus === "error") return;
    if (perms.length !== 0) return;
    autoRetryRef.current = true;
    const t = setTimeout(() => {
      try { retryPermissions(); } catch {}
      setCanForceRepair(true);
    }, 5000);
    return () => clearTimeout(t);
  }, [user, perms.length, permissionsStatus, retryPermissions]);

  if (silent) return props.children;

  if (user && user.userType === "firm_user" && perms.length === 0) {
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
        <div className="text-2xl font-bold text-slate-900">正在初始化您的帳號</div>
        <div className="text-slate-500 mt-2">正在同步權限資料，請稍候…</div>
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            variant="outline"
            className="border-slate-200"
            disabled={!canForceRepair}
            onClick={() => {
              try { retryPermissions(); } catch {}
            }}
          >
            強制修復
          </Button>
        </div>
      </div>
    );
  }
  const allowed = hasPermission(user, props.module, props.action);
  if (allowed) return props.children;
  if (user && user.userType === "firm_user" && props.module === "dashboard" && props.action === "read") {
    if (hasPermission(user, "cases", "read")) {
      return <DashboardFallbackRedirect setLocation={setLocation} />;
    }
  }
  return (
    <div className="py-16 text-center">
      <div className="text-2xl font-bold text-slate-900">Access denied</div>
      <div className="text-slate-500 mt-2">Missing permission: {props.module}:{props.action}</div>
    </div>
  );
}

function DashboardFallbackRedirect(props: { setLocation: (path: string) => void }) {
  const { setLocation } = props;
  useEffect(() => {
    setLocation("/app/workbench");
  }, [setLocation]);
  return (
    <div className="py-16 text-center">
      <div className="text-slate-500 mt-2">Redirecting…</div>
    </div>
  );
}
