import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Home,
  ListTodo,
  MonitorCog,
  UserCircle2,
  Bell,
  AlertTriangle,
  Clock,
  CheckCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { MeSheet } from "./me-sheet";
import { PartnerAlertSheet } from "./partner-alert-sheet";
import { userNotificationsQueryKey } from "@/lib/query-keys";

export type MobileDockViewId = "home" | "work" | "monitor" | "alerts" | "me";

export type NotifRow = {
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

export function MobileDockView(props: {
  view: MobileDockViewId;
  onChange: (next: MobileDockViewId) => void;
  counts: { workUnread: number; notifUnread: number; monitorUniqueCount: number };
  user: { id?: string | number; name?: string; email?: string; roleName?: string; firmName?: string; userType?: string } | null | undefined;
}) {
  const { logout } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [meOpen, setMeOpen] = useState(false);

  const isPartner = useMemo(() => {
    if (!props.user?.roleName) return false;
    return String(props.user.roleName).trim().toLowerCase() === "partner";
  }, [props.user?.roleName]);
  const canViewMonitor = hasPermission(props.user as any, "case_monitor", "view") || hasPermission(props.user as any, "accounting", "read");
  const canViewEscalationFeed = isPartner || hasPermission(props.user as any, "case_monitor", "view");

  useEffect(() => {
    if (props.view === "alerts" && !canViewEscalationFeed) {
      props.onChange("home");
    }
  }, [props.view, canViewEscalationFeed, props.onChange]);

  const dockItems = [
    { id: "home" as const, label: "Home", icon: Home, href: "/app/dashboard", badge: 0, badgeVariant: "" },
    { id: "work" as const, label: "Work", icon: ListTodo, href: "/app/my-work", badge: props.counts.workUnread, badgeVariant: "bg-blue-500" },
    { id: "monitor" as const, label: "Monitor", icon: MonitorCog, href: "/app/accounting?tab=monitor", badge: canViewMonitor ? props.counts.monitorUniqueCount : 0, badgeVariant: (props.counts.monitorUniqueCount > 0 ? "bg-orange-500" : "bg-amber-500"), requires: "monitor" as const },
    { id: "alerts" as const, label: "Alerts", icon: Bell, href: null, badge: canViewEscalationFeed ? props.counts.notifUnread : 0, badgeVariant: "bg-red-500", requires: "alerts" as const },
    { id: "me" as const, label: "Me", icon: UserCircle2, href: null, badge: 0, badgeVariant: "" },
  ];

  if (!props.user) return null;

  return (
    <>
      {/* Mobile-only dock nav: fixed bottom safe area */}
      <nav className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85"
           style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
           aria-label="Mobile primary navigation">
        <div className="grid grid-cols-5 gap-1 px-1 py-2">
          {dockItems.map((it) => {
            const active = props.view === it.id;
            const disabled = it.requires === "monitor" ? !canViewMonitor : (it.requires === "alerts" ? !canViewEscalationFeed : false);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => {
                  if (disabled) return;
                  if (it.href) { navigate(it.href); }
                  props.onChange(it.id);
                  if (it.id === "me") setMeOpen(true);
                  if (it.id === "alerts") { const fid = (props.user as any)?.firmId ?? null; const uid = (props.user as any)?.id ?? null; void qc.invalidateQueries({ queryKey: userNotificationsQueryKey(fid, uid) }); }
                }}
                aria-label={`${it.label}${disabled ? " (unauthorized)" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-disabled={disabled || undefined}
                disabled={disabled}
                className={`relative inline-flex flex-col items-center justify-center gap-0.5 rounded-lg transition-colors min-h-[48px] ${active ? "bg-slate-900 text-white" : disabled ? "text-slate-300 opacity-60" : "text-slate-600 hover:bg-slate-100 active:bg-slate-200"}`}
                style={{ minWidth: "48px" }}
              >
                <div className="relative inline-flex items-center justify-center w-[28px] h-[28px]">
                  <it.icon className={`w-[20px] h-[20px] ${active ? "text-white" : "text-slate-600"}`} />
                  {it.badge > 0 ? (
                    <span className={`absolute -top-1 -right-1.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[9px] font-bold text-white shadow-sm ${it.badgeVariant}`}>
                      {it.badge > 99 ? "99+" : it.badge}
                    </span>
                  ) : null}
                </div>
                <span className={`text-[10px] font-semibold leading-none tracking-wide ${active ? "text-white" : "text-slate-600"}`}>{it.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {props.view === "alerts" && canViewEscalationFeed ? (
        <PartnerAlertSheet user={props.user as any} />
      ) : null}

      <MeSheet
        open={meOpen}
        onOpenChange={(v) => setMeOpen(v)}
        onChangeView={(v) => { setMeOpen(false); props.onChange(v); }}
        user={props.user as any}
        logout={logout}
      />
    </>
  );
}
