import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Download, BookOpen } from "lucide-react";
import { useLocation } from "wouter";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  issued: "bg-blue-100 text-blue-700",
  partially_paid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  void: "bg-red-100 text-red-600",
};

function fmtDate(d: string | null) { return d ? new Date(d).toLocaleDateString("en-MY") : "—"; }
function fmtAmt(v: unknown) { return `RM ${Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`; }

export default function BillsDeliveredBook() {
  const [, setLocation] = useLocation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState({ from: "", to: "" });

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["bills-delivered-book", applied],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (applied.from) params.set("from", applied.from);
      if (applied.to) params.set("to", applied.to);
      const r = await fetch(`${API_BASE}/reports/bills-delivered-book?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const invoices: any[] = data?.invoices ?? [];
  const totals: any = data?.totals ?? {};

  function printReport() { window.print(); }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/reports")} className="text-slate-500">
          <ArrowLeft className="h-4 w-4 mr-1" /> Reports
        </Button>
        <div>
          <h1 className="text-xl font-bold text-[#0f1729]">Bills Delivered Book</h1>
          <p className="text-xs text-slate-500">Statutory record of all bills rendered — Solicitors' Accounts Rules 1990</p>
        </div>
      </div>

      {/* Filters */}
      <Card className="border-slate-200">
        <CardContent className="py-3 px-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <p className="text-xs text-slate-500 mb-1">From</p>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-8 text-sm w-36" />
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">To</p>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-8 text-sm w-36" />
            </div>
            <Button size="sm" className="h-8 bg-[#0f1729] hover:bg-slate-800 text-white" onClick={() => setApplied({ from, to })}>
              Apply
            </Button>
            {(applied.from || applied.to) && (
              <Button size="sm" variant="ghost" className="h-8 text-slate-500" onClick={() => { setFrom(""); setTo(""); setApplied({ from: "", to: "" }); }}>
                Clear
              </Button>
            )}
            <div className="ml-auto">
              <Button size="sm" variant="outline" className="h-8" onClick={printReport}>
                <Download className="h-3.5 w-3.5 mr-1" /> Print
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Bills Rendered", value: totals.count ?? 0, sub: "invoices" },
          { label: "Total Billed", value: totals.totalBilled ? `RM ${Number(totals.totalBilled).toLocaleString("en-MY")}` : "RM 0", sub: "gross" },
          { label: "Total Collected", value: totals.totalPaid ? `RM ${Number(totals.totalPaid).toLocaleString("en-MY")}` : "RM 0", sub: "received" },
          { label: "Outstanding", value: totals.totalOutstanding ? `RM ${Number(totals.totalOutstanding).toLocaleString("en-MY")}` : "RM 0", sub: "unpaid" },
        ].map(({ label, value, sub }) => (
          <Card key={label} className="border-slate-200">
            <CardContent className="py-3 px-4">
              <p className="text-xs text-slate-500 mb-1">{label}</p>
              <p className="text-lg font-bold text-[#0f1729]">{value}</p>
              <p className="text-xs text-slate-400">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table */}
      <Card className="border-slate-200">
        <CardHeader className="py-3 px-4 border-b">
          <CardTitle className="text-sm font-medium text-slate-700 flex items-center gap-2">
            <BookOpen className="h-4 w-4" /> Bills Delivered
          </CardTitle>
        </CardHeader>
        {isLoading ? (
          <CardContent className="py-8 text-center text-sm text-slate-400">Loading...</CardContent>
        ) : invoices.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-slate-400">No bills found for this period.</CardContent>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b">
                <tr>
                  {["Date", "Invoice No.", "File Ref", "Client", "Gross (RM)", "Paid (RM)", "Due (RM)", "Status"].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.map((inv: any) => (
                  <tr key={inv.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-2.5 text-slate-600">{fmtDate(inv.issuedDate)}</td>
                    <td className="px-4 py-2.5 font-mono font-medium text-slate-800">{inv.invoiceNo}</td>
                    <td className="px-4 py-2.5 text-slate-600">{inv.caseRef ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-700">{inv.clientName ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{Number(inv.grandTotal).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-green-700">{Number(inv.amountPaid).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-red-600">{Number(inv.amountDue).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className={`text-xs border-0 capitalize ${STATUS_BADGE[inv.status] ?? ""}`}>{inv.status?.replace("_", " ")}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 border-t font-medium">
                <tr>
                  <td colSpan={4} className="px-4 py-2.5 text-slate-700">Totals ({totals.count} bills)</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{Number(totals.totalBilled ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-green-700">{Number(totals.totalPaid ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-red-600">{Number(totals.totalOutstanding ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
