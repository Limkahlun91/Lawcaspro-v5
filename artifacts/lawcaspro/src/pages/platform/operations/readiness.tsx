import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";

function ReadinessBadge({ status }: { status: string }) {
  const cls = (() => {
    if (status === "ready") return "bg-green-50 text-green-700 border border-green-200";
    if (status === "ready_with_warning") return "bg-amber-50 text-amber-800 border border-amber-200";
    if (status === "blocked") return "bg-red-50 text-red-700 border border-red-200";
    return "bg-slate-100 text-slate-700 border border-slate-200";
  })();
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{status || "unknown"}</span>;
}

export default function PlatformOperationsReadiness() {
  const { user } = useAuth();
  const canRead = hasFounderPermission(user, "founder.ops.read");

  const readinessQuery = useQuery({
    queryKey: ["platform-ops-center-readiness"],
    queryFn: async () => {
      return await apiFetchJson(`/platform/operations/readiness?limit=80`);
    },
    enabled: canRead,
    retry: false,
  });

  const items = ((readinessQuery.data as any)?.items ?? []) as any[];

  if (!canRead) {
    return (
      <Card>
        <CardHeader><CardTitle>Recovery Readiness</CardTitle></CardHeader>
        <CardContent className="text-sm text-slate-600">Missing permission: founder.ops.read</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-2xl font-bold text-slate-900">Recovery Readiness</div>
          <div className="text-sm text-slate-600">Is a firm ready for safe restore / rollback?</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link href="/platform/operations"><a className="text-amber-700 hover:underline">Overview</a></Link>
          <span className="text-slate-400">·</span>
          <Link href="/platform/operations/recommendations"><a className="text-amber-700 hover:underline">Recommendations</a></Link>
          <Button variant="outline" onClick={() => readinessQuery.refetch()} disabled={readinessQuery.isFetching}>Refresh</Button>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Readiness Matrix</CardTitle></CardHeader>
        <CardContent>
          {readinessQuery.isError ? (
            <QueryFallback title="Readiness unavailable" error={readinessQuery.error} onRetry={() => readinessQuery.refetch()} isRetrying={readinessQuery.isFetching} />
          ) : readinessQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-10 text-center">Loading readiness...</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No data.</div>
          ) : (
            <div className="rounded border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 sticky top-0">
                  <tr className="text-left">
                    <th className="px-3 py-2">Firm</th>
                    <th className="px-3 py-2">Readiness</th>
                    <th className="px-3 py-2">Latest snapshot</th>
                    <th className="px-3 py-2">Valid snapshot</th>
                    <th className="px-3 py-2">Lock</th>
                    <th className="px-3 py-2">Blockers</th>
                    <th className="px-3 py-2">Quick actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r: any) => (
                    <tr key={String(r.firm_id)} className="border-t">
                      <td className="px-3 py-2">
                        <Link href={`/platform/firms/${String(r.firm_id)}`}><a className="text-amber-700 hover:underline">#{String(r.firm_id)}</a></Link>
                        <div className="text-xs text-slate-500">{String(r.firm_name ?? "")}</div>
                      </td>
                      <td className="px-3 py-2">
                        <ReadinessBadge status={String(r.readiness ?? "unknown")} />
                        <div className="text-xs text-slate-500 mt-1">{String(r.warnings_count ?? 0)} warnings · {String(r.critical_blockers_count ?? 0)} blockers</div>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600 font-mono">
                        {r.latest_snapshot_at ? new Date(String(r.latest_snapshot_at)).toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.latest_successful_snapshot?.id ? (
                          <div className="font-mono">{String(r.latest_successful_snapshot.id).slice(0, 8)}</div>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <Badge variant="outline" className="text-xs">{r.lock_free ? "free" : "locked"}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="flex items-center gap-1 flex-wrap">
                          {(r.blockers ?? []).slice(0, 3).map((b: any) => <Badge key={String(b)} variant="outline" className="text-xs">{String(b)}</Badge>)}
                          {(r.warnings ?? []).slice(0, 2).map((w: any) => <Badge key={String(w)} variant="outline" className="text-xs">{String(w)}</Badge>)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <Link href={`/platform/firms/${String(r.firm_id)}?tab=snapshots`}><a className="text-amber-700 hover:underline">Snapshots</a></Link>
                          <Link href={`/platform/firms/${String(r.firm_id)}?tab=history`}><a className="text-amber-700 hover:underline">History</a></Link>
                        </div>
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

