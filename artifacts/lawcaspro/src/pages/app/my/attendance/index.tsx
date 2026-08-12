import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Badge } from "@/components/ui/badge";

type AttendanceRow = { id: number; date: string; clockedInAt: string | null; clockedOutAt: string | null; status: string; workMinutes: number | null };

function MyAttendance() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [now, setNow] = useState<Date | null>(null);
  const list = useQuery({
    queryKey: ["my-attendance"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: AttendanceRow[] }>(await apiFetchJson("/hr/attendance/me")); }
      catch { return { items: [] as AttendanceRow[] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  const clockIn = useMutation({
    mutationFn: async () => unwrapApiData(await apiFetchJson("/hr/attendance/me/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "in", at: now?.toISOString() ?? new Date().toISOString() }) })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["my-attendance"] }); toast({ title: "Clocked in" }); setNow(null); },
    onError: (e) => toastError(toast, e, "Clock in failed"),
  });
  const clockOut = useMutation({
    mutationFn: async () => unwrapApiData(await apiFetchJson("/hr/attendance/me/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "out", at: now?.toISOString() ?? new Date().toISOString() }) })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["my-attendance"] }); toast({ title: "Clocked out" }); setNow(null); },
    onError: (e) => toastError(toast, e, "Clock out failed"),
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>Clock In / Out</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs text-slate-500">Current Time</div>
            <div className="font-mono text-lg">{(now ?? new Date()).toLocaleString()}</div>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setNow(new Date())}>Refresh</Button>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => clockIn.mutate()} disabled={clockIn.isPending}>Clock In</Button>
            <Button size="sm" variant="outline" onClick={() => clockOut.mutate()} disabled={clockOut.isPending}>Clock Out</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>My Attendance</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Date</th><th className="text-left py-2 px-2">Clock In</th><th className="text-left py-2 px-2">Clock Out</th><th className="text-right py-2 px-2">Work (m)</th><th className="text-left py-2 px-2">Status</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((a) => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="py-2 px-2">{a.date}</td>
                  <td className="py-2 px-2 text-xs text-slate-600">{a.clockedInAt ? new Date(a.clockedInAt).toLocaleTimeString() : "—"}</td>
                  <td className="py-2 px-2 text-xs text-slate-600">{a.clockedOutAt ? new Date(a.clockedOutAt).toLocaleTimeString() : "—"}</td>
                  <td className="py-2 px-2 text-right">{a.workMinutes ?? 0}</td>
                  <td className="py-2 px-2"><Badge variant={a.status === "present" ? "default" : "secondary"}>{a.status}</Badge></td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && <tr><td colSpan={5} className="py-10 text-center text-sm text-slate-500">No records.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyAttendance;
