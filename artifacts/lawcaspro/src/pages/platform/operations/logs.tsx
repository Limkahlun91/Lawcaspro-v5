import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { useAuth } from "@/lib/auth-context";

type Category = "" | "maintenance" | "governance" | "safety" | "system" | "incident";
type Severity = "" | "low" | "medium" | "high" | "critical";
type Status = "" | "success" | "failed" | "blocked" | "pending";

function StatusPill({ status }: { status: string }) {
  const cls = (() => {
    if (status === "success") return "bg-green-50 text-green-700 border border-green-200";
    if (status === "failed") return "bg-red-50 text-red-700 border border-red-200";
    if (status === "blocked") return "bg-amber-50 text-amber-800 border border-amber-200";
    return "bg-slate-100 text-slate-700 border border-slate-200";
  })();
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{status || "—"}</span>;
}

export default function PlatformOperationsLogs() {
  const { user } = useAuth();
  const canRead = hasFounderPermission(user, "founder.ops.read");

  const [category, setCategory] = useState<Category>("");
  const [severity, setSeverity] = useState<Severity>("");
  const [riskLevel, setRiskLevel] = useState<Severity>("");
  const [status, setStatus] = useState<Status>("");
  const [firmId, setFirmId] = useState("");
  const [moduleCode, setModuleCode] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [q, setQ] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);

  const [selected, setSelected] = useState<{ kind: string; id: string; raw: any } | null>(null);

  const queryKey = useMemo(() => ({
    category,
    severity,
    riskLevel,
    status,
    firmId: firmId.trim(),
    moduleCode: moduleCode.trim(),
    actorUserId: actorUserId.trim(),
    q: q.trim(),
    before,
  }), [actorUserId, before, category, firmId, moduleCode, q, riskLevel, severity, status]);

  const logsQuery = useQuery({
    queryKey: ["platform-ops-center-logs", queryKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (category) params.set("event_category", category);
      if (severity) params.set("severity", severity);
      if (riskLevel) params.set("risk_level", riskLevel);
      if (status) params.set("status", status);
      if (firmId.trim()) params.set("firm_id", firmId.trim());
      if (moduleCode.trim()) params.set("module_code", moduleCode.trim());
      if (actorUserId.trim()) params.set("actor_user_id", actorUserId.trim());
      if (q.trim()) params.set("q", q.trim());
      if (before) params.set("before", before);
      return await apiFetchJson(`/platform/operations/logs?${params.toString()}`);
    },
    enabled: canRead,
    retry: false,
  });

  useEffect(() => {
    if (!logsQuery.data) return;
    const next = (logsQuery.data as any)?.items ?? [];
    setItems((prev) => {
      const base = before ? prev : [];
      const seen = new Set(base.map((it: any) => String(it.id)));
      const merged = [...base];
      for (const it of next) {
        const id = String(it.id);
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(it);
      }
      return merged;
    });
  }, [before, logsQuery.data]);

  const pageInfo = (logsQuery.data as any)?.page_info ?? null;

  const detailQuery = useQuery({
    queryKey: ["platform-ops-center-operation-detail", selected?.kind, selected?.id],
    queryFn: async () => {
      if (!selected) return null;
      if (selected.kind === "audit") return { kind: "audit", item: selected.raw };
      return await apiFetchJson(`/platform/operations/operations/${encodeURIComponent(selected.kind)}/${encodeURIComponent(selected.id)}`);
    },
    enabled: !!selected,
    retry: false,
  });

  if (!canRead) {
    return (
      <Card>
        <CardHeader><CardTitle>Operations Log</CardTitle></CardHeader>
        <CardContent className="text-sm text-slate-600">Missing permission: founder.ops.read</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-2xl font-bold text-slate-900">Operations Log</div>
          <div className="text-sm text-slate-600">Maintenance / restore / approvals unified view.</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link href="/platform/operations"><a className="text-amber-700 hover:underline">Overview</a></Link>
          <span className="text-slate-400">·</span>
          <Link href="/platform/operations/incidents"><a className="text-amber-700 hover:underline">Incidents</a></Link>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Filters</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { setBefore(null); setItems([]); logsQuery.refetch(); }} disabled={logsQuery.isFetching}>Apply</Button>
            <Button variant="outline" onClick={() => {
              setCategory("");
              setSeverity("");
              setRiskLevel("");
              setStatus("");
              setFirmId("");
              setModuleCode("");
              setActorUserId("");
              setQ("");
              setBefore(null);
              setItems([]);
            }} disabled={logsQuery.isFetching}>Reset</Button>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
            <SelectTrigger><SelectValue placeholder="Category" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="maintenance">Maintenance</SelectItem>
              <SelectItem value="governance">Governance</SelectItem>
              <SelectItem value="safety">Safety</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="incident">Incident</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
            <SelectTrigger><SelectValue placeholder="Severity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
          <Select value={riskLevel} onValueChange={(v) => setRiskLevel(v as Severity)}>
            <SelectTrigger><SelectValue placeholder="Risk level" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
            <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Input value={firmId} onChange={(e) => setFirmId(e.target.value)} placeholder="Firm id" />
          <Input value={moduleCode} onChange={(e) => setModuleCode(e.target.value)} placeholder="Module code" />
          <Input value={actorUserId} onChange={(e) => setActorUserId(e.target.value)} placeholder="Actor user id" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Keyword search" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Log</CardTitle></CardHeader>
        <CardContent>
          {logsQuery.isError ? (
            <QueryFallback title="Logs unavailable" error={logsQuery.error} onRetry={() => logsQuery.refetch()} isRetrying={logsQuery.isFetching} />
          ) : logsQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-10 text-center">Loading logs...</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No logs.</div>
          ) : (
            <div className="rounded border border-slate-200 overflow-x-auto overflow-y-hidden">
              <table className="w-full text-sm min-w-[900px]">
                <thead className="bg-slate-50 sticky top-0">
                  <tr className="text-left">
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Event</th>
                    <th className="px-3 py-2">Firm</th>
                    <th className="px-3 py-2">Module/Target</th>
                    <th className="px-3 py-2">Risk</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it: any) => {
                    const id = String(it.id ?? "");
                    const kind = id.includes(":") ? id.split(":")[0] : "";
                    const opId = id.includes(":") ? id.split(":")[1] : "";
                    const time = it.created_at ? new Date(String(it.created_at)).toLocaleString() : "—";
                    return (
                      <tr key={id} className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => setSelected({ kind, id: opId, raw: it })}>
                        <td className="px-3 py-2 text-xs text-slate-600 font-mono">{time}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className="text-xs">{String(it.event_category)}</Badge>
                            <span className="font-mono text-xs">{String(it.event_code)}</span>
                            {it.emergency_flag ? <Badge variant="outline" className="text-xs">emergency</Badge> : null}
                            {it.impersonation_flag ? <Badge variant="outline" className="text-xs">impersonation</Badge> : null}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">{String(it.summary ?? "")}</div>
                        </td>
                        <td className="px-3 py-2">
                          {it.firm_id ? (
                            <Link href={`/platform/firms/${String(it.firm_id)}`}><a className="text-amber-700 hover:underline">#{String(it.firm_id)}</a></Link>
                          ) : "—"}
                          <div className="text-xs text-slate-500">{String(it.firm_name ?? "")}</div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div className="font-mono">{String(it.module_code ?? "—")}</div>
                          <div className="text-slate-500">{String(it.entity_type ?? "")}{it.entity_id ? `:${String(it.entity_id)}` : ""}</div>
                        </td>
                        <td className="px-3 py-2 text-xs">{String(it.risk_level ?? "—")}</td>
                        <td className="px-3 py-2"><StatusPill status={String(it.status ?? "")} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex items-center justify-center">
            <Button
              variant="outline"
              onClick={() => {
                const next = pageInfo?.next_before ?? null;
                if (next) setBefore(String(next));
              }}
              disabled={!pageInfo?.has_more || logsQuery.isFetching}
            >
              {logsQuery.isFetching ? "Loading..." : pageInfo?.has_more ? "Load more" : "No more"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Operation Detail</DialogTitle>
          </DialogHeader>
          {detailQuery.isError ? (
            <QueryFallback title="Detail unavailable" error={detailQuery.error} onRetry={() => detailQuery.refetch()} isRetrying={detailQuery.isFetching} />
          ) : detailQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading detail...</div>
          ) : detailQuery.data ? (
            <div className="space-y-3">
              <div className="text-xs text-slate-500 font-mono">{selected?.kind}:{selected?.id}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Summary</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-slate-700 space-y-2">
                    <div>Kind: <span className="font-mono">{String((detailQuery.data as any)?.kind ?? "")}</span></div>
                    <div>Firm: {(() => {
                      const firmId = (detailQuery.data as any)?.action?.firmId ?? (detailQuery.data as any)?.item?.firmId ?? null;
                      return firmId ? <Link href={`/platform/firms/${String(firmId)}`}><a className="text-amber-700 hover:underline">#{String(firmId)}</a></Link> : "—";
                    })()}</div>
                    <div>Status: <StatusPill status={String((detailQuery.data as any)?.action?.status ?? (detailQuery.data as any)?.item?.status ?? "")} /></div>
                    <div>Risk: <Badge variant="outline" className="text-xs">{String((detailQuery.data as any)?.action?.riskLevel ?? (detailQuery.data as any)?.item?.riskLevel ?? "—")}</Badge></div>
                    <div>Action: <Badge variant="outline" className="text-xs">{String((detailQuery.data as any)?.action?.actionCode ?? (detailQuery.data as any)?.action?.operationCode ?? (detailQuery.data as any)?.item?.actionCode ?? "—")}</Badge></div>
                    <div>Target: <span className="font-mono">{String((detailQuery.data as any)?.action?.targetEntityType ?? (detailQuery.data as any)?.item?.targetEntityType ?? "—")}{(detailQuery.data as any)?.action?.targetEntityId ? `:${String((detailQuery.data as any)?.action?.targetEntityId)}` : ""}</span></div>
                    <div>Snapshot: <span className="font-mono">{String((detailQuery.data as any)?.action?.snapshotId ?? (detailQuery.data as any)?.item?.snapshotId ?? (detailQuery.data as any)?.action?.preActionSnapshotId ?? "—").slice(0, 8)}</span></div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Timeline</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="text-xs text-slate-500">Steps</div>
                    {Array.isArray((detailQuery.data as any)?.steps) && (detailQuery.data as any).steps.length ? (
                      <div className="rounded border border-slate-200 divide-y">
                        {(detailQuery.data as any).steps.map((s: any) => (
                          <div key={String(s.id)} className="p-2 text-xs flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-mono text-slate-900">{String(s.stepCode ?? s.step_code ?? "")}</div>
                              <div className="text-slate-500">started {s.startedAt ? new Date(String(s.startedAt)).toLocaleString() : "—"} · done {s.completedAt ? new Date(String(s.completedAt)).toLocaleString() : "—"}</div>
                              {s.errorMessage || s.error_message ? <div className="text-red-700 whitespace-pre-wrap break-words mt-1">{String(s.errorMessage ?? s.error_message)}</div> : null}
                            </div>
                            <Badge variant="outline" className="text-xs">{String(s.status ?? "")}</Badge>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">No steps</div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {(detailQuery.data as any)?.approval ? (
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Approval</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-slate-700">
                    <pre className="text-xs whitespace-pre-wrap break-words text-slate-700 rounded border border-slate-200 bg-slate-50 p-3">{JSON.stringify((detailQuery.data as any).approval, null, 2)}</pre>
                  </CardContent>
                </Card>
              ) : null}

              {Array.isArray((detailQuery.data as any)?.audit) && (detailQuery.data as any).audit.length ? (
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Audit Trail</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="rounded border border-slate-200 divide-y">
                      {(detailQuery.data as any).audit.map((a: any) => (
                        <div key={String(a.id)} className="p-2 text-xs">
                          <div className="text-slate-900">{String(a.action ?? "")}</div>
                          <div className="text-slate-500">by {String(a.actorId ?? a.actor_id ?? "—")} · {a.createdAt ? new Date(String(a.createdAt)).toLocaleString() : "—"}</div>
                          {a.detail ? <div className="mt-1 whitespace-pre-wrap break-words text-slate-700">{String(a.detail)}</div> : null}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Raw JSON</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs whitespace-pre-wrap break-words text-slate-700 rounded border border-slate-200 bg-slate-50 p-3">{JSON.stringify(detailQuery.data, null, 2)}</pre>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
