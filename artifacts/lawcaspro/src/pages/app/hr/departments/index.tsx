import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { wrapRouteWithFeature } from "@/lib/feature-guards";

function HrDepartmentsInner() {
  const list = useQuery({
    queryKey: ["hr-departments"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: Array<{ id: number; name: string; headName: string | null; employeeCount: number | null }> }>(await apiFetchJson("/hr/departments")); }
      catch { return { items: [] }; }
    },
    staleTime: 60_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>Departments</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {(list.data?.items ?? []).map((d) => (
              <Card key={d.id}><CardContent className="p-4">
                <div className="font-semibold text-slate-900">{d.name}</div>
                <div className="text-xs text-slate-500 mt-1">Head: {d.headName ?? "—"}</div>
                <div className="text-xs text-slate-500 mt-0.5">Employees: {d.employeeCount ?? 0}</div>
              </CardContent></Card>
            ))}
            {(!list.data?.items || list.data.items.length === 0) && <div className="col-span-full text-sm text-slate-500">No departments configured.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
export default wrapRouteWithFeature("module.hr", HrDepartmentsInner);
