import { type ReactNode } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

export function DeveloperLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  if (!user || user.userType !== "firm_user") return null;

  return (
    <div className="min-h-screen w-full bg-slate-50 overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate">{user.firmName}</div>
            <div className="text-xs text-slate-500">Developer Portal</div>
          </div>
          <Button variant="outline" onClick={() => logout()} className="shrink-0">
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}
