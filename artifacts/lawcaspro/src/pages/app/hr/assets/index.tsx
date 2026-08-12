import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { Package, Monitor, Laptop } from "lucide-react";

type AssetRow = {
  id: number;
  tag?: string | null;
  name?: string | null;
  category?: string | null;
  status?: string | null;
  assignedTo?: string | null;
  assignedEmployeeId?: number | null;
  purchasedAt?: string | null;
};

function HrAssetsInner() {
  const listQuery = useQuery({
    queryKey: ["hr-assets-list"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/assets");
        const d = unwrapApiData<any>(res);
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.items)) return d.items;
        return [];
      } catch {
        try {
          const res2 = await apiFetchJson("/hr-assets");
          const d2 = unwrapApiData<any>(res2);
          if (Array.isArray(d2)) return d2;
          if (d2 && Array.isArray(d2.items)) return d2.items;
          return [];
        } catch { return [] as AssetRow[]; }
      }
    },
    staleTime: 60_000, retry: false,
  });

  const rows = (listQuery.data ?? []) as AssetRow[];

  const catIcon = (c: string | null | undefined) => {
    const v = String(c ?? "").toLowerCase();
    if (v.includes("laptop") || v.includes("computer") || v.includes("mac")) return <Laptop className="w-4 h-4 text-slate-500" />;
    if (v.includes("monitor") || v.includes("display")) return <Monitor className="w-4 h-4 text-slate-500" />;
    return <Package className="w-4 h-4 text-slate-500" />;
  };

  const statusBadge = (s: string | null | undefined) => {
    const v = String(s ?? "unknown").toLowerCase();
    if (v.includes("assign") || v.includes("allocat")) return <Badge variant="default" className="bg-blue-100 text-blue-700 hover:bg-blue-100">Assigned</Badge>;
    if (v.includes("avail") || v.includes("stock") || v.includes("unassign")) return <Badge variant="secondary">Available</Badge>;
    if (v.includes("repair") || v.includes("damag")) return <Badge variant="destructive">Repair</Badge>;
    if (v.includes("retire") || v.includes("dispose")) return <Badge variant="outline">Retired</Badge>;
    return <Badge variant="outline">{String(s ?? "—")}</Badge>;
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Package className="w-5 h-5 text-slate-500" /> Assets
        </h1>
        <p className="text-slate-500 mt-1">Track company assets assigned to employees</p>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Assets ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <Package className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-600">No assets registered</p>
              <p className="text-xs mt-1">Asset records will appear when populated.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">Asset</th>
                    <th className="px-4 py-3 text-left font-medium">Tag</th>
                    <th className="px-4 py-3 text-left font-medium">Category</th>
                    <th className="px-4 py-3 text-left font-medium">Assigned To</th>
                    <th className="px-4 py-3 text-left font-medium">Purchased</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900 flex items-center gap-2">
                        {catIcon(r.category)}
                        <span>{r.name ?? `Asset #${r.id}`}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{r.tag ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-600 text-xs">{r.category ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-700 text-xs">{r.assignedTo ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{r.purchasedAt ? new Date(String(r.purchasedAt)).toLocaleDateString() : "—"}</td>
                      <td className="px-4 py-3">{statusBadge(r.status)}</td>
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

export default function HRAssetsPage() {
  return (
    <PermissionGuard module="hr" action="read">
      <HrAssetsInner />
    </PermissionGuard>
  );
}
