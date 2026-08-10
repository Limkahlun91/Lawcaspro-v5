import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Briefcase, Users, Building2, HardHat, MessageSquare, ArrowRight, AlertTriangle, Activity, Clock, CheckCircle, ChevronRight, XCircle, FolderKey } from "lucide-react";
import { useLocation } from "wouter";
import { apiFetchJson } from "@/lib/api-client";
import { QueryFallback } from "@/components/query-fallback";
import { useAuth } from "@/lib/auth-context";
import { useEffect, useState } from "react";
import { hasPermission } from "@/lib/permissions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

const STATUS_SHORT: Record<string, string> = {
  "File Opened / SPA Pending Signing": "SPA Pending",
  "SPA Stamped": "SPA Stamped",
  "Loan Docs Pending": "Loan Pending",
  "Loan Docs Signed": "Loan Signed",
  "MOT Pending": "MOT Pending",
  "MOT Registered": "MOT Registered",
  "NOA Served": "NOA Served",
  "Completed": "Completed",
};

const STATUS_COLORS: Record<string, string> = {
  Completed: "bg-green-50 text-green-700",
  "MOT Registered": "bg-teal-50 text-teal-700",
  "NOA Served": "bg-cyan-50 text-cyan-700",
};

function StatusBadge({ status }: { status: string }) {
  const short = STATUS_SHORT[status] ?? status;
  const colorClass = STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${colorClass}`}>{short}</span>
  );
}

export default function AppDashboard() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const firmId = user?.firmId ?? null;
  const roleName = String((user as any)?.roleName ?? "");
  const isManagement = (n: string) => (n || "").toLowerCase().includes("partner") || (n || "").toLowerCase().includes("manager");
  const isManagementRole = isManagement(roleName);
  const isFirmStaffBlocked = user?.userType === "firm_user" && !isManagementRole;

  useEffect(() => {
    if (isFirmStaffBlocked) {
      setLocation("/app/workbench");
    }
  }, [isFirmStaffBlocked, setLocation]);

  const canApproveCases = (() => {
    const n = roleName.trim().toLowerCase();
    if (!n) return false;
    if (n.includes("partner")) return true;
    if (n === "account admin" || n === "account manager") return true;
    if (n.includes("account") && n.includes("admin")) return true;
    if (n.includes("account") && n.includes("manager")) return true;
    return false;
  })();
  const refresh = (() => {
    if (typeof window === "undefined") return false;
    const raw = new URLSearchParams(window.location.search).get("refresh");
    if (!raw) return false;
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  })();

  const queryClient = useQueryClient();
  const canViewCaseMonitor = !isFirmStaffBlocked && (hasPermission(user, "case_monitor", "view") || canApproveCases);

  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveTargetId, setResolveTargetId] = useState<number | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  const monitorSummary = useQuery({
    queryKey: ["case-monitor", "summary", firmId],
    queryFn: ({ signal }) =>
      apiFetchJson("/case-monitor/summary", { signal, timeoutMs: 12_000 }) as Promise<{
        total: number;
        bySeverity: Record<string, number>;
        byKind: Record<string, number>;
        byLawyer: Array<{ userId: number; userName: string; count: number }>;
        pvDelays: number;
        urgentCount: number;
        attentionCount: number;
        criticalCount: number;
      }>,
    enabled: canViewCaseMonitor && Number.isFinite(firmId) && Number(firmId) > 0,
    staleTime: 60_000,
    retry: 0,
  });

  const monitorBottlenecks = useQuery({
    queryKey: ["case-monitor", "bottlenecks", firmId],
    queryFn: ({ signal }) =>
      apiFetchJson("/case-monitor/bottlenecks?onlyEscalated=0&limit=6", { signal, timeoutMs: 15_000 }) as Promise<{
        items: Array<{
          id: number; monitorKind: string; severity: string; daysStuck: number; title: string; detail: string;
          escalatedToPartner: boolean; caseId: number | null; caseReferenceNo: string | null; paymentVoucherId: number | null;
          voucherNo: string | null; lawyerName: string | null; createdAt: string;
        }>;
        limit: number; offset: number;
      }>,
    enabled: canViewCaseMonitor && Number.isFinite(firmId) && Number(firmId) > 0,
    staleTime: 60_000,
    retry: 0,
  });

  const canViewFileCustody = !isFirmStaffBlocked && (hasPermission(user, "accounting", "view") || hasPermission(user, "file_custody", "view"));
  const custodySummary = useQuery({
    queryKey: ["file-custody", "summary", firmId],
    queryFn: ({ signal }) =>
      apiFetchJson("/file-custody/items/summary", { signal, timeoutMs: 12_000 }) as Promise<{
        total: number; out: number; overdueReturn: number; unacknowledgedOverdue: number;
        byStatus: Record<string, number>; byCategory: Record<string, number>;
      }>,
    enabled: canViewFileCustody && Number.isFinite(firmId) && Number(firmId) > 0,
    staleTime: 30_000,
    retry: 0,
  });

  const resolveMut = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      return apiFetchJson(`/case-monitor/bottlenecks/${id}/resolve`, {
        method: "POST",
        timeoutMs: 15_000,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      }) as Promise<{ ok: true; resolvedAt: string }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["case-monitor"] });
      setResolveOpen(false);
      setResolveTargetId(null);
      setResolveNote("");
    },
  });

  const openResolve = (id: number) => {
    setResolveTargetId(id);
    setResolveNote("");
    setResolveOpen(true);
  };

  useEffect(() => {
    if (!refresh) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("refresh");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, [refresh]);

  const getErrStatus = (e: unknown): number | null => {
    const raw = (e as any)?.status;
    return typeof raw === "number" ? raw : null;
  };

  const isAbortLikeError = (e: unknown): boolean => {
    const name = (e as any)?.name;
    if (name === "AbortError") return true;
    const msg = typeof (e as any)?.message === "string" ? String((e as any).message) : "";
    return msg.toLowerCase().includes("signal is aborted");
  };

  const { data: stats, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["dashboard", firmId],
    queryFn: ({ signal }) =>
      apiFetchJson(refresh ? "/dashboard?refresh=1" : "/dashboard", { timeoutMs: refresh ? 15_000 : 12_000, signal }) as Promise<Record<string, any>>,
    enabled: !isFirmStaffBlocked && Number.isFinite(firmId) && Number(firmId) > 0,
    staleTime: 30_000,
    retry: (failureCount, err) => {
      if (failureCount >= 2) return false;
      if (isAbortLikeError(err)) return false;
      const status = getErrStatus(err);
      if (status === 401 || status === 403 || status === 404) return false;
      if ((err as any)?.retryable === false) return false;
      return true;
    },
    retryDelay: (attemptIndex) => {
      const base = 300 * Math.pow(2, attemptIndex);
      const jitter = Math.floor(Math.random() * 200);
      return base + jitter;
    },
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (prev) => prev,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h1>
          <p className="text-slate-500 mt-1">Overview of your firm's operations</p>
          <div className="mt-2 text-xs text-slate-400">Loading data...</div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="pt-5 pb-4">
                <div className="h-4 w-24 bg-slate-100 rounded" />
                <div className="mt-3 h-8 w-20 bg-slate-100 rounded" />
                <div className="mt-2 h-3 w-32 bg-slate-100 rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const errStatus = getErrStatus(error);
  if (isError && (errStatus === 401 || errStatus === 403)) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <QueryFallback title="Unauthorized" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
        </div>
      </div>
    );
  }

  const effectiveStats = (() => {
    if (!isError) return stats;
    if (isAbortLikeError(error)) return stats;
    if (stats) return stats;
    const unavailableFields = [
      "totalCases",
      "activeCases",
      "completedCases",
      "totalClients",
      "totalDevelopers",
      "totalProjects",
      "recentCases",
      "commsThisMonth",
      "completionSlaOverdue",
    ];
    return {
      ok: true,
      degraded: true,
      stale: false,
      reason: "request_failed",
      warnings: [{ module: "network", code: null, message: "Dashboard data request failed. Showing partial UI." }],
      unavailableFields,
      dashboard: {},
    } as Record<string, any>;
  })();

  if (!effectiveStats) {
    return (
      <div className="text-slate-400 py-12 text-center text-sm">
        No dashboard data available
      </div>
    );
  }

  const degraded = Boolean((effectiveStats as any)?.degraded) || Boolean((effectiveStats as any)?.ok === false);
  const warnings: Array<{ module?: string; code?: string | null; message?: string }> = Array.isArray((effectiveStats as any)?.warnings) ? (effectiveStats as any).warnings : [];
  const unavailableFields: string[] = Array.isArray((effectiveStats as any)?.unavailableFields) ? (effectiveStats as any).unavailableFields : [];
  const debugInfo = (effectiveStats as any)?.debug && typeof (effectiveStats as any)?.debug === "object" ? (effectiveStats as any).debug : null;
  const dashboard = ((effectiveStats as any)?.dashboard && typeof (effectiveStats as any).dashboard === "object" ? (effectiveStats as any).dashboard : null) as Record<string, any> | null;
  const resolvedStats = (dashboard ?? effectiveStats) as Record<string, any>;
  const criticalFields = ["totalCases", "activeCases", "completedCases", "totalClients", "totalProjects", "totalDevelopers"];
  const hasCriticalUnavailable = degraded && criticalFields.some((f) => unavailableFields.includes(f));
  const showMajorDegradedBanner = hasCriticalUnavailable || (isError && !stats && !isAbortLikeError(error));
  const lastUpdatedAtLabel = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleString() : null;

  const showValue = (field: string, value: unknown): string => {
    if (degraded && unavailableFields.includes(field)) return "—";
    if (value === null || value === undefined) return "0";
    return String(value);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h1>
        <p className="text-slate-500 mt-1">Overview of your firm's operations</p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>{isFetching ? "Refreshing..." : lastUpdatedAtLabel ? `Last updated: ${lastUpdatedAtLabel}` : null}</span>
          <button className="text-amber-700 hover:text-amber-800 underline" onClick={() => refetch()} disabled={isFetching}>
            Refresh Dashboard
          </button>
        </div>
      </div>

      {showMajorDegradedBanner ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium">Dashboard partially unavailable</div>
          {warnings.length > 0 ? (
            <div className="mt-1 text-xs text-amber-900/90">
              {warnings.slice(0, 3).map((w, idx) => (
                <div key={`${String(w.module ?? "warn")}_${idx}`}>
                  {String(w.module ?? "unknown")} — {String(w.code ?? "")}{w.code ? " — " : ""}{String(w.message ?? "")}
                </div>
              ))}
            </div>
          ) : null}
          {debugInfo ? (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-amber-100/60 p-2 text-[11px] leading-snug">{JSON.stringify(debugInfo, null, 2)}</pre>
          ) : null}
        </div>
      ) : degraded ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Some widgets are temporarily unavailable. Core stats are still shown.
        </div>
      ) : null}

      {/* Primary stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Approved Cases",
            value: showValue("totalCases", resolvedStats.totalCases),
            sub: `${showValue("activeCases", resolvedStats.activeCases)} active · ${showValue("completedCases", resolvedStats.completedCases)} completed`,
            icon: Briefcase,
            color: "bg-amber-50 text-amber-600",
            href: "/app/cases",
          },
          {
            label: "Clients",
            value: showValue("totalClients", resolvedStats.totalClients),
            sub: null,
            icon: Users,
            color: "bg-blue-50 text-blue-600",
            href: "/app/clients",
          },
          {
            label: "Projects",
            value: showValue("totalProjects", resolvedStats.totalProjects),
            sub: null,
            icon: Building2,
            color: "bg-green-50 text-green-600",
            href: "/app/projects",
          },
          {
            label: "Developers",
            value: showValue("totalDevelopers", resolvedStats.totalDevelopers),
            sub: null,
            icon: HardHat,
            color: "bg-slate-100 text-slate-600",
            href: "/app/developers",
          },
        ].map((item) => (
          <Card
            key={item.label}
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => setLocation(item.href)}
          >
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.color}`}>
                  <item.icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-500">{item.label}</div>
                  <div className="text-2xl font-bold text-slate-900 leading-tight">{item.value}</div>
                  {item.sub && <div className="text-xs text-slate-400 mt-0.5">{item.sub}</div>}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {canApproveCases ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              label: "OPEN FILE PENDING APPROVAL",
              value: showValue("pendingApprovalCases", (resolvedStats as any).pendingApprovalCases),
              sub: null,
              icon: Briefcase,
              color: "bg-slate-100 text-slate-700",
              href: "/app/accounting/file-listing?approvalStatus=pending_approval",
            },
          ].map((item) => (
            <Card
              key={item.label}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => setLocation(item.href)}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.color}`}>
                    <item.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">{item.label}</div>
                    <div className="text-2xl font-bold text-slate-900 leading-tight">{item.value}</div>
                    {item.sub && <div className="text-xs text-slate-400 mt-0.5">{item.sub}</div>}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "CASE DETAILS TO AMEND",
            value: showValue("rejectedCases", (resolvedStats as any).rejectedCases),
            sub: null,
            icon: Briefcase,
            color: "bg-slate-100 text-slate-700",
            href: "/app/cases?approvalStatus=rejected",
          },
        ].map((item) => (
          <Card
            key={item.label}
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => setLocation(item.href)}
          >
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.color}`}>
                  <item.icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-500">{item.label}</div>
                  <div className="text-2xl font-bold text-slate-900 leading-tight">{item.value}</div>
                  {item.sub && <div className="text-xs text-slate-400 mt-0.5">{item.sub}</div>}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setLocation("/app/communications")}>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <div className="text-xs text-slate-500">Comms This Month</div>
                <div className="text-xl font-bold text-slate-900">{showValue("commsThisMonth", resolvedStats.commsThisMonth)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {canViewCaseMonitor ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card
              className={(monitorSummary.data?.total ?? 0) > 0 ? "cursor-pointer hover:shadow-md transition-shadow border-rose-200 bg-rose-50/40" : "cursor-pointer hover:shadow-md transition-shadow"}
              onClick={() => setLocation("/app/accounting?tab=monitor")}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-rose-50 text-rose-600">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">ACTIVE BOTTLENECKS</div>
                    <div className="text-2xl font-bold text-slate-900 leading-tight">
                      {monitorSummary.isLoading ? "…" : String(monitorSummary.data?.total ?? 0)}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">Case 3d no-move + PV overdue</div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card
              className={(monitorSummary.data?.criticalCount ?? 0) > 0 ? "cursor-pointer hover:shadow-md transition-shadow border-red-300 bg-red-50/60" : "cursor-pointer hover:shadow-md transition-shadow"}
              onClick={() => setLocation("/app/accounting?tab=monitor&severity=critical")}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-red-50 text-red-600">
                    <XCircle className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">CRITICAL</div>
                    <div className="text-2xl font-bold text-slate-900 leading-tight">
                      {monitorSummary.isLoading ? "…" : String(monitorSummary.data?.criticalCount ?? 0)}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">≥7d / ≥96h overdue</div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card
              className={(monitorSummary.data?.urgentCount ?? 0) > 0 ? "cursor-pointer hover:shadow-md transition-shadow border-amber-300 bg-amber-50/60" : "cursor-pointer hover:shadow-md transition-shadow"}
              onClick={() => setLocation("/app/accounting?tab=monitor&severity=urgent")}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-amber-50 text-amber-600">
                    <Activity className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">URGENT</div>
                    <div className="text-2xl font-bold text-slate-900 leading-tight">
                      {monitorSummary.isLoading ? "…" : String(monitorSummary.data?.urgentCount ?? 0)}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">≥5d / ≥72h overdue</div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card
              className={(monitorSummary.data?.pvDelays ?? 0) > 0 ? "cursor-pointer hover:shadow-md transition-shadow border-orange-200 bg-orange-50/50" : "cursor-pointer hover:shadow-md transition-shadow"}
              onClick={() => setLocation("/app/accounting?tab=monitor&kind=pv_delay")}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-orange-50 text-orange-600">
                    <Clock className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">PV DELAYS</div>
                    <div className="text-2xl font-bold text-slate-900 leading-tight">
                      {monitorSummary.isLoading ? "…" : String(monitorSummary.data?.pvDelays ?? 0)}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">Payment overdue &gt;48h</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className={(monitorSummary.data?.criticalCount ?? 0) > 0 ? "border-red-200 bg-red-50/20" : undefined}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">Partner Bottleneck Monitor</CardTitle>
                {!monitorSummary.isLoading && (
                  ((monitorBottlenecks.data?.items?.length ?? 0) > 0) ? (
                    <Badge variant="secondary" className="bg-slate-100 text-slate-700 text-xs">Top {monitorBottlenecks.data?.items?.length ?? 0}</Badge>
                  ) : null
                )}
              </div>
              <button
                className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1"
                onClick={() => setLocation("/app/accounting?tab=monitor")}
              >
                Open Monitor <ChevronRight className="w-3 h-3" />
              </button>
            </CardHeader>
            <CardContent>
              {monitorBottlenecks.isLoading || monitorSummary.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="animate-pulse h-12 rounded bg-slate-100" />
                  ))}
                </div>
              ) : monitorBottlenecks.error || monitorSummary.error ? (
                <div className="text-xs text-slate-500 italic py-4 text-center">Case monitor unavailable right now</div>
              ) : !monitorBottlenecks.data?.items || monitorBottlenecks.data.items.length === 0 ? (
                <div className="text-sm text-slate-500 py-6 text-center flex flex-col items-center gap-2">
                  <CheckCircle className="w-6 h-6 text-emerald-500" />
                  <div className="font-medium text-emerald-700">All caught up — no active bottlenecks</div>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {monitorBottlenecks.data.items.map((b) => {
                    const sevBg =
                      b.severity === "critical"
                        ? "bg-red-500"
                        : b.severity === "urgent"
                          ? "bg-amber-500"
                          : b.severity === "attention"
                            ? "bg-sky-500"
                            : "bg-slate-400";
                    const badgeBg =
                      b.severity === "critical"
                        ? "bg-red-100 text-red-700 border border-red-200"
                        : b.severity === "urgent"
                          ? "bg-amber-100 text-amber-800 border border-amber-200"
                          : b.severity === "attention"
                            ? "bg-sky-100 text-sky-700 border border-sky-200"
                            : "bg-slate-100 text-slate-700";
                    const kindLabel =
                      b.monitorKind === "case_no_movement"
                        ? "Case stuck"
                        : b.monitorKind === "pv_delay"
                          ? "PV overdue"
                          : String(b.monitorKind);
                    return (
                      <li key={String(b.id)} className="py-3 first:pt-0 last:pb-0 flex items-start gap-3">
                        <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${sevBg}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={badgeBg}>{b.severity.toUpperCase()}</Badge>
                            <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200">{kindLabel}</Badge>
                            <span className="text-xs text-slate-500">{b.daysStuck}d stuck</span>
                            {b.escalatedToPartner ? (
                              <Badge variant="destructive" className="bg-red-50 text-red-700 border border-red-200 hover:bg-red-50">ESCALATED</Badge>
                            ) : null}
                          </div>
                          <button
                            className="mt-1 font-medium text-sm text-slate-800 hover:text-slate-900 truncate block text-left w-full"
                            onClick={() => {
                              if (b.caseId) setLocation(`/app/cases/${b.caseId}?returnTo=${encodeURIComponent("/app/dashboard")}`);
                              else if (b.paymentVoucherId) setLocation(`/app/accounting?pv=${b.paymentVoucherId}&returnTo=${encodeURIComponent("/app/dashboard")}`);
                            }}
                          >
                            {b.title}
                          </button>
                          <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{b.detail}</div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                            {b.lawyerName ? <span>Assigned: <span className="font-medium text-slate-700">{b.lawyerName}</span></span> : null}
                            {b.caseReferenceNo ? <span>Case ref: <span className="font-medium text-slate-700">{b.caseReferenceNo}</span></span> : null}
                            {b.voucherNo ? <span>PV: <span className="font-medium text-slate-700">{b.voucherNo}</span></span> : null}
                          </div>
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                          <Button size="sm" variant="secondary" onClick={() => openResolve(b.id)} disabled={resolveMut.isPending}>
                            Resolve
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      {canViewFileCustody ? (
        <Card className={(custodySummary.data?.overdueReturn ?? 0) > 0 || (custodySummary.data?.unacknowledgedOverdue ?? 0) > 0 ? "border-orange-200 bg-orange-50/30" : undefined}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base flex items-center gap-2"><FolderKey className="w-4 h-4 text-amber-600" /> File Custody Escalation</CardTitle>
              {!custodySummary.isLoading && (custodySummary.data?.out ?? 0) > 0 ? (
                <Badge variant="secondary" className="bg-slate-100 text-slate-700 text-xs">{custodySummary.data?.out ?? 0} out</Badge>
              ) : null}
            </div>
            <button
              className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1"
              onClick={() => setLocation("/app/accounting?tab=file-custody&only_out=1")}
            >
              Open Custody <ChevronRight className="w-3 h-3" />
            </button>
          </CardHeader>
          <CardContent>
            {custodySummary.isLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="animate-pulse h-16 rounded-md bg-slate-100" />
                ))}
              </div>
            ) : custodySummary.error ? (
              <div className="text-xs text-slate-500 italic py-4 text-center">File custody unavailable right now</div>
            ) : (() => {
              const total = custodySummary.data?.total ?? 0;
              const out = custodySummary.data?.out ?? 0;
              const overdueReturn = custodySummary.data?.overdueReturn ?? 0;
              const unack = custodySummary.data?.unacknowledgedOverdue ?? 0;
              if (total === 0 && out === 0) {
                return (
                  <div className="text-sm text-slate-500 py-6 text-center flex flex-col items-center gap-2">
                    <CheckCircle className="w-6 h-6 text-emerald-500" />
                    <div className="font-medium text-emerald-700">No custody items — all files in office</div>
                  </div>
                );
              }
              return (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <div className="rounded-md border border-slate-200 bg-white p-3">
                    <div className="text-[11px] uppercase text-slate-500 font-medium tracking-wider">Total files</div>
                    <div className="text-2xl font-bold text-slate-900 mt-1">{total}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">Registered custody</div>
                  </div>
                  <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3">
                    <div className="text-[11px] uppercase text-amber-700 font-medium tracking-wider">Currently out</div>
                    <div className="text-2xl font-bold text-amber-800 mt-1">{out}</div>
                    <div className="text-[11px] text-amber-600/80 mt-0.5">With holders</div>
                  </div>
                  <div className={`rounded-md border p-3 ${overdueReturn > 0 ? "border-orange-300 bg-orange-50/60" : "border-slate-200 bg-white"}`}>
                    <div className={`text-[11px] uppercase font-medium tracking-wider ${overdueReturn > 0 ? "text-orange-700" : "text-slate-500"}`}>Return overdue</div>
                    <div className={`text-2xl font-bold mt-1 ${overdueReturn > 0 ? "text-orange-800" : "text-slate-900"}`}>{overdueReturn}</div>
                    <div className={`text-[11px] mt-0.5 ${overdueReturn > 0 ? "text-orange-700" : "text-slate-400"}`}>Past due date</div>
                  </div>
                  <div className={`rounded-md border p-3 ${unack > 0 ? "border-rose-300 bg-rose-50/60" : "border-slate-200 bg-white"}`}>
                    <div className={`text-[11px] uppercase font-medium tracking-wider ${unack > 0 ? "text-rose-700" : "text-slate-500"}`}>Ack overdue</div>
                    <div className={`text-2xl font-bold mt-1 ${unack > 0 ? "text-rose-800" : "text-slate-900"}`}>{unack}</div>
                    <div className={`text-[11px] mt-0.5 ${unack > 0 ? "text-rose-700" : "text-slate-400"}`}>Receipt not confirmed</div>
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.isArray((resolvedStats as any).completionSlaOverdue) && (resolvedStats as any).completionSlaOverdue.length > 0 ? (
          <Card className="md:col-span-2 border-red-200 bg-red-50/40">
            <CardHeader className="pb-3">
              <CardTitle className="text-red-700">Completion SLA Overdue</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-red-700">
                {(resolvedStats as any).completionSlaOverdue.length} case(s) overdue for Advice on.
              </div>
              <div className="mt-3 space-y-2">
                {(resolvedStats as any).completionSlaOverdue.slice(0, 5).map((c: any) => (
                  <div key={String(c.caseId)} className="flex items-center justify-between gap-3">
                    <button
                      className="text-sm font-semibold text-red-700 hover:text-red-800 truncate"
                      onClick={() => setLocation(`/app/cases/${c.caseId}?returnTo=${encodeURIComponent("/app/dashboard")}`)}
                    >
                      {String(c.referenceNo || `Case #${c.caseId}`)}
                    </button>
                    <span className="text-xs text-red-700">
                      {Math.floor(Number(c.hoursElapsed ?? 0))}h
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}
        {/* Case Breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Case Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">By Financing</div>
              {[
                { label: "Cash Purchases", value: resolvedStats.cashCases ?? 0, total: resolvedStats.totalCases ?? 0, color: "bg-amber-400" },
                { label: "Loan Purchases", value: resolvedStats.loanCases ?? 0, total: resolvedStats.totalCases ?? 0, color: "bg-blue-400" },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <div className="text-sm text-slate-600 w-36">{item.label}</div>
                  <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${item.color}`} style={{ width: `${item.total ? (item.value / item.total) * 100 : 0}%` }} />
                  </div>
                  <div className="text-sm font-semibold text-slate-700 w-6 text-right">{item.value}</div>
                </div>
              ))}
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 mt-4">By Title Type</div>
              {[
                { label: "Master Title", value: resolvedStats.masterTitleCases ?? 0, color: "bg-purple-400" },
                { label: "Individual Title", value: resolvedStats.individualTitleCases ?? 0, color: "bg-green-400" },
                { label: "Strata Title", value: resolvedStats.strataTitleCases ?? 0, color: "bg-teal-400" },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <div className="text-sm text-slate-600 w-36">{item.label}</div>
                  <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${item.color}`} style={{ width: `${resolvedStats.totalCases ? (item.value / resolvedStats.totalCases) * 100 : 0}%` }} />
                  </div>
                  <div className="text-sm font-semibold text-slate-700 w-6 text-right">{item.value}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Cases */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle>Recent Cases</CardTitle>
            <button
              className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1"
              onClick={() => setLocation("/app/cases")}
            >
              View all <ArrowRight className="w-3 h-3" />
            </button>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-slate-50">
              {(resolvedStats.recentCases ?? []).map((c: Record<string, any>) => (
                <div
                  key={String(c.id)}
                  className="py-3 flex items-start justify-between gap-2 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded"
                  onClick={() => setLocation(`/app/cases/${c.id}?returnTo=${encodeURIComponent("/app/dashboard")}`)}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-amber-600 text-sm">{String(c.referenceNo)}</div>
                    <div className="text-xs text-slate-500 truncate">{String(c.projectName)}</div>
                    {c.assignedLawyerName && (
                      <div className="text-xs text-slate-400 mt-0.5">{String(c.assignedLawyerName)}</div>
                    )}
                    {c.completionSla?.status ? (
                      <div className="mt-1">
                        <span
                          className={[
                            "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold",
                            c.completionSla.status === "overdue"
                              ? "bg-red-100 text-red-700"
                              : c.completionSla.status === "soon"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-emerald-100 text-emerald-800",
                          ].join(" ")}
                        >
                          Advice SLA: {c.completionSla.status === "overdue" ? "Overdue" : c.completionSla.status === "soon" ? "Soon" : "Due"}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0">
                    <StatusBadge status={String(c.status)} />
                  </div>
                </div>
              ))}
              {!(resolvedStats.recentCases?.length) && (
                <div className="text-sm text-slate-400 italic py-4 text-center">No cases yet</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={resolveOpen} onOpenChange={(o) => { if (!o) { setResolveOpen(false); setResolveTargetId(null); setResolveNote(""); } }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Resolve Bottleneck #{resolveTargetId ?? "—"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="text-xs text-slate-500">
              Mark this item as resolved. A note is required to record the reason/next step.
            </div>
            <Textarea
              rows={4}
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              placeholder="e.g. Reassigned the file to another clerk; Milestone step progressed today."
            />
            {resolveMut.error ? (
              <div className="text-xs text-red-600">
                Failed to resolve: {String((resolveMut.error as any)?.message ?? (resolveMut.error as any) ?? "unknown")}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => { setResolveOpen(false); setResolveTargetId(null); setResolveNote(""); }}>
              Cancel
            </Button>
            <Button
              disabled={!Number.isFinite(resolveTargetId) || resolveNote.trim().length < 3 || resolveMut.isPending}
              onClick={() => {
                if (!Number.isFinite(resolveTargetId)) return;
                void resolveMut.mutateAsync({ id: resolveTargetId as number, note: resolveNote });
              }}
            >
              {resolveMut.isPending ? "Resolving..." : "Confirm Resolve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
