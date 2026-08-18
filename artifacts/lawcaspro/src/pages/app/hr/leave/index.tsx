import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { CalendarDays, CheckCircle2, FileText, XCircle } from "lucide-react";

type LeaveRow = {
  id: number;
  employeeId?: number | null;
  employeeName?: string | null;
  leaveType?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  days?: number | null;
  status?: string | null;
  reason?: string | null;
  createdAt?: string | null;
};

function HrLeaveInner() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ["hr-leave-admin-list"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/leave");
        const d = unwrapApiData<any>(res);
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.items)) return d.items;
        return [];
      } catch {
        return [] as LeaveRow[];
      }
    },
    staleTime: 30_000,
    retry: false,
  });

  const approveMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/leave/${id}/approve`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Leave approved" });
      void qc.invalidateQueries({ queryKey: ["hr-leave-admin"] });
    },
    onError: (e) => toastError(toast, e, "Approve failed"),
  });

  const rejectMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/leave/${id}/reject`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Leave rejected" });
      void qc.invalidateQueries({ queryKey: ["hr-leave-admin"] });
    },
    onError: (e) => toastError(toast, e, "Reject failed"),
  });

  const rows = (listQuery.data ?? []) as LeaveRow[];

  const statusBadge = (s: string | null | undefined) => {
    const v = String(s ?? "unknown").toLowerCase();
    if (v === "approved") return <Badge variant="default" className="bg-green-100 text-green-700 hover:bg-green-100">Approved</Badge>;
    if (v === "rejected" || v === "denied") return <Badge variant="destructive">Rejected</Badge>;
    if (v === "pending" || v === "submitted") return <Badge variant="secondary">Pending</Badge>;
    if (v === "cancelled") return <Badge variant="outline">Cancelled</Badge>;
    return <Badge variant="outline">{String(s ?? "—")}</Badge>;
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <CalendarDays className="w-5 h-5 text-slate-500" /> Leave Management
        </h1>
        <p className="text-slate-500 mt-1">Review and approve/reject leave requests</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Leave Requests ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading…</div>
          ) : listQuery.isError ? (
            <div className="text-center py-12 text-sm">
              <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-rose-50 text-rose-500 flex items-center justify-center opacity-70">
                <FileText className="w-5 h-5" />
              </div>
              <p className="font-medium text-rose-700">Leave requests unavailable</p>
              <p className="text-xs mt-1 text-slate-500">
                We couldn&apos;t load leave. Please retry.
              </p>
              <div className="mt-4">
                <Button size="sm" variant="outline" onClick={() => { void listQuery.refetch(); }}>
                  Retry
                </Button>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-600">No leave requests</p>
              <p className="text-xs mt-1">Submitted requests will appear here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">Employee</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="px-4 py-3 text-left font-medium">From</th>
                    <th className="px-4 py-3 text-left font-medium">To</th>
                    <th className="px-4 py-3 text-right font-medium">Days</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Reason</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => {
                    const isPending = String(r.status ?? "").toLowerCase() === "pending" || String(r.status ?? "").toLowerCase() === "submitted";
                    return (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-900">{r.employeeName ?? `#${r.employeeId ?? r.id}`}</td>
                        <td className="px-4 py-3 text-slate-700 text-xs">{r.leaveType ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{r.startDate ? new Date(String(r.startDate)).toLocaleDateString() : "—"}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{r.endDate ? new Date(String(r.endDate)).toLocaleDateString() : "—"}</td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">{r.days ?? "—"}</td>
                        <td className="px-4 py-3">{statusBadge(r.status)}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs max-w-[200px] truncate" title={r.reason ?? ""}>{r.reason ?? "—"}</td>
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

export default function HRLeavePage() {
  return (
    <PermissionGuard module="hr" action="read">
      <HrLeaveInner />
    </PermissionGuard>
  );
}
