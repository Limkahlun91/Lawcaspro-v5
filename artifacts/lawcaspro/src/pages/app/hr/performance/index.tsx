import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { wrapRouteWithFeature } from "@/lib/feature-guards";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

type PerfRow = { id: number; employeeName: string | null; reviewPeriod: string; overallScore: number | null; status: string };

function HrPerformanceInner() {
  const list = useQuery({
    queryKey: ["hr-performance-list"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: PerfRow[] }>(await apiFetchJson("/hr/performance/reviews")); }
      catch { return { items: [] as PerfRow[] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>Performance Reviews</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Employee</th><th className="text-left py-2 px-2">Period</th><th className="text-left py-2 px-2">Score</th><th className="text-left py-2 px-2 w-40">Progress</th><th className="text-left py-2 px-2">Status</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-2 px-2">{r.employeeName ?? "—"}</td>
                  <td className="py-2 px-2">{r.reviewPeriod}</td>
                  <td className="py-2 px-2 font-medium">{r.overallScore != null ? `${r.overallScore}/100` : "—"}</td>
                  <td className="py-2 px-2"><Progress value={r.overallScore ?? 0} className="h-2" /></td>
                  <td className="py-2 px-2"><Badge variant="outline">{r.status}</Badge></td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && (
                <tr><td colSpan={5} className="py-10 text-center text-sm text-slate-500">No reviews scheduled.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default wrapRouteWithFeature("module.hr", HrPerformanceInner);
