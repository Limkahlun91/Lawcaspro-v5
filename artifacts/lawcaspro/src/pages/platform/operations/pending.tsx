import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { ensureArray } from "@/lib/list-items";

export default function PlatformOperationsPending() {
  const { user } = useAuth();
  const canRead = hasFounderPermission(user, "founder.ops.read");

  const pendingQuery = useQuery({
    queryKey: ["platform-ops-center-pending"],
    queryFn: async () => {
      return await apiFetchJson(`/platform/operations/pending?limit=50`);
    },
    enabled: canRead,
    retry: false,
  });

  const approvalsRequested = useMemo(() => ensureArray<any>((pendingQuery.data as any)?.approvals?.requested), [pendingQuery.data]);
  const approvalsApproved = useMemo(() => ensureArray<any>((pendingQuery.data as any)?.approvals?.approved), [pendingQuery.data]);
  const maint = useMemo(() => ensureArray<any>((pendingQuery.data as any)?.operations?.maintenance), [pendingQuery.data]);
  const restore = useMemo(() => ensureArray<any>((pendingQuery.data as any)?.operations?.restore), [pendingQuery.data]);
  const cooldown = useMemo(() => ensureArray<any>((pendingQuery.data as any)?.cooldown), [pendingQuery.data]);

  if (!canRead) {
    return (
      <Card>
        <CardHeader><CardTitle>Pending Actions</CardTitle></CardHeader>
        <CardContent className="text-sm text-slate-600">Missing permission: founder.ops.read</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-2xl font-bold text-slate-900">Pending Actions</div>
          <div className="text-sm text-slate-600">Approvals, queued operations, cooldown windows.</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link href="/platform/operations"><a className="text-amber-700 hover:underline">Overview</a></Link>
          <span className="text-slate-400">·</span>
          <Link href="/platform/operations/incidents"><a className="text-amber-700 hover:underline">Incidents</a></Link>
          <Button variant="outline" onClick={() => pendingQuery.refetch()} disabled={pendingQuery.isFetching}>Refresh</Button>
        </div>
      </div>

      {pendingQuery.isError ? (
        <QueryFallback title="Pending unavailable" error={pendingQuery.error} onRetry={() => pendingQuery.refetch()} isRetrying={pendingQuery.isFetching} />
      ) : pendingQuery.isLoading ? (
        <div className="text-sm text-slate-500 py-10 text-center">Loading pending...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle>Approvals (Requested)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(approvalsRequested as any[]).length === 0 ? <div className="text-sm text-slate-500">None.</div> : (
                <div className="rounded border border-slate-200 divide-y">
                  {(approvalsRequested as any[]).slice(0, 20).map((a: any) => (
                    <div key={String(a.id)} className="p-2 text-sm">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="font-mono text-xs">{String(a.requestCode ?? "").trim() || String(a.id).slice(0, 8)}</div>
                          <div className="text-xs text-slate-600">{String(a.actionCode ?? "")} · risk {String(a.riskLevel ?? "")}</div>
                          <div className="text-xs text-slate-500">firm #{String(a.firmId)}</div>
                        </div>
                        <Link href={`/platform/operations/logs`}><a className="text-amber-700 hover:underline text-xs">open logs</a></Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Approvals (Approved)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(approvalsApproved as any[]).length === 0 ? <div className="text-sm text-slate-500">None.</div> : (
                <div className="rounded border border-slate-200 divide-y">
                  {(approvalsApproved as any[]).slice(0, 20).map((a: any) => (
                    <div key={String(a.id)} className="p-2 text-sm">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="font-mono text-xs">{String(a.requestCode ?? "").trim() || String(a.id).slice(0, 8)}</div>
                          <div className="text-xs text-slate-600">{String(a.actionCode ?? "")} · risk {String(a.riskLevel ?? "")}</div>
                          <div className="text-xs text-slate-500">firm #{String(a.firmId)}</div>
                        </div>
                        <Badge variant="outline" className="text-xs">approved</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Operations (Maintenance)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(maint as any[]).length === 0 ? <div className="text-sm text-slate-500">None.</div> : (
                <div className="rounded border border-slate-200 divide-y">
                  {(maint as any[]).slice(0, 20).map((a: any) => (
                    <div key={String(a.id)} className="p-2 text-sm">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="text-xs text-slate-600">{String(a.actionCode ?? "")} · {String(a.status ?? "")}</div>
                          <div className="text-xs text-slate-500">firm #{String(a.firmId)} · risk {String(a.riskLevel ?? "")}</div>
                        </div>
                        <Link href={`/platform/firms/${String(a.firmId)}?tab=maintenance`}><a className="text-amber-700 hover:underline text-xs">open</a></Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Operations (Restore/Rollback)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(restore as any[]).length === 0 ? <div className="text-sm text-slate-500">None.</div> : (
                <div className="rounded border border-slate-200 divide-y">
                  {(restore as any[]).slice(0, 20).map((a: any) => (
                    <div key={String(a.id)} className="p-2 text-sm">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="text-xs text-slate-600">{String(a.operationCode ?? "")} · {String(a.status ?? "")}</div>
                          <div className="text-xs text-slate-500">firm #{String(a.firmId)} · risk {String(a.riskLevel ?? "")}</div>
                        </div>
                        <Link href={`/platform/firms/${String(a.firmId)}?tab=snapshots`}><a className="text-amber-700 hover:underline text-xs">open</a></Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader><CardTitle>Cooldown / Step-up Not Before</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(cooldown as any[]).length === 0 ? <div className="text-sm text-slate-500">None.</div> : (
                <div className="rounded border border-slate-200 divide-y">
                  {(cooldown as any[]).slice(0, 20).map((c: any) => (
                    <div key={String(c.id)} className="p-2 text-sm">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="text-xs text-slate-600 font-mono">{String(c.id).slice(0, 8)}</div>
                          <div className="text-xs text-slate-500">firm #{String(c.firmId)} · not before {c.notBeforeAt ? new Date(String(c.notBeforeAt)).toLocaleString() : "—"}</div>
                        </div>
                        <Badge variant="outline" className="text-xs">cooldown</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

