import { useMemo } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, isAccountingRoleAllowed } from "@/lib/permissions";
import { useQuery } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api-client";

export type NotificationCounts = {
  workUnread: number;
  notifUnread: number;
  monitorUniqueCount: number;
};

export function useNotificationCounts(options?: { enabled?: boolean }): NotificationCounts {
  const { user } = useAuth();
  const enabled = options?.enabled ?? true;
  const firmUser = !!user && user.userType === "firm_user";

  const caseUnread = useQuery({
    queryKey: ["case-notifications", "unread-counts", "mobile-counts"],
    queryFn: () => apiFetchJson<{ totalUnreadCount: number }>("/case-notifications/unread-counts").catch(() => ({ totalUnreadCount: 0 })),
    refetchInterval: 30_000,
    enabled: enabled && firmUser && hasPermission(user, "cases", "read"),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  }).data?.totalUnreadCount ?? 0;

  const commsUnread = useQuery({
    queryKey: ["unread-count", "mobile-counts"],
    queryFn: () => apiFetchJson<{ count: number }>("/communications/unread-count").catch(() => ({ count: 0 })),
    refetchInterval: 30_000,
    enabled: enabled && firmUser && hasPermission(user, "communications", "read"),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  }).data?.count ?? 0;

  const notifSummary = useQuery({
    queryKey: ["user-notifications", "summary", "mobile-counts"],
    queryFn: () =>
      apiFetchJson<{
        unread: number;
        urgent: number;
        escalated: number;
        overdue: number;
        monitorUniqueCount: number;
        activeDistinctCount: number;
      }>("/user-notifications/summary").catch(() => ({
        unread: 0,
        urgent: 0,
        escalated: 0,
        overdue: 0,
        monitorUniqueCount: 0,
        activeDistinctCount: 0,
      })),
    refetchInterval: 45_000,
    enabled: enabled && firmUser,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  }).data ?? { unread: 0, urgent: 0, escalated: 0, overdue: 0, monitorUniqueCount: 0, activeDistinctCount: 0 };

  const workUnread = useMemo(() => {
    return caseUnread + commsUnread;
  }, [caseUnread, commsUnread]);

  return {
    workUnread: Number(workUnread ?? 0),
    notifUnread: Number(notifSummary.unread ?? 0),
    monitorUniqueCount: Number(notifSummary.monitorUniqueCount ?? notifSummary.activeDistinctCount ?? 0),
  };
}

export function useIsPartnerOrManager(user: { roleName?: string | null | undefined } | null | undefined): {
  isPartner: boolean;
  canViewMonitor: boolean;
  canViewEscalationFeed: boolean;
} {
  const rn = String(user?.roleName ?? "").trim().toLowerCase();
  const isPartner = rn === "partner";
  const canViewMonitor = isPartner || isAccountingRoleAllowed(String(user?.roleName ?? "")) || hasPermission(user as any, "case_monitor", "view") || hasPermission(user as any, "accounting", "read");
  const canViewEscalationFeed = isPartner || hasPermission(user as any, "case_monitor", "view");
  return { isPartner, canViewMonitor, canViewEscalationFeed };
}
