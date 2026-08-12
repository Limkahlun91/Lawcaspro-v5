import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";

type MonitorRow = {
  caseId: number;
  caseNumber: string | null;
  caseName: string;
  stage: string | null;
  daysInStage: number | null;
  lastActivityAt: string | null;
  responsibleLawyer: string | null;
  pvAlert: boolean;
  documentAlert: boolean;
  approvalAlert: boolean;
  riskBadge: string | null;
};

const hasRole = (roles: Array<"Partner" | "Manager" | "Staff">, userRoleName: string | null | undefined) =>
  !!userRoleName && roles.includes(userRoleName as any);

function CaseMonitorInner() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["case-monitor-list"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: MonitorRow[] }>(await apiFetchJson("/case-monitor")); }
      catch {
        return {
          items: [] as MonitorRow[],
        };
      }
    },
    staleTime: 30_000,
    retry: false,
  });
  const canReadAll = hasRole(["Partner", "Manager"], user?.roleName);
  const rows = q.data?.items ?? [];
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Partner Case Monitor</CardTitle>
          <div className="text-xs text-slate-500">
            {canReadAll ? "Partner / Manager access — view all cases" : "Staff access restricted"}
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="text-left py-2 px-2 whitespace-nowrap">Case</th>
                  <th className="text-left py-2 px-2 whitespace-nowrap">Stage</th>
                  <th className="text-right py-2 px-2 whitespace-nowrap">Days In Stage</th>
                  <th className="text-left py-2 px-2 whitespace-nowrap">Last Activity</th>
                  <th className="text-left py-2 px-2 whitespace-nowrap">Responsible Lawyer</th>
                  <th className="text-center py-2 px-2 whitespace-nowrap">PV Alert</th>
                  <th className="text-center py-2 px-2 whitespace-nowrap">Doc Alert</th>
                  <th className="text-center py-2 px-2 whitespace-nowrap">Approval</th>
                  <th className="text-left py-2 px-2 whitespace-nowrap">Risk</th>
                  <th className="text-left py-2 px-2 whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.caseId} className="border-b border-slate-100">
                    <td className="py-2 px-2 font-medium">
                      <a className="text-sky-700 hover:underline" href={`/app/cases/${r.caseId}`}>
                        {r.caseNumber ? `${r.caseNumber} · ` : ""}{r.caseName}
                      </a>
                    </td>
                    <td className="py-2 px-2">{r.stage ?? "—"}</td>
                    <td className="py-2 px-2 text-right font-mono">{r.daysInStage ?? 0}</td>
                    <td className="py-2 px-2 text-xs text-slate-500">{r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleString() : "—"}</td>
                    <td className="py-2 px-2">{r.responsibleLawyer ?? "—"}</td>
                    <td className="py-2 px-2 text-center">{r.pvAlert ? <Badge variant="destructive" className="text-xs">Yes</Badge> : <span className="text-slate-400 text-xs">—</span>}</td>
                    <td className="py-2 px-2 text-center">{r.documentAlert ? <Badge variant="destructive" className="text-xs">Yes</Badge> : <span className="text-slate-400 text-xs">—</span>}</td>
                    <td className="py-2 px-2 text-center">{r.approvalAlert ? <Badge variant="destructive" className="text-xs">Yes</Badge> : <span className="text-slate-400 text-xs">—</span>}</td>
                    <td className="py-2 px-2">
                      {r.riskBadge ? (
                        <Badge variant={r.riskBadge === "HIGH" ? "destructive" : r.riskBadge === "MEDIUM" ? "secondary" : "outline"}>{r.riskBadge}</Badge>
                      ) : <span className="text-slate-400 text-xs">—</span>}
                    </td>
                    <td className="py-2 px-2">
                      <Button size="sm" variant="outline" onClick={() => (window.location.href = `/app/cases/${r.caseId}`)}>Open</Button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={10} className="py-10 text-center text-sm text-slate-500">No cases to monitor.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function CaseMonitorPage() {
  const { user } = useAuth();
  if (hasRole(["Partner", "Manager"], user?.roleName)) {
    return <CaseMonitorInner />;
  }
  return (
    <PermissionGuard module="case_monitor" action="read" mode="block">
      <CaseMonitorInner />
    </PermissionGuard>
  );
}
