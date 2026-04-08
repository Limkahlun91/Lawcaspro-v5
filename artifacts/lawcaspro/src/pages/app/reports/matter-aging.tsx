import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, AlertTriangle, Download } from "lucide-react";
import { useLocation } from "wouter";
import { API_BASE } from "@/lib/api-base";
import { downloadFromApi } from "@/lib/download";
import { useToast } from "@/hooks/use-toast";

const BUCKET_CONFIG: Record<string, { label: string; color: string; barColor: string }> = {
  current:   { label: "Current (not yet due)",  color: "text-green-700",  barColor: "bg-green-500" },
  days1_30:  { label: "1–30 days overdue",       color: "text-amber-700",  barColor: "bg-amber-400" },
  days31_60: { label: "31–60 days overdue",      color: "text-orange-700", barColor: "bg-orange-500" },
  days61_90: { label: "61–90 days overdue",      color: "text-red-600",    barColor: "bg-red-500" },
  over90:    { label: "Over 90 days overdue",    color: "text-red-800",    barColor: "bg-red-700" },
};

function fmtDate(d: string | null) { return d ? new Date(d).toLocaleDateString("en-MY") : "—"; }

export default function MatterAging() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["matter-aging"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/reports/matter-aging`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const buckets: any[] = data?.buckets ?? [];
  const grandTotal = Number(data?.grandTotal ?? 0);
  const maxBucketTotal = Math.max(...buckets.map((b: any) => Number(b.total)), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/reports")} className="text-slate-500">
          <ArrowLeft className="h-4 w-4 mr-1" /> Reports
        </Button>
        <div>
          <h1 className="text-xl font-bold text-[#0f1729]">Matter Aging Report</h1>
          <p className="text-xs text-slate-500">Outstanding invoices grouped by age — as at today</p>
        </div>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => downloadFromApi("/reports/matter-aging?format=csv", "matter-aging.csv").catch((e: any) => {
              toast({ title: "Download failed", description: e.message, variant: "destructive" });
            })}
          >
            <Download className="h-3.5 w-3.5 mr-1" /> Download CSV
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      <Card className="border-slate-200">
        <CardContent className="py-4 px-4">
          <p className="text-xs text-slate-500 mb-1">Total Outstanding</p>
          <p className="text-2xl font-bold text-[#0f1729]">RM {grandTotal.toLocaleString("en-MY", { minimumFractionDigits: 2 })}</p>
        </CardContent>
      </Card>

      {/* Buckets */}
      {isLoading ? (
        <Card><CardContent className="py-8 text-center text-sm text-slate-400">Loading...</CardContent></Card>
      ) : isError ? (
        <Card><CardContent className="py-8 text-center text-sm text-red-600 break-words">{String((error as any)?.message ?? error)}</CardContent></Card>
      ) : (
        <div className="space-y-4">
          {buckets.map((bucket: any) => {
            const cfg = BUCKET_CONFIG[bucket.bucket] ?? { label: bucket.bucket, color: "text-slate-700", barColor: "bg-slate-400" };
            const pct = grandTotal > 0 ? (Number(bucket.total) / grandTotal) * 100 : 0;
            const barPct = (Number(bucket.total) / maxBucketTotal) * 100;
            return (
              <Card key={bucket.bucket} className="border-slate-200">
                <CardHeader className="py-3 px-4 border-b flex flex-row items-center justify-between space-y-0">
                  <CardTitle className={`text-sm font-medium ${cfg.color}`}>{cfg.label}</CardTitle>
                  <div className="text-right">
                    <p className={`text-lg font-bold ${cfg.color}`}>RM {Number(bucket.total).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</p>
                    <p className="text-xs text-slate-400">{bucket.count} invoices · {pct.toFixed(1)}% of total</p>
                  </div>
                </CardHeader>
                {/* Progress bar */}
                <div className="h-1.5 w-full bg-slate-100">
                  <div className={`h-1.5 ${cfg.barColor} transition-all`} style={{ width: `${barPct}%` }} />
                </div>
                {bucket.items.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b">
                        <tr>
                          {["Invoice No.", "Case Ref", "Issue Date", "Due Date", "Outstanding (RM)"].map(h => (
                            <th key={h} className="text-left px-4 py-2 text-xs font-medium text-slate-500 uppercase tracking-wide">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {bucket.items.map((inv: any) => (
                          <tr key={inv.id} className="hover:bg-slate-50/50">
                            <td className="px-4 py-2 font-mono font-medium text-slate-800">{inv.invoiceNo}</td>
                            <td className="px-4 py-2 text-slate-600">{inv.caseId ?? "—"}</td>
                            <td className="px-4 py-2 text-slate-600">{fmtDate(inv.issuedDate)}</td>
                            <td className={`px-4 py-2 font-medium ${bucket.bucket !== "current" ? "text-red-600" : "text-slate-600"}`}>{fmtDate(inv.dueDate)}</td>
                            <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-800">
                              {Number(inv.amountDue).toLocaleString("en-MY", { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
