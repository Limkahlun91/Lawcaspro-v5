import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";

type SnapshotType = "firm" | "module" | "settings" | "record";
type ScopeType = "firm" | "module" | "settings" | "record";

function SeverityBadge({ sev }: { sev: string }) {
  const cls = (() => {
    if (sev === "critical") return "bg-red-50 text-red-700 border border-red-200";
    if (sev === "high") return "bg-amber-50 text-amber-800 border border-amber-200";
    if (sev === "medium") return "bg-yellow-50 text-yellow-800 border border-yellow-200";
    return "bg-slate-100 text-slate-700 border border-slate-200";
  })();
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{sev || "—"}</span>;
}

export default function PlatformOperationsRecommendations() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canRead = hasFounderPermission(user, "founder.ops.read");
  const canCreateSnapshot = hasFounderPermission(user, "founder.snapshot.create");

  const [createOpen, setCreateOpen] = useState(false);
  const [createFirmId, setCreateFirmId] = useState<number | null>(null);
  const [snapshotType, setSnapshotType] = useState<SnapshotType>("firm");
  const [scopeType, setScopeType] = useState<ScopeType>("firm");
  const [reason, setReason] = useState("");

  const recsQuery = useQuery({
    queryKey: ["platform-ops-center-recommendations"],
    queryFn: async () => {
      return await apiFetchJson(`/platform/operations/recommendations?limit=50`);
    },
    enabled: canRead,
    retry: false,
  });

  const items = useMemo(() => {
    const rows = (recsQuery.data as any)?.items ?? [];
    return Array.isArray(rows) ? rows : [];
  }, [recsQuery.data]);

  const createSnapshotMutation = useMutation({
    mutationFn: async () => {
      if (!createFirmId) throw new Error("Missing firm id");
      const body = {
        snapshot_type: snapshotType,
        scope_type: scopeType,
        trigger_type: "manual",
        reason: reason.trim(),
        note: "created_from_ops_center",
      };
      return await apiFetchJson(`/platform/firms/${createFirmId}/snapshots`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      toast({ title: "Snapshot created" });
      setCreateOpen(false);
      setCreateFirmId(null);
      setReason("");
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-recommendations"] });
    },
    onError: (e) => toastError(toast, e, "Create snapshot failed"),
  });

  if (!canRead) {
    return (
      <Card>
        <CardHeader><CardTitle>Recommendations</CardTitle></CardHeader>
        <CardContent className="text-sm text-slate-600">Missing permission: founder.ops.read</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-2xl font-bold text-slate-900">Repair Recommendations</div>
          <div className="text-sm text-slate-600">Rule-based suggestions derived from incidents + readiness.</div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link href="/platform/operations"><a className="text-amber-700 hover:underline">Overview</a></Link>
          <span className="text-slate-400">·</span>
          <Link href="/platform/operations/incidents"><a className="text-amber-700 hover:underline">Incidents</a></Link>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recommendations</CardTitle>
          <Button variant="outline" onClick={() => recsQuery.refetch()} disabled={recsQuery.isFetching}>Refresh</Button>
        </CardHeader>
        <CardContent>
          {recsQuery.isError ? (
            <QueryFallback title="Recommendations unavailable" error={recsQuery.error} onRetry={() => recsQuery.refetch()} isRetrying={recsQuery.isFetching} />
          ) : recsQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-10 text-center">Loading recommendations...</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No recommendations.</div>
          ) : (
            <div className="rounded border border-slate-200 divide-y">
              {items.map((row: any, idx: number) => {
                const rec = row.recommendation ?? null;
                const inc = row.incident ?? null;
                const firmId = rec?.applies_to_scope?.firm_id ?? inc?.firmId ?? null;
                const canExecute = !!rec?.can_execute_directly && rec?.recommendation_code === "create_snapshot_first" && canCreateSnapshot && Number.isFinite(Number(firmId));
                return (
                  <div key={`${String(rec?.recommendation_code ?? "rec")}:${String(inc?.id ?? idx)}`} className="p-3">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-slate-900">{String(rec?.title ?? "Recommendation")}</span>
                          <SeverityBadge sev={String(rec?.severity ?? "low")} />
                          <Badge variant="outline" className="text-xs">{String(rec?.confidence_level ?? "low")}</Badge>
                          <span className="font-mono text-xs text-slate-500">{String(rec?.recommendation_code ?? "")}</span>
                          {inc?.incidentCode ? <Badge variant="outline" className="text-xs">incident:{String(inc.incidentCode)}</Badge> : null}
                        </div>
                        <div className="text-xs text-slate-600 mt-1">{String(rec?.reason ?? "")}</div>
                        <div className="text-xs text-slate-500 mt-1">{String(rec?.recommended_next_action ?? "")}</div>
                        <div className="text-xs text-slate-500 mt-2">
                          Scope: {firmId ? <span className="font-mono">firm:{String(firmId)}</span> : "—"}
                          {rec?.applies_to_scope?.module_code ? <span className="font-mono"> · module:{String(rec.applies_to_scope.module_code)}</span> : null}
                          {rec?.applies_to_scope?.entity_type ? <span className="font-mono"> · {String(rec.applies_to_scope.entity_type)}:{String(rec.applies_to_scope.entity_id ?? "")}</span> : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {firmId ? (
                          <Link href={`/platform/firms/${String(firmId)}?tab=snapshots`}><a className="text-amber-700 hover:underline text-sm">Open snapshots</a></Link>
                        ) : null}
                        {inc?.id ? (
                          <Link href={`/platform/operations/incidents/${String(inc.id)}`}><a className="text-amber-700 hover:underline text-sm">Open incident</a></Link>
                        ) : null}
                        {canExecute ? (
                          <Button
                            variant="outline"
                            onClick={() => {
                              setCreateFirmId(Number(firmId));
                              setSnapshotType("firm");
                              setScopeType("firm");
                              setReason("Create snapshot before destructive operations (ops-center recommendation).");
                              setCreateOpen(true);
                            }}
                          >
                            Create snapshot
                          </Button>
                        ) : (
                          <Button variant="outline" disabled>Execute</Button>
                        )}
                      </div>
                    </div>
                    {rec?.note ? <div className="text-xs text-slate-600 mt-2">{String(rec.note)}</div> : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) setCreateOpen(false); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create snapshot (from recommendation)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-slate-700">Firm: <span className="font-mono">#{String(createFirmId ?? "")}</span></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <Select value={snapshotType} onValueChange={(v) => setSnapshotType(v as SnapshotType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="firm">firm</SelectItem>
                  <SelectItem value="module">module</SelectItem>
                  <SelectItem value="settings">settings</SelectItem>
                  <SelectItem value="record">record</SelectItem>
                </SelectContent>
              </Select>
              <Select value={scopeType} onValueChange={(v) => setScopeType(v as ScopeType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="firm">firm</SelectItem>
                  <SelectItem value="module">module</SelectItem>
                  <SelectItem value="settings">settings</SelectItem>
                  <SelectItem value="record">record</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (>= 10 chars)" />
            <div className="text-xs text-slate-500">Requires an approved active support session for this firm.</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createSnapshotMutation.mutate()} disabled={createSnapshotMutation.isPending || reason.trim().length < 10 || !createFirmId}>
              {createSnapshotMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

