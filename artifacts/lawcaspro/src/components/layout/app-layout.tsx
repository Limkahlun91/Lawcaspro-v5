import { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Briefcase, 
  Building2, 
  HardHat, 
  Users, 
  UserCircle, 
  ShieldCheck, 
  MessageSquare, 
  Calculator, 
  BarChart, 
  ScrollText, 
  Settings,
  LogOut
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();

  if (!user || user.userType !== "firm_user") {
    return null;
  }

  const navItems = [
    { label: "Dashboard", href: "/app/dashboard", icon: LayoutDashboard },
    { label: "Cases", href: "/app/cases", icon: Briefcase },
    { label: "Projects", href: "/app/projects", icon: Building2 },
    { label: "Developers", href: "/app/developers", icon: HardHat },
    { label: "Clients", href: "/app/clients", icon: Users },
    { label: "Users", href: "/app/users", icon: UserCircle },
    { label: "Roles & Permissions", href: "/app/roles", icon: ShieldCheck },
    { label: "Communications", href: "/app/communications", icon: MessageSquare },
    { label: "Accounting", href: "/app/accounting", icon: Calculator },
    { label: "Reports", href: "/app/reports", icon: BarChart },
    { label: "Audit Logs", href: "/app/audit-logs", icon: ScrollText },
    { label: "Settings", href: "/app/settings", icon: Settings },
  ];

  return (
    <div className="flex min-h-screen w-full bg-slate-50">
      <div className="w-64 bg-slate-900 text-slate-100 flex flex-col shrink-0 sticky top-0 h-screen overflow-y-auto">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 font-bold text-xl text-amber-500">
            <div className="w-6 h-6 bg-amber-500 rounded-sm"></div>
            Lawcaspro
          </div>
          <div className="mt-4">
            <div className="text-sm font-medium text-slate-200">{user.firmName}</div>
            <div className="text-xs text-slate-400 mt-1">{user.roleName || "User"}</div>
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
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {item.badge && (
                    <span className="ml-auto text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700 shrink-0">
                      {item.badge}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 mt-auto sticky bottom-0 bg-slate-900">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center font-semibold text-sm text-slate-300 shrink-0">
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
