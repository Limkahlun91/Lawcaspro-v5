import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Search, Users } from "lucide-react";

type EmployeeRow = {
  id: number;
  employeeId?: string | null;
  name?: string | null;
  email?: string | null;
  status?: string | null;
  department?: string | null;
  userId?: number | null;
};

function HrAdminEmployeesInner() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  const listQuery = useQuery({
    queryKey: ["hr-employees-list"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/employees");
        return unwrapApiData<{ items: EmployeeRow[] }>(res);
      } catch {
        try {
          const res2 = await apiFetchJson("/hr/employees/list");
          return unwrapApiData<{ items: EmployeeRow[] }>(res2);
        } catch {
          return { items: [] as EmployeeRow[] };
        }
      }
    },
    staleTime: 30_000,
    retry: false,
  });

  const rows = listQuery.data?.items ?? [];
  const filtered = rows.filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(r.name ?? "").toLowerCase().includes(q) ||
      String(r.email ?? "").toLowerCase().includes(q) ||
      String(r.employeeId ?? "").toLowerCase().includes(q) ||
      String(r.department ?? "").toLowerCase().includes(q)
    );
  });

  const statusBadge = (s: string | null | undefined) => {
    const v = String(s ?? "unknown").toLowerCase();
    if (v === "active" || v === "current") return <Badge variant="default" className="bg-green-100 text-green-700 hover:bg-green-100">Active</Badge>;
    if (v === "inactive") return <Badge variant="outline">Inactive</Badge>;
    if (v === "on_leave" || v === "leave") return <Badge variant="secondary">On Leave</Badge>;
    if (v === "terminated" || v === "resigned") return <Badge variant="destructive">{String(s)}</Badge>;
    return <Badge variant="outline">{String(s ?? "—")}</Badge>;
  };

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Users className="w-5 h-5 text-slate-500" /> Employees
          </h1>
          <p className="text-slate-500 mt-1">Manage firm employees</p>
        </div>
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Search name, email, dept…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All Employees ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading…</div>
          ) : listQuery.isError && filtered.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-sm">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>Employee list unavailable</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-600">No employees found</p>
              <p className="text-xs mt-1">Employee data will appear here when HR module is populated.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">ID</th>
                    <th className="px-4 py-3 text-left font-medium">Name</th>
                    <th className="px-4 py-3 text-left font-medium">Email</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Department</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">
                        {r.employeeId ?? `#${r.id}`}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {r.name ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs">
                        {r.email ?? "—"}
                      </td>
                      <td className="px-4 py-3">{statusBadge(r.status)}</td>
                      <td className="px-4 py-3 text-slate-600 text-xs">
                        {r.department ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-slate-500 hover:text-slate-800">View</Button>
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

export default function HRAdminEmployeesPage() {
  return (
    <PermissionGuard module="hr" action="read">
      <HrAdminEmployeesInner />
    </PermissionGuard>
  );
}
