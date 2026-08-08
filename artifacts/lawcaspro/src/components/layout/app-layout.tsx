import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { isEmailControlEnabled, isWhatsAppInboxEnabled } from "@/lib/feature-flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  Clock,
  AlertTriangle,
  CheckCircle,
  ArrowUpRight,
  X,
  Flag,
  Menu,
  Home,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";
import { apiFetchJson } from "@/lib/api-client";
import { getListCasesQueryKey, getListDevelopersQueryKey, getListProjectsQueryKey, getListUsersQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { SidebarBody } from "./sidebar-body";
import { MobileDockView, type MobileDockViewId } from "./mobile/mobile-dock";
import { useNotificationCounts, useIsPartnerOrManager } from "@/hooks/use-notification-counts";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const [location] = useLocation();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [mobileView, setMobileView] = useState<MobileDockViewId>(() => {
    if (location.startsWith("/app/dashboard")) return "home";
    if (location.startsWith("/app/workbench") || location.startsWith("/app/cases") || location.startsWith("/app/projects")) return "work";
    if (location.startsWith("/app/accounting") || location.startsWith("/app/audit")) return "monitor";
    if (location.startsWith("/app/communication") || location.startsWith("/app/hub")) return "alerts";
    return "home";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    if (location.startsWith("/app/dashboard")) setMobileView("home");
    else if (location.startsWith("/app/workbench") || location.startsWith("/app/cases") || location.startsWith("/app/projects") || location.startsWith("/app/developers")) setMobileView("work");
    else if (location.startsWith("/app/accounting") || location.startsWith("/app/reports") || location.startsWith("/app/audit")) setMobileView("monitor");
    else if (location.startsWith("/app/communication") || location.startsWith("/app/hub") || location.startsWith("/app/documents")) setMobileView("alerts");
    else if (location.startsWith("/app/settings") || location.startsWith("/app/users") || location.startsWith("/app/roles")) setMobileView("me");
  }, [location]);

  const { canViewMonitor, canViewEscalationFeed } = useIsPartnerOrManager(user);
  const counts = useNotificationCounts({ enabled: !!user && user.userType === "firm_user" });

  const [mobileOpen, setMobileOpen] = useState(false);
  const prefetchStateRef = useRef<Record<string, { timer: any | null; lastAt: number }>>({});
  const [unreadEnabled, setUnreadEnabled] = useState(false);
  const [notifCenterOpen, setNotifCenterOpen] = useState(false);
  const [notifFilter, setNotifFilter] = useState<"all" | "active" | "urgent" | "overdue" | "escalated">("active");
  const [notifAckId, setNotifAckId] = useState<number | null>(null);
  const [notifAckNote, setNotifAckNote] = useState("");
  const [notifEscId, setNotifEscId] = useState<number | null>(null);
  const [notifEscPartnerId, setNotifEscPartnerId] = useState<string>("");
  const [notifEscNote, setNotifEscNote] = useState("");
  const [notifResolveId, setNotifResolveId] = useState<number | null>(null);
  const [notifResolveNote, setNotifResolveNote] = useState("");
  const queryClient = useQueryClient();

  useEffect(() => {
    setUnreadEnabled(false);
    if (!user || user.userType !== "firm_user") return;
    const t = setTimeout(() => setUnreadEnabled(true), 1500);
    return () => clearTimeout(t);
  }, [user && user.userType === "firm_user" ? (user as any).id : null, user && user.userType === "firm_user" ? (user as any).firmId : null]);

  const phase2CommsEnabled = isEmailControlEnabled() || isWhatsAppInboxEnabled();
  const { data: unreadData } = useQuery({
    queryKey: ["unread-count"],
    queryFn: () => apiFetchJson<{ count: number }>("/communications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 30000,
    enabled: phase2CommsEnabled && unreadEnabled && !!user && user.userType === "firm_user" && hasPermission(user, "communications", "read"),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const unreadCount = unreadData?.count ?? 0;

  const { data: caseUnreadData } = useQuery({
    queryKey: ["case-notifications", "unread-counts"],
    queryFn: () => apiFetchJson<{ totalUnreadCount: number }>("/case-notifications/unread-counts").catch(() => ({ totalUnreadCount: 0 })),
    refetchInterval: 30000,
    enabled: unreadEnabled && !!user && user.userType === "firm_user" && hasPermission(user, "cases", "read"),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const caseUnreadCount = caseUnreadData?.totalUnreadCount ?? 0;

  const { data: accountingUnreadData } = useQuery({
    queryKey: ["user-notifications", "unread-count", "global"],
    queryFn: () => apiFetchJson<{ count: number }>("/user-notifications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 30000,
    enabled: unreadEnabled && !!user && user.userType === "firm_user",
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const accountingUnreadCount = accountingUnreadData?.count ?? 0;

  type NotifRow = {
    id: number;
    status: string;
    severity: string;
    targetScope: string | null;
    dismissible: boolean;
    sourceType: string;
    sourceId: number;
    caseId: number | null;
    notificationType: string;
    title: string;
    message: string | null;
    isRead: boolean;
    readAt: string | null;
    acknowledgedAt: string | null;
    escalatedAt: string | null;
    resolvedAt: string | null;
    autoResolvedAt: string | null;
    acknowledgementDueAt: string | null;
    resolutionSlaDueAt: string | null;
    createdAt: string;
    isOverdue: boolean;
    severityRank: number;
  };

  const notifSummaryQuery = useQuery({
    queryKey: ["user-notifications", "summary"],
    queryFn: () =>
      apiFetchJson<{ unread: number; urgent: number; escalated: number; overdue: number; monitorUniqueCount?: number; overlap?: { criticalOverdue?: number; criticalEscalated?: number; overdueEscalated?: number; allThree?: number } }>("/user-notifications/summary").catch(
        () => ({ unread: 0, urgent: 0, escalated: 0, overdue: 0 })
      ),
    enabled: unreadEnabled && !!user && user.userType === "firm_user",
    refetchInterval: 45000,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const notifSummary = notifSummaryQuery.data ?? { unread: 0, urgent: 0, escalated: 0, overdue: 0 };

  const notifListQuery = useQuery({
    queryKey: ["user-notifications", "list", notifFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (notifFilter === "active") params.set("only_active", "1");
      if (notifFilter === "urgent") { params.set("severity", "urgent"); params.set("only_active", "1"); }
      if (notifFilter === "overdue") { params.set("only_overdue", "1"); params.set("only_active", "1"); }
      if (notifFilter === "escalated") params.set("only_escalated", "1");
      return apiFetchJson<{ total: number; items: NotifRow[] }>(`/user-notifications?${params.toString()}`).catch(
        () => ({ total: 0, items: [] as NotifRow[] })
      );
    },
    enabled: notifCenterOpen && !!user && user.userType === "firm_user",
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const markAllReadMut = useMutation({
    mutationFn: () =>
      fetch("/api/user-notifications/mark-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      }).then((r) => r.json()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["user-notifications"] });
      await qc.invalidateQueries({ queryKey: ["case-notifications", "unread-counts"] });
      await qc.invalidateQueries({ queryKey: ["unread-count"] });
    },
  });

  const ackMut = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      fetch(`/api/user-notifications/${id}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ note: note || undefined }),
      }).then(async (r) => {
        if (!r.ok) throw new Error("ack_failed");
        return r.json();
      }),
    onSuccess: async () => {
      setNotifAckId(null); setNotifAckNote("");
      await qc.invalidateQueries({ queryKey: ["user-notifications"] });
    },
  });

  const dismissMut = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      fetch(`/api/user-notifications/${id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason: reason || undefined }),
      }).then(async (r) => {
        if (!r.ok) { const text = await r.text(); throw new Error(text || "dismiss_failed"); }
        return r.json();
      }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["user-notifications"] }); },
  });

  const escMut = useMutation({
    mutationFn: ({ id, targetPartnerUserId, note }: { id: number; targetPartnerUserId?: string; note?: string }) =>
      fetch(`/api/user-notifications/${id}/escalate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetPartnerUserId: targetPartnerUserId || undefined, note: note || undefined }),
      }).then(async (r) => {
        if (!r.ok) throw new Error("escalate_failed");
        return r.json();
      }),
    onSuccess: async () => {
      setNotifEscId(null); setNotifEscPartnerId(""); setNotifEscNote("");
      await qc.invalidateQueries({ queryKey: ["user-notifications"] });
    },
  });

  const resolveMut = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      fetch(`/api/user-notifications/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ note }),
      }).then(async (r) => {
        if (!r.ok) throw new Error("resolve_failed");
        return r.json();
      }),
    onSuccess: async () => {
      setNotifResolveId(null); setNotifResolveNote("");
      await qc.invalidateQueries({ queryKey: ["user-notifications"] });
    },
  });

  function relativeTime(dateStr: string | Date | null | undefined): string {
    if (!dateStr) return "";
    const now = Date.now();
    const then = typeof dateStr === "string" ? new Date(dateStr).getTime() : dateStr.getTime();
    if (!Number.isFinite(then)) return "";
    const diff = Math.max(0, now - then);
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    const wk = Math.floor(d / 7);
    if (wk < 8) return `${wk}w`;
    const mo = Math.floor(d / 30);
    if (mo < 24) return `${mo}mo`;
    return `${Math.floor(d / 365)}y`;
  }

  function severityBadgeVariant(sev: string): "default" | "secondary" | "destructive" | "outline" {
    switch (sev) {
      case "critical": return "destructive";
      case "urgent": return "destructive";
      case "high": return "default";
      case "normal": return "secondary";
      case "info": return "outline";
      default: return "secondary";
    }
  }

  const notifList = notifListQuery.data?.items ?? [];
  const canResolveNotifs = canViewEscalationFeed || hasPermission(user, "accounting", "read") || hasPermission(user, "audit", "read") || hasPermission(user, "settings", "update");

  if (!user || user.userType !== "firm_user") {
    return null;
  }

  const prefetchByHref: Record<string, () => void> = {
    "/app/cases": () => {
      const params = { page: 1, limit: 50 } as const;
      queryClient.prefetchQuery({
        queryKey: getListCasesQueryKey(params),
        queryFn: () => apiFetchJson(`/cases?page=${params.page}&limit=${params.limit}`),
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
  }, [location]);

  void schedulePrefetch;
  void logout;

  const globalUnreadCount = caseUnreadCount + accountingUnreadCount;

  // Safe-area policy: apply each physical edge ONCE
  // Header  -> top
  // Dock    -> bottom
  // root    -> left/right (landscape / iOS landscape inset)
  // => root does NOT apply top/bottom to avoid double padding.
  return (
    <div className="flex min-h-screen w-full bg-slate-50 overflow-x-hidden"
         style={{
           paddingLeft: "env(safe-area-inset-left, 0px)",
           paddingRight: "env(safe-area-inset-right, 0px)",
         }}>
      <SidebarBody isMobile={false} className="hidden md:flex" />
      <div className="md:hidden fixed inset-x-0 top-0 z-40 h-14 bg-slate-900 text-slate-100 flex items-center gap-3 px-3 border-b border-slate-800"
           style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <Sheet open={mobileOpen} onOpenChange={(o) => { setMobileOpen(o); if (!o && menuTriggerRef.current) { try { menuTriggerRef.current.focus(); } catch {} } }}>
          <SheetTrigger asChild>
            <button ref={menuTriggerRef} type="button" aria-label="Open menu" className="inline-flex items-center justify-center w-9 h-9 rounded-md hover:bg-slate-800 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
              <Menu className="w-5 h-5" />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[82%] max-w-sm p-0 bg-slate-900 text-slate-100 border-r border-slate-800 !max-w-none" aria-describedby="mobile-sheet-desc">
            <SidebarBody isMobile={true} onNavigate={() => setMobileOpen(false)} />
            <p id="mobile-sheet-desc" className="sr-only">Mobile primary navigation sidebar. Press Escape to close.</p>
          </SheetContent>
        </Sheet>
        <div className="flex items-center gap-2 font-bold text-blue-300 min-w-0 flex-1">
          <div className="w-5 h-5 bg-blue-500 rounded-sm shrink-0" aria-hidden />
          <span className="text-sm truncate">Lawcaspro</span>
        </div>
        {canViewEscalationFeed ? (
          <button type="button" aria-label="Open notification center" className="relative inline-flex items-center justify-center w-9 h-9 rounded-md hover:bg-slate-800 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  onClick={() => { setMobileView("alerts"); setNotifCenterOpen(true); void qc.invalidateQueries({ queryKey: ["user-notifications"] }); }}>
            <Bell className="w-5 h-5 text-slate-200" aria-hidden />
            {globalUnreadCount > 0 ? <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full shadow-sm" aria-label={`${globalUnreadCount} unread notifications`}>{globalUnreadCount > 99 ? "99+" : globalUnreadCount}</span> : null}
          </button>
        ) : null}
        <Link href="/app/dashboard" onClick={() => setMobileView("home")} className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" aria-label="Dashboard">
          <Home className="w-4 h-4 text-slate-300" aria-hidden />
        </Link>
      </div>
      <main className="flex-1 overflow-auto min-w-0" id="app-main-content" tabIndex={-1}>
        <div className="md:hidden h-14 shrink-0" aria-hidden />
        <div className="max-w-[1440px] mx-auto w-full px-3 md:px-8 md:py-8 py-4 min-w-0 space-y-6 pb-24 md:pb-6">
          {children}
        </div>
      </main>
      <MobileDockView
        view={mobileView}
        onChange={(v) => setMobileView(v)}
        counts={{
          workUnread: counts.workUnread,
          notifUnread: counts.notifUnread,
          monitorUniqueCount: canViewMonitor ? counts.monitorUniqueCount : 0,
        }}
        user={user as any}
      />

      <Dialog open={notifCenterOpen} onOpenChange={(v) => { setNotifCenterOpen(v); if (!v) { setNotifAckId(null); setNotifAckNote(""); setNotifEscId(null); setNotifEscPartnerId(""); setNotifEscNote(""); setNotifResolveId(null); setNotifResolveNote(""); } }}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-hidden flex flex-col p-0 focus:outline-none">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-slate-200">
            <div className="flex items-start justify-between gap-4">
              <div>
                <DialogTitle className="flex items-center gap-2 text-lg">
                  <Bell className="w-4 h-4 text-slate-700" aria-hidden /> Notifications
                </DialogTitle>
                <DialogDescription className="text-xs mt-1 text-slate-500">
                  Unread <span className="font-semibold text-slate-700">{notifSummary.unread}</span> · Urgent <span className="font-semibold text-amber-700">{notifSummary.urgent}</span> · Overdue <span className="font-semibold text-orange-700">{notifSummary.overdue}</span> · Escalated <span className="font-semibold text-rose-700">{notifSummary.escalated}</span>
                  {notifSummary.monitorUniqueCount != null ? <> · Unique alerts <span className="font-semibold text-slate-800">{notifSummary.monitorUniqueCount}</span></> : null}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={markAllReadMut.isPending || (notifSummary.unread ?? 0) === 0}
                  onClick={() => markAllReadMut.mutate()}
                >
                  <CheckCircle className="w-3.5 h-3.5 mr-1.5" aria-hidden /> Mark all read
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNotifCenterOpen(false)} aria-label="Close notifications"><X className="w-4 h-4" aria-hidden /></Button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Notification filters">
              {(["active","all","urgent","overdue","escalated"] as const).map((k) => {
                const labelMap: Record<typeof k,string> = { active:"Active", all:"All", urgent:"Urgent+", overdue:"Overdue", escalated:"Escalated" };
                const active = notifFilter === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    id={`notif-tab-${k}`}
                    aria-controls={`notif-panel-${k}`}
                    onClick={() => setNotifFilter(k)}
                    className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}`}
                  >
                    {labelMap[k]}
                  </button>
                );
              })}
              <div className="ml-auto text-[11px] text-slate-500">
                {notifListQuery.isLoading ? "Loading…" : notifList.length === 0 ? "Empty" : `${notifList.length} shown`}
              </div>
            </div>
          </DialogHeader>
          <div role="tabpanel" id={`notif-panel-${notifFilter}`} aria-labelledby={`notif-tab-${notifFilter}`} className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-slate-50">
            {notifListQuery.isLoading ? (
              <div className="p-6 text-center text-sm text-slate-500">Loading…</div>
            ) : notifList.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500 flex flex-col items-center gap-2">
                <CheckCircle className="w-8 h-8 text-emerald-600" aria-hidden />
                <div className="font-medium text-slate-700">All caught up</div>
                <div className="text-xs text-slate-500">No notifications match this filter.</div>
              </div>
            ) : (
              notifList.map((n) => {
                const isEsc = n.status === "escalated";
                const isAck = n.status === "acknowledged";
                const bg = n.isOverdue ? "bg-orange-50/60 border-orange-200" : (isEsc ? "bg-rose-50/60 border-rose-200" : (!n.isRead ? "bg-white border-blue-200" : "bg-white border-slate-200"));
                return (
                  <article key={n.id} className={`rounded-xl border p-3 shadow-sm ${bg}`} aria-labelledby={`notif-title-${n.id}`}>
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0" aria-hidden>
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center ${n.severityRank >= 3 ? "bg-red-100 text-red-700" : n.severityRank >= 2 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                          {n.severityRank >= 3 ? <AlertTriangle className="w-3.5 h-3.5" /> : n.severityRank >= 2 ? <Clock className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div id={`notif-title-${n.id}`} className={`text-sm ${!n.isRead ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`}>
                              {n.title}
                            </div>
                            {n.message ? <div className="text-xs text-slate-600 mt-0.5 whitespace-pre-wrap break-words">{n.message}</div> : null}
                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              <Badge variant={severityBadgeVariant(n.severity)} className="text-[10px] uppercase tracking-wide">{n.severity}</Badge>
                              {n.targetScope ? <Badge variant="outline" className="text-[10px] text-slate-600">{n.targetScope.replace(/_/g, " ")}</Badge> : null}
                              {isEsc ? <Badge variant="destructive" className="text-[10px]">ESCALATED</Badge> : null}
                              {isAck ? <Badge variant="secondary" className="text-[10px]">ACKNOWLEDGED</Badge> : null}
                              {n.isOverdue ? <Badge variant="default" className="bg-orange-600 text-white text-[10px]">OVERDUE</Badge> : null}
                              {!n.dismissible ? <Badge variant="outline" className="text-[10px] border-slate-400 text-slate-700">NON-DISMISSIBLE</Badge> : null}
                            </div>
                            <div className="text-[10px] text-slate-500 mt-1 flex flex-wrap items-center gap-x-2">
                              <span>{relativeTime(n.createdAt)} ago</span>
                              <span>·</span>
                              <span className="truncate">{n.notificationType.replace(/_/g, " ")}</span>
                              {(n.acknowledgementDueAt || n.resolutionSlaDueAt) ? (
                                <>
                                  <span>·</span>
                                  <span>due {relativeTime(n.acknowledgementDueAt ?? n.resolutionSlaDueAt)}</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Button size="sm" variant="secondary" disabled={ackMut.isPending || (n.status === "dismissed" || n.status === "resolved" || n.status === "auto_resolved")} onClick={() => { setNotifAckId(n.id); setNotifAckNote(""); }}>
                            Acknowledge
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={dismissMut.isPending || n.dismissible === false || n.status === "dismissed" || n.status === "resolved" || n.status === "auto_resolved"}
                            onClick={() => dismissMut.mutate({ id: n.id, reason: "dismissed from notification center" })}
                            title={n.dismissible === false ? "This notification cannot be dismissed manually (dismissible=false)" : "Dismiss this notification"}
                          >
                            Dismiss
                          </Button>
                          {canViewEscalationFeed ? (
                            <Button size="sm" variant="secondary" className="bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100" disabled={escMut.isPending || (n.status === "dismissed" || n.status === "resolved" || n.status === "auto_resolved")} onClick={() => { setNotifEscId(n.id); setNotifEscPartnerId(""); setNotifEscNote(""); }}>
                              <Flag className="w-3 h-3 mr-1" aria-hidden /> Escalate
                            </Button>
                          ) : null}
                          {canResolveNotifs ? (
                            <Button size="sm" variant="outline" disabled={resolveMut.isPending || (n.status === "resolved" || n.status === "auto_resolved")} onClick={() => { setNotifResolveId(n.id); setNotifResolveNote(""); }}>
                              <CheckCircle className="w-3 h-3 mr-1" aria-hidden /> Resolve
                            </Button>
                          ) : null}
                          {(n.caseId || (n.sourceType === "case" && n.sourceId)) ? (
                            <Link href={`/app/cases/${n.caseId ?? n.sourceId}`}>
                              <Button size="sm" variant="ghost" className="ml-auto">Open <ArrowUpRight className="w-3 h-3 ml-1" aria-hidden /></Button>
                            </Link>
                          ) : (n.sourceType.startsWith("payment_voucher") && n.sourceId) ? (
                            <Link href={`/app/accounting?tab=payment-vouchers&pv=${n.sourceId}`}>
                              <Button size="sm" variant="ghost" className="ml-auto">Open PV <ArrowUpRight className="w-3 h-3 ml-1" aria-hidden /></Button>
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
          <DialogFooter className="px-5 py-3 border-t border-slate-200 bg-white flex-wrap justify-start">
            <div className="text-[11px] text-slate-500">
              Actions here are audited. Non-dismissible notifications require acknowledgement or resolution by a partner/approver.
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notifAckId != null} onOpenChange={(v) => { if (!v) { setNotifAckId(null); setNotifAckNote(""); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Acknowledge notification</DialogTitle>
            <DialogDescription>Confirm you have seen this notification. This action will be recorded.</DialogDescription>
          </DialogHeader>
          <textarea
            className="w-full min-h-[88px] rounded-md border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            placeholder="Optional note (max 1000 chars)…"
            value={notifAckNote}
            maxLength={1000}
            onChange={(e) => setNotifAckNote(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setNotifAckId(null); setNotifAckNote(""); }}>Cancel</Button>
            <Button disabled={notifAckId == null || ackMut.isPending} onClick={() => ackMut.mutate({ id: notifAckId!, note: notifAckNote })}>Confirm acknowledge</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notifEscId != null} onOpenChange={(v) => { if (!v) { setNotifEscId(null); setNotifEscPartnerId(""); setNotifEscNote(""); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Escalate notification</DialogTitle>
            <DialogDescription>
              Leave partner empty to broadcast to <span className="font-semibold">all active Partners</span>. Otherwise target a specific partner user ID.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-slate-600" htmlFor="esc-target">Target partner user ID (optional)</label>
              <input
                id="esc-target"
                className="w-full rounded-md border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 mt-1"
                value={notifEscPartnerId}
                onChange={(e) => setNotifEscPartnerId(e.target.value)}
                placeholder="Leave empty = all active partners"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600" htmlFor="esc-note">Escalation note</label>
              <textarea
                id="esc-note"
                className="w-full min-h-[96px] rounded-md border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 mt-1"
                maxLength={1000}
                value={notifEscNote}
                onChange={(e) => setNotifEscNote(e.target.value)}
                placeholder="Optional reason or context (max 1000 chars)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setNotifEscId(null); setNotifEscPartnerId(""); setNotifEscNote(""); }}>Cancel</Button>
            <Button
              disabled={notifEscId == null || escMut.isPending}
              variant={notifEscPartnerId ? "default" : "destructive"}
              onClick={() => escMut.mutate({ id: notifEscId!, targetPartnerUserId: notifEscPartnerId || undefined, note: notifEscNote || undefined })}
            >
              {notifEscPartnerId ? "Escalate to target partner" : "Escalate to all partners"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notifResolveId != null} onOpenChange={(v) => { if (!v) { setNotifResolveId(null); setNotifResolveNote(""); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Resolve notification</DialogTitle>
            <DialogDescription>Provide a resolution note. Minimum 3 characters.</DialogDescription>
          </DialogHeader>
          <textarea
            className="w-full min-h-[112px] rounded-md border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            placeholder="Resolution note (3 - 1000 chars)…"
            maxLength={1000}
            value={notifResolveNote}
            onChange={(e) => setNotifResolveNote(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setNotifResolveId(null); setNotifResolveNote(""); }}>Cancel</Button>
            <Button
              disabled={notifResolveId == null || resolveMut.isPending || notifResolveNote.trim().length < 3}
              onClick={() => resolveMut.mutate({ id: notifResolveId!, note: notifResolveNote.trim() })}
            >
              Confirm resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
