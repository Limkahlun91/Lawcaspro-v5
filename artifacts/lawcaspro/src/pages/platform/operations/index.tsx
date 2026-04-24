import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { useAuth } from "@/lib/auth-context";

type Range = "24h" | "7d" | "30d";

function KpiCard({ title, value }: { title: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-slate-500">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-slate-900">{value}</div>
      </CardContent>
    </Card>
  );
}

export default function PlatformOperationsOverview() {
  const { user } = useAuth();
  const canRead = hasFounderPermission(user, "founder.ops.read");
  const [range, setRange] = useState<Range>("7d");

  const overviewQuery = useQuery({
    queryKey: ["platform-ops-center-overview", range],
    queryFn: async () => {
      return await apiFetchJson(`/platform/operations/overview?range=${range}`);
    },
    enabled: canRead,
    retry: false,
  });

  const kpi = (overviewQuery.data as any)?.kpi ?? null;
  const trends = (overviewQuery.data as any)?.trends ?? null;
  const riskLists = (overviewQuery.data as any)?.risk_lists ?? null;

  const opsByDay = useMemo(() => {
    const rows = trends?.operations_by_day ?? [];
    return Array.isArray(rows) ? rows : [];
  }, [trends]);
  const incidentsByDay = useMemo(() => {
    const rows = trends?.incidents_by_day ?? [];
    return Array.isArray(rows) ? rows : [];
  }, [trends]);

  if (!canRead) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Operations Center</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-600">Missing permission: founder.ops.read</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-2xl font-bold text-slate-900">Founder Operations Center</div>
          <div className="text-sm text-slate-600">Incidents, operations log, recommendations, readiness, and pending queue.</div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={(v) => setRange(v as Range)}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">24h</SelectItem>
              <SelectItem value="7d">7d</SelectItem>
              <SelectItem value="30d">30d</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => overviewQuery.refetch()} disabled={overviewQuery.isFetching}>
            Refresh
          </Button>
        </div>
      </div>

      {overviewQuery.isError ? (
        <QueryFallback title="Overview unavailable" error={overviewQuery.error} onRetry={() => overviewQuery.refetch()} isRetrying={overviewQuery.isFetching} />
      ) : overviewQuery.isLoading ? (
        <div className="text-sm text-slate-500 py-10 text-center">Loading overview...</div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <KpiCard title="Total operations" value={kpi?.total_operations ?? "—"} />
            <KpiCard title="Failed operations" value={kpi?.failed_operations ?? "—"} />
            <KpiCard title="Open incidents" value={kpi?.open_incidents ?? "—"} />
            <KpiCard title="Critical incidents" value={kpi?.critical_incidents ?? "—"} />
            <KpiCard title="Pending approvals" value={kpi?.pending_approvals ?? "—"} />
            <KpiCard title="Pending recoveries" value={kpi?.pending_recoveries ?? "—"} />
            <KpiCard title="High-risk actions" value={kpi?.high_risk_actions ?? "—"} />
            <KpiCard title="Restore-ready firms" value={kpi?.restore_ready_firms ?? "—"} />
            <KpiCard title="No valid snapshot" value={kpi?.firms_with_no_valid_snapshot ?? "—"} />
            <KpiCard title="Emergency overrides (7d)" value={kpi?.emergency_overrides_7d ?? "—"} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Trends</CardTitle>
                <div className="flex items-center gap-2 text-sm">
                  <Link href="/platform/operations/logs"><a className="text-amber-700 hover:underline">Logs</a></Link>
                  <span className="text-slate-400">·</span>
                  <Link href="/platform/operations/incidents"><a className="text-amber-700 hover:underline">Incidents</a></Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Operations by day</div>
                  <div className="rounded border border-slate-200 overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr className="text-left">
                          <th className="px-3 py-2">Day</th>
                          <th className="px-3 py-2">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(opsByDay ?? []).slice(-14).map((r: any) => (
                          <tr key={String(r.day)} className="border-t">
                            <td className="px-3 py-2 font-mono">{String(r.day)}</td>
                            <td className="px-3 py-2">{String(r.c)}</td>
                          </tr>
                        ))}
                        {(opsByDay ?? []).length === 0 ? (
                          <tr><td className="px-3 py-4 text-slate-500" colSpan={2}>No data</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Incidents by day</div>
                  <div className="rounded border border-slate-200 overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr className="text-left">
                          <th className="px-3 py-2">Day</th>
                          <th className="px-3 py-2">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(incidentsByDay ?? []).slice(-14).map((r: any) => (
                          <tr key={String(r.day)} className="border-t">
                            <td className="px-3 py-2 font-mono">{String(r.day)}</td>
                            <td className="px-3 py-2">{String(r.c)}</td>
                          </tr>
                        ))}
                        {(incidentsByDay ?? []).length === 0 ? (
                          <tr><td className="px-3 py-4 text-slate-500" colSpan={2}>No data</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Risk Lists</CardTitle>
                <div className="flex items-center gap-2 text-sm">
                  <Link href="/platform/operations/readiness"><a className="text-amber-700 hover:underline">Readiness</a></Link>
                  <span className="text-slate-400">·</span>
                  <Link href="/platform/operations/pending"><a className="text-amber-700 hover:underline">Pending</a></Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Top failing firms</div>
                  <div className="rounded border border-slate-200 overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr className="text-left">
                          <th className="px-3 py-2">Firm</th>
                          <th className="px-3 py-2">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {((riskLists?.top_failing_firms ?? []) as any[]).map((r: any) => (
                          <tr key={String(r.firm_id)} className="border-t">
                            <td className="px-3 py-2">
                              <Link href={`/platform/firms/${String(r.firm_id)}`}><a className="text-amber-700 hover:underline">Firm #{String(r.firm_id)}</a></Link>
                            </td>
                            <td className="px-3 py-2">{String(r.c)}</td>
                          </tr>
                        ))}
                        {((riskLists?.top_failing_firms ?? []) as any[]).length === 0 ? (
                          <tr><td className="px-3 py-4 text-slate-500" colSpan={2}>No data</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Top failing modules</div>
                  <div className="rounded border border-slate-200 overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr className="text-left">
                          <th className="px-3 py-2">Module</th>
                          <th className="px-3 py-2">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {((riskLists?.top_failing_modules ?? []) as any[]).map((r: any, idx: number) => (
                          <tr key={`${String(r.module_code)}:${idx}`} className="border-t">
                            <td className="px-3 py-2 font-mono">{String(r.module_code)}</td>
                            <td className="px-3 py-2">{String(r.c)}</td>
                          </tr>
                        ))}
                        {((riskLists?.top_failing_modules ?? []) as any[]).length === 0 ? (
                          <tr><td className="px-3 py-4 text-slate-500" colSpan={2}>No data</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

