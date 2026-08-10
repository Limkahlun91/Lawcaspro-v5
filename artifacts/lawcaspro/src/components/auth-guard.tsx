import { ReactNode, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";

export function AuthGuard({ children, requireRole }: { children: ReactNode, requireRole?: "founder" | "firm_user" }) {
  const { user, isLoading, authStatus, retryMe } = useAuth();
  const [location, setLocation] = useLocation();
  const roleName = user ? String((user as any)?.roleName ?? "") : "";
  const isDeveloperUser = user?.userType === "firm_user" && roleName === "Developer_User";
  const shouldRedirectDeveloperAwayFromApp = isDeveloperUser && location.startsWith("/app");

  useEffect(() => {
    if (!isLoading) {
      if (authStatus === "unauthenticated" && !user) {
        setLocation("/auth/login");
      } else if (requireRole && user && user.userType !== requireRole) {
        if (user.userType === "founder") {
          setLocation("/platform/dashboard");
        } else {
          const isManagement = (n: string) => (n || "").toLowerCase().includes("partner") || (n || "").toLowerCase().includes("manager");
          setLocation(isManagement(roleName) ? "/app/dashboard" : "/app/workbench");
        }
      } else if (shouldRedirectDeveloperAwayFromApp) {
        setLocation("/developer/dashboard");
      }
    }
  }, [user, isLoading, authStatus, requireRole, setLocation, shouldRedirectDeveloperAwayFromApp, roleName]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
      </div>
    );
  }

  if (authStatus === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6">
          <div className="text-slate-900 font-semibold">Unable to verify your session</div>
          <div className="text-slate-600 text-sm mt-1">
            The server is taking longer than expected to respond. Please retry.
          </div>
          <div className="mt-4">
            <Button className="w-full bg-slate-900 hover:bg-slate-800 text-white" onClick={() => retryMe?.()}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!user || (requireRole && user.userType !== requireRole) || shouldRedirectDeveloperAwayFromApp) {
    return null;
  }

  return <>{children}</>;
}
