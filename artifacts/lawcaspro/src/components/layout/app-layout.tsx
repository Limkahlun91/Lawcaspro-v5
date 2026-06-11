import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, isAccountingRoleAllowed } from "@/lib/permissions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  ListTodo,
  Briefcase, 
  Building2, 
  HardHat, 
  MessageSquare, 
  Calculator, 
  BarChart, 
  ScrollText, 
  Settings,
  FileText,
  Bell,
  LogOut,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetchJson } from "@/lib/api-client";
import { getListCasesQueryKey, getListDevelopersQueryKey, getListProjectsQueryKey, getListUsersQueryKey } from "@workspace/api-client-react";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const prefetchStateRef = useRef<Record<string, { timer: any | null; lastAt: number }>>({});

  const { data: unreadData } = useQuery({
    queryKey: ["unread-count"],
    queryFn: () => apiFetchJson<{ count: number }>("/communications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 30000,
    enabled: !!user && user.userType === "firm_user" && hasPermission(user, "communications", "read"),
    retry: false,
  });
  const unreadCount = unreadData?.count ?? 0;

  const { data: caseUnreadData } = useQuery({
    queryKey: ["case-notifications", "unread-counts"],
    queryFn: () => apiFetchJson<{ totalUnreadCount: number }>("/case-notifications/unread-counts").catch(() => ({ totalUnreadCount: 0 })),
    refetchInterval: 30000,
    enabled: !!user && user.userType === "firm_user" && hasPermission(user, "cases", "read"),
    retry: false,
  });
  const caseUnreadCount = caseUnreadData?.totalUnreadCount ?? 0;

  if (!user || user.userType !== "firm_user") {
    return null;
  }

  type SidebarGroupKey = "main" | "documents" | "settings_system";
  const storageKey = useMemo(() => {
    const firmId = (user as any)?.firmId ?? "unknown";
    const userKey = (user as any)?.id ?? (user as any)?.email ?? "unknown";
    return `lawcaspro.sidebar.groups:${firmId}:${userKey}`;
  }, [(user as any)?.firmId, (user as any)?.id, (user as any)?.email]);

  const navGroups: Array<{
    key: SidebarGroupKey;
    label: string;
    items: Array<{ label: string; href: string; icon: any; perm: readonly [string, string] }>;
  }> = [
    {
      key: "main",
      label: "MAIN",
      items: [
        { label: "Dashboard", href: "/app/dashboard", icon: LayoutDashboard, perm: ["dashboard", "read"] as const },
        { label: "My Work", href: "/app/workbench", icon: ListTodo, perm: ["cases", "read"] as const },
        { label: "Cases", href: "/app/cases", icon: Briefcase, perm: ["cases", "read"] as const },
        { label: "Projects", href: "/app/projects", icon: Building2, perm: ["projects", "read"] as const },
        { label: "Developers", href: "/app/developers", icon: HardHat, perm: ["developers", "read"] as const },
        { label: "Email Control", href: "/app/communication/email", icon: MessageSquare, perm: ["communications", "read"] as const },
        { label: "WhatsApp Inbox", href: "/app/communication/whatsapp", icon: MessageSquare, perm: ["communications", "read"] as const },
        { label: "Hub", href: "/app/hub", icon: MessageSquare, perm: ["communications", "read"] as const },
        { label: "Accounting", href: "/app/accounting", icon: Calculator, perm: ["accounting", "read"] as const },
        { label: "Reports", href: "/app/reports", icon: BarChart, perm: ["reports", "read"] as const },
      ],
    },
    {
      key: "documents",
      label: "DOCUMENTS",
      items: [
        { label: "Documents", href: "/app/documents", icon: FileText, perm: ["documents", "read"] as const },
        { label: "Doc Automation", href: "/app/documents/automation", icon: FileText, perm: ["documents", "read"] as const },
        { label: "Variable Dictionary", href: "/app/documents/variables", icon: FileText, perm: ["documents", "read"] as const },
        { label: "Custom Dictionary", href: "/app/documents/custom-variables", icon: FileText, perm: ["documents", "read"] as const },
      ],
    },
    {
      key: "settings_system",
      label: "SETTINGS / SYSTEM",
      items: [
        { label: "Settings", href: "/app/settings", icon: Settings, perm: ["settings", "read"] as const },
        { label: "Email Settings", href: "/app/settings/email", icon: Settings, perm: ["communications", "read"] as const },
        { label: "Audit Logs", href: "/app/audit-logs", icon: ScrollText, perm: ["audit", "read"] as const },
        { label: "Doc Gen Logs", href: "/app/documents/generation-logs", icon: ScrollText, perm: ["audit", "read"] as const },
      ],
    },
  ];

  const visibleNavGroups = navGroups
    .map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.filter((i) => {
        if (!hasPermission(user, i.perm[0], i.perm[1])) return false;
        if (i.href === "/app/accounting") return isAccountingRoleAllowed(user.roleName);
        return true;
      }),
    }))
    .filter((g) => g.items.length > 0);

  const activeGroupKeys = useMemo(() => {
    const keys = new Set<SidebarGroupKey>();
    for (const group of visibleNavGroups) {
      for (const item of group.items) {
        const isActive =
          (item.href === "/app/documents"
            ? location === "/app/documents"
            : location === item.href || location.startsWith(`${item.href}/`)) ||
          (item.href === "/app/accounting" && location.startsWith("/app/quotations"));
        if (isActive) keys.add(group.key);
      }
    }
    return keys;
  }, [location, visibleNavGroups]);

  const [expandedGroups, setExpandedGroups] = useState<Record<SidebarGroupKey, boolean>>(() => {
    try {
      if (typeof window === "undefined" || typeof localStorage === "undefined") return { main: true, documents: true, settings_system: true };
      const raw = localStorage.getItem(storageKey);
      if (!raw) return { main: true, documents: true, settings_system: true };
      const parsed = JSON.parse(raw) as any;
      const groups = (parsed && typeof parsed === "object" && parsed.groups && typeof parsed.groups === "object") ? parsed.groups : parsed;
      return {
        main: typeof groups?.main === "boolean" ? groups.main : true,
        documents: typeof groups?.documents === "boolean" ? groups.documents : true,
        settings_system: typeof groups?.settings_system === "boolean" ? groups.settings_system : true,
      };
    } catch {
      return { main: true, documents: true, settings_system: true };
    }
  });

  useEffect(() => {
    try {
      if (typeof window === "undefined" || typeof localStorage === "undefined") return;
      localStorage.setItem(storageKey, JSON.stringify(expandedGroups));
    } catch {
      return;
    }
  }, [expandedGroups]);

  const toggleGroup = (key: SidebarGroupKey) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const prefetchByHref: Record<string, () => void> = {
    "/app/cases": () => {
      const params = { page: 1, limit: 50 } as const;
      queryClient.prefetchQuery({
        queryKey: getListCasesQueryKey(params),
        queryFn: () => apiFetchJson(`/cases?page=${params.page}&limit=${params.limit}`),
        staleTime: 30_000,
      });
      queryClient.prefetchQuery({
        queryKey: ["cases", "filter-options"],
        queryFn: () => apiFetchJson("/cases/filter-options"),
        staleTime: 30_000,
      });
      queryClient.prefetchQuery({
        queryKey: getListProjectsQueryKey({ page: 1, limit: 200 }),
        queryFn: () => apiFetchJson("/projects?page=1&limit=200"),
        staleTime: 30_000,
      });
      queryClient.prefetchQuery({
        queryKey: getListDevelopersQueryKey({ page: 1, limit: 200 }),
        queryFn: () => apiFetchJson("/developers?page=1&limit=200"),
        staleTime: 30_000,
      });
      queryClient.prefetchQuery({
        queryKey: getListUsersQueryKey({ page: 1, limit: 200 }),
        queryFn: () => apiFetchJson("/users?page=1&limit=200"),
        staleTime: 30_000,
      });
    },
    "/app/projects": () => {
      queryClient.prefetchQuery({
        queryKey: getListProjectsQueryKey({ page: 1, limit: 50 }),
        queryFn: () => apiFetchJson("/projects?page=1&limit=50"),
        staleTime: 30_000,
      });
      queryClient.prefetchQuery({
        queryKey: getListDevelopersQueryKey({ limit: 100 }),
        queryFn: () => apiFetchJson("/developers?limit=100"),
        staleTime: 30_000,
      });
    },
    "/app/developers": () => {
      queryClient.prefetchQuery({
        queryKey: getListDevelopersQueryKey({ page: 1, limit: 50 }),
        queryFn: () => apiFetchJson("/developers?page=1&limit=50"),
        staleTime: 30_000,
      });
    },
    "/app/settings": () => {
      const userParams = { page: 1, limit: 50 } as const;
      queryClient.prefetchQuery({
        queryKey: getListUsersQueryKey(userParams),
        queryFn: () => apiFetchJson(`/users?page=${userParams.page}&limit=${userParams.limit}`),
        staleTime: 30_000,
      });
    },
  };

  const schedulePrefetch = useCallback((href: string) => {
    if (location === href || location.startsWith(`${href}/`)) return;
    const fn = prefetchByHref[href];
    if (!fn) return;
    const now = Date.now();
    const state = prefetchStateRef.current[href] ?? { timer: null, lastAt: 0 };
    if (state.lastAt && now - state.lastAt < 30_000) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      state.lastAt = Date.now();
      fn();
    }, 250);
    prefetchStateRef.current[href] = state;
  }, [location, prefetchByHref]);

  const cancelPrefetch = useCallback((href: string) => {
    const state = prefetchStateRef.current[href];
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }, []);

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
            <div className="text-xs text-slate-400 mt-1">{user.roleName || "User"}</div>
            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs text-slate-500">Notifications</div>
              <Link href="/app/cases">
                <div className="relative inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-slate-800">
                  <Bell className="w-4 h-4 text-slate-200" />
                  {caseUnreadCount > 0 ? (
                    <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                      {caseUnreadCount}
                    </span>
                  ) : null}
                </div>
              </Link>
            </div>
          </div>
        </div>
        
        <nav className="flex-1 py-4 px-3 space-y-4">
          {visibleNavGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
                onClick={() => toggleGroup(group.key)}
              >
                <span>{group.label}</span>
                {((expandedGroups[group.key] ?? true) || activeGroupKeys.has(group.key)) ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
              {((expandedGroups[group.key] ?? true) || activeGroupKeys.has(group.key)) ? (
                group.items.map((item) => {
                  const isActive =
                    (item.href === "/app/documents"
                      ? location === "/app/documents"
                      : location === item.href || location.startsWith(`${item.href}/`)) ||
                    (item.href === "/app/accounting" && location.startsWith("/app/quotations"));
                  return (
                    <Link key={item.href} href={item.href}>
                      <div
                        onMouseEnter={() => schedulePrefetch(item.href)}
                        onMouseLeave={() => cancelPrefetch(item.href)}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                          isActive
                            ? "bg-blue-500/10 text-blue-200"
                            : "text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                        }`}
                      >
                        <item.icon className="w-4 h-4 shrink-0" />
                        <span className="truncate flex-1">{item.label}</span>
                        {item.label === "Communications" && unreadCount > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-blue-500 rounded-full">
                            {unreadCount}
                          </span>
                        )}
                      </div>
                    </Link>
                  );
                })
              ) : null}
            </div>
          ))}
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
      
      <main className="flex-1 overflow-auto min-w-0">
        <div className="max-w-[1440px] mx-auto w-full px-6 py-6 md:px-8 md:py-8 min-w-0 space-y-6">
          {children}
        </div>
      </main>
    </div>
  );
}
