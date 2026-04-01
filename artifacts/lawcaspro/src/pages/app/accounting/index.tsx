import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation } from "wouter";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { DollarSign, TrendingUp, Clock, Briefcase } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  legal_fee: "Legal Fees",
  disbursement: "Disbursements",
  stamp_duty: "Stamp Duty",
  professional_fee: "Professional Fees",
  other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  legal_fee: "#f59e0b",
  disbursement: "#3b82f6",
  stamp_duty: "#10b981",
  professional_fee: "#8b5cf6",
  other: "#6b7280",
};

export default function Accounting() {
  const [, setLocation] = useLocation();

  const { data, isLoading } = useQuery({
    queryKey: ["accounting-summary"],
    queryFn: () => apiFetch("/accounting/summary"),
  });

  const totals = (data?.totals ?? {}) as Record<string, unknown>;
  const byCategory = (data?.byCategory ?? []) as Record<string, unknown>[];
  const topCases = (data?.topCases ?? []) as Record<string, unknown>[];
  const monthly = (data?.monthly ?? []) as Record<string, unknown>[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Accounting</h1>
        <p className="text-slate-500 mt-1">Billing entries and financial overview across all cases</p>
      </div>

      {isLoading ? (
        <div className="text-slate-500 py-12 text-center">Loading...</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Billed", value: fmt(totals.total), icon: DollarSign, color: "bg-amber-50 text-amber-600" },
              { label: "Collected", value: fmt(totals.paid), icon: TrendingUp, color: "bg-green-50 text-green-600" },
              { label: "Outstanding", value: fmt(totals.outstanding), icon: Clock, color: "bg-red-50 text-red-500" },
              { label: "Billed Cases", value: String(totals.case_count ?? 0), icon: Briefcase, color: "bg-slate-100 text-slate-600" },
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
              <CardHeader><CardTitle>By Category</CardTitle></CardHeader>
              <CardContent>
                {byCategory.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-sm">No billing entries yet. Add entries from individual case pages.</div>
                ) : (
                  <div className="space-y-3">
                    {byCategory.map((row) => {
                      const cat = row.category as string;
                      const total = Number(row.total ?? 0);
                      const grand = Number(totals.total ?? 1) || 1;
                      const pct = (total / grand) * 100;
                      return (
                        <div key={cat}>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="font-medium text-slate-700">{CATEGORY_LABELS[cat] ?? cat}</span>
                            <span className="text-slate-500">{fmt(total)}</span>
                          </div>
                          <div className="h-2 rounded-full bg-slate-100">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: CATEGORY_COLORS[cat] ?? "#6b7280" }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Monthly Billing</CardTitle></CardHeader>
              <CardContent>
                {monthly.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 text-sm">No data yet</div>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={monthly}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(Number(v)/1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v) => [fmt(v), "Billed"]} />
                      <Bar dataKey="total" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Top Cases by Billing</CardTitle></CardHeader>
            <CardContent>
              {topCases.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-sm">No billing data. Open a case and add billing entries from the Accounting tab.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-slate-500 text-left">
                      <th className="py-2 font-medium">Case</th>
                      <th className="py-2 font-medium text-right">Total</th>
                      <th className="py-2 font-medium text-right">Paid</th>
                      <th className="py-2 font-medium text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topCases.map((row) => (
                      <tr key={String(row.case_id)} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => setLocation(`/app/cases/${row.case_id}`)}>
                        <td className="py-3 font-medium text-slate-900">{String(row.reference_no)}</td>
                        <td className="py-3 text-right text-slate-700">{fmt(row.total)}</td>
                        <td className="py-3 text-right text-green-600">{fmt(row.paid)}</td>
                        <td className="py-3 text-right text-red-600">{fmt(row.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
