import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Calculator, Play, CheckCircle2, Download, FileCheck } from "lucide-react";

type PayrollPeriod = {
  id: number;
  periodName?: string | null;
  periodMonth?: string | null;
  periodYear?: number | null;
  status?: string | null;
  totalEmployees?: number | null;
  totalGross?: number | string | null;
  totalNet?: number | string | null;
  payslipCount?: number | null;
  runAt?: string | null;
  approvedAt?: string | null;
  finalisedAt?: string | null;
};

function HrPayrollInner() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ["hr-payroll-periods"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/payroll/periods");
        const d = unwrapApiData<any>(res);
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.items)) return d.items;
        return [];
      } catch {
        return [] as PayrollPeriod[];
      }
    },
    staleTime: 30_000,
    retry: false,
  });

  const runMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/payroll/periods/${id}/run`, { method: "POST" }),
    onSuccess: () => { toast({ title: "Payroll run started" }); void qc.invalidateQueries({ queryKey: ["hr-payroll"] }); },
    onError: (e) => toastError(toast, e, "Run failed"),
  });

  const calcMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/payroll/periods/${id}/calculate`, { method: "POST" }),
    onSuccess: () => { toast({ title: "Calculation complete" }); void qc.invalidateQueries({ queryKey: ["hr-payroll"] }); },
    onError: (e) => toastError(toast, e, "Calculate failed"),
  });

  const approveMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/payroll/periods/${id}/approve`, { method: "POST" }),
    onSuccess: () => { toast({ title: "Payroll approved" }); void qc.invalidateQueries({ queryKey: ["hr-payroll"] }); },
    onError: (e) => toastError(toast, e, "Approve failed"),
  });

  const finaliseMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/payroll/periods/${id}/finalise`, { method: "POST" }),
    onSuccess: () => { toast({ title: "Payroll finalised" }); void qc.invalidateQueries({ queryKey: ["hr-payroll"] }); },
    onError: (e) => toastError(toast, e, "Finalise failed"),
  });

  const downloadPayslip = async (periodId: number, employeeId?: number) => {
    try {
      const url = employeeId
        ? `/hr/payroll/periods/${periodId}/payslips/${employeeId}`
        : `/hr/payroll/periods/${periodId}/payslips`;
      toast({ title: "Generating payslip…" });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toastError(toast, e, "Download failed");
    }
  };

  const rows = (listQuery.data ?? []) as PayrollPeriod[];
  const fmt = (v: unknown) => `RM ${Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statusBadge = (s: string | null | undefined) => {
    const v = String(s ?? "unknown").toLowerCase();
    if (v.includes("final") || v.includes("closed")) return <Badge variant="default" className="bg-green-100 text-green-700 hover:bg-green-100">Finalised</Badge>;
    if (v.includes("approv")) return <Badge variant="default" className="bg-blue-100 text-blue-700 hover:bg-blue-100">Approved</Badge>;
    if (v.includes("run") || v.includes("calculat") || v.includes("processing")) return <Badge variant="secondary">Calculated</Badge>;
    if (v.includes("draft") || v.includes("open")) return <Badge variant="outline">Draft</Badge>;
    return <Badge variant="outline">{String(s ?? "—")}</Badge>;
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Calculator className="w-5 h-5 text-slate-500" /> Payroll
        </h1>
        <p className="text-slate-500 mt-1">Run, calculate, approve, and finalise payroll periods</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Payroll Periods ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <Calculator className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-600">No payroll periods</p>
              <p className="text-xs mt-1">Create payroll periods in HR settings to begin.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">Period</th>
                    <th className="px-4 py-3 text-right font-medium">Employees</th>
                    <th className="px-4 py-3 text-right font-medium">Gross</th>
                    <th className="px-4 py-3 text-right font-medium">Net</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => {
                    const s = String(r.status ?? "").toLowerCase();
                    const isDraft = s.includes("draft");
                    const isCalculated = s.includes("run") || s.includes("calculat") || s.includes("processing");
                    const isApproved = s.includes("approv");
                    const isFinal = s.includes("final") || s.includes("closed");
                    return (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-900">
                          {r.periodName ?? (`${r.periodMonth ?? ""} ${r.periodYear ?? ""}` || `Period #${r.id}`)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">{r.totalEmployees ?? "—"}</td>
                        <td className="px-4 py-3 text-right text-slate-700">{fmt(r.totalGross)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-800">{fmt(r.totalNet)}</td>
                        <td className="px-4 py-3">{statusBadge(r.status)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2 flex-wrap">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1"
                              onClick={() => runMut.mutate(r.id)}
                              disabled={isFinal || runMut.isPending}
                            >
                              <Play className="w-3.5 h-3.5" /> Run
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1"
                              onClick={() => calcMut.mutate(r.id)}
                              disabled={isFinal || calcMut.isPending}
                            >
                              <Calculator className="w-3.5 h-3.5" /> Calculate
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-blue-700 border-blue-200 hover:bg-blue-50"
                              onClick={() => approveMut.mutate(r.id)}
                              disabled={isFinal || isApproved || approveMut.isPending}
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-green-700 border-green-200 hover:bg-green-50"
                              onClick={() => finaliseMut.mutate(r.id)}
                              disabled={isFinal || finaliseMut.isPending}
                            >
                              <FileCheck className="w-3.5 h-3.5" /> Finalise
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1"
                              onClick={() => downloadPayslip(r.id)}
                              disabled={!isCalculated && !isApproved && !isFinal}
                            >
                              <Download className="w-3.5 h-3.5" /> Payslips
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function HRPayrollPage() {
  return (
    <PermissionGuard module="hr" action="read">
      <HrPayrollInner />
    </PermissionGuard>
  );
}
