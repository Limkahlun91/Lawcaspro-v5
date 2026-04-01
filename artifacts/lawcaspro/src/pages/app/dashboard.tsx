import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Briefcase, Users, Building2, HardHat, DollarSign, TrendingUp, MessageSquare, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

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

  const { data: stats, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiFetch("/dashboard"),
  });

  if (isLoading) {
    return <div className="text-slate-400 py-12 text-center text-sm">Loading dashboard...</div>;
  }

  if (!stats) return null;

  const billing = (stats.billing ?? {}) as Record<string, number>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h1>
        <p className="text-slate-500 mt-1">Overview of your firm's operations</p>
      </div>

      {/* Primary stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Total Cases",
            value: stats.totalCases,
            sub: `${stats.activeCases} active · ${stats.completedCases} completed`,
            icon: Briefcase,
            color: "bg-amber-50 text-amber-600",
            href: "/app/cases",
          },
          {
            label: "Clients",
            value: stats.totalClients,
            sub: null,
            icon: Users,
            color: "bg-blue-50 text-blue-600",
            href: "/app/clients",
          },
          {
            label: "Projects",
            value: stats.totalProjects,
            sub: null,
            icon: Building2,
            color: "bg-green-50 text-green-600",
            href: "/app/projects",
          },
          {
            label: "Developers",
            value: stats.totalDevelopers,
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

      {/* Billing + Comms summary row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setLocation("/app/accounting")}>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <div className="text-xs text-slate-500">Total Billed</div>
                <div className="text-xl font-bold text-slate-900">{fmt(billing.totalBilled)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
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
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setLocation("/app/communications")}>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <div className="text-xs text-slate-500">Comms This Month</div>
                <div className="text-xl font-bold text-slate-900">{stats.commsThisMonth ?? 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Case Breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Case Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">By Financing</div>
              {[
                { label: "Cash Purchases", value: stats.cashCases, total: stats.totalCases, color: "bg-amber-400" },
                { label: "Loan Purchases", value: stats.loanCases, total: stats.totalCases, color: "bg-blue-400" },
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
                { label: "Master Title", value: stats.masterTitleCases, color: "bg-purple-400" },
                { label: "Individual Title", value: stats.individualTitleCases, color: "bg-green-400" },
                { label: "Strata Title", value: stats.strataTitleCases, color: "bg-teal-400" },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <div className="text-sm text-slate-600 w-36">{item.label}</div>
                  <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${item.color}`} style={{ width: `${stats.totalCases ? (item.value / stats.totalCases) * 100 : 0}%` }} />
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
              {(stats.recentCases ?? []).map((c: Record<string, unknown>) => (
                <div
                  key={String(c.id)}
                  className="py-3 flex items-start justify-between gap-2 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded"
                  onClick={() => setLocation(`/app/cases/${c.id}`)}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-amber-600 text-sm">{String(c.referenceNo)}</div>
                    <div className="text-xs text-slate-500 truncate">{String(c.projectName)}</div>
                    {c.assignedLawyerName && (
                      <div className="text-xs text-slate-400 mt-0.5">{String(c.assignedLawyerName)}</div>
                    )}
                  </div>
                  <div className="shrink-0">
                    <StatusBadge status={String(c.status)} />
                  </div>
                </div>
              ))}
              {!(stats.recentCases?.length) && (
                <div className="text-sm text-slate-400 italic py-4 text-center">No cases yet</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
