import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { useState } from "react";
import { LogOut, ListChecks, Play, FileCheck, UserMinus } from "lucide-react";

type OffboardingRow = {
  id: number;
  employeeId?: number | null;
  employeeName?: string | null;
  status?: string | null;
  startDate?: string | null;
  lastWorkingDay?: string | null;
  reason?: string | null;
  checklistCompletedCount?: number | null;
  checklistTotalCount?: number | null;
};

function HrOffboardingInner() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedEmployee, setSelectedEmployee] = useState<string>("");
  const [lastWorkingDay, setLastWorkingDay] = useState<string>(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState<string>("");

  const listQuery = useQuery({
    queryKey: ["hr-offboarding-list"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/offboarding");
        const d = unwrapApiData<any>(res);
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.items)) return d.items;
        return [];
      } catch {
        return [] as OffboardingRow[];
      }
    },
    staleTime: 30_000, retry: false,
  });

  const employeesQuery = useQuery({
    queryKey: ["hr-offboarding-employees"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/employees");
        const d = unwrapApiData<any>(res);
        const arr: any[] = Array.isArray(d) ? d : d?.items ?? [];
        return arr.filter((e: any) => {
          const s = String(e.status ?? "active").toLowerCase();
          return s === "active" || s === "current";
        });
      } catch { return []; }
    },
    staleTime: 60_000, retry: false,
  });

  const startMut = useMutation({
    mutationFn: async () => {
      const empId = parseInt(selectedEmployee, 10);
      if (!Number.isFinite(empId) || empId <= 0) throw new Error("Select an employee");
      return apiFetchJson("/hr/offboarding/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: empId, lastWorkingDay, reason: reason.trim() || undefined }),
      });
    },
    onSuccess: () => {
      toast({ title: "Offboarding started" });
      void qc.invalidateQueries({ queryKey: ["hr-offboarding"] });
      setSelectedEmployee(""); setReason("");
    },
    onError: (e) => toastError(toast, e, "Start failed"),
  });

  const checklistMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/offboarding/${id}/checklist`, { method: "POST" }),
    onSuccess: () => { toast({ title: "Checklist updated" }); void qc.invalidateQueries({ queryKey: ["hr-offboarding"] }); },
    onError: (e) => toastError(toast, e, "Checklist failed"),
  });

  const finaliseMut = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/hr/offboarding/${id}/finalise`, { method: "POST" }),
    onSuccess: () => { toast({ title: "Offboarding finalised", description: "Employee deactivated and records archived." }); void qc.invalidateQueries({ queryKey: ["hr-offboarding"] }); void qc.invalidateQueries({ queryKey: ["hr-employees"] }); },
    onError: (e) => toastError(toast, e, "Finalise failed"),
  });

  const rows = (listQuery.data ?? []) as OffboardingRow[];
  const employees = employeesQuery.data ?? [];

  const statusBadge = (s: string | null | undefined) => {
    const v = String(s ?? "unknown").toLowerCase();
    if (v.includes("final") || v.includes("complete")) return <Badge variant="default" className="bg-slate-600 text-white hover:bg-slate-600">Finalised</Badge>;
    if (v.includes("checklist") || v.includes("in_progress") || v.includes("progress")) return <Badge variant="secondary">In Progress</Badge>;
    if (v.includes("start") || v.includes("initiated")) return <Badge variant="outline">Started</Badge>;
    return <Badge variant="outline">{String(s ?? "—")}</Badge>;
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <LogOut className="w-5 h-5 text-slate-500" /> Offboarding
        </h1>
        <p className="text-slate-500 mt-1">Start employee offboarding, manage checklist, and finalise</p>
      </div>

      <Card className="border-amber-200 bg-amber-50/50">
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Play className="w-4 h-4 text-amber-600" /> Start Offboarding</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label>Employee</Label>
              <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
                <SelectTrigger>
                  <SelectValue placeholder="Select employee…" />
                </SelectTrigger>
                <SelectContent>
                  {employees.length === 0 ? (
                    <SelectItem value="__none" disabled>No active employees</SelectItem>
                  ) : employees.map((e: any) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.name ?? `#${e.id}`} {e.email ? `(${e.email})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Last Working Day</Label>
              <Input type="date" value={lastWorkingDay} onChange={(e) => setLastWorkingDay(e.target.value)} />
            </div>
            <div>
              <Label>Reason (optional)</Label>
              <Input placeholder="e.g. resignation, termination" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => startMut.mutate()}
              disabled={!selectedEmployee || startMut.isPending}
              className="gap-2"
            >
              <UserMinus className="w-4 h-4" />
              {startMut.isPending ? "Starting…" : "Start Offboarding"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Offboarding Cases ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading…</div>
          ) : listQuery.isError ? (
            <div className="text-center py-12 text-sm">
              <LogOut className="w-10 h-10 mx-auto mb-3 text-rose-400 opacity-60" />
              <p className="font-medium text-rose-700">Offboarding cases unavailable</p>
              <p className="text-xs mt-1 text-slate-500">
                We couldn&apos;t load offboarding. Please retry.
              </p>
              <div className="mt-4">
                <Button size="sm" variant="outline" onClick={() => { void listQuery.refetch(); }}>
                  Retry
                </Button>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <LogOut className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-600">No offboarding cases</p>
              <p className="text-xs mt-1">Start an offboarding above to track exit procedures.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">Employee</th>
                    <th className="px-4 py-3 text-left font-medium">Started</th>
                    <th className="px-4 py-3 text-left font-medium">Last Day</th>
                    <th className="px-4 py-3 text-left font-medium">Checklist</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => {
                    const done = r.checklistCompletedCount ?? 0;
                    const total = r.checklistTotalCount ?? 0;
                    const allDone = total > 0 && done >= total;
                    const s = String(r.status ?? "").toLowerCase();
                    const isFinal = s.includes("final") || s.includes("complete");
                    return (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-900">{r.employeeName ?? `#${r.employeeId ?? r.id}`}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{r.startDate ? new Date(String(r.startDate)).toLocaleDateString() : "—"}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{r.lastWorkingDay ? new Date(String(r.lastWorkingDay)).toLocaleDateString() : "—"}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="text-xs font-mono text-slate-700">{done}/{total}</div>
                            <div className="w-24 h-2 rounded bg-slate-100 overflow-hidden">
                              <div className="h-full bg-amber-500" style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">{statusBadge(r.status)}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1"
                              onClick={() => checklistMut.mutate(r.id)}
                              disabled={isFinal || checklistMut.isPending}
                            >
                              <ListChecks className="w-3.5 h-3.5" /> Checklist
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-green-700 border-green-200 hover:bg-green-50"
                              onClick={() => finaliseMut.mutate(r.id)}
                              disabled={isFinal || !allDone || finaliseMut.isPending}
                            >
                              <FileCheck className="w-3.5 h-3.5" /> Finalise
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

export default function HROffboardingPage() {
  return (
    <PermissionGuard module="hr" action="write">
      <HrOffboardingInner />
    </PermissionGuard>
  );
}
