import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useLocation } from "wouter";
import {
  Users,
  UserCheck,
  CalendarClock,
  FileText,
  Shield,
  Briefcase,
  Clock,
  Sparkles,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { getHttpStatus, getErrorMessage } from "@/lib/error-message";
import { getApiFailureCodeFromError } from "@/lib/api-failure";
import { useEffectiveUserFeaturesMap } from "@/lib/feature-guards";

export type HrDashboardSummary = {
  totalEmployees: number;
  activeToday: number;
  onLeaveToday: number;
  pendingLeave: number;
  pendingClaims: number;
  payroll: {
    label: "Not Started" | "Draft" | "Processing" | "Completed";
    period: string | null;
  } | null;
};

function isNotFoundApiError(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status === 404) return true;
  const code = getApiFailureCodeFromError(error);
  if (code === "ROUTE_NOT_FOUND") return true;
  if (code && code.endsWith("_NOT_FOUND")) return true;
  return false;
}

function getErrorRequestId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const anyErr = error as { requestId?: unknown; data?: { meta?: { request_id?: unknown } } };
  if (typeof anyErr.requestId === "string" && anyErr.requestId.trim()) return anyErr.requestId;
  const nested = anyErr.data?.meta?.request_id;
  if (typeof nested === "string" && nested.trim()) return nested;
  return null;
}

function formatErrorId(error: unknown): string {
  const rid = getErrorRequestId(error);
  if (rid) {
    const short = rid.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    return short || "HR-ERR-000000";
  }
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `HR-${rand}`;
}

type LegacyStats = {
  headcount?: number;
  activeToday?: number;
  pendingLeaves?: number;
  pendingClaims?: number;
  onLeaveToday?: number;
  payroll?: HrDashboardSummary["payroll"];
};

async function loadNewDashboard(): Promise<HrDashboardSummary> {
  const res = await apiFetchJson("/hr/me/dashboard");
  const raw = unwrapApiData<any>(res);
  return {
    totalEmployees: Number(raw?.totalEmployees ?? raw?.headcount ?? 0),
    activeToday: Number(raw?.activeToday ?? 0),
    onLeaveToday: Number(raw?.onLeaveToday ?? 0),
    pendingLeave: Number(raw?.pendingLeave ?? raw?.pendingLeaves ?? 0),
    pendingClaims: Number(raw?.pendingClaims ?? 0),
    payroll: normalizePayroll(raw?.payroll),
  };
}

async function loadLegacyDashboard(): Promise<HrDashboardSummary> {
  const res = await apiFetchJson("/hr/dashboard/stats");
  const raw = unwrapApiData<LegacyStats>(res);
  return {
    totalEmployees: Number(raw?.headcount ?? 0),
    activeToday: Number(raw?.activeToday ?? 0),
    onLeaveToday: Number(raw?.onLeaveToday ?? 0),
    pendingLeave: Number(raw?.pendingLeaves ?? 0),
    pendingClaims: Number(raw?.pendingClaims ?? 0),
    payroll: normalizePayroll(raw?.payroll),
  };
}

function normalizePayroll(
  raw: unknown,
): HrDashboardSummary["payroll"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { label?: unknown; period?: unknown; status?: unknown };
  const allowedLabels: HrDashboardSummary["payroll"]["label"][] = [
    "Not Started",
    "Draft",
    "Processing",
    "Completed",
  ];
  let label: HrDashboardSummary["payroll"]["label"] | null = null;
  const cand = typeof r.label === "string" ? r.label : typeof r.status === "string" ? r.status : "";
  for (const a of allowedLabels) {
    if (cand.toLowerCase() === a.toLowerCase()) {
      label = a;
      break;
    }
  }
  if (!label) return null;
  return {
    label,
    period: typeof r.period === "string" && r.period.trim() ? r.period : null,
  };
}

function pageRootClasses(): string {
  return "space-y-6 p-4 md:p-6 min-h-[calc(100vh-80px)]";
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 tracking-tight">HR Dashboard</h1>
      <p className="text-slate-500 mt-1">Human Resources overview</p>
    </div>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="pt-4 pb-4 px-4">
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function DashboardError({
  error,
  onRetry,
  isRetrying,
}: {
  error: unknown;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6 pb-6 px-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <div className="font-semibold text-slate-900 text-base">
                Unable to load HR Dashboard
              </div>
              <p className="text-sm text-slate-500 mt-1">
                We couldn&apos;t load the latest HR information.
              </p>
              <p className="text-xs text-slate-400 mt-2 break-words">
                {getErrorMessage(error)}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <Button onClick={onRetry} disabled={isRetrying} size="sm">
                {isRetrying ? "Retrying…" : "Retry"}
              </Button>
              <div className="text-xs text-slate-500">
                Error ID:{" "}
                <code className="px-2 py-1 bg-slate-100 rounded font-mono">
                  {formatErrorId(error)}
                </code>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  canAddEmployees,
  onNavigate,
}: {
  canAddEmployees: boolean;
  onNavigate: (path: string) => void;
}) {
  return (
    <Card>
      <CardContent className="pt-10 pb-10 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-slate-50 flex items-center justify-center text-slate-400">
          <Users className="w-7 h-7" />
        </div>
        <div className="mt-4 font-semibold text-slate-900">No employees yet</div>
        <p className="mt-1 text-sm text-slate-500">
          Start by adding your first employee.
        </p>
        {canAddEmployees ? (
          <div className="mt-5">
            <Button onClick={() => onNavigate("/app/hr/employees")}>
              Add Employee
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

type QuickAction = {
  key: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

const ALL_QUICK_ACTIONS: QuickAction[] = [
  { key: "hr.employees", label: "Employees", href: "/app/hr/employees", icon: Users },
  { key: "hr.attendance", label: "Attendance", href: "/app/hr/attendance", icon: Clock },
  { key: "hr.leave", label: "Leave", href: "/app/hr/leave", icon: CalendarClock },
  { key: "hr.claims", label: "Claims", href: "/app/hr/claims", icon: FileText },
  { key: "hr.payroll", label: "Payroll", href: "/app/hr/payroll", icon: Briefcase },
  { key: "hr.recruitment", label: "Recruitment", href: "/app/hr/recruitment", icon: Sparkles },
];

type CardDef = {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  href?: string;
  enabled: boolean;
};

function HrDashboardInner() {
  const [, setLocation] = useLocation();
  const features = useEffectiveUserFeaturesMap();

  const dashboardQuery = useQuery<HrDashboardSummary>({
    queryKey: ["hr-dashboard-summary-v2"],
    queryFn: async (): Promise<HrDashboardSummary> => {
      try {
        return await loadNewDashboard();
      } catch (error) {
        if (!isNotFoundApiError(error)) {
          throw error;
        }
        return await loadLegacyDashboard();
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const summary = dashboardQuery.data;
  const isEmpty =
    !!summary &&
    summary.totalEmployees <= 0 &&
    summary.activeToday <= 0 &&
    summary.onLeaveToday <= 0 &&
    summary.pendingLeave <= 0 &&
    summary.pendingClaims <= 0 &&
    !summary.payroll;

  const cards: CardDef[] = [
    {
      label: "Total Employees",
      value: summary?.totalEmployees ?? 0,
      icon: Users,
      color: "bg-blue-50 text-blue-600",
      href: "/app/hr/employees",
      enabled: features.enabled("hr.employees"),
    },
    {
      label: "Active Today",
      value: summary?.activeToday ?? 0,
      icon: UserCheck,
      color: "bg-emerald-50 text-emerald-600",
      href: "/app/hr/attendance",
      enabled: features.enabled("hr.attendance"),
    },
    {
      label: "On Leave Today",
      value: summary?.onLeaveToday ?? 0,
      icon: CalendarClock,
      color: "bg-indigo-50 text-indigo-600",
      href: "/app/hr/leave",
      enabled: features.enabled("hr.leave"),
    },
    {
      label: "Pending Leave",
      value: summary?.pendingLeave ?? 0,
      icon: CalendarClock,
      color: "bg-amber-50 text-amber-600",
      href: "/app/hr/leave",
      enabled: features.enabled("hr.leave"),
    },
    {
      label: "Pending Claims",
      value: summary?.pendingClaims ?? 0,
      icon: FileText,
      color: "bg-rose-50 text-rose-600",
      href: "/app/hr/claims",
      enabled: features.enabled("hr.claims"),
    },
    {
      label: "Payroll Status",
      value: summary?.payroll?.label ?? "—",
      icon: Briefcase,
      color: "bg-violet-50 text-violet-600",
      href: "/app/hr/payroll",
      enabled: features.enabled("hr.payroll"),
    },
  ];

  const pendingActions = useMemo(() => {
    const items: { key: string; label: string; href: string; enabled: boolean }[] = [];
    if (summary && summary.pendingLeave > 0) {
      items.push({
        key: "leave",
        label: `${summary.pendingLeave} Leave Request${summary.pendingLeave === 1 ? "" : "s"}`,
        href: "/app/hr/leave",
        enabled: features.enabled("hr.leave"),
      });
    }
    if (summary && summary.pendingClaims > 0) {
      items.push({
        key: "claims",
        label: `${summary.pendingClaims} Claim${summary.pendingClaims === 1 ? "" : "s"} Awaiting Approval`,
        href: "/app/hr/claims",
        enabled: features.enabled("hr.claims"),
      });
    }
    if (summary?.payroll && (summary.payroll.label === "Draft" || summary.payroll.label === "Processing")) {
      const periodLabel = summary.payroll.period
        ? `${summary.payroll.period} — `
        : "";
      items.push({
        key: "payroll",
        label: `${periodLabel}${summary.payroll.label}`,
        href: "/app/hr/payroll",
        enabled: features.enabled("hr.payroll"),
      });
    }
    return items.filter((i) => i.enabled);
  }, [summary, features]);

  const visibleQuickActions = ALL_QUICK_ACTIONS.filter((a) => features.enabled(a.key));

  return (
    <div className={pageRootClasses()}>
      <PageHeader />

      {dashboardQuery.isLoading ? (
        <>
          <LoadingCards />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="pt-5 pb-5">
                <Skeleton className="h-4 w-32 mb-3" />
                <div className="space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-2/3" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5 pb-5">
                <Skeleton className="h-4 w-28 mb-3" />
                <div className="grid grid-cols-2 gap-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full rounded-md" />
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      ) : dashboardQuery.isError ? (
        <DashboardError
          error={dashboardQuery.error}
          onRetry={() => {
            void dashboardQuery.refetch();
          }}
          isRetrying={dashboardQuery.isFetching}
        />
      ) : isEmpty ? (
        <EmptyState
          canAddEmployees={features.enabled("hr.employees")}
          onNavigate={(p) => setLocation(p)}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {cards.map((c) => {
              const cardClickable = c.enabled && c.href;
              return (
                <Card
                  key={c.label}
                  className={cardClickable ? "cursor-pointer hover:shadow-md transition-shadow" : ""}
                  onClick={() => {
                    if (cardClickable && c.href) {
                      setLocation(c.href);
                    }
                  }}
                >
                  <CardContent className="pt-4 pb-4 px-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${c.color}`}
                      >
                        <c.icon className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-slate-500 truncate">
                          {c.label}
                        </div>
                        <div className="text-xl font-bold text-slate-900 leading-tight truncate">
                          {c.value}
                        </div>
                      </div>
                    </div>
                    {c.label === "Payroll Status" && summary?.payroll?.period ? (
                      <div className="mt-2 text-[11px] text-slate-500 truncate">
                        {summary.payroll.period}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Shield className="w-4 h-4 text-slate-500" />
                  Pending Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {pendingActions.length === 0 ? (
                  <div className="text-sm text-slate-500 py-4">
                    You&apos;re all caught up.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {pendingActions.map((p) => (
                      <li key={p.key}>
                        <button
                          type="button"
                          onClick={() => setLocation(p.href)}
                          className="w-full text-left px-3 py-2 rounded-md hover:bg-slate-50 flex items-center justify-between gap-2 text-sm text-slate-700 border border-transparent hover:border-slate-200"
                        >
                          <span>{p.label}</span>
                          <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-slate-500" />
                  Quick Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {visibleQuickActions.length === 0 ? (
                  <div className="text-sm text-slate-500 py-4 text-center">
                    No HR modules enabled for your role.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {visibleQuickActions.map((a) => (
                      <Button
                        key={a.key}
                        variant="outline"
                        size="sm"
                        onClick={() => setLocation(a.href)}
                        className="justify-start gap-2"
                      >
                        <a.icon className="w-4 h-4 shrink-0" />
                        <span className="truncate">{a.label}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

export default function HRDashboardPage() {
  return <HrDashboardInner />;
}
