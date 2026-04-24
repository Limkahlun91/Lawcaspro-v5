import { useListFirms, getListFirmsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";

export default function FirmsList() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  
  const { data: response, isLoading } = useListFirms({ 
    page: 1, 
    limit: 50,
    search: search || undefined,
    status: status !== "all" ? status : undefined
  });

  const firms = (() => {
    const r: unknown = response;
    if (!r || typeof r !== "object") return [];
    if (!("items" in r)) return [];
    const items = (r as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    return items as Array<{
      id: number;
      name: string;
      slug: string;
      status: string;
      subscriptionPlan: string;
      userCount: number;
      caseCount: number;
    }>;
  })();

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Firms</h1>
          <p className="text-slate-500 mt-1">Manage all law firms on the platform</p>
        </div>
        <Link href="/platform/firms/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Firm
          </Button>
        </Link>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search firms..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading firms...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Name</th>
                    <th className="px-6 py-3 font-semibold">Status</th>
                    <th className="px-6 py-3 font-semibold">Plan</th>
                    <th className="px-6 py-3 font-semibold text-right">Users</th>
                    <th className="px-6 py-3 font-semibold text-right">Cases</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {firms.map((firm) => (
                    <tr key={firm.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <Link href={`/platform/firms/${firm.id}`}>
                          <span className="font-medium text-slate-900 hover:text-amber-600 cursor-pointer transition-colors">
                            {firm.name}
                          </span>
                        </Link>
                        <div className="text-slate-500 text-xs mt-0.5">{firm.slug}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          firm.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-800'
                        }`}>
                          {firm.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-600 capitalize">
                        {firm.subscriptionPlan}
                      </td>
                      <td className="px-6 py-4 text-right text-slate-600">
                        {firm.userCount}
                      </td>
                      <td className="px-6 py-4 text-right text-slate-600">
                        {firm.caseCount}
                      </td>
                    </tr>
                  ))}
                  {firms.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                        No firms found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
