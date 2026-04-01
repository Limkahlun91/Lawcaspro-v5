import { ReactNode, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";

export function AuthGuard({ children, requireRole }: { children: ReactNode, requireRole?: "founder" | "firm_user" }) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading) {
      if (!user) {
        setLocation("/auth/login");
      } else if (requireRole && user.userType !== requireRole) {
        if (user.userType === "founder") {
          setLocation("/platform/dashboard");
        } else {
          setLocation("/app/dashboard");
        }
      }
    }
  }, [user, isLoading, requireRole, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
      </div>
    );
  }

  if (!user || (requireRole && user.userType !== requireRole)) {
    return null;
  }

  return <>{children}</>;
}
