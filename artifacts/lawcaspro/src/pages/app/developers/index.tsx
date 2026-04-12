import { useListDevelopers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { QueryFallback } from "@/components/query-fallback";

export default function DevelopersList() {
  const [search, setSearch] = useState("");
  
  const { data: response, isLoading, isError, error, refetch, isFetching } = useListDevelopers({ 
    page: 1, 
    limit: 50,
    search: search || undefined
  });
  const developers = response?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Developers</h1>
          <p className="text-slate-500 mt-1">Manage property developers</p>
        </div>
        <Link href="/app/developers/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Developer
          </Button>
        </Link>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search developers..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading developers...</div>
          ) : isError ? (
            <div className="p-6">
              <QueryFallback title="Developers unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Name</th>
                    <th className="px-6 py-3 font-semibold">Reg No</th>
                    <th className="px-6 py-3 font-semibold">Contact Person</th>
                    <th className="px-6 py-3 font-semibold text-right">Projects</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {developers.map((dev) => (
                    <tr key={dev.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <Link href={`/app/developers/${dev.id}`}>
                          <span className="font-medium text-slate-900 hover:text-amber-600 cursor-pointer transition-colors">
                            {dev.name}
                          </span>
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {dev.companyRegNo || "-"}
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {dev.contactPerson || "-"}
                        {dev.phone && <div className="text-xs text-slate-400 mt-0.5">{dev.phone}</div>}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-slate-600 bg-slate-100 rounded">
                          {dev.projectCount}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {developers.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-slate-500">
                        No developers found.
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
