import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Package, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

export function DeveloperLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();

  if (!user || user.userType !== "firm_user") return null;

  const navItems = [
    { label: "Dashboard", href: "/developer/dashboard", icon: LayoutDashboard },
    { label: "Inventory", href: "/developer/inventory", icon: Package },
  ];

  return (
    <div className="flex min-h-screen w-full bg-slate-50 overflow-x-hidden">
      <div className="w-64 bg-slate-900 text-slate-100 flex flex-col shrink-0 sticky top-0 h-screen overflow-y-auto">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 font-bold text-xl text-blue-300">
            <div className="w-6 h-6 bg-blue-500 rounded-sm"></div>
            Lawcaspro
          </div>
          <div className="mt-4">
            <div className="text-sm font-medium text-slate-200">{user.firmName}</div>
            <div className="text-xs text-slate-400">Developer Portal</div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <div className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  active ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
                }`}>
                  <Icon className="w-4 h-4" />
                  <span className="text-sm font-medium">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800">
          <Button
            variant="ghost"
            className="w-full justify-start text-slate-300 hover:text-white hover:bg-slate-800"
            onClick={() => logout()}
          >
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
        </div>
      </div>

      <main className="flex-1 p-6 min-w-0">
        {children}
      </main>
    </div>
  );
}

