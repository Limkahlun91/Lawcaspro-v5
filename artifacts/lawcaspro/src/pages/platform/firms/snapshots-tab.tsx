import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";

type SnapshotRow = any;

export function FirmSnapshotsTab({ firmId, firmName }: { firmId: number; firmName: string }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");

  const [searchKeyword, setSearchKeyword] = useState("");
  const [snapBefore, setSnapBefore] = useState<string | null>(null);
  const [snapItems, setSnapItems] = useState<SnapshotRow[]>([]);

  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoreSnapshot, setRestoreSnapshot] = useState<SnapshotRow | null>(null);

  const snapshotsQuery = useQuery({
    queryKey: ["platform-firm-snapshots-min", firmId, snapBefore],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (snapBefore) params.set("before", snapBefore);
      const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots?${params.toString()}`);
      return unwrapApiData<{ items: SnapshotRow[]; page_info?: { has_more?: boolean; next_before?: string | null } }>(res);
    },
    retry: false,
  });

  useEffect(() => {
    setSnapBefore(null);
    setSnapItems([]);
  }, [firmId]);

  useEffect(() => {
    if (!snapshotsQuery.data?.items) return;
    const next = snapshotsQuery.data.items;
    setSnapItems((prev) => {
      const base = snapBefore ? prev : [];
      const seen = new Set(base.map((s: any) => String(s.id)));
      const merged = [...base];
      for (const s of next) {
        const id = String((s as any).id);
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(s);
      }
      return merged;
    });
  }, [snapBefore, snapshotsQuery.data?.items]);

  const filteredSnapshots = useMemo(() => {
    const kw = searchKeyword.trim().toLowerCase();
    if (!kw) return snapItems;
    return snapItems.filter((s: any) => {
      const r = typeof s?.reason === "string" ? s.reason : "";
      const n = typeof s?.note === "string" ? s.note : "";
      return `${r} ${n}`.toLowerCase().includes(kw);
    });
  }, [snapItems, searchKeyword]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (reason.trim().length < 10) throw new Error("Reason must be at least 10 characters");
      if (typed.trim().toUpperCase() !== "CONFIRM") throw new Error("Typed confirmation required");
      const body = {
        snapshot_type: "firm",
        scope_type: "firm",
        trigger_type: "manual",
        reason: reason.trim(),
        target_entity_type: "firm",
        target_entity_id: String(firmId),
        target_label: firmName,
      };
      const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots`, { method: "POST", body: JSON.stringify(body) });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      toast({ title: "Snapshot created" });
      setCreateOpen(false);
      setReason("");
      setTyped("");
      setSearchKeyword("");
      setSnapBefore(null);
      setSnapItems([]);
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots-min", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history-v2", firmId] });
    },
    onError: (e) => toastError(toast, e, "Snapshot failed"),
  });

  const restoreMutation = useMutation({
    mutationFn: async (snap: SnapshotRow) => {
      const previewRes = await apiFetchJson(`/platform/firms/${firmId}/restore/preview`, {
        method: "POST",
        body: JSON.stringify({ snapshot_id: snap.id }),
      });
      const preview = unwrapApiData<any>(previewRes);
      const restoreActionId = String(preview.restore_action_id ?? "");
      if (!restoreActionId) throw new Error("Missing restore_action_id");
      const required =
        typeof preview.required_confirmation === "string" && preview.required_confirmation.trim()
          ? String(preview.required_confirmation).trim()
          : null;
      const execRes = await apiFetchJson(`/platform/firms/${firmId}/restore/execute`, {
        method: "POST",
        body: JSON.stringify({
          restore_action_id: restoreActionId,
          reason: `Restore to snapshot ${String(snap.id)}`,
          typed_confirmation: required,
          approval_request_id: null,
          step_up_challenge_id: null,
          step_up_phrase: null,
          emergency_flag: false,
        }),
      });
      return unwrapApiData(execRes);
    },
    onSuccess: async () => {
      toast({ title: "Restore started" });
      setRestoreConfirmOpen(false);
      setRestoreSnapshot(null);
      setSnapBefore(null);
      setSnapItems([]);
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots-min", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history-v2", firmId] });
    },
    onError: (e) => toastError(toast, e, "Restore failed"),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Backups / Restore</CardTitle>
          <Button onClick={() => setCreateOpen(true)} disabled={!hasFounderPermission(user, "founder.snapshot.create")}>
            Create Snapshot
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            placeholder="Search keywords..."
          />

          {snapshotsQuery.isError ? (
            <QueryFallback title="Snapshots unavailable" error={snapshotsQuery.error} onRetry={() => snapshotsQuery.refetch()} isRetrying={snapshotsQuery.isFetching} />
          ) : snapshotsQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading snapshots...</div>
          ) : filteredSnapshots.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No snapshots found.</div>
          ) : (
            <div className="overflow-x-auto rounded border border-slate-200">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Date / Time</th>
                    <th className="px-4 py-3 font-semibold">Reason / Note</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSnapshots.map((s: any) => {
                    const status = String(s.status ?? "");
                    const statusLower = status.toLowerCase();
                    const isCompleted = statusLower === "completed";
                    const statusBadge = isCompleted
                      ? <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">Completed</Badge>
                      : statusLower === "failed"
                        ? <Badge variant="destructive">Failed</Badge>
                        : <Badge variant="outline">{status || "—"}</Badge>;
                    const reasonText = (() => {
                      const r = typeof s.reason === "string" ? s.reason.trim() : "";
                      const n = typeof s.note === "string" ? s.note.trim() : "";
                      return r || n ? `${r}${r && n ? " — " : ""}${n}` : "—";
                    })();
                    const createdAt = s.createdAt ? new Date(String(s.createdAt)).toLocaleString() : "—";
                    return (
                      <tr key={String(s.id)} className="hover:bg-slate-50/50">
                        <td className="px-4 py-3 text-slate-700 whitespace-nowrap">{createdAt}</td>
                        <td className="px-4 py-3 text-slate-900">{reasonText}</td>
                        <td className="px-4 py-3">{statusBadge}</td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            size="sm"
                            className="bg-amber-500 hover:bg-amber-600 text-white"
                            disabled={!isCompleted || !hasFounderPermission(user, "founder.snapshot.restore.preview")}
                            onClick={() => {
                              setRestoreSnapshot(s);
                              setRestoreConfirmOpen(true);
                            }}
                          >
                            Restore
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-center">
            <Button
              variant="outline"
              onClick={() => {
                const next = (snapshotsQuery.data as any)?.page_info?.next_before ?? null;
                if (next) setSnapBefore(String(next));
              }}
              disabled={!((snapshotsQuery.data as any)?.page_info?.has_more) || snapshotsQuery.isFetching}
            >
              {snapshotsQuery.isFetching ? "Loading..." : ((snapshotsQuery.data as any)?.page_info?.has_more ? "Load more" : "No more")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Snapshot</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <div className="text-xs text-slate-500">Reason (required)</div>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (min 10 chars)" className="min-h-[90px]" />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-slate-500">Type CONFIRM</div>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="CONFIRM" />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={restoreConfirmOpen} onOpenChange={(o) => { if (!o) { setRestoreConfirmOpen(false); setRestoreSnapshot(null); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Restore snapshot</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-slate-700">
            Are you sure you want to restore to this snapshot? This will overwrite the current firm settings.
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setRestoreConfirmOpen(false); setRestoreSnapshot(null); }} disabled={restoreMutation.isPending}>Cancel</Button>
            <Button
              className="bg-amber-500 hover:bg-amber-600 text-white"
              onClick={() => {
                if (!restoreSnapshot) return;
                restoreMutation.mutate(restoreSnapshot);
              }}
              disabled={!restoreSnapshot || restoreMutation.isPending}
            >
              {restoreMutation.isPending ? "Restoring..." : "Confirm Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
