import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

function MyDashboard() {
  const { user } = useAuth();
  const stats = useQuery({
    queryKey: ["my-dashboard-stats"],
    queryFn: async () => {
      try { return unwrapApiData<{ assignedCases: number; pendingApprovals: number; leaveBalance: number; upcomingPayslip: string | null }>(await apiFetchJson("/hr/me/dashboard")); }
      catch { return { assignedCases: 0, pendingApprovals: 0, leaveBalance: 0, upcomingPayslip: null }; }
    },
    staleTime: 60_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>My Work Dashboard</CardTitle></CardHeader>
        <CardContent>
          <div className="text-sm text-slate-500 mb-4">Welcome back, <span className="font-medium text-slate-800">{user?.name ?? "Staff"}</span>.</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="p-4"><div className="text-xs text-slate-500">My Cases</div><div className="text-2xl font-semibold">{stats.data?.assignedCases ?? 0}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Pending Approvals</div><div className="text-2xl font-semibold text-amber-700">{stats.data?.pendingApprovals ?? 0}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Leave Balance</div><div className="text-2xl font-semibold text-emerald-700">{stats.data?.leaveBalance ?? 0}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Next Payslip</div><div className="text-2xl font-semibold">{stats.data?.upcomingPayslip ?? "—"}</div></CardContent></Card>
          </div>
          <div className="mt-4 flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => (window.location.href = "/app/my/leave")}>Apply Leave</Button>
            <Button size="sm" variant="outline" onClick={() => (window.location.href = "/app/my/claims")}>Submit Claim</Button>
            <Button size="sm" variant="outline" onClick={() => (window.location.href = "/app/my/attendance")}>Clock In</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyDashboard;
