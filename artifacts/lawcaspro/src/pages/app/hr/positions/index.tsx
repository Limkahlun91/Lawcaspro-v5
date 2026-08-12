import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { wrapRouteWithFeature } from "@/lib/feature-guards";

function HrPositionsInner() {
  const list = useQuery({
    queryKey: ["hr-positions"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: Array<{ id: number; title: string; department: string | null; grade: string | null; vacantCount: number | null }> }>(await apiFetchJson("/hr/positions")); }
      catch { return { items: [] }; }
    },
    staleTime: 60_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>Positions</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Title</th><th className="text-left py-2 px-2">Department</th><th className="text-left py-2 px-2">Grade</th><th className="text-left py-2 px-2 text-right">Vacant</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((p) => (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="py-2 px-2 font-medium">{p.title}</td>
                  <td className="py-2 px-2">{p.department ?? "—"}</td>
                  <td className="py-2 px-2">{p.grade ?? "—"}</td>
                  <td className="py-2 px-2 text-right">{p.vacantCount ?? 0}</td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && (
                <tr><td colSpan={4} className="py-10 text-center text-sm text-slate-500">No positions.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default wrapRouteWithFeature("module.hr", HrPositionsInner);
