import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { DangerActionDialog, type DangerPreview } from "@/components/danger-action-dialog";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";

type SnapshotRow = any;

export function FirmSnapshotsTab({ firmId, firmName }: { firmId: number; firmName: string }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [snapshotType, setSnapshotType] = useState<"settings" | "record" | "module" | "firm">("settings");
  const [scopeType, setScopeType] = useState<"settings" | "record" | "module" | "firm">("settings");
  const [moduleCode, setModuleCode] = useState<string>("projects");
  const [targetEntityId, setTargetEntityId] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");

  const snapshotsQuery = useQuery({
    queryKey: ["platform-firm-snapshots", firmId],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots?limit=50`);
      return unwrapApiData<{ items: SnapshotRow[] }>(res);
    },
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (reason.trim().length < 10) throw new Error("Reason must be at least 10 characters");
      if (typed.trim() !== "CONFIRM") throw new Error("Typed confirmation required");
      const body: any = {
        snapshot_type: snapshotType,
        scope_type: scopeType,
        trigger_type: "manual",
        reason: reason.trim(),
        note: note.trim() || null,
      };
      if (snapshotType === "module") body.module_code = moduleCode;
      if (snapshotType === "record") {
        body.target_entity_type = "case";
        body.target_entity_id = targetEntityId.trim();
        body.target_label = targetEntityId.trim();
      }
      if (snapshotType === "firm") {
        body.target_entity_type = "firm";
        body.target_entity_id = String(firmId);
        body.target_label = firmName;
      }
      const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots`, { method: "POST", body: JSON.stringify(body) });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      toast({ title: "Snapshot created" });
      setCreateOpen(false);
      setReason("");
      setNote("");
      setTyped("");
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history", firmId] });
    },
    onError: (e) => toastError(toast, e, "Snapshot failed"),
  });

  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotRow | null>(null);
  const snapshotDetailQuery = useQuery({
    queryKey: ["platform-firm-snapshot-detail", firmId, selectedSnapshot?.id],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots/${selectedSnapshot!.id}`);
      return unwrapApiData<{ item: any; items: any[] }>(res);
    },
    enabled: !!selectedSnapshot,
    retry: false,
  });

  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restorePreview, setRestorePreview] = useState<DangerPreview | null>(null);
  const [restoreActionId, setRestoreActionId] = useState<string | null>(null);
  const [restoreRequiredText, setRestoreRequiredText] = useState<string | null>(null);
  const [restoreGovernance, setRestoreGovernance] = useState<any | null>(null);
  const [restoreStepUp, setRestoreStepUp] = useState<any | null>(null);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pinPreview, setPinPreview] = useState<DangerPreview | null>(null);
  const [pinSnapshotId, setPinSnapshotId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePreview, setDeletePreview] = useState<DangerPreview | null>(null);
  const [deleteSnapshotId, setDeleteSnapshotId] = useState<string | null>(null);

  const openRestore = async (snap: SnapshotRow) => {
    try {
      const res = await apiFetchJson(`/platform/firms/${firmId}/restore/preview`, {
        method: "POST",
        body: JSON.stringify({ snapshot_id: snap.id }),
      });
      const data = unwrapApiData<any>(res);
      setRestoreActionId(String(data.restore_action_id));
      setRestoreRequiredText(data.required_confirmation ?? null);
      setRestoreGovernance(data.governance ?? null);
      setRestoreStepUp(data.step_up ?? null);
      const p: DangerPreview = {
        action_code: "restore_snapshot",
        scope_type: String(data.preview?.restore_scope_type ?? snap.snapshotType ?? "settings") as any,
        module_code: String(snap.moduleCode ?? "settings") as any,
        risk_level: (String(data.preview?.restore_scope_type ?? snap.snapshotType) === "settings" ? "medium" : "high") as any,
        requires_snapshot: true,
        snapshot_strategy: "pre_restore",
        impact_summary: data.preview?.impact_summary ?? { settings_to_restore: 1 },
        dependency_summary: { has_blockers: false, blocking_items: [] },
        warnings: [{ code: "PRE_RESTORE_SNAPSHOT", message: "A pre-restore snapshot will be created automatically before applying restore." }],
        restore_availability: { available: true, notes: "Restore will overwrite current settings." },
        target: { entity_type: String(snap.targetEntityType ?? snap.snapshotType ?? "firm"), entity_id: String(snap.targetEntityId ?? firmId), label: String(snap.targetLabel ?? snap.id) },
      };
      setRestorePreview(p);
      setRestoreDialogOpen(true);
    } catch (e) {
      toastError(toast, e, "Restore preview failed");
    }
  };

  const openPin = (snap: SnapshotRow) => {
    setPinSnapshotId(String(snap.id));
    setPinPreview({
      action_code: "snapshot_pin",
      scope_type: "firm",
      module_code: "snapshots",
      risk_level: "low",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: { pinned: 1 },
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings: [{ code: "RETENTION_PROTECTED", message: "Pinned snapshots are excluded from retention cleanup until unpinned." }],
      restore_availability: { available: false },
      target: { entity_type: "snapshot", entity_id: String(snap.id), label: String(snap.targetLabel ?? snap.id) },
    });
    setPinDialogOpen(true);
  };

  const openDelete = (snap: SnapshotRow) => {
    setDeleteSnapshotId(String(snap.id));
    setDeletePreview({
      action_code: "snapshot_delete",
      scope_type: "firm",
      module_code: "snapshots",
      risk_level: "medium",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: { payload_removed: 1 },
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings: [{ code: "PAYLOAD_REMOVED", message: "Snapshot payload will be removed and snapshot will become non-restorable. Metadata/audit trail remains." }],
      restore_availability: { available: false },
      target: { entity_type: "snapshot", entity_id: String(snap.id), label: String(snap.targetLabel ?? snap.id) },
    });
    setDeleteDialogOpen(true);
  };

  const restoreMutation = useMutation({
    mutationFn: async (payload: { reason: string; typed_confirmation: string | null; approval_request_id: string | null; step_up_challenge_id: string | null; step_up_phrase: string | null; emergency_flag: boolean }) => {
      if (!restoreActionId) throw new Error("Missing restore_action_id");
      const res = await apiFetchJson(`/platform/firms/${firmId}/restore/execute`, {
        method: "POST",
        body: JSON.stringify({ restore_action_id: restoreActionId, reason: payload.reason, typed_confirmation: payload.typed_confirmation, approval_request_id: payload.approval_request_id, step_up_challenge_id: payload.step_up_challenge_id, step_up_phrase: payload.step_up_phrase, emergency_flag: payload.emergency_flag }),
      });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      toast({ title: "Restore completed" });
      setRestoreDialogOpen(false);
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history", firmId] });
    },
    onError: (e) => toastError(toast, e, "Restore failed"),
  });

  const snapshots = snapshotsQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Backups / Restore</CardTitle>
          <Button onClick={() => setCreateOpen(true)} disabled={!hasFounderPermission(user, "founder.snapshot.create")}>Create Snapshot</Button>
        </CardHeader>
        <CardContent>
          {snapshotsQuery.isError ? (
            <QueryFallback title="Snapshots unavailable" error={snapshotsQuery.error} onRetry={() => snapshotsQuery.refetch()} isRetrying={snapshotsQuery.isFetching} />
          ) : snapshotsQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading snapshots...</div>
          ) : snapshots.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No snapshots yet.</div>
          ) : (
            <div className="rounded border border-slate-200 divide-y">
              {snapshots.map((s) => (
                <div key={String(s.id)} className="p-3 flex items-start justify-between gap-3">
                  <button className="text-left min-w-0" onClick={() => setSelectedSnapshot(s)}>
                    <div className="text-sm font-medium text-slate-900 truncate">{String(s.targetLabel ?? s.snapshotType ?? s.id)}</div>
                    <div className="text-xs text-slate-500">
                      {String(s.snapshotType)} · {String(s.triggerType)} · {String(s.status)}{s.pinnedAt ? " · pinned" : ""} · {new Date(String(s.createdAt)).toLocaleString()}
                    </div>
                  </button>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => setSelectedSnapshot(s)}>View</Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openRestore(s)}
                      disabled={
                        !hasFounderPermission(user, "founder.snapshot.restore.preview")
                        || String(s.status) !== "completed"
                        || String(s.snapshotType) === "firm"
                        || (String(s.snapshotType) === "module" && String(s.moduleCode) !== "projects")
                      }
                    >
                      {String(s.snapshotType) === "settings"
                        ? "Restore settings"
                        : String(s.snapshotType) === "module"
                          ? "Restore projects"
                          : "Restore"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => (s.pinnedAt ? apiFetchJson(`/platform/firms/${firmId}/snapshots/${String(s.id)}/unpin`, { method: "POST" }).then(() => qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] })) : openPin(s))}
                      disabled={!hasFounderPermission(user, "founder.snapshot.pin")}
                    >
                      {s.pinnedAt ? "Unpin" : "Pin"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openDelete(s)}
                      disabled={!hasFounderPermission(user, "founder.snapshot.delete") || !!s.pinnedAt || String(s.status) === "deleted"}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Snapshot</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-slate-500">Snapshot type</div>
                <Select value={snapshotType} onValueChange={(v) => { setSnapshotType(v as any); setScopeType(v as any); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="settings">Settings</SelectItem>
                    <SelectItem value="record">Single case</SelectItem>
                    <SelectItem value="module">Module snapshot</SelectItem>
                    <SelectItem value="firm">Firm summary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {snapshotType === "module" ? (
                <div className="space-y-1">
                  <div className="text-xs text-slate-500">Module</div>
                  <Select value={moduleCode} onValueChange={setModuleCode}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="projects">Projects</SelectItem>
                      <SelectItem value="developers">Developers</SelectItem>
                      <SelectItem value="documents">Documents metadata</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : snapshotType === "record" ? (
                <div className="space-y-1">
                  <div className="text-xs text-slate-500">Case ID</div>
                  <Input value={targetEntityId} onChange={(e) => setTargetEntityId(e.target.value)} placeholder="Case ID" />
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-xs text-slate-500">Scope</div>
                  <Input value={scopeType} disabled />
                </div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-xs text-slate-500">Reason (required)</div>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (min 10 chars)" className="min-h-[90px]" />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-slate-500">Optional note</div>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" />
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

      <Dialog open={!!selectedSnapshot} onOpenChange={(o) => { if (!o) setSelectedSnapshot(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Snapshot Details</DialogTitle>
          </DialogHeader>
          {snapshotDetailQuery.isError ? (
            <QueryFallback title="Snapshot detail unavailable" error={snapshotDetailQuery.error} onRetry={() => snapshotDetailQuery.refetch()} isRetrying={snapshotDetailQuery.isFetching} />
          ) : snapshotDetailQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading snapshot detail...</div>
          ) : (
            <div className="space-y-3">
              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <pre className="text-xs whitespace-pre-wrap break-words text-slate-700">{JSON.stringify(snapshotDetailQuery.data?.item ?? null, null, 2)}</pre>
              </div>
              <div className="rounded border border-slate-200 p-3">
                <div className="text-sm font-medium text-slate-900 mb-2">Items</div>
                <div className="max-h-[280px] overflow-auto space-y-1">
                  {(snapshotDetailQuery.data?.items ?? []).map((it: any) => (
                    <div key={String(it.id)} className="text-xs text-slate-600">
                      {String(it.itemType)} {it.itemLabel ? `· ${String(it.itemLabel)}` : ""} {it.itemId ? `(#${String(it.itemId)})` : ""}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedSnapshot(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DangerActionDialog
        open={restoreDialogOpen}
        onOpenChange={setRestoreDialogOpen}
        title="Restore from snapshot"
        preview={restorePreview}
        requiredConfirmationText={restoreRequiredText}
        governance={restoreGovernance}
        stepUp={restoreStepUp}
        canRequestApproval={hasFounderPermission(user, "founder.approval.request")}
        onRequestApproval={async (payload) => {
          if (!restoreActionId) throw new Error("Missing restore_action_id");
          const res = await apiFetchJson(`/platform/firms/${firmId}/restore/request-approval`, {
            method: "POST",
            body: JSON.stringify({ restore_action_id: restoreActionId, reason: payload.reason, detailed_note: payload.detailed_note, emergency_flag: payload.emergency_flag }),
          });
          const data = unwrapApiData<any>(res);
          const approval = data.approval ?? data;
          return { id: String(approval.id), requestCode: String(approval.requestCode ?? ""), status: String(approval.status ?? "") };
        }}
        requireFirmName={true}
        firmNameHint={firmName}
        requireTargetLabel={false}
        targetLabelHint={null}
        isExecuting={restoreMutation.isPending}
        onExecute={(payload) => restoreMutation.mutateAsync(payload)}
      />

      <DangerActionDialog
        open={pinDialogOpen}
        onOpenChange={setPinDialogOpen}
        title="Pin snapshot"
        preview={pinPreview}
        requiredConfirmationText={null}
        requireFirmName={true}
        firmNameHint={firmName}
        requireTargetLabel={false}
        targetLabelHint={null}
        onExecute={async (payload) => {
          if (!pinSnapshotId) throw new Error("Missing snapshot id");
          await apiFetchJson(`/platform/firms/${firmId}/snapshots/${pinSnapshotId}/pin`, {
            method: "POST",
            body: JSON.stringify({ reason: payload.reason }),
          });
          await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
          return { pinned: true };
        }}
      />

      <DangerActionDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete snapshot payload"
        preview={deletePreview}
        requiredConfirmationText={"CONFIRM"}
        requireFirmName={true}
        firmNameHint={firmName}
        requireTargetLabel={false}
        targetLabelHint={null}
        onExecute={async (payload) => {
          if (!deleteSnapshotId) throw new Error("Missing snapshot id");
          await apiFetchJson(`/platform/firms/${firmId}/snapshots/${deleteSnapshotId}/delete`, {
            method: "POST",
            body: JSON.stringify({ reason: payload.reason, typed_confirmation: payload.typed_confirmation }),
          });
          await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
          return { deleted: true };
        }}
      />
    </div>
  );
}
