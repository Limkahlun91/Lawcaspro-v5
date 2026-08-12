import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { Badge } from "@/components/ui/badge";

type RequestRow = { id: number; kind: string; title: string | null; status: string; created: string | null };

function MyRequests() {
  const list = useQuery({
    queryKey: ["my-requests-combined"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: RequestRow[] }>(await apiFetchJson("/hr/me/requests")); }
      catch { return { items: [] as RequestRow[] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>My Requests</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Kind</th><th className="text-left py-2 px-2">Title</th><th className="text-left py-2 px-2">Status</th><th className="text-left py-2 px-2">Created</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-2 px-2 capitalize">{r.kind}</td>
                  <td className="py-2 px-2">{r.title ?? "—"}</td>
                  <td className="py-2 px-2"><Badge variant={r.status === "approved" ? "default" : r.status === "pending" ? "secondary" : "outline"}>{r.status}</Badge></td>
                  <td className="py-2 px-2 text-xs text-slate-500">{r.created ? new Date(r.created).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && <tr><td colSpan={4} className="py-10 text-center text-sm text-slate-500">No requests. Apply for leave or claims via My Work.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyRequests;
