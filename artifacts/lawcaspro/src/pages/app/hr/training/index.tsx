import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { wrapRouteWithFeature } from "@/lib/feature-guards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type TrainingRow = { id: number; title: string; category: string | null; durationHours: number | null; status: string };

function HrTrainingInner() {
  const list = useQuery({
    queryKey: ["hr-training-list"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: TrainingRow[] }>(await apiFetchJson("/hr/training/programs")); }
      catch { return { items: [] as TrainingRow[] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Training Programs</CardTitle>
          <Button size="sm" variant="outline">+ New Program</Button>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Title</th><th className="text-left py-2 px-2">Category</th><th className="text-left py-2 px-2">Hours</th><th className="text-left py-2 px-2">Status</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((t) => (
                <tr key={t.id} className="border-b border-slate-100">
                  <td className="py-2 px-2 font-medium">{t.title}</td>
                  <td className="py-2 px-2">{t.category ?? "—"}</td>
                  <td className="py-2 px-2">{t.durationHours ?? "—"}</td>
                  <td className="py-2 px-2"><Badge variant="outline">{t.status}</Badge></td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && (
                <tr><td colSpan={4} className="py-10 text-center text-sm text-slate-500">No training programs.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default wrapRouteWithFeature("module.hr", HrTrainingInner);
