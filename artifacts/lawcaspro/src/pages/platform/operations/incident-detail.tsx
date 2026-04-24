import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";

function SeverityBadge({ sev }: { sev: string }) {
  const cls = (() => {
    if (sev === "critical") return "bg-red-50 text-red-700 border border-red-200";
    if (sev === "high") return "bg-amber-50 text-amber-800 border border-amber-200";
    if (sev === "medium") return "bg-yellow-50 text-yellow-800 border border-yellow-200";
    return "bg-slate-100 text-slate-700 border border-slate-200";
  })();
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{sev || "—"}</span>;
}

export default function PlatformOperationsIncidentDetail() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const params = useParams();
  const id = String((params as any)?.id ?? "");

  const canRead = hasFounderPermission(user, "founder.ops.read");
  const canAck = hasFounderPermission(user, "founder.ops.incident.ack");
  const canResolve = hasFounderPermission(user, "founder.ops.incident.resolve");
  const canDismiss = hasFounderPermission(user, "founder.ops.incident.dismiss");
  const canNote = hasFounderPermission(user, "founder.ops.incident.note");

  const [note, setNote] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");

  const incidentQuery = useQuery({
    queryKey: ["platform-ops-center-incident-detail", id],
    queryFn: async () => {
      return await apiFetchJson(`/platform/operations/incidents/${encodeURIComponent(id)}`);
    },
    enabled: canRead && !!id,
    retry: false,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: async () => {
      return await apiFetchJson(`/platform/operations/incidents/${encodeURIComponent(id)}/acknowledge`, { method: "POST" });
    },
    onSuccess: async () => {
      toast({ title: "Acknowledged" });
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incident-detail", id] });
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incidents"] });
    },
    onError: (e) => toastError(toast, e, "Acknowledge failed"),
  });

  const resolveMutation = useMutation({
    mutationFn: async () => {
      return await apiFetchJson(`/platform/operations/incidents/${encodeURIComponent(id)}/resolve`, { method: "POST", body: JSON.stringify({ note: resolutionNote.trim() }) });
    },
    onSuccess: async () => {
      toast({ title: "Resolved" });
      setResolutionNote("");
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incident-detail", id] });
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incidents"] });
    },
    onError: (e) => toastError(toast, e, "Resolve failed"),
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      return await apiFetchJson(`/platform/operations/incidents/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: JSON.stringify({ note: resolutionNote.trim() }) });
    },
    onSuccess: async () => {
      toast({ title: "Dismissed" });
      setResolutionNote("");
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incident-detail", id] });
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incidents"] });
    },
    onError: (e) => toastError(toast, e, "Dismiss failed"),
  });

  const noteMutation = useMutation({
    mutationFn: async () => {
      return await apiFetchJson(`/platform/operations/incidents/${encodeURIComponent(id)}/notes`, { method: "POST", body: JSON.stringify({ note: note.trim() }) });
    },
    onSuccess: async () => {
      toast({ title: "Note added" });
      setNote("");
      await qc.invalidateQueries({ queryKey: ["platform-ops-center-incident-detail", id] });
    },
    onError: (e) => toastError(toast, e, "Add note failed"),
  });

  if (!canRead) {
    return (
      <Card>
        <CardHeader><CardTitle>Incident Detail</CardTitle></CardHeader>
        <CardContent className="text-sm text-slate-600">Missing permission: founder.ops.read</CardContent>
      </Card>
    );
  }

  const incident = (incidentQuery.data as any)?.incident ?? null;
  const notes = ((incidentQuery.data as any)?.notes ?? []) as any[];
  const recs = ((incidentQuery.data as any)?.recommendations ?? []) as any[];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-2xl font-bold text-slate-900">Incident</div>
          <div className="text-sm text-slate-600">
            <Link href="/platform/operations/incidents"><a className="text-amber-700 hover:underline">Back to incidents</a></Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canAck && incident?.status === "open" ? (
            <Button variant="outline" onClick={() => acknowledgeMutation.mutate()} disabled={acknowledgeMutation.isPending}>Acknowledge</Button>
          ) : null}
          {canResolve && incident && incident.status !== "resolved" ? (
            <Button variant="outline" onClick={() => resolveMutation.mutate()} disabled={resolveMutation.isPending || resolutionNote.trim().length < 3}>Resolve</Button>
          ) : null}
          {canDismiss && incident && incident.status !== "dismissed" ? (
            <Button variant="outline" onClick={() => dismissMutation.mutate()} disabled={dismissMutation.isPending || resolutionNote.trim().length < 3}>Dismiss</Button>
          ) : null}
        </div>
      </div>

      {incidentQuery.isError ? (
        <QueryFallback title="Incident unavailable" error={incidentQuery.error} onRetry={() => incidentQuery.refetch()} isRetrying={incidentQuery.isFetching} />
      ) : incidentQuery.isLoading ? (
        <div className="text-sm text-slate-500 py-10 text-center">Loading incident...</div>
      ) : !incident ? (
        <div className="text-sm text-slate-500 py-10 text-center">Not found</div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 flex-wrap">
                <span className="font-mono">{String(incident.incidentCode ?? String(incident.id).slice(0, 8))}</span>
                <Badge variant="outline" className="text-xs">{String(incident.incidentType)}</Badge>
                <SeverityBadge sev={String(incident.severity)} />
                <Badge variant="outline" className="text-xs">{String(incident.status)}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm text-slate-900 font-medium">{String(incident.title)}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-700">
                <div>Detected: {incident.detectedAt ? new Date(String(incident.detectedAt)).toLocaleString() : "—"}</div>
                <div>Last event: {incident.lastEventAt ? new Date(String(incident.lastEventAt)).toLocaleString() : "—"}</div>
                <div>Firm: <Link href={`/platform/firms/${String(incident.firmId)}`}><a className="text-amber-700 hover:underline">#{String(incident.firmId)}</a></Link></div>
                <div>Module: <span className="font-mono">{String(incident.moduleCode ?? "—")}</span></div>
                <div>Entity: <span className="font-mono">{String(incident.entityType ?? "—")}{incident.entityId ? `:${String(incident.entityId)}` : ""}</span></div>
                <div>Snapshot: {incident.snapshotId ? <span className="font-mono">{String(incident.snapshotId).slice(0, 8)}</span> : "—"}</div>
              </div>
              {incident.summary ? (
                <div>
                  <div className="text-xs text-slate-500 mb-1">Summary</div>
                  <div className="text-sm text-slate-700 whitespace-pre-wrap break-words">{String(incident.summary)}</div>
                </div>
              ) : null}
              {incident.technicalSummary ? (
                <div className="rounded border border-slate-200 bg-slate-50 p-3">
                  <div className="text-xs text-slate-500 mb-1">Technical summary</div>
                  <div className="text-sm text-slate-700 whitespace-pre-wrap break-words">{String(incident.technicalSummary)}</div>
                </div>
              ) : null}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                <div>Source event: <span className="font-mono">{String(incident.sourceEventId ?? "—")}</span></div>
                <div>Source operation: <span className="font-mono">{String(incident.sourceOperationId ?? "—")}</span></div>
              </div>
              {incident.sourceOperationId ? (
                <div className="text-sm">
                  <Link href={`/platform/operations/logs`}><a className="text-amber-700 hover:underline">Open in logs</a></Link>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Recommendations</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {recs.length === 0 ? (
                <div className="text-sm text-slate-500">No recommendations.</div>
              ) : (
                <div className="rounded border border-slate-200 divide-y">
                  {recs.map((r: any) => (
                    <div key={String(r.recommendation_code)} className="p-3">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-slate-900">{String(r.title)}</span>
                            <SeverityBadge sev={String(r.severity)} />
                            <Badge variant="outline" className="text-xs">{String(r.confidence_level)}</Badge>
                            <span className="font-mono text-xs text-slate-500">{String(r.recommendation_code)}</span>
                          </div>
                          <div className="text-xs text-slate-600 mt-1">{String(r.reason)}</div>
                          <div className="text-xs text-slate-500 mt-1">{String(r.recommended_next_action)}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {r.can_execute_directly ? (
                            <Link href={`/platform/firms/${String(incident.firmId)}?tab=snapshots`}><a className="text-amber-700 hover:underline text-sm">Open snapshots</a></Link>
                          ) : (
                            <Link href={`/platform/firms/${String(incident.firmId)}?tab=history`}><a className="text-amber-700 hover:underline text-sm">Open history</a></Link>
                          )}
                        </div>
                      </div>
                      {r.note ? <div className="text-xs text-slate-600 mt-2">{String(r.note)}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {canNote ? (
                <div className="space-y-2">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add note..." />
                  <Button onClick={() => noteMutation.mutate()} disabled={noteMutation.isPending || note.trim().length < 3}>Add note</Button>
                </div>
              ) : (
                <div className="text-sm text-slate-500">Missing permission: founder.ops.incident.note</div>
              )}
              <div className="rounded border border-slate-200 divide-y">
                {notes.map((n: any) => (
                  <div key={String(n.id)} className="p-3 text-sm">
                    <div className="text-xs text-slate-500">
                      user #{String(n.authorUserId)} · {n.createdAt ? new Date(String(n.createdAt)).toLocaleString() : "—"}
                    </div>
                    <div className="whitespace-pre-wrap break-words text-slate-700 mt-1">{String(n.note)}</div>
                  </div>
                ))}
                {notes.length === 0 ? <div className="p-3 text-sm text-slate-500">No notes.</div> : null}
              </div>
            </CardContent>
          </Card>

          {(canResolve || canDismiss) ? (
            <Card>
              <CardHeader><CardTitle>Resolution</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Textarea value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} placeholder="Resolution note (required for resolve/dismiss)..." />
                <div className="text-xs text-slate-500">Minimum 3 characters.</div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}

