import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type DocRow = { id: number; name: string; docType: string | null; version: number | null; uploadedAt: string | null; status: string };

function MyDocuments() {
  const list = useQuery({
    queryKey: ["my-personnel-documents"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: DocRow[] }>(await apiFetchJson("/hr/documents/me")); }
      catch { return { items: [] as DocRow[] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>My Personnel Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">File</th><th className="text-left py-2 px-2">Type</th><th className="text-left py-2 px-2 text-right">Version</th><th className="text-left py-2 px-2">Uploaded</th><th className="text-left py-2 px-2">Status</th><th className="text-left py-2 px-2">Actions</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((d) => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="py-2 px-2 font-medium">{d.name}</td>
                  <td className="py-2 px-2">{d.docType ?? "—"}</td>
                  <td className="py-2 px-2 text-right">v{d.version ?? 1}</td>
                  <td className="py-2 px-2 text-xs text-slate-500">{d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : "—"}</td>
                  <td className="py-2 px-2"><Badge variant="outline">{d.status}</Badge></td>
                  <td className="py-2 px-2"><Button size="sm" variant="outline">Download</Button></td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && <tr><td colSpan={6} className="py-10 text-center text-sm text-slate-500">No documents.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyDocuments;
