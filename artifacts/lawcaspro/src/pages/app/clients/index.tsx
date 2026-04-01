import { useListClients } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { useState } from "react";

export default function ClientsList() {
  const [search, setSearch] = useState("");
  
  const { data: response, isLoading } = useListClients({ 
    page: 1, 
    limit: 50,
    search: search || undefined
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Clients</h1>
          <p className="text-slate-500 mt-1">Manage individual and corporate clients</p>
        </div>
        <Link href="/app/clients/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Client
          </Button>
        </Link>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search clients..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading clients...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Name / IC</th>
                    <th className="px-6 py-3 font-semibold">Contact</th>
                    <th className="px-6 py-3 font-semibold">Nationality</th>
                    <th className="px-6 py-3 font-semibold text-right">Cases</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {response?.data.map((client) => (
                    <tr key={client.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <Link href={`/app/clients/${client.id}`}>
                          <span className="font-medium text-slate-900 hover:text-amber-600 cursor-pointer transition-colors">
                            {client.name}
                          </span>
                        </Link>
                        <div className="text-slate-500 text-xs mt-0.5">{client.icNo || "No IC"}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-slate-800">{client.email || "-"}</div>
                        <div className="text-slate-500 text-xs mt-0.5">{client.phone || "-"}</div>
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {client.nationality || "-"}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-slate-600 bg-slate-100 rounded">
                          {client.caseCount}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {response?.data.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-slate-500">
                        No clients found.
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
