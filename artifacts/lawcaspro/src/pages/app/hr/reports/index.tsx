import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { wrapRouteWithFeature } from "@/lib/feature-guards";
import { Button } from "@/components/ui/button";

type ReportDef = { id: string; name: string; description: string | null; category: string };

function HrReportsInner() {
  const list = useQuery({
    queryKey: ["hr-reports-catalog"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: ReportDef[] }>(await apiFetchJson("/hr/reports/catalog")); }
      catch {
        return {
          items: [
            { id: "headcount", name: "Headcount", description: "Current headcount by department", category: "Workforce" },
            { id: "attrition", name: "Attrition", description: "Turnover rate by period", category: "Workforce" },
            { id: "payroll-summary", name: "Payroll Summary", description: "Net pay, deductions and contributions", category: "Payroll" },
            { id: "leave-utilization", name: "Leave Utilization", description: "Leave type balances used vs entitled", category: "Leave" },
          ] as ReportDef[],
        };
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>HR Reports</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(list.data?.items ?? []).map((r) => (
              <Card key={r.id}><CardContent className="p-4 flex flex-row items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-slate-500">{r.category}</div>
                  <div className="font-semibold mt-0.5">{r.name}</div>
                  {r.description && <div className="text-xs text-slate-500 mt-1">{r.description}</div>}
                </div>
                <Button size="sm" variant="outline">Run</Button>
              </CardContent></Card>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
export default wrapRouteWithFeature("module.hr", HrReportsInner);
