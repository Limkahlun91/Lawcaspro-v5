import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Briefcase, Users, Building2, HardHat, DollarSign, TrendingUp, MessageSquare, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";
import { apiFetchJson } from "@/lib/api-client";
import { QueryFallback } from "@/components/query-fallback";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, isAccountingRoleAllowed } from "@/lib/permissions";
import { MilestonesTable } from "@/components/milestones-table";

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
  const refresh = (() => {
    if (typeof window === "undefined") return false;
    const raw = new URLSearchParams(window.location.search).get("refresh");
    if (!raw) return false;
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  })();

  const { data: stats, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["dashboard", firmId, refresh ? "refresh" : "cached"],
    queryFn: () => apiFetchJson(refresh ? "/dashboard?refresh=1" : "/dashboard", { timeoutMs: 8000 }) as Promise<Record<string, any>>,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  if (isLoading) {
    return <div className="text-slate-400 py-12 text-center text-sm">Loading dashboard...</div>;
  }

  const errStatus = typeof (error as any)?.status === "number" ? Number((error as any).status) : null;
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
    const unavailableFields = [
      "totalCases",
      "activeCases",
      "completedCases",
      "totalClients",
      "totalDevelopers",
      "totalProjects",
      "milestoneCards",
      "milestoneSections",
      "recentCases",
      "billing",
      "outstandingAdvances",
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

  const showValue = (field: string, value: unknown): string => {
    if (degraded && unavailableFields.includes(field)) return "—";
    if (value === null || value === undefined) return "0";
    return String(value);
  };

  const canSeeAccounting = !!user && hasPermission(user, "accounting", "read") && isAccountingRoleAllowed(user.roleName);
  const billing = (resolvedStats.billing ?? {}) as Record<string, number>;
  const outstandingAdvances = (resolvedStats.outstandingAdvances ?? {}) as Record<string, any>;
  type MilestoneCard = {
    key: string;
    label: string;
    count: number;
    pendingCount?: number;
    doneCount?: number;
    filter: { milestone?: string; milestonePresence?: string; purchaseMode?: string; titleType?: string };
  };
  const milestoneCards: MilestoneCard[] = Array.isArray((resolvedStats as Record<string, any>).milestoneCards)
    ? ((resolvedStats as Record<string, any>).milestoneCards as MilestoneCard[])
    : [];
  type MilestoneSection = { key: string; label: string; total: number; cards: MilestoneCard[] };
  const milestoneSections: MilestoneSection[] = Array.isArray((resolvedStats as Record<string, any>).milestoneSections)
    ? ((resolvedStats as Record<string, any>).milestoneSections as MilestoneSection[])
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h1>
        <p className="text-slate-500 mt-1">Overview of your firm's operations</p>
      </div>

      {degraded ? (
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
      ) : null}

      {/* Primary stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Total Cases",
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

      <MilestonesTable
        milestoneSections={milestoneSections}
        milestoneCards={milestoneCards}
        onNavigate={(href) => setLocation(href)}
      />

      <div className={`grid grid-cols-1 gap-4 ${canSeeAccounting ? "md:grid-cols-4" : ""}`}>
        {canSeeAccounting && (
          <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setLocation("/app/accounting")}>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
                  <DollarSign className="w-5 h-5 text-slate-700" />
                </div>
                <div>
                  <div className="text-xs text-slate-500">Total Billed</div>
                  <div className="text-xl font-bold text-slate-900">{fmt(billing.totalBilled)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        {canSeeAccounting && (
          <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setLocation("/app/accounting")}>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                  <TrendingUp className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <div className="text-xs text-slate-500">Outstanding</div>
                  <div className="text-xl font-bold text-red-600">{fmt(billing.totalOutstanding)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        {canSeeAccounting && (
          <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setLocation("/app/accounting?tab=ledger")}>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                  <ArrowRight className="w-5 h-5 text-amber-700" />
                </div>
                <div className="flex-1">
                  <div className="text-xs text-slate-500">Outstanding Client Advances</div>
                  <div className="text-xl font-bold text-amber-800">{fmt(outstandingAdvances.totalAmount)}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{Number(outstandingAdvances.caseCount ?? 0)} case(s)</div>
                  {Array.isArray(outstandingAdvances.topCases) && outstandingAdvances.topCases.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {outstandingAdvances.topCases.slice(0, 3).map((c: any) => (
                        <div key={String(c.caseId)} className="text-xs text-slate-600 flex items-center justify-between gap-2">
                          <span className="truncate">{String(c.referenceNo || `Case #${c.caseId}`)}</span>
                          <span className="font-semibold text-amber-800">{fmt(c.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
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
    </div>
  );
}
