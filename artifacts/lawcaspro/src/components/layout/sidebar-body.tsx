import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { isEmailControlEnabled, isEmailSettingsEnabled, isWhatsAppInboxEnabled } from "@/lib/feature-flags";
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
  AlertTriangle,
  Clock,
  ArrowUpRight,
  Flag,
  UserCog,
  Users,
  Shield,
  FileSpreadsheet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";

export type SidebarGroupKey =
  | "work"
  | "cases"
  | "documents"
  | "accounting"
  | "hr"
  | "communication"
  | "administration";

export type SidebarGroupStorage = {
  version: 1;
  groups: Record<SidebarGroupKey, boolean>;
};

export function parseSidebarGroupStorage(raw: string | null): Partial<Record<SidebarGroupKey, boolean>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    if (parsed.groups && typeof parsed.groups === "object") {
      return parsed.groups as Partial<Record<SidebarGroupKey, boolean>>;
    }
    return parsed as Partial<Record<SidebarGroupKey, boolean>>;
  } catch {
    return {};
  }
}

export type SidebarNavItem = {
  label: string;
  href: string;
  icon: any;
  perm: readonly [string, string];
  featureCheck?: () => boolean;
  roleCheck?: (ctx: SidebarRoleContext) => boolean;
};

type SidebarRoleContext = {
  userType: string;
  roleGroup: string;
  roleLower: string;
};

function isFounderOrManagementOrPartnerOrManager(ctx: SidebarRoleContext): boolean {
  return (
    ctx.userType === "founder" ||
    ctx.userType === "developer_user" ||
    ctx.roleGroup.toLowerCase() === "management" ||
    ctx.roleLower.includes("partner") ||
    ctx.roleLower.includes("manager")
  );
}

function isAccountingRole(ctx: SidebarRoleContext): boolean {
  return (
    ctx.roleLower.includes("partner") ||
    ctx.roleLower.includes("account manager") ||
    ctx.roleLower.includes("account admin")
  );
}

function isHRFullRole(ctx: SidebarRoleContext): boolean {
  return (
    ctx.roleLower.includes("partner") ||
    ctx.roleLower.includes("hr manager") ||
    ctx.roleLower.includes("hr admin")
  );
}

export function navGroupsForUser(): Array<{
  key: SidebarGroupKey;
  label: string;
  items: SidebarNavItem[];
}> {
  return [
    {
      key: "work",
      label: "Work",
      items: [
        {
          label: "Dashboard",
          href: "/app/dashboard",
          icon: LayoutDashboard,
          perm: ["dashboard", "read"],
          roleCheck: isFounderOrManagementOrPartnerOrManager,
        },
        { label: "My Work", href: "/app/my-work", icon: ListTodo, perm: ["cases", "read"] },
      ],
    },
    {
      key: "cases",
      label: "Cases",
      items: [
        { label: "Cases", href: "/app/cases", icon: Briefcase, perm: ["cases", "read"] },
        { label: "Projects", href: "/app/projects", icon: Building2, perm: ["projects", "read"] },
        { label: "Developers", href: "/app/developers", icon: HardHat, perm: ["developers", "read"] },
        { label: "Clients", href: "/app/clients", icon: Users, perm: ["contacts", "read"] },
      ],
    },
    {
      key: "documents",
      label: "Documents",
      items: [
        { label: "Documents", href: "/app/documents", icon: FileText, perm: ["documents", "read"] },
        { label: "Doc Automation", href: "/app/documents/automation", icon: FileSpreadsheet, perm: ["documents", "read"] },
        { label: "Variables", href: "/app/documents/variables", icon: FileText, perm: ["documents", "read"] },
      ],
    },
    {
      key: "accounting",
      label: "Accounting",
      items: [
        {
          label: "Accounting",
          href: "/app/accounting",
          icon: Calculator,
          perm: ["accounting", "read"],
          roleCheck: isAccountingRole,
        },
        {
          label: "Reports",
          href: "/app/reports",
          icon: BarChart,
          perm: ["reports", "read"],
          roleCheck: isFounderOrManagementOrPartnerOrManager,
        },
      ],
    },
    {
      key: "hr",
      label: "HR",
      items: [
        {
          label: "Self Service",
          href: "/app/my/dashboard",
          icon: UserCog,
          perm: ["hr", "read"],
        },
        {
          label: "Employees",
          href: "/app/hr/dashboard",
          icon: Users,
          perm: ["hr", "read"],
          roleCheck: isHRFullRole,
        },
      ],
    },
    {
      key: "communication",
      label: "Communication",
      items: [
        {
          label: "Email Control",
          href: "/app/communication/email",
          icon: MessageSquare,
          perm: ["communications", "read"],
          featureCheck: isEmailControlEnabled,
        },
        {
          label: "WhatsApp Inbox",
          href: "/app/communication/whatsapp",
          icon: MessageSquare,
          perm: ["communications", "read"],
          featureCheck: isWhatsAppInboxEnabled,
        },
        { label: "Hub", href: "/app/hub", icon: MessageSquare, perm: ["communications", "read"] },
      ],
    },
    {
      key: "administration",
      label: "Administration",
      items: [
        {
          label: "Settings",
          href: "/app/settings",
          icon: Settings,
          perm: ["settings", "read"],
          roleCheck: isFounderOrManagementOrPartnerOrManager,
        },
        {
          label: "Users",
          href: "/app/settings?tab=users",
          icon: Users,
          perm: ["users", "read"],
          roleCheck: isFounderOrManagementOrPartnerOrManager,
        },
        {
          label: "Roles",
          href: "/app/settings?tab=roles",
          icon: Shield,
          perm: ["roles", "read"],
          roleCheck: isFounderOrManagementOrPartnerOrManager,
        },
        {
          label: "Accounting Settings",
          href: "/app/settings/accounting",
          icon: Settings,
          perm: ["accounting", "read"],
          roleCheck: isAccountingRole,
        },
        {
          label: "Email Settings",
          href: "/app/settings/email",
          icon: Settings,
          perm: ["communications", "read"],
          featureCheck: isEmailSettingsEnabled,
          roleCheck: isFounderOrManagementOrPartnerOrManager,
        },
        {
          label: "Audit Logs",
          href: "/app/settings/logs",
          icon: ScrollText,
          perm: ["audit", "read"],
          roleCheck: isFounderOrManagementOrPartnerOrManager,
        },
      ],
    },
  ];
}

export function SidebarBody({
  isMobile,
  onNavigate,
  className,
}: {
  isMobile: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  const { user, logout, roleName: roleNameFromContext } = useAuth() as any;
  const roleName = roleNameFromContext ?? (user as any)?.roleName ?? "";
  const [location] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const accountingUnreadCount = useQuery({
    queryKey: ["user-notifications", "unread-count", "sidebar"],
    queryFn: () => apiFetchJson<{ count: number }>("/user-notifications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: !!user && user.userType === "firm_user",
  }).data?.count ?? 0;
  const unreadCount = useQuery({
    queryKey: ["unread-count", "sidebar"],
    queryFn: () => apiFetchJson<{ count: number }>("/communications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: false,
    refetchOnWindowFocus: false,
    enabled:
      !!user &&
      user.userType === "firm_user" &&
      (isEmailControlEnabled() || isWhatsAppInboxEnabled()) &&
      hasPermission(user, "communications", "read"),
  }).data?.count ?? 0;
  const notifSummary = useQuery({
    queryKey: ["user-notifications", "summary", "sidebar"],
    queryFn: () =>
      apiFetchJson<{
        unread: number;
        urgent: number;
        escalated: number;
        overdue: number;
        monitorUniqueCount?: number;
        activeDistinctCount?: number;
      }>("/user-notifications/summary").catch(() => ({
        unread: 0,
        urgent: 0,
        escalated: 0,
        overdue: 0,
        monitorUniqueCount: 0,
        activeDistinctCount: 0,
      })),
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: !!user && user.userType === "firm_user",
  }).data ?? { unread: 0, urgent: 0, escalated: 0, overdue: 0, monitorUniqueCount: 0, activeDistinctCount: 0 };
  const globalUnreadCount = accountingUnreadCount + unreadCount;
  const badgeUrgent = Number(notifSummary.urgent ?? 0);
  const badgeOverdue = Number(notifSummary.overdue ?? 0);
  const badgeEscalated = Number(notifSummary.escalated ?? 0);
  const notificationHref = accountingUnreadCount > 0
    ? (hasPermission(user, "accounting", "read") ? "/app/accounting?tab=monitor" : "/app/workbench")
    : "/app/cases";
  const prefetchStateRef = useRef<Record<string, { timer: any | null; lastAt: number }>>({});
  const schedulePrefetch = useCallback((href: string) => {
    try {
      const state = prefetchStateRef.current[href] ?? { timer: null, lastAt: 0 };
      if (state.timer || Date.now() - state.lastAt < 30_000) return;
      state.timer = setTimeout(async () => {
        try {
          await fetch(href, { credentials: "include", headers: { "Sec-Fetch-Dest": "empty", "X-Prefetch": "1" } }).catch(
            () => {}
          );
        } catch {
          /* ignore */
        } finally {
          state.timer = null;
          state.lastAt = Date.now();
        }
      }, 220);
      prefetchStateRef.current[href] = state;
    } catch {
      /* ignore */
    }
  }, []);
  const cancelPrefetch = useCallback((href: string) => {
    const state = prefetchStateRef.current[href];
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }, []);

  const storageKey = useMemo(() => {
    const firmId = (user as any)?.firmId ?? "unknown";
    const userKey = (user as any)?.id ?? (user as any)?.email ?? "unknown";
    return `lawcaspro.sidebar.groups:${firmId}:${userKey}`;
  }, [(user as any)?.firmId, (user as any)?.id, (user as any)?.email]);

  const navGroups = navGroupsForUser();

  const ctx: SidebarRoleContext = useMemo(() => {
    const userType = String((user as any)?.userType ?? "");
    const roleGroup = String((user as any)?.roleGroup ?? "");
    const roleLower = String(roleName ?? "").toLowerCase();
    return { userType, roleGroup, roleLower };
  }, [user, roleName]);

  const visibleNavGroups = navGroups
    .map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.filter((i) => {
        if (!hasPermission(user, i.perm[0], i.perm[1])) return false;
        if (typeof i.featureCheck === "function" && !i.featureCheck()) return false;
        if (typeof i.roleCheck === "function" && !i.roleCheck(ctx)) return false;
        return true;
      }),
    }))
    .filter((g) => g.items.length > 0);

  const activeGroupKeys = useMemo(() => {
    const s = new Set<SidebarGroupKey>();
    for (const group of visibleNavGroups) {
      if (
        group.items.some((item) =>
          item.href === "/app/documents"
            ? location === item.href
            : location === item.href ||
              location.startsWith(`${item.href}/`) ||
              (item.href.startsWith("/app/settings") && location.startsWith(item.href.split("?")[0])) ||
              (item.href === "/app/accounting" && location.startsWith("/app/quotations"))
        )
      )
        s.add(group.key);
    }
    return s;
  }, [location, visibleNavGroups]);

  const defaultExpanded: Record<SidebarGroupKey, boolean> = {
    work: true,
    cases: true,
    documents: true,
    accounting: true,
    hr: true,
    communication: true,
    administration: true,
  };

  const [expandedGroups, setExpandedGroups] = useState<Record<SidebarGroupKey, boolean>>(() => {
    try {
      if (typeof window === "undefined" || typeof localStorage === "undefined") return defaultExpanded;
      const raw = localStorage.getItem(storageKey);
      const groups = parseSidebarGroupStorage(raw);
      return {
        work: typeof groups.work === "boolean" ? groups.work : true,
        cases: typeof groups.cases === "boolean" ? groups.cases : true,
        documents: typeof groups.documents === "boolean" ? groups.documents : true,
        accounting: typeof groups.accounting === "boolean" ? groups.accounting : true,
        hr: typeof groups.hr === "boolean" ? groups.hr : true,
        communication: typeof groups.communication === "boolean" ? groups.communication : true,
        administration: typeof groups.administration === "boolean" ? groups.administration : true,
      };
    } catch {
      return defaultExpanded;
    }
  });

  useEffect(() => {
    try {
      if (typeof window === "undefined" || typeof localStorage === "undefined") return;
      const payload: SidebarGroupStorage = {
        version: 1,
        groups: expandedGroups,
      };
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      return;
    }
  }, [expandedGroups]);

  const toggleGroup = (key: SidebarGroupKey) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const wrapper = (children: ReactNode) => (
    <div
      className={`w-64 bg-slate-900 text-slate-100 flex flex-col shrink-0 h-full overflow-hidden ${className ?? ""}`}
      style={isMobile ? undefined : { position: "sticky", top: 0, height: "100vh", overflowY: "auto" }}
    >
      {children}
    </div>
  );

  return wrapper(
    <>
      <div className={`${isMobile ? "p-4 border-b border-slate-800" : "p-6 border-b border-slate-800"}`}>
        <div className="flex items-center gap-2 font-bold text-xl text-blue-300">
          <div className="w-6 h-6 bg-blue-500 rounded-sm" />
          <span className={isMobile ? "text-lg" : ""}>Lawcaspro</span>
        </div>
        <div className="mt-4">
          <div className="text-sm font-medium text-slate-200">{(user as any)?.firmName}</div>
          <div className="text-xs text-slate-400 mt-1">{(user as any)?.roleName || "User"}</div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500">Notifications</div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  toast({
                    title: "Notifications",
                    description: "Tap bell in the notification drawer for lifecycle actions",
                  });
                  if (onNavigate) onNavigate();
                }}
                className="relative inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                aria-label="Open notifications"
              >
                <Bell className="w-4 h-4 text-slate-200" />
                {globalUnreadCount > 0 ? (
                  <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full shadow-sm">
                    {globalUnreadCount > 99 ? "99+" : globalUnreadCount}
                  </span>
                ) : null}
                {badgeOverdue > 0 ? (
                  <span
                    className="absolute -bottom-1 -right-1 inline-flex items-center justify-center px-1 h-[14px] text-[9px] font-bold text-white bg-orange-600 rounded-full"
                    title="Overdue"
                  >
                    {badgeOverdue > 9 ? "9+" : badgeOverdue}
                  </span>
                ) : badgeUrgent > 0 ? (
                  <span
                    className="absolute -bottom-1 -right-1 inline-flex items-center justify-center px-1 h-[14px] text-[9px] font-bold text-white bg-amber-500 rounded-full"
                    title="Urgent"
                  >
                    {badgeUrgent > 9 ? "9+" : badgeUrgent}
                  </span>
                ) : badgeEscalated > 0 ? (
                  <span
                    className="absolute -bottom-1 -right-1 inline-flex items-center justify-center px-1 h-[14px] text-[9px] font-bold text-slate-900 bg-rose-300 rounded-full"
                    title="Escalated"
                  >
                    {badgeEscalated > 9 ? "9+" : badgeEscalated}
                  </span>
                ) : null}
              </button>
              <Link href={notificationHref} title="Jump to hotlist" onClick={onNavigate}>
                <div className="inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-slate-800">
                  <ArrowUpRight className="w-3.5 h-3.5 text-slate-400" />
                </div>
              </Link>
            </div>
          </div>
          {badgeOverdue + badgeUrgent + badgeEscalated > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {badgeEscalated > 0 ? (
                <Badge
                  variant="outline"
                  className="bg-rose-500/10 text-rose-200 border-rose-700/60 text-[10px] px-1.5 py-0.5"
                >
                  <Flag className="w-3 h-3 mr-1" /> Esc {badgeEscalated}
                </Badge>
              ) : null}
              {badgeOverdue > 0 ? (
                <Badge
                  variant="outline"
                  className="bg-orange-500/10 text-orange-200 border-orange-700/60 text-[10px] px-1.5 py-0.5"
                >
                  <AlertTriangle className="w-3 h-3 mr-1" /> OD {badgeOverdue}
                </Badge>
              ) : null}
              {badgeUrgent > 0 ? (
                <Badge
                  variant="outline"
                  className="bg-amber-500/10 text-amber-200 border-amber-700/60 text-[10px] px-1.5 py-0.5"
                >
                  <Clock className="w-3 h-3 mr-1" /> Urg {badgeUrgent}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <nav className={`flex-1 py-4 px-3 space-y-4 overflow-y-auto`}>
        {visibleNavGroups.map((group) => (
          <div key={group.key} className="space-y-1">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
              onClick={() => toggleGroup(group.key)}
              aria-expanded={Boolean((expandedGroups[group.key] ?? true) || activeGroupKeys.has(group.key))}
              aria-controls={`sidebar-group-${group.key}`}
            >
              <span>{group.label}</span>
              {(expandedGroups[group.key] ?? true) || activeGroupKeys.has(group.key) ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
            {(expandedGroups[group.key] ?? true) || activeGroupKeys.has(group.key) ? (
              <div id={`sidebar-group-${group.key}`} role="group">
                {group.items.map((item) => {
                  const itemPath = item.href.split("?")[0];
                  const isActive =
                    (item.href === "/app/documents" ? location === "/app/documents" : false) ||
                    location === item.href ||
                    location.startsWith(`${item.href}/`) ||
                    location.startsWith(`${itemPath}/`) ||
                    (item.href === "/app/accounting" && location.startsWith("/app/quotations"));
                  return (
                    <Link key={item.href} href={item.href} onClick={onNavigate}>
                      <div
                        onMouseEnter={() => schedulePrefetch(itemPath)}
                        onMouseLeave={() => cancelPrefetch(itemPath)}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                          isActive
                            ? "bg-blue-500/10 text-blue-200"
                            : "text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                        }`}
                      >
                        <item.icon className="w-4 h-4 shrink-0" />
                        <span className="truncate flex-1">{item.label}</span>
                        {item.href === "/app/accounting" && accountingUnreadCount > 0 ? (
                          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                            {accountingUnreadCount}
                          </span>
                        ) : null}
                        {group.key === "communication" && unreadCount > 0 && item.href.startsWith("/app/communication/") ? (
                          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-blue-500 rounded-full">
                            {unreadCount}
                          </span>
                        ) : null}
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        ))}
      </nav>

      <div
        className={`${
          isMobile
            ? "p-3 border-t border-slate-800 mt-auto bg-slate-900 sticky bottom-0"
            : "p-4 border-t border-slate-800 mt-auto sticky bottom-0 bg-slate-900"
        }`}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center font-semibold text-sm text-slate-300 shrink-0">
            {((user as any)?.name ?? "U").charAt(0)}
          </div>
          <div className="overflow-hidden min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{(user as any)?.name}</div>
            <div className="text-xs text-slate-400 truncate">{(user as any)?.email}</div>
          </div>
        </div>
        <Button
          variant="outline"
          className="w-full justify-start text-slate-300 border-slate-700 bg-transparent hover:bg-slate-800 hover:text-slate-100"
          onClick={() => {
            logout();
            if (onNavigate) onNavigate();
          }}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign out
        </Button>
      </div>
    </>
  );
}
