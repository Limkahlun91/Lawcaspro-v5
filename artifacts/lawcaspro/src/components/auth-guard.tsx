import { ReactNode, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";

export function AuthGuard({ children, requireRole }: { children: ReactNode, requireRole?: "founder" | "firm_user" }) {
  const { user, isLoading } = useAuth();
  const [location, setLocation] = useLocation();
  const roleName = user ? String((user as any)?.roleName ?? "") : "";
  const isDeveloperUser = user?.userType === "firm_user" && roleName === "Developer_User";
  const shouldRedirectDeveloperAwayFromApp = isDeveloperUser && location.startsWith("/app");

  useEffect(() => {
    if (!isLoading) {
      if (!user) {
        setLocation("/auth/login");
      } else if (requireRole && user && user.userType !== requireRole) {
        if (user.userType === "founder") {
          setLocation("/platform/dashboard");
        } else {
          setLocation("/app/dashboard");
        }
      } else if (shouldRedirectDeveloperAwayFromApp) {
        setLocation("/developer/dashboard");
      }
    }
  }, [user, isLoading, requireRole, setLocation, shouldRedirectDeveloperAwayFromApp]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
      </div>
    );
  }

  if (!user || (requireRole && user.userType !== requireRole) || shouldRedirectDeveloperAwayFromApp) {
    return null;
  }

  return <>{children}</>;
}
