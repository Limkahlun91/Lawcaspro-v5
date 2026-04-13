import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Landmark, Download } from "lucide-react";
import { useLocation } from "wouter";
import { downloadFromApi } from "@/lib/download";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";

function fmtDate(d: string | null) { return d ? new Date(d).toLocaleDateString("en-MY") : "—"; }
function fmtAmt(v: unknown) { return Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 }); }

export default function TrustAccountStatement() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [caseId, setCaseId] = useState("");
  const [applied, setApplied] = useState("");

  type TrustStatementEntry = Record<string, unknown>;
  type TrustStatementResponse = {
    entries?: TrustStatementEntry[];
    balance?: number;
  };

  const stmtQuery = useQuery<TrustStatementResponse>({
    queryKey: ["trust-account-statement", applied],
    queryFn: async () => {
      const params = applied ? `?caseId=${applied}` : "";
      return await apiFetchJson<TrustStatementResponse>(`/reports/trust-account-statement${params}`);
    },
    retry: false,
  });
  const { data, isLoading, isError, error } = stmtQuery;

  const entries = data?.entries ?? [];
  const balance = Number(data?.balance ?? 0);

  // Running balance
  let running = 0;
  const withRunning = entries.map(e => {
    running += Number(e.credit) - Number(e.debit);
    return { ...e, runningBalance: running };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/reports")} className="text-slate-500">
          <ArrowLeft className="h-4 w-4 mr-1" /> Reports
        </Button>
        <div>
          <h1 className="text-xl font-bold text-[#0f1729]">Trust Account Statement</h1>
          <p className="text-xs text-slate-500">Client trust money movements — Solicitors' Accounts Rules 1990 r.7</p>
        </div>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => {
              const params = new URLSearchParams();
              if (applied) params.set("caseId", applied);
              params.set("format", "csv");
              downloadFromApi(`/reports/trust-account-statement?${params.toString()}`, `trust-account-statement${applied ? `_${applied}` : ""}.csv`).catch((e: any) => {
                toastError(toast, e, "Download failed");
              });
            }}
          >
            <Download className="h-3.5 w-3.5 mr-1" /> Download CSV
          </Button>
        </div>
      </div>

      <Card className="border-slate-200">
        <CardContent className="py-3 px-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <p className="text-xs text-slate-500 mb-1">Filter by Case ID (optional)</p>
              <Input value={caseId} onChange={e => setCaseId(e.target.value)} className="h-8 text-sm w-36" placeholder="Case ID" />
            </div>
            <Button size="sm" className="h-8 bg-[#0f1729] hover:bg-slate-800 text-white" onClick={() => setApplied(caseId)}>Apply</Button>
            {applied && <Button size="sm" variant="ghost" className="h-8 text-slate-500" onClick={() => { setCaseId(""); setApplied(""); }}>Clear</Button>}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Credits", value: `RM ${fmtAmt(entries.reduce((s, e) => s + Number(e.credit), 0))}`, color: "text-green-700" },
          { label: "Total Debits",  value: `RM ${fmtAmt(entries.reduce((s, e) => s + Number(e.debit), 0))}`,  color: "text-red-600" },
          { label: "Balance",       value: `RM ${fmtAmt(balance)}`, color: balance >= 0 ? "text-[#0f1729]" : "text-red-700" },
        ].map(({ label, value, color }) => (
          <Card key={label} className="border-slate-200">
            <CardContent className="py-3 px-4">
              <p className="text-xs text-slate-500 mb-1">{label}</p>
              <p className={`text-lg font-bold ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-slate-200">
        <CardHeader className="py-3 px-4 border-b">
          <CardTitle className="text-sm font-medium text-slate-700 flex items-center gap-2">
            <Landmark className="h-4 w-4" /> Trust Ledger Entries
          </CardTitle>
        </CardHeader>
        {isLoading ? (
          <CardContent className="py-8 text-center text-sm text-slate-400">Loading...</CardContent>
        ) : isError ? (
          <CardContent className="py-4">
            <QueryFallback title="Report unavailable" error={error} onRetry={() => stmtQuery.refetch()} isRetrying={stmtQuery.isFetching} />
          </CardContent>
        ) : entries.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-slate-400">No trust movements found.</CardContent>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b">
                <tr>
                  {["Date", "Case", "Ref", "Description", "Debit (RM)", "Credit (RM)", "Balance (RM)"].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {withRunning.map((e: any) => (
                  <tr key={e.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-2.5 text-slate-600">{fmtDate(e.entryDate)}</td>
                    <td className="px-4 py-2.5 text-slate-600">{e.caseId ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{e.referenceNo ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-700 max-w-xs truncate">{e.description}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-red-600">
                      {Number(e.debit) > 0 ? fmtAmt(e.debit) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-green-700">
                      {Number(e.credit) > 0 ? fmtAmt(e.credit) : "—"}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${e.runningBalance >= 0 ? "text-slate-800" : "text-red-700"}`}>
                      {fmtAmt(e.runningBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
