import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { DangerActionDialog, type DangerPreview } from "@/components/danger-action-dialog";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { getSupportSessionId } from "@/lib/support-session";

type SnapshotRow = any;

export function FirmSnapshotsTab({ firmId, firmName }: { firmId: number; firmName: string }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [snapshotType, setSnapshotType] = useState<"settings" | "record" | "module" | "firm">("settings");
  const [scopeType, setScopeType] = useState<"settings" | "record" | "module" | "firm">("settings");
  const [moduleCode, setModuleCode] = useState<string>("projects");
  const [settingsGroup, setSettingsGroup] = useState<"all" | "firm_profile" | "bank_accounts">("all");
  const [recordEntityType, setRecordEntityType] = useState<"case" | "project" | "developer">("case");
  const [targetEntityId, setTargetEntityId] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");

  const [snapBefore, setSnapBefore] = useState<string | null>(null);
  const [snapItems, setSnapItems] = useState<SnapshotRow[]>([]);
  const [filterSnapshotType, setFilterSnapshotType] = useState<"" | "settings" | "record" | "module" | "firm">("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterPinned, setFilterPinned] = useState<"" | "pinned" | "unpinned">("");
  const [filterTargetType, setFilterTargetType] = useState("");
  const [filterTargetId, setFilterTargetId] = useState("");

  const [restoreTargetKind, setRestoreTargetKind] = useState<"case" | "project" | "developer" | "settings_group">("case");
  const [restoreKeyword, setRestoreKeyword] = useState("");
  const [restoreSearchResults, setRestoreSearchResults] = useState<Array<{ entity_type: string; entity_id: string; label: string }>>([]);
  const [restoreSelected, setRestoreSelected] = useState<{ entity_type: string; entity_id: string; label: string } | null>(null);
  const [restoreSettingsGroup, setRestoreSettingsGroup] = useState<"firm_profile" | "bank_accounts">("firm_profile");

  const snapshotsQuery = useQuery({
    queryKey: ["platform-firm-snapshots", firmId, filterSnapshotType, filterStatus, filterPinned, filterTargetType, filterTargetId, snapBefore],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (filterSnapshotType) params.set("snapshot_type", filterSnapshotType);
      if (filterStatus.trim()) params.set("status", filterStatus.trim());
      if (filterPinned === "pinned") params.set("pinned", "true");
      if (filterPinned === "unpinned") params.set("pinned", "false");
      if (filterTargetType.trim()) params.set("target_entity_type", filterTargetType.trim());
      if (filterTargetId.trim()) params.set("target_entity_id", filterTargetId.trim());
      if (snapBefore) params.set("before", snapBefore);
      const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots?${params.toString()}`);
      return unwrapApiData<{ items: SnapshotRow[]; page_info?: { has_more?: boolean; next_before?: string | null } }>(res);
    },
    retry: false,
  });

  useEffect(() => {
    setSnapBefore(null);
    setSnapItems([]);
  }, [firmId, filterPinned, filterSnapshotType, filterStatus, filterTargetId, filterTargetType]);

  const searchTargetsMutation = useMutation({
    mutationFn: async () => {
      const q = restoreKeyword.trim();
      if (restoreTargetKind === "settings_group") return [];
      if (q.length < 2) throw new Error("Keyword must be at least 2 characters");
      const res = await apiFetchJson(`/platform/firms/${firmId}/maintenance/search?entity_type=${encodeURIComponent(restoreTargetKind)}&q=${encodeURIComponent(q)}&limit=10`);
      const data = unwrapApiData<{ items: any[] }>(res);
      return (data.items ?? []).map((it: any) => ({
        entity_type: String(it.entity_type ?? it.entityType ?? restoreTargetKind),
        entity_id: String(it.entity_id ?? it.entityId ?? it.id ?? ""),
        label: String(it.label ?? it.name ?? it.entity_id ?? it.id ?? ""),
      })).filter((it: any) => it.entity_id);
    },
    onSuccess: (rows) => {
      setRestoreSearchResults(rows);
      if (rows.length === 0) setRestoreSelected(null);
    },
    onError: (e) => toastError(toast, e, "Search failed"),
  });

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
        body.target_entity_type = recordEntityType;
        body.target_entity_id = targetEntityId.trim();
        body.target_label = `${recordEntityType}:${targetEntityId.trim()}`;
      }
      if (snapshotType === "settings" && settingsGroup !== "all") {
        body.target_entity_type = "settings";
        body.target_entity_id = settingsGroup;
        body.target_label = `settings:${settingsGroup}`;
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
      setSnapBefore(null);
      setSnapItems([]);
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history-v2", firmId] });
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
      const scope = String(data.preview?.restore_scope_type ?? snap.snapshotType ?? "settings");
      const inferredRisk = scope === "settings" ? "medium" : "high";
      const p: DangerPreview = {
        action_code: "restore_snapshot",
        scope_type: scope as any,
        module_code: String(snap.moduleCode ?? "settings") as any,
        risk_level: inferredRisk as any,
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

  const rollbackCandidatesQuery = useQuery({
    queryKey: ["platform-firm-rollback-candidates", firmId],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/firms/${firmId}/history?kind=restore&status=completed&limit=50`);
      return unwrapApiData<{ items: unknown[] }>(res);
    },
    retry: false,
  });

  const supportQuery = useQuery({
    queryKey: ["platform-firm-snapshots-support-session", firmId],
    queryFn: async () => {
      return await apiFetchJson<{ items: any[] }>(`/support-sessions?firmId=${firmId}`);
    },
    enabled: !!firmId,
    retry: false,
  });

  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false);
  const [rollbackPreview, setRollbackPreview] = useState<DangerPreview | null>(null);
  const [rollbackActionId, setRollbackActionId] = useState<string | null>(null);
  const [rollbackRequiredText, setRollbackRequiredText] = useState<string | null>(null);
  const [rollbackGovernance, setRollbackGovernance] = useState<any | null>(null);
  const [rollbackStepUp, setRollbackStepUp] = useState<any | null>(null);

  const openRollback = async (sourceRestoreActionId: string, targetLabel: string) => {
    try {
      const res = await apiFetchJson(`/platform/firms/${firmId}/recovery/rollback/preview`, {
        method: "POST",
        body: JSON.stringify({ source_restore_action_id: sourceRestoreActionId }),
      });
      const data = unwrapApiData<any>(res);
      setRollbackActionId(String(data.rollback_action_id));
      setRollbackRequiredText(data.required_confirmation ?? null);
      setRollbackGovernance(data.governance ?? null);
      setRollbackStepUp(data.step_up ?? null);
      const p: DangerPreview = {
        action_code: "rollback_restore",
        scope_type: String(data.preview?.restore_scope_type ?? "firm") as any,
        module_code: "recovery" as any,
        risk_level: "critical" as any,
        requires_snapshot: true,
        snapshot_strategy: "pre_restore",
        impact_summary: data.preview?.impact_summary ?? { rollback: 1 },
        dependency_summary: { has_blockers: false, blocking_items: [] },
        warnings: [{ code: "ROLLBACK_REPLACES_STATE", message: "Rollback will overwrite current state using the pre-restore snapshot." }],
        restore_availability: { available: true, notes: "Rollback creates a pre-rollback snapshot for safety." },
        target: { entity_type: "restore_action", entity_id: sourceRestoreActionId, label: targetLabel },
      };
      setRollbackPreview(p);
      setRollbackDialogOpen(true);
    } catch (e) {
      toastError(toast, e, "Rollback preview failed");
    }
  };

  const rollbackMutation = useMutation({
    mutationFn: async (payload: { reason: string; typed_confirmation: string | null; approval_request_id: string | null; step_up_challenge_id: string | null; step_up_phrase: string | null; emergency_flag: boolean }) => {
      if (!rollbackActionId) throw new Error("Missing rollback_action_id");
      const res = await apiFetchJson(`/platform/firms/${firmId}/recovery/rollback/execute`, {
        method: "POST",
        body: JSON.stringify({ rollback_action_id: rollbackActionId, reason: payload.reason, typed_confirmation: payload.typed_confirmation, approval_request_id: payload.approval_request_id, step_up_challenge_id: payload.step_up_challenge_id, step_up_phrase: payload.step_up_phrase, emergency_flag: payload.emergency_flag }),
      });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      toast({ title: "Rollback completed" });
      setRollbackDialogOpen(false);
      setSnapBefore(null);
      setSnapItems([]);
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history-v2", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-rollback-candidates", firmId] });
    },
    onError: (e) => toastError(toast, e, "Rollback failed"),
  });

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
      setSnapBefore(null);
      setSnapItems([]);
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history-v2", firmId] });
    },
    onError: (e) => toastError(toast, e, "Restore failed"),
  });

  const snapshots = snapItems;
  const storedSupportSessionId = getSupportSessionId();
  const latestSupport = (supportQuery.data?.items ?? [])[0] ?? null;
  const latestStatus = latestSupport?.status ? String(latestSupport.status) : "";
  const latestExpiresAt = latestSupport?.expiresAt ? String(latestSupport.expiresAt) : "";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Backups / Restore</CardTitle>
          <Button onClick={() => setCreateOpen(true)} disabled={!hasFounderPermission(user, "founder.snapshot.create")}>Create Snapshot</Button>
        </CardHeader>
        <CardContent>
          <div className="text-xs text-slate-600 mb-4">
            Support session: {storedSupportSessionId ? <span className="font-mono">#{storedSupportSessionId}</span> : "—"}
            {latestSupport ? (
              <>
                <span className="mx-2">·</span>
                <Badge variant="outline" className="text-xs">{latestStatus || "unknown"}</Badge>
                {latestExpiresAt ? <span className="text-xs text-slate-500"> · expires {new Date(latestExpiresAt).toLocaleString()}</span> : null}
              </>
            ) : null}
          </div>
          <div className="mb-4 grid grid-cols-1 md:grid-cols-5 gap-2">
            <Select value={filterSnapshotType} onValueChange={(v) => setFilterSnapshotType(v as any)}>
              <SelectTrigger><SelectValue placeholder="Snapshot type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">All types</SelectItem>
                <SelectItem value="settings">Settings</SelectItem>
                <SelectItem value="record">Record</SelectItem>
                <SelectItem value="module">Module</SelectItem>
                <SelectItem value="firm">Firm</SelectItem>
              </SelectContent>
            </Select>
            <Input value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} placeholder="Status (completed/failed/...)" />
            <Select value={filterPinned} onValueChange={(v) => setFilterPinned(v as any)}>
              <SelectTrigger><SelectValue placeholder="Pinned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">All</SelectItem>
                <SelectItem value="pinned">Pinned</SelectItem>
                <SelectItem value="unpinned">Unpinned</SelectItem>
              </SelectContent>
            </Select>
            <Input value={filterTargetType} onChange={(e) => setFilterTargetType(e.target.value)} placeholder="Target type (case/project/...)" />
            <Input value={filterTargetId} onChange={(e) => setFilterTargetId(e.target.value)} placeholder="Target id" />
          </div>
          <div className="flex items-center gap-2 mb-4">
            <Button
              variant="outline"
              onClick={() => {
                setSnapBefore(null);
                setSnapItems([]);
                snapshotsQuery.refetch();
              }}
              disabled={snapshotsQuery.isFetching}
            >
              Apply filters
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setFilterSnapshotType("");
                setFilterStatus("");
                setFilterPinned("");
                setFilterTargetType("");
                setFilterTargetId("");
                setSnapBefore(null);
                setSnapItems([]);
              }}
              disabled={snapshotsQuery.isFetching}
            >
              Reset
            </Button>
          </div>
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
                    <div className="flex items-center gap-2 flex-wrap mt-1">
                      <Badge variant="outline" className="text-xs">{String(s.snapshotType)}</Badge>
                      <Badge variant="outline" className="text-xs">{String(s.triggerType)}</Badge>
                      <Badge variant="outline" className="text-xs">{String(s.status)}</Badge>
                      {s.pinnedAt ? <Badge variant="outline" className="text-xs">pinned</Badge> : null}
                      {s.restorable === false ? <Badge variant="outline" className="text-xs">not restorable</Badge> : null}
                      <span className="text-xs text-slate-500">{new Date(String(s.createdAt)).toLocaleString()}</span>
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
                      {String(s.snapshotType) === "firm" ? "Restore" : "Restore"}
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
          <div className="mt-4 flex items-center justify-center">
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

      <Card>
        <CardHeader>
          <CardTitle>Record-level restore</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Select value={restoreTargetKind} onValueChange={(v) => {
              setRestoreTargetKind(v as any);
              setRestoreSearchResults([]);
              setRestoreSelected(null);
              setRestoreKeyword("");
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="case">Case</SelectItem>
                <SelectItem value="project">Project</SelectItem>
                <SelectItem value="developer">Developer</SelectItem>
                <SelectItem value="settings_group">Settings group</SelectItem>
              </SelectContent>
            </Select>

            {restoreTargetKind === "settings_group" ? (
              <Select value={restoreSettingsGroup} onValueChange={(v) => setRestoreSettingsGroup(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="firm_profile">Firm profile</SelectItem>
                  <SelectItem value="bank_accounts">Bank accounts</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input value={restoreKeyword} onChange={(e) => setRestoreKeyword(e.target.value)} placeholder="Search keyword (name/title)" />
            )}

            <Button
              variant="outline"
              onClick={() => searchTargetsMutation.mutate()}
              disabled={restoreTargetKind === "settings_group" || searchTargetsMutation.isPending || restoreKeyword.trim().length < 2}
            >
              {searchTargetsMutation.isPending ? "Searching..." : "Search"}
            </Button>
          </div>

          {restoreTargetKind !== "settings_group" ? (
            <div className="rounded border border-slate-200 divide-y">
              {(restoreSearchResults ?? []).length ? (
                restoreSearchResults.map((r) => (
                  <button
                    key={`${r.entity_type}:${r.entity_id}`}
                    className={`w-full text-left p-2 text-sm hover:bg-slate-50 ${restoreSelected?.entity_id === r.entity_id && restoreSelected?.entity_type === r.entity_type ? "bg-slate-50" : ""}`}
                    onClick={() => setRestoreSelected(r)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-slate-900 truncate">{r.label}</div>
                        <div className="text-xs text-slate-500 font-mono">{r.entity_type}:{r.entity_id}</div>
                      </div>
                      {restoreSelected?.entity_id === r.entity_id && restoreSelected?.entity_type === r.entity_type ? <Badge variant="outline" className="text-xs">selected</Badge> : null}
                    </div>
                  </button>
                ))
              ) : (
                <div className="p-3 text-sm text-slate-500">Search a target to restore (case/project/developer).</div>
              )}
            </div>
          ) : (
            <div className="text-sm text-slate-600">
              Selected group: <span className="font-mono">{restoreSettingsGroup}</span>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => {
                setSnapBefore(null);
                setSnapItems([]);
                if (restoreTargetKind === "settings_group") {
                  setFilterSnapshotType("settings");
                  setFilterTargetType("settings");
                  setFilterTargetId(restoreSettingsGroup);
                  return;
                }
                if (!restoreSelected) return;
                setFilterSnapshotType("record");
                setFilterTargetType(restoreSelected.entity_type);
                setFilterTargetId(restoreSelected.entity_id);
              }}
              disabled={restoreTargetKind !== "settings_group" && !restoreSelected}
            >
              Filter snapshots
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (restoreTargetKind === "settings_group") {
                  setSnapshotType("settings");
                  setScopeType("settings");
                  setSettingsGroup(restoreSettingsGroup);
                  setCreateOpen(true);
                  return;
                }
                if (!restoreSelected) return;
                setSnapshotType("record");
                setScopeType("record");
                setRecordEntityType(restoreSelected.entity_type as any);
                setTargetEntityId(restoreSelected.entity_id);
                setCreateOpen(true);
              }}
              disabled={restoreTargetKind !== "settings_group" && !restoreSelected}
            >
              Create snapshot
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const params = new URLSearchParams();
                params.set("limit", "1");
                if (restoreTargetKind === "settings_group") {
                  params.set("snapshot_type", "settings");
                  params.set("target_entity_type", "settings");
                  params.set("target_entity_id", restoreSettingsGroup);
                } else {
                  if (!restoreSelected) throw new Error("Select a target first");
                  params.set("snapshot_type", "record");
                  params.set("target_entity_type", restoreSelected.entity_type);
                  params.set("target_entity_id", restoreSelected.entity_id);
                }
                const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots?${params.toString()}`);
                const data = unwrapApiData<{ items: any[] }>(res);
                const latest = (data.items ?? [])[0] ?? null;
                if (!latest) throw new Error("No snapshots found for this target");
                await openRestore(latest);
              }}
              disabled={!hasFounderPermission(user, "founder.snapshot.restore.preview")}
            >
              Preview restore latest
            </Button>
          </div>

          <div className="text-xs text-slate-500">
            Supported: settings group restore (firm_profile, bank_accounts) · record restore (case, project, developer) · module restore (projects).
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rollback (Undo Restore)</CardTitle>
        </CardHeader>
        <CardContent>
          {rollbackCandidatesQuery.isError ? (
            <QueryFallback title="Rollback candidates unavailable" error={rollbackCandidatesQuery.error} onRetry={() => rollbackCandidatesQuery.refetch()} isRetrying={rollbackCandidatesQuery.isFetching} />
          ) : rollbackCandidatesQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading rollback candidates...</div>
          ) : (
            <div className="rounded border border-slate-200 divide-y">
              {(rollbackCandidatesQuery.data?.items ?? [])
                .filter((it: unknown) => {
                  const o = it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
                  if (!o) return false;
                  const kind = typeof o["kind"] === "string" ? o["kind"] : null;
                  const operationCode = typeof o["operationCode"] === "string" ? o["operationCode"] : "restore_snapshot";
                  const status = typeof o["status"] === "string" ? o["status"] : null;
                  const preRestoreSnapshotId = o["preRestoreSnapshotId"];
                  return kind === "restore" && operationCode === "restore_snapshot" && status === "completed" && !!preRestoreSnapshotId;
                })
                .slice(0, 10)
                .map((it: unknown) => {
                  const o = it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
                  if (!o) return null;
                  const id = String(o["id"] ?? "");
                  const label = String(o["targetLabel"] ?? o["id"] ?? "");
                  const createdAt = String(o["createdAt"] ?? "");
                  return (
                    <div key={id} className="p-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{label}</div>
                      <div className="text-xs text-slate-500">restore_action · completed · {createdAt ? new Date(createdAt).toLocaleString() : "—"}</div>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => openRollback(id, label)}
                      disabled={!hasFounderPermission(user, "founder.recovery.preview")}
                    >
                      Preview rollback
                    </Button>
                  </div>
                  );
                })}
              {(rollbackCandidatesQuery.data?.items ?? []).filter((it: unknown) => {
                const o = it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
                if (!o) return false;
                const kind = typeof o["kind"] === "string" ? o["kind"] : null;
                const status = typeof o["status"] === "string" ? o["status"] : null;
                const preRestoreSnapshotId = o["preRestoreSnapshotId"];
                return kind === "restore" && status === "completed" && !!preRestoreSnapshotId;
              }).length === 0 ? (
                <div className="text-sm text-slate-500 py-6 text-center">No completed restores with rollback available yet.</div>
              ) : null}
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
                    <SelectItem value="record">Single record</SelectItem>
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
                  <div className="text-xs text-slate-500">Record</div>
                  <Select value={recordEntityType} onValueChange={(v) => setRecordEntityType(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="case">Case</SelectItem>
                      <SelectItem value="project">Project</SelectItem>
                      <SelectItem value="developer">Developer</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="mt-2">
                    <Input value={targetEntityId} onChange={(e) => setTargetEntityId(e.target.value)} placeholder="Record ID" />
                  </div>
                </div>
              ) : snapshotType === "settings" ? (
                <div className="space-y-1">
                  <div className="text-xs text-slate-500">Settings group</div>
                  <Select value={settingsGroup} onValueChange={(v) => setSettingsGroup(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="firm_profile">Firm profile</SelectItem>
                      <SelectItem value="bank_accounts">Bank accounts</SelectItem>
                    </SelectContent>
                  </Select>
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
        open={rollbackDialogOpen}
        onOpenChange={setRollbackDialogOpen}
        title="Rollback (undo restore)"
        preview={rollbackPreview}
        requiredConfirmationText={rollbackRequiredText}
        governance={rollbackGovernance}
        stepUp={rollbackStepUp}
        canRequestApproval={hasFounderPermission(user, "founder.approval.request")}
        onRequestApproval={async (payload) => {
          if (!rollbackActionId) throw new Error("Missing rollback_action_id");
          const res = await apiFetchJson(`/platform/firms/${firmId}/recovery/rollback/request-approval`, {
            method: "POST",
            body: JSON.stringify({ rollback_action_id: rollbackActionId, reason: payload.reason, detailed_note: payload.detailed_note, emergency_flag: payload.emergency_flag }),
          });
          const data = unwrapApiData<any>(res);
          const approval = data.approval ?? data;
          return { id: String(approval.id), requestCode: String(approval.requestCode ?? ""), status: String(approval.status ?? "") };
        }}
        requireFirmName={true}
        firmNameHint={firmName}
        requireTargetLabel={false}
        targetLabelHint={null}
        isExecuting={rollbackMutation.isPending}
        onExecute={(payload) => rollbackMutation.mutateAsync(payload)}
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
