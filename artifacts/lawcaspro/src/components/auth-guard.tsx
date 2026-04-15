import { ReactNode, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";
import { QueryFallback } from "@/components/query-fallback";
import { Button } from "@/components/ui/button";
import { clearStoredAuthToken } from "@/lib/auth-token";

export function AuthGuard({ children, requireRole }: { children: ReactNode, requireRole?: "founder" | "firm_user" }) {
  const { user, isLoading, hydrationError, retryHydration, isRetryingHydration } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading) {
      if (!user && !hydrationError) {
        setLocation("/auth/login");
      } else if (requireRole && user && user.userType !== requireRole) {
        if (user.userType === "founder") {
          setLocation("/platform/dashboard");
        } else {
          setLocation("/app/dashboard");
        }
      }
    }
  }, [user, isLoading, hydrationError, requireRole, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
      </div>
    );
  }

  if (hydrationError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-lg space-y-4">
          <QueryFallback
            title="Auth temporarily unavailable"
            error={hydrationError}
            onRetry={retryHydration}
            isRetrying={isRetryingHydration}
          />
          <div className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => {
                clearStoredAuthToken();
                setLocation("/auth/login");
              }}
            >
              Back to login
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!user || (requireRole && user.userType !== requireRole)) {
    return null;
  }

  return <>{children}</>;
}
