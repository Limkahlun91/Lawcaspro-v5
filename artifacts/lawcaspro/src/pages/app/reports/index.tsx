import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from "recharts";
import { TrendingUp, Briefcase, Users, MessageSquare, BookOpen, Landmark, Clock, ArrowRight, AlertTriangle } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

const STATUS_COLORS: Record<string, string> = {
  "File Opened / SPA Pending Signing": "#94a3b8",
  "SPA Stamped": "#3b82f6",
  "Loan Docs Pending": "#f59e0b",
  "Loan Docs Signed": "#10b981",
  "MOT Pending": "#8b5cf6",
  "MOT Registered": "#06b6d4",
  "NOA Served": "#84cc16",
  "Completed": "#22c55e",
};

const COMM_COLORS: Record<string, string> = {
  email: "#3b82f6",
  whatsapp: "#22c55e",
  phone: "#f59e0b",
  letter: "#8b5cf6",
  portal: "#06b6d4",
};

export default function Reports() {
  const [, setLocation] = useLocation();
  const reportsQuery = useQuery({
    queryKey: ["reports-overview"],
    queryFn: () => apiFetchJson("/reports/overview"),
    retry: false,
  });
  const { data, isLoading } = reportsQuery;

  const casesByStatus = (data?.casesByStatus ?? []) as Record<string, unknown>[];
  const casesByMonth = (data?.casesByMonth ?? []) as Record<string, unknown>[];
  const lawyerWorkload = (data?.lawyerWorkload ?? []) as Record<string, unknown>[];
  const workflowCompletion = (data?.workflowCompletion ?? []) as Record<string, unknown>[];
  const billing = (data?.billingTotals ?? {}) as Record<string, unknown>;
  const commStats = (data?.communicationStats ?? []) as Record<string, unknown>[];

  const commByType = commStats.reduce<Record<string, number>>((acc, row) => {
    const t = row.type as string;
    acc[t] = (acc[t] ?? 0) + Number(row.count ?? 0);
    return acc;
  }, {});
  const commPieData = Object.entries(commByType).map(([type, count]) => ({ name: type, value: count }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Reports</h1>
        <p className="text-slate-500 mt-1">Firm performance and compliance reports</p>
      </div>

      {/* Compliance Reports — statutory Malaysian requirements */}
      <div>
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">Statutory Reports</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            {
              title: "Bills Delivered Book",
              description: "Statutory record of all bills rendered. Required under Solicitors' Accounts Rules 1990.",
              icon: BookOpen,
              href: "/app/reports/bills-delivered-book",
              color: "text-blue-600 bg-blue-50",
            },
            {
              title: "Trust Account Statement",
              description: "Client trust money movements and running balance per case (SAR 1990 r.7).",
              icon: Landmark,
              href: "/app/reports/trust-account-statement",
              color: "text-green-700 bg-green-50",
            },
            {
              title: "Matter Aging Report",
              description: "Outstanding invoices grouped by age bracket — 30, 60, 90+ days overdue.",
              icon: AlertTriangle,
              href: "/app/reports/matter-aging",
              color: "text-red-600 bg-red-50",
            },
          ].map(({ title, description, icon: Icon, href, color }) => (
            <Card key={title} className="border-slate-200 hover:border-slate-300 cursor-pointer transition-colors" onClick={() => setLocation(href)}>
              <CardContent className="py-4 px-4 flex gap-3">
                <div className={`p-2 rounded-lg ${color} flex-shrink-0 h-fit mt-0.5`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="font-semibold text-sm text-slate-800">{title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{description}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-slate-300 ml-auto flex-shrink-0 mt-1" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="border-t border-slate-200" />
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Analytics</h2>

      {reportsQuery.isError ? (
        <QueryFallback title="Reports unavailable" error={reportsQuery.error} onRetry={() => reportsQuery.refetch()} isRetrying={reportsQuery.isFetching} />
      ) : isLoading ? (
        <div className="text-slate-500 py-12 text-center">Loading reports...</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Cases", value: String(casesByStatus.reduce((s, r) => s + Number(r.count), 0)), icon: Briefcase, color: "bg-slate-100 text-slate-600" },
              { label: "Total Billed", value: fmt(billing.total_billed), icon: TrendingUp, color: "bg-amber-50 text-amber-600" },
              { label: "Outstanding", value: fmt(billing.total_outstanding), icon: TrendingUp, color: "bg-red-50 text-red-500" },
              { label: "Lawyers Active", value: String(lawyerWorkload.length), icon: Users, color: "bg-blue-50 text-blue-600" },
            ].map((item) => (
              <Card key={item.label}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.color}`}>
                      <item.icon className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">{item.label}</div>
                      <div className="text-lg font-bold text-slate-900 leading-tight">{item.value}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle>Cases by Status</CardTitle></CardHeader>
              <CardContent>
                {casesByStatus.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-sm">No cases yet</div>
                ) : (
                  <div className="space-y-2">
                    {casesByStatus.map((row) => {
                      const total = casesByStatus.reduce((s, r) => s + Number(r.count), 0) || 1;
                      const pct = (Number(row.count) / total) * 100;
                      const color = STATUS_COLORS[row.status as string] ?? "#94a3b8";
                      return (
                        <div key={String(row.status)}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-slate-600 truncate max-w-[240px]">{String(row.status)}</span>
                            <span className="font-medium text-slate-900 ml-2 shrink-0">{String(row.count)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-100">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>New Cases by Month</CardTitle></CardHeader>
              <CardContent>
                {casesByMonth.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-sm">No data yet</div>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={casesByMonth}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip />
                      <Line type="monotone" dataKey="count" stroke="#f59e0b" strokeWidth={2} dot={{ r: 4, fill: "#f59e0b" }} name="Cases" />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle>Lawyer Caseload</CardTitle></CardHeader>
              <CardContent>
                {lawyerWorkload.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-sm">No assignments yet</div>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={lawyerWorkload} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                      <Tooltip />
                      <Bar dataKey="case_count" fill="#3b82f6" radius={[0, 3, 3, 0]} name="Cases" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Workflow Completion Rate</CardTitle></CardHeader>
              <CardContent>
                {workflowCompletion.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-sm">No workflow data yet</div>
                ) : (
                  <div className="space-y-2">
                    {workflowCompletion.slice(0, 8).map((row) => {
                      const total = Number(row.total_steps) || 1;
                      const done = Number(row.completed_steps);
                      const pct = (done / total) * 100;
                      return (
                        <div key={String(row.case_id)}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="font-medium text-slate-700">{String(row.reference_no)}</span>
                            <span className="text-slate-500">{done}/{total} steps ({pct.toFixed(0)}%)</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {commPieData.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Communications by Channel</CardTitle></CardHeader>
              <CardContent className="flex justify-center">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={commPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                      {commPieData.map((entry, i) => (
                        <Cell key={entry.name} fill={COMM_COLORS[entry.name] ?? `hsl(${i * 60}, 60%, 50%)`} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
