import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation, useSearch } from "wouter";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { DollarSign, TrendingUp, Clock, Briefcase, Plus, Copy, Trash2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include", ...opts });
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

const TABS = ["Overview", "Quotations"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  overview: "Overview",
  quotations: "Quotations",
};

function OverviewTab() {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ["accounting-summary"],
    queryFn: () => apiFetch("/accounting/summary"),
  });

  const totals = (data?.totals ?? {}) as Record<string, unknown>;
  const byCategory = (data?.byCategory ?? []) as Record<string, unknown>[];
  const topCases = (data?.topCases ?? []) as Record<string, unknown>[];
  const monthly = (data?.monthly ?? []) as Record<string, unknown>[];

  if (isLoading) return <div className="text-slate-500 py-12 text-center">Loading...</div>;

  return (
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
  );
}

function QuotationsTab() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  const { data: quotations, isLoading } = useQuery({
    queryKey: ["quotations"],
    queryFn: () => apiFetch("/quotations"),
  });

  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    sent: "bg-blue-100 text-blue-700",
    accepted: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
  };

  const filtered = (quotations || []).filter((q: any) =>
    !search ||
    q.referenceNo?.toLowerCase().includes(search.toLowerCase()) ||
    q.clientName?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search quotations..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={() => setLocation("/app/quotations/new")}>
          <Plus className="w-4 h-4 mr-2" /> New Quotation
        </Button>
      </div>

      {isLoading ? (
        <div className="text-slate-500 py-12 text-center">Loading...</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-slate-500">No quotations yet</p>
            <p className="text-sm text-slate-400 mt-1">Create your first quotation to get started</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Reference</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Client</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Property</th>
                  <th className="text-right px-4 py-3 font-medium text-slate-600">Total</th>
                  <th className="text-center px-4 py-3 font-medium text-slate-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Date</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q: any) => (
                  <tr
                    key={q.id}
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => setLocation(`/app/quotations/${q.id}`)}
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">{q.referenceNo}</td>
                    <td className="px-4 py-3 text-slate-600">{q.clientName}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs max-w-[200px] truncate">{q.propertyDescription || "-"}</td>
                    <td className="px-4 py-3 text-right font-medium">{fmt(q.totalInclTax)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${statusColors[q.status] || statusColors.draft}`}>
                        {q.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {new Date(q.createdAt).toLocaleDateString("en-MY")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function Accounting() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const initialTab = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : "Overview";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (tabFromUrl && TAB_KEYS[tabFromUrl]) {
      setActiveTab(TAB_KEYS[tabFromUrl]);
    }
  }, [tabFromUrl]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Accounting</h1>
        <p className="text-slate-500 mt-1">Billing overview and fee quotations</p>
      </div>

      <div className="flex border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
              activeTab === tab
                ? "border-amber-500 text-amber-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Overview" && <OverviewTab />}
      {activeTab === "Quotations" && <QuotationsTab />}
    </div>
  );
}
