import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { FileText, Download } from "lucide-react";

type HrDocRow = {
  id: number;
  title?: string | null;
  category?: string | null;
  fileName?: string | null;
  uploadedAt?: string | null;
  uploadedByName?: string | null;
  visibility?: string | null;
};

function HrDocumentsInner() {
  const { toast } = useToast();

  const listQuery = useQuery({
    queryKey: ["hr-documents-list"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/documents");
        const d = unwrapApiData<any>(res);
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.items)) return d.items;
        return [];
      } catch {
        try {
          const res2 = await apiFetchJson("/hr-documents");
          const d2 = unwrapApiData<any>(res2);
          if (Array.isArray(d2)) return d2;
          if (d2 && Array.isArray(d2.items)) return d2.items;
          return [];
        } catch { return [] as HrDocRow[]; }
      }
    },
    staleTime: 60_000, retry: false,
  });

  const rows = (listQuery.data ?? []) as HrDocRow[];

  const download = async (r: HrDocRow) => {
    try {
      const url = `/hr/documents/${r.id}/download`;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toastError(toast, e, "Download failed");
    }
  };

  const visBadge = (v: string | null | undefined) => {
    const s = String(v ?? "all").toLowerCase();
    if (s.includes("confidential") || s.includes("hr") || s.includes("admin")) return <Badge variant="destructive">HR Confidential</Badge>;
    if (s.includes("staff") || s.includes("employee")) return <Badge variant="secondary">Staff Only</Badge>;
    return <Badge variant="outline">General</Badge>;
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-slate-500" /> HR Documents
        </h1>
        <p className="text-slate-500 mt-1">Policies, forms, and HR-related documents</p>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Documents ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-600">No HR documents</p>
              <p className="text-xs mt-1">Upload employee handbooks and forms to share here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">Title</th>
                    <th className="px-4 py-3 text-left font-medium">File</th>
                    <th className="px-4 py-3 text-left font-medium">Category</th>
                    <th className="px-4 py-3 text-left font-medium">Visibility</th>
                    <th className="px-4 py-3 text-left font-medium">Uploaded</th>
                    <th className="px-4 py-3 text-left font-medium">By</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">{r.title ?? r.fileName ?? `Doc #${r.id}`}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 font-mono">{r.fileName ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{r.category ?? "—"}</td>
                      <td className="px-4 py-3">{visBadge(r.visibility)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{r.uploadedAt ? new Date(String(r.uploadedAt)).toLocaleDateString() : "—"}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{r.uploadedByName ?? "—"}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1"
                          onClick={() => download(r)}
                        >
                          <Download className="w-3.5 h-3.5" /> Download
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function HRDocumentsPage() {
  return (
    <PermissionGuard module="hr" action="read">
      <HrDocumentsInner />
    </PermissionGuard>
  );
}
