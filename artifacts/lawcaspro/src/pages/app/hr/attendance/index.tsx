import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Clock, LogIn, LogOut, Calendar } from "lucide-react";

type AttendanceRecord = {
  id: number;
  date?: string | null;
  clockIn?: string | null;
  clockOut?: string | null;
  status?: string | null;
  hoursWorked?: number | null;
};

type AttendanceToday = {
  clockedIn: boolean;
  clockedOut: boolean;
  clockInAt?: string | null;
  clockOutAt?: string | null;
  todayRecords?: AttendanceRecord[];
};

function HrAttendanceInner() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const todayQuery = useQuery({
    queryKey: ["hr-attendance-me-today"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/attendance/me");
        return unwrapApiData<AttendanceToday>(res);
      } catch {
        try {
          const res2 = await apiFetchJson("/hr/self/attendance");
          const d = unwrapApiData<{ items: AttendanceRecord[] }>(res2);
          const today = new Date().toISOString().slice(0, 10);
          const todayRecs = (d.items ?? []).filter((r) => String(r.date ?? "").startsWith(today));
          return {
            clockedIn: todayRecs.some((r) => r.clockIn),
            clockedOut: todayRecs.some((r) => r.clockOut),
            clockInAt: todayRecs.find((r) => r.clockIn)?.clockIn ?? null,
            clockOutAt: todayRecs.find((r) => r.clockOut)?.clockOut ?? null,
            todayRecords: todayRecs,
          };
        } catch {
          return { clockedIn: false, clockedOut: false, todayRecords: [] };
        }
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const historyQuery = useQuery({
    queryKey: ["hr-attendance-me-history"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/attendance/me?range=30");
        const d = unwrapApiData<any>(res);
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.items)) return d.items;
        return [];
      } catch {
        try {
          const res2 = await apiFetchJson("/hr/self/attendance");
          const d2 = unwrapApiData<{ items: AttendanceRecord[] }>(res2);
          return d2.items ?? [];
        } catch {
          return [] as AttendanceRecord[];
        }
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const clockInMut = useMutation({
    mutationFn: async () => apiFetchJson("/hr/attendance/me/clock-in", { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Clocked in", description: new Date().toLocaleTimeString() });
      void qc.invalidateQueries({ queryKey: ["hr-attendance-me"] });
    },
    onError: (e) => toastError(toast, e, "Clock in failed"),
  });

  const clockOutMut = useMutation({
    mutationFn: async () => apiFetchJson("/hr/attendance/me/clock-out", { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Clocked out", description: new Date().toLocaleTimeString() });
      void qc.invalidateQueries({ queryKey: ["hr-attendance-me"] });
    },
    onError: (e) => toastError(toast, e, "Clock out failed"),
  });

  const today = todayQuery.data ?? { clockedIn: false, clockedOut: false };
  const history = (historyQuery.data ?? []) as AttendanceRecord[];

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Clock className="w-5 h-5 text-slate-500" /> Attendance
        </h1>
        <p className="text-slate-500 mt-1">Clock in / out for today</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Today — {new Date().toLocaleDateString("en-MY", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
            <div className="flex flex-col items-center gap-2 p-4 rounded-lg border border-slate-200">
              <div className={`w-3 h-3 rounded-full ${today.clockedIn ? "bg-green-500" : "bg-slate-300"}`} />
              <div className="text-xs text-slate-500 uppercase">Clock In</div>
              <div className="text-lg font-semibold text-slate-900">
                {today.clockInAt ? new Date(String(today.clockInAt)).toLocaleTimeString() : "—"}
              </div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="flex gap-3">
                <Button
                  size="lg"
                  onClick={() => clockInMut.mutate()}
                  disabled={today.clockedIn || clockInMut.isPending}
                  className="gap-2 bg-green-600 hover:bg-green-700 text-white"
                >
                  <LogIn className="w-4 h-4" />
                  {clockInMut.isPending ? "Clocking In…" : "Clock In"}
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => clockOutMut.mutate()}
                  disabled={!today.clockedIn || today.clockedOut || clockOutMut.isPending}
                  className="gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  {clockOutMut.isPending ? "Clocking Out…" : "Clock Out"}
                </Button>
              </div>
              {today.clockedIn && !today.clockedOut ? (
                <Badge variant="secondary" className="bg-green-100 text-green-700 mt-2">Currently Clocked In</Badge>
              ) : today.clockedOut ? (
                <Badge variant="outline" className="mt-2">Completed Today</Badge>
              ) : (
                <Badge variant="outline" className="mt-2">Not Clocked In</Badge>
              )}
            </div>
            <div className="flex flex-col items-center gap-2 p-4 rounded-lg border border-slate-200">
              <div className={`w-3 h-3 rounded-full ${today.clockedOut ? "bg-slate-700" : "bg-slate-300"}`} />
              <div className="text-xs text-slate-500 uppercase">Clock Out</div>
              <div className="text-lg font-semibold text-slate-900">
                {today.clockOutAt ? new Date(String(today.clockOutAt)).toLocaleTimeString() : "—"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-500" /> Recent Attendance
          </CardTitle>
        </CardHeader>
        <CardContent>
          {historyQuery.isLoading ? (
            <div className="text-center py-8 text-slate-400 text-sm">Loading…</div>
          ) : history.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No attendance history yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                    <th className="px-4 py-3 text-left font-medium">Clock In</th>
                    <th className="px-4 py-3 text-left font-medium">Clock Out</th>
                    <th className="px-4 py-3 text-right font-medium">Hours</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.slice(0, 20).map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {r.date ? new Date(String(r.date)).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.clockIn ? new Date(String(r.clockIn)).toLocaleTimeString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.clockOut ? new Date(String(r.clockOut)).toLocaleTimeString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {typeof r.hoursWorked === "number" ? Number(r.hoursWorked).toFixed(1) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs">{r.status ?? "recorded"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function HRAttendancePage() {
  return <HrAttendanceInner />;
}
