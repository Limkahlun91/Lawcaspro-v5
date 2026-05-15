import { type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";

export function DeveloperGuard({ children }: { children: ReactNode }) {
  const { user, isLoading, permissionsStatus } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
      </div>
    );
  }

  if (!user) return null;
  if (user.userType !== "firm_user") return null;

  if (permissionsStatus === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-8 h-8 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
      </div>
    );
  }

  const roleName = String((user as any)?.roleName ?? "");
  const developerId = (user as any)?.developerId ?? null;
  const allowed = roleName === "Developer_User" && hasPermission(user, "developer_portal", "read") && typeof developerId === "number";

  if (!allowed) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <Card>
            <CardContent className="py-10 text-center text-slate-700">
              Access denied. Developer portal access required.
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
