import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { FileText, CheckCircle2, XCircle } from "lucide-react";

type ClaimRow = {
  id: number;
  employeeId?: number | null;
  employeeName?: string | null;
  claimType?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  submittedAt?: string | null;
  status?: string | null;
  description?: string | null;
};

function HrClaimsInner() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ["hr-claims-admin-list"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/claims/admin");
        const d = unwrapApiData<any>(res);
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.items)) return d.items;
        return [];
      } catch {
        try {
          const res2 = await apiFetchJson("/hr/claims");
          const d2 = unwrapApiData<any>(res2);
          if (Array.isArray(d2)) return d2;
          if (d2 && Array.isArray(d2.items)) return d2.items;
          return [];
        } catch {
          return [] as ClaimRow[];
        }
      }
    },
    staleTime: 30_000,
    retry: false,
  });

  const approveMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/claims/${id}/approve`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Claim approved" });
      void qc.invalidateQueries({ queryKey: ["hr-claims-admin"] });
    },
    onError: (e) => toastError(toast, e, "Approve failed"),
  });

  const rejectMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/claims/${id}/reject`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Claim rejected" });
      void qc.invalidateQueries({ queryKey: ["hr-claims-admin"] });
    },
    onError: (e) => toastError(toast, e, "Reject failed"),
  });

  const rows = (listQuery.data ?? []) as ClaimRow[];
  const fmt = (v: unknown) => `RM ${Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statusBadge = (s: string | null | undefined) => {
    const v = String(s ?? "unknown").toLowerCase();
    if (v === "approved" || v === "paid") return <Badge variant="default" className="bg-green-100 text-green-700 hover:bg-green-100">Approved</Badge>;
    if (v === "rejected" || v === "denied") return <Badge variant="destructive">Rejected</Badge>;
    if (v === "pending" || v === "submitted") return <Badge variant="secondary">Pending</Badge>;
    return <Badge variant="outline">{String(s ?? "—")}</Badge>;
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-slate-500" /> Claims Management
        </h1>
        <p className="text-slate-500 mt-1">Review and approve/reject expense claims</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Claims ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-600">No claims</p>
              <p className="text-xs mt-1">Submitted claims will appear here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">Employee</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-left font-medium">Submitted</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Description</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => {
                    const isPending = String(r.status ?? "").toLowerCase() === "pending" || String(r.status ?? "").toLowerCase() === "submitted";
                    return (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-900">{r.employeeName ?? `#${r.employeeId ?? r.id}`}</td>
                        <td className="px-4 py-3 text-slate-700 text-xs">{r.claimType ?? "—"}</td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-800">{fmt(r.amount)}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{r.submittedAt ? new Date(String(r.submittedAt)).toLocaleDateString() : "—"}</td>
                        <td className="px-4 py-3">{statusBadge(r.status)}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs max-w-[200px] truncate" title={r.description ?? ""}>{r.description ?? "—"}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {isPending ? (
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 text-green-700 border-green-200 hover:bg-green-50"
                                onClick={() => approveMut.mutate(r.id)}
                                disabled={approveMut.isPending || rejectMut.isPending}
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 text-red-700 border-red-200 hover:bg-red-50"
                                onClick={() => rejectMut.mutate(r.id)}
                                disabled={approveMut.isPending || rejectMut.isPending}
                              >
                                <XCircle className="w-3.5 h-3.5" /> Reject
                              </Button>
                            </div>
                          ) : null}
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

export default function HRClaimsPage() {
  return (
    <PermissionGuard module="hr" action="read">
      <HrClaimsInner />
    </PermissionGuard>
  );
}
