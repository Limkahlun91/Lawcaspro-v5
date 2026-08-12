import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type AdapterRow = { key: string; name: string; status: "active" | "beta" | "upcoming"; importCsv?: boolean; exportCsv?: boolean };

function BankAdaptersInner() {
  const q = useQuery({
    queryKey: ["bank-adapters-list"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: AdapterRow[] }>(await apiFetchJson("/bank-adapters")); }
      catch {
        return {
          items: [
            { key: "maybank", name: "Maybank", status: "active", importCsv: true, exportCsv: true },
            { key: "cimb", name: "CIMB Bank", status: "active", importCsv: true, exportCsv: true },
            { key: "ocbc", name: "OCBC Bank", status: "beta", importCsv: true, exportCsv: false },
            { key: "public", name: "Public Bank", status: "upcoming", importCsv: false, exportCsv: false },
            { key: "rhb", name: "RHB Bank", status: "upcoming", importCsv: false, exportCsv: false },
            { key: "hlb", name: "Hong Leong Bank (HLB)", status: "upcoming", importCsv: false, exportCsv: false },
          ] as AdapterRow[],
        };
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Bank Adapters</CardTitle>
          <div className="text-xs text-slate-500">
            Import / export bank statements for reconciliation and payment voucher matching
          </div>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left py-2 px-2 whitespace-nowrap">Bank</th>
                <th className="text-left py-2 px-2 whitespace-nowrap">Status</th>
                <th className="text-center py-2 px-2 whitespace-nowrap">Import</th>
                <th className="text-center py-2 px-2 whitespace-nowrap">Export</th>
                <th className="text-left py-2 px-2 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const upcoming = b.status === "upcoming";
                return (
                  <tr key={b.key} className="border-b border-slate-100">
                    <td className="py-2 px-2 font-medium">{b.name}</td>
                    <td className="py-2 px-2">
                      <Badge variant={b.status === "active" ? "default" : b.status === "beta" ? "secondary" : "outline"}>
                        {b.status}
                      </Badge>
                    </td>
                    <td className="py-2 px-2 text-center">{b.importCsv ? <span className="text-emerald-700">✓</span> : <span className="text-slate-300">—</span>}</td>
                    <td className="py-2 px-2 text-center">{b.exportCsv ? <span className="text-emerald-700">✓</span> : <span className="text-slate-300">—</span>}</td>
                    <td className="py-2 px-2 flex gap-2">
                      <Button size="sm" variant="outline" disabled={!b.importCsv}>Import CSV</Button>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="inline-block">
                              <Button size="sm" variant="outline" disabled={!b.exportCsv || upcoming}>Export</Button>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            {upcoming
                              ? "Official file specification pending verification."
                              : b.exportCsv
                                ? "Download bank statement in the official reconciliation format."
                                : "Export format not supported for this bank yet."}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-sm text-slate-500">No adapters.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BankAdaptersPage() {
  return (
    <PermissionGuard module="accounting" action="read" mode="block">
      <BankAdaptersInner />
    </PermissionGuard>
  );
}
