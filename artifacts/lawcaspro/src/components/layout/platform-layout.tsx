import { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Building2, Activity, ScrollText, LogOut, FileText, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PlatformLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();

  if (!user || user.userType !== "founder") {
    return null;
  }

  const navItems = [
    { label: "Dashboard", href: "/platform/dashboard", icon: LayoutDashboard },
    { label: "Firms", href: "/platform/firms", icon: Building2 },
    { label: "System Documents", href: "/platform/documents", icon: FileText },
    { label: "Communication Hub", href: "/platform/messages", icon: MessageSquare },
    { label: "Platform Monitoring", href: "/platform/monitoring", icon: Activity, badge: "Phase 3" },
    { label: "Audit Logs", href: "/platform/audit-logs", icon: ScrollText, badge: "Phase 3" },
  ];

  return (
    <div className="flex min-h-screen w-full bg-slate-50">
      <div className="w-64 bg-slate-900 text-slate-100 flex flex-col shrink-0 sticky top-0 h-screen">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 font-bold text-xl text-amber-500">
            <div className="w-6 h-6 bg-amber-500 rounded-sm"></div>
            Lawcaspro
          </div>
          <div className="mt-4 text-xs text-slate-400 uppercase tracking-wider font-semibold">
            Platform Admin
          </div>
        </div>
        
        <nav className="flex-1 py-4 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href}>
                <div className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  isActive 
                    ? "bg-amber-500/10 text-amber-500" 
                    : "text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                }`}>
                  <item.icon className="w-4 h-4" />
                  {item.label}
                  {item.badge && (
                    <span className="ml-auto text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                      {item.badge}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 mt-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center font-semibold text-sm text-slate-300">
              {user.name.charAt(0)}
            </div>
            <div className="overflow-hidden">
              <div className="text-sm font-medium truncate">{user.name}</div>
              <div className="text-xs text-slate-400 truncate">{user.email}</div>
            </div>
          </div>
          <Button variant="outline" className="w-full justify-start text-slate-300 border-slate-700 bg-transparent hover:bg-slate-800 hover:text-slate-100" onClick={logout}>
            <LogOut className="w-4 h-4 mr-2" />
            Sign out
          </Button>
        </div>
      </div>
      
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
