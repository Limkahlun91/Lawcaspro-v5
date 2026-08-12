import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { wrapRouteWithFeature } from "@/lib/feature-guards";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Badge } from "@/components/ui/badge";

type TaskRow = { id: number; title: string; ownerName: string | null; status: string; dueAt: string | null };

function HrOnboardingInner() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["hr-onboarding-list"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: TaskRow[]; workflows: Array<{ id: number; employeeName: string | null; status: string; startDate: string | null }> }>(await apiFetchJson("/hr/onboarding/workflows")); }
      catch { return { items: [] as TaskRow[], workflows: [] as Array<{ id: number; employeeName: string | null; status: string; startDate: string | null }> }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  const finalise = useMutation({
    mutationFn: async (id: number) => unwrapApiData(await apiFetchJson(`/hr/onboarding/workflows/${id}/finalise`, { method: "POST" })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["hr-onboarding"] }); toast({ title: "Onboarding complete" }); },
    onError: (e) => toastError(toast, e, "Finalise failed — may require no active tasks first"),
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Onboarding Workflows</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Employee</th><th className="text-left py-2 px-2">Started</th><th className="text-left py-2 px-2">Status</th><th className="text-left py-2 px-2">Actions</th></tr>
            </thead>
            <tbody>
              {(list.data?.workflows ?? []).map((w) => (
                <tr key={w.id} className="border-b border-slate-100">
                  <td className="py-2 px-2">{w.employeeName ?? `#${w.id}`}</td>
                  <td className="py-2 px-2 text-xs text-slate-500">{w.startDate ? new Date(w.startDate).toLocaleDateString() : "—"}</td>
                  <td className="py-2 px-2"><Badge variant="outline">{w.status}</Badge></td>
                  <td className="py-2 px-2">
                    {w.status !== "completed" && <Button size="sm" variant="outline" onClick={() => finalise.mutate(w.id)} disabled={finalise.isPending}>Complete</Button>}
                  </td>
                </tr>
              ))}
              {(!list.data?.workflows || list.data.workflows.length === 0) && (
                <tr><td colSpan={4} className="py-10 text-center text-sm text-slate-500">No onboarding workflows.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default wrapRouteWithFeature("module.hr", HrOnboardingInner);
