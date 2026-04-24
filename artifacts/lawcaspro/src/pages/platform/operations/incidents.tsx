import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";

type Severity = "" | "low" | "medium" | "high" | "critical";
type Status = "" | "open" | "investigating" | "awaiting-approval" | "awaiting-execution" | "mitigated" | "resolved" | "dismissed";

function SeverityBadge({ sev }: { sev: string }) {
  const cls = (() => {
    if (sev === "critical") return "bg-red-50 text-red-700 border border-red-200";
    if (sev === "high") return "bg-amber-50 text-amber-800 border border-amber-200";
    if (sev === "medium") return "bg-yellow-50 text-yellow-800 border border-yellow-200";
    return "bg-slate-100 text-slate-700 border border-slate-200";
  })();
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{sev || "—"}</span>;
}

export default function PlatformOperationsIncidents() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canRead = hasFounderPermission(user, "founder.ops.read");
  const canRecompute = hasFounderPermission(user, "founder.ops.recommendation.recompute");

  const [status, setStatus] = useState<Status>("open");
  const [severity, setSeverity] = useState<Severity>("");
  const [firmId, setFirmId] = useState("");
  const [moduleCode, setModuleCode] = useState("");
  const [q, setQ] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);

  const filtersKey = useMemo(() => ({
    status,
    severity,
    firmId: firmId.trim(),
    moduleCode: moduleCode.trim(),
    q: q.trim(),
    before,
  }), [before, firmId, moduleCode, q, severity, status]);

  const incidentsQuery = useQuery({
    queryKey: ["platform-ops-center-incidents", filtersKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (status) params.set("status", status);
      if (severity) params.set("severity", severity);
      if (firmId.trim()) params.set("firm_id", firmId.trim());
      if (moduleCode.trim()) params.set("module_code", moduleCode.trim());
      if (q.trim()) params.set("q", q.trim());
      if (before) params.set("before", before);
      return await apiFetchJson(`/platform/operations/incidents?${params.toString()}`);
    },
    enabled: canRead,
    retry: false,
  });

  useEffect(() => {
    if (!incidentsQuery.data) return;
    const next = (incidentsQuery.data as any)?.items ?? [];
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
  }, [before, incidentsQuery.data]);

  const pageInfo = (incidentsQuery.data as any)?.page_info ?? null;

  const recomputeMutation = useMutation({
    mutationFn: async () => {
      return await apiFetchJson(`/platform/operations/incidents/recompute?days=30&limit=200`, { method: "POST" });
    },
    onSuccess: async () => {
      toast({ title: "Recomputed incidents" });
      setBefore(null);
      setItems([]);
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incidents"] });
    },
    onError: (e) => toastError(toast, e, "Recompute failed"),
  });

  if (!canRead) {
    return (
      <Card>
        <CardHeader><CardTitle>Incident Center</CardTitle></CardHeader>
        <CardContent className="text-sm text-slate-600">Missing permission: founder.ops.read</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-2xl font-bold text-slate-900">Incident Center</div>
          <div className="text-sm text-slate-600">Aggregated failures, blocks, and governance issues.</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link href="/platform/operations"><a className="text-amber-700 hover:underline">Overview</a></Link>
          <span className="text-slate-400">·</span>
          <Link href="/platform/operations/logs"><a className="text-amber-700 hover:underline">Logs</a></Link>
          {canRecompute ? (
            <>
              <span className="text-slate-400">·</span>
              <Button variant="outline" onClick={() => recomputeMutation.mutate()} disabled={recomputeMutation.isPending}>
                {recomputeMutation.isPending ? "Recomputing..." : "Recompute"}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Filters</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { setBefore(null); setItems([]); incidentsQuery.refetch(); }} disabled={incidentsQuery.isFetching}>Apply</Button>
            <Button variant="outline" onClick={() => { setStatus("open"); setSeverity(""); setFirmId(""); setModuleCode(""); setQ(""); setBefore(null); setItems([]); }} disabled={incidentsQuery.isFetching}>Reset</Button>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
            <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="investigating">Investigating</SelectItem>
              <SelectItem value="awaiting-approval">Awaiting approval</SelectItem>
              <SelectItem value="awaiting-execution">Awaiting execution</SelectItem>
              <SelectItem value="mitigated">Mitigated</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
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
          <Input value={firmId} onChange={(e) => setFirmId(e.target.value)} placeholder="Firm id" />
          <Input value={moduleCode} onChange={(e) => setModuleCode(e.target.value)} placeholder="Module code" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Keyword" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Incidents</CardTitle></CardHeader>
        <CardContent>
          {incidentsQuery.isError ? (
            <QueryFallback title="Incidents unavailable" error={incidentsQuery.error} onRetry={() => incidentsQuery.refetch()} isRetrying={incidentsQuery.isFetching} />
          ) : incidentsQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-10 text-center">Loading incidents...</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No incidents.</div>
          ) : (
            <div className="rounded border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 sticky top-0">
                  <tr className="text-left">
                    <th className="px-3 py-2">Detected</th>
                    <th className="px-3 py-2">Incident</th>
                    <th className="px-3 py-2">Firm</th>
                    <th className="px-3 py-2">Module</th>
                    <th className="px-3 py-2">Severity</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it: any) => (
                    <tr key={String(it.id)} className="border-t hover:bg-slate-50">
                      <td className="px-3 py-2 text-xs text-slate-600 font-mono">{it.detectedAt ? new Date(String(it.detectedAt)).toLocaleString() : "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link href={`/platform/operations/incidents/${String(it.id)}`}><a className="text-amber-700 hover:underline font-medium">{String(it.incidentCode ?? String(it.id).slice(0, 8))}</a></Link>
                          <Badge variant="outline" className="text-xs">{String(it.incidentType)}</Badge>
                        </div>
                        <div className="text-xs text-slate-600 mt-1">{String(it.title)}</div>
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/platform/firms/${String(it.firmId)}`}><a className="text-amber-700 hover:underline">#{String(it.firmId)}</a></Link>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">{String(it.moduleCode ?? "—")}</td>
                      <td className="px-3 py-2"><SeverityBadge sev={String(it.severity)} /></td>
                      <td className="px-3 py-2 text-xs">{String(it.status)}</td>
                    </tr>
                  ))}
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
              disabled={!pageInfo?.has_more || incidentsQuery.isFetching}
            >
              {incidentsQuery.isFetching ? "Loading..." : pageInfo?.has_more ? "Load more" : "No more"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

