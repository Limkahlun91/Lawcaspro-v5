import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Building2, Users, Briefcase, FileText } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { listItems } from "@/lib/list-items";

export default function PlatformMonitoring() {
  const statsQuery = useQuery({
    queryKey: ["platform-stats"],
    queryFn: () => apiFetchJson("/platform/stats"),
    refetchInterval: 30000,
    retry: false,
  });
  const { data: stats, isLoading: statsLoading } = statsQuery;

  const firmsQuery = useQuery<Record<string, unknown>[]>({
    queryKey: ["platform-firms-monitoring"],
    queryFn: async () => listItems<Record<string, unknown>>(await apiFetchJson("/platform/firms?limit=50")),
    retry: false,
  });
  const { data: firmsData, isLoading: firmsLoading } = firmsQuery;

  const firms = firmsData ?? [];
  const isLoading = statsLoading || firmsLoading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Platform Monitoring</h1>
        <p className="text-slate-500 mt-1">System health and tenant resource overview</p>
      </div>

      {isLoading ? (
        <div className="text-slate-500 py-12 text-center">Loading platform data...</div>
      ) : statsQuery.isError || firmsQuery.isError ? (
        <QueryFallback
          title="Platform monitoring unavailable"
          error={statsQuery.error ?? firmsQuery.error}
          onRetry={() => { statsQuery.refetch(); firmsQuery.refetch(); }}
          isRetrying={statsQuery.isFetching || firmsQuery.isFetching}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Firms", value: String((stats as any)?.totalFirms ?? 0), icon: Building2, color: "bg-blue-50 text-blue-600" },
              { label: "Total Users", value: String((stats as any)?.totalUsers ?? 0), icon: Users, color: "bg-amber-50 text-amber-600" },
              { label: "Total Cases", value: String((stats as any)?.totalCases ?? 0), icon: Briefcase, color: "bg-green-50 text-green-600" },
              { label: "Documents Generated", value: String((stats as any)?.totalDocuments ?? 0), icon: FileText, color: "bg-purple-50 text-purple-600" },
            ].map((item) => (
              <Card key={item.label}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.color}`}>
                      <item.icon className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">{item.label}</div>
                      <div className="text-xl font-bold text-slate-900">{item.value}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-green-500" />
                <CardTitle>Tenant Overview</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {firms.length === 0 ? (
                <div className="text-center py-8 text-slate-400">No firms found</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-slate-500 text-left">
                      <th className="py-2 font-medium">Firm</th>
                      <th className="py-2 font-medium">Plan</th>
                      <th className="py-2 font-medium text-right">Users</th>
                      <th className="py-2 font-medium text-right">Cases</th>
                      <th className="py-2 font-medium text-right">Documents</th>
                      <th className="py-2 font-medium text-right">Billing</th>
                      <th className="py-2 font-medium text-right">Comms</th>
                      <th className="py-2 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {firms.map((firm) => (
                      <tr key={String(firm.id)} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="py-3">
                          <div className="font-medium text-slate-900">{String(firm.name)}</div>
                          <div className="text-xs text-slate-400">{String(firm.slug ?? "")}</div>
                        </td>
                        <td className="py-3">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 capitalize font-medium">
                            {String(firm.subscriptionPlan ?? firm.subscription_plan ?? "starter")}
                          </span>
                        </td>
                        <td className="py-3 text-right text-slate-700">{String(firm.user_count ?? 0)}</td>
                        <td className="py-3 text-right text-slate-700">{String(firm.case_count ?? 0)}</td>
                        <td className="py-3 text-right text-slate-700">{String(firm.document_count ?? 0)}</td>
                        <td className="py-3 text-right text-slate-700">{String(firm.billing_entry_count ?? 0)}</td>
                        <td className="py-3 text-right text-slate-700">{String(firm.comm_count ?? 0)}</td>
                        <td className="py-3 text-right">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${firm.status === "active" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
                            {String(firm.status ?? "active")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
