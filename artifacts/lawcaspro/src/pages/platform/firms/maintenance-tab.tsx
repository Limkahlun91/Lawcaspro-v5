import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { DangerActionDialog, type DangerPreview, type GovernanceDecision, type StepUpInfo } from "@/components/danger-action-dialog";
import { RiskBadge } from "@/components/risk-badge";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";

type ActionCode =
  | "recalculate_stats"
  | "rebuild_reports"
  | "reindex_documents"
  | "clear_failed_jobs"
  | "force_logout_sessions"
  | "repair_derived_data"
  | "reset_settings_default"
  | "reset_projects_module"
  | "reset_case_workflow"
  | "reset_case_generated_docs"
  | "reset_case_progress_metadata"
  | "reset_case_full_soft";

type SearchEntity = "case" | "project";

type PreviewResponse = {
  preview: DangerPreview;
  action_id: string;
  required_confirmation: string | null;
  governance?: GovernanceDecision;
  step_up?: StepUpInfo | null;
};

function ActionCard({
  title,
  description,
  risk,
  onPreview,
}: {
  title: string;
  description: string;
  risk: "low" | "medium" | "high" | "critical";
  onPreview: () => void;
}) {
  return (
    <div className="rounded border border-slate-200 p-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-medium text-slate-900">{title}</div>
          <RiskBadge level={risk} />
        </div>
        <div className="text-sm text-slate-500 mt-1">{description}</div>
      </div>
      <Button variant="outline" className="shrink-0" onClick={onPreview}>Preview</Button>
    </div>
  );
}

export function FirmMaintenanceTab({ firmId, firmName }: { firmId: number; firmName: string }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTitle, setDialogTitle] = useState("");
  const [preview, setPreview] = useState<DangerPreview | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [requiredText, setRequiredText] = useState<string | null>(null);
  const [governance, setGovernance] = useState<GovernanceDecision | null>(null);
  const [stepUp, setStepUp] = useState<StepUpInfo | null>(null);
  const [requireFirmName, setRequireFirmName] = useState(false);
  const [requireTarget, setRequireTarget] = useState(false);
  const [targetHint, setTargetHint] = useState<string | null>(null);

  const openPreview = async (title: string, action_code: ActionCode, target?: { entity_type: string; entity_id: string; label?: string }) => {
    setDialogTitle(title);
    setPreview(null);
    setActionId(null);
    setRequiredText(null);
    setGovernance(null);
    setStepUp(null);
    setRequireFirmName(false);
    setRequireTarget(false);
    setTargetHint(null);
    setDialogOpen(true);
    try {
      const res = await apiFetchJson(`/platform/firms/${firmId}/maintenance/preview`, {
        method: "POST",
        body: JSON.stringify({ action_code, target }),
      });
      const data = unwrapApiData<PreviewResponse>(res);
      setPreview(data.preview);
      setActionId(data.action_id);
      setRequiredText(data.required_confirmation ?? null);
      setGovernance(data.governance ?? null);
      setStepUp(data.step_up ?? null);
      const risk = data.preview.risk_level;
      if (risk === "critical") setRequireFirmName(true);
      if (data.preview.target?.label) {
        setRequireTarget(risk === "high" || risk === "critical");
        setTargetHint(data.preview.target.label);
      }
    } catch (e) {
      toastError(toast, e, "Preview failed");
      setDialogOpen(false);
    }
  };

  const executeMutation = useMutation({
    mutationFn: async (payload: { reason: string; typed_confirmation: string | null; confirm_firm: string | null; confirm_target: string | null; approval_request_id: string | null; step_up_challenge_id: string | null; step_up_phrase: string | null; emergency_flag: boolean }) => {
      if (!actionId) throw new Error("Missing action_id");
      const res = await apiFetchJson(`/platform/firms/${firmId}/maintenance/execute`, {
        method: "POST",
        body: JSON.stringify({ action_id: actionId, reason: payload.reason, typed_confirmation: payload.typed_confirmation, confirm_firm: payload.confirm_firm, confirm_target: payload.confirm_target, approval_request_id: payload.approval_request_id, step_up_challenge_id: payload.step_up_challenge_id, step_up_phrase: payload.step_up_phrase, emergency_flag: payload.emergency_flag }),
      });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["platform-firm-history", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-snapshots", firmId] });
      await qc.invalidateQueries({ queryKey: ["platform-firm-maint-actions", firmId] });
      setDialogOpen(false);
    },
    onError: (e) => toastError(toast, e, "Execution failed"),
  });

  const [entityType, setEntityType] = useState<SearchEntity>("case");
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<any>(null);

  const searchQuery = useQuery({
    queryKey: ["platform-maint-search", firmId, entityType, keyword],
    queryFn: async () => {
      const params = new URLSearchParams({ entity_type: entityType, q: keyword, limit: "10" });
      const res = await apiFetchJson(`/platform/firms/${firmId}/maintenance/search?${params.toString()}`);
      return unwrapApiData<{ items: any[] }>(res);
    },
    enabled: keyword.trim().length >= 2,
    retry: false,
  });

  const searchItems = searchQuery.data?.items ?? [];
  const canShowCaseActions = selected?.entity_type === "case";

  const recordActions = useMemo(() => {
    if (!canShowCaseActions) return [];
    return [
      { code: "reset_case_workflow" as const, title: "Reset workflow/status", risk: "high" as const, desc: "Keeps the base case record, resets workflow steps to pending." },
      { code: "reset_case_generated_docs" as const, title: "Reset generated documents", risk: "high" as const, desc: "Archives generated case documents and soft-deletes workflow uploads." },
      { code: "reset_case_progress_metadata" as const, title: "Reset progress metadata", risk: "high" as const, desc: "Clears workflow completion and key date progress fields." },
      { code: "reset_case_full_soft" as const, title: "Full soft reset (initial state)", risk: "critical" as const, desc: "Resets workflow, generated outputs, and progress metadata. Snapshot required." },
    ];
  }, [canShowCaseActions]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Safe Maintenance Tools</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ActionCard
            title="Recalculate statistics"
            description="Recompute key counts used in dashboards and summaries."
            risk="low"
            onPreview={() => openPreview("Recalculate statistics", "recalculate_stats")}
          />
          <ActionCard
            title="Rebuild dashboard cache"
            description="Rebuilds firm dashboard stats cache to reduce load and improve dashboard responsiveness."
            risk="medium"
            onPreview={() => openPreview("Rebuild dashboard cache", "rebuild_reports")}
          />
          <ActionCard
            title="Reindex documents checklist metadata"
            description="Resets derived checklist/applicability metadata so it can be recomputed safely."
            risk="medium"
            onPreview={() => openPreview("Reindex documents checklist metadata", "reindex_documents")}
          />
          <ActionCard
            title="Clear failed document jobs"
            description="Archives failed document batch/extraction jobs for this firm (metadata is preserved)."
            risk="low"
            onPreview={() => openPreview("Clear failed document jobs", "clear_failed_jobs")}
          />
          <ActionCard
            title="Force logout all firm sessions"
            description="Invalidates all active sessions for users in this firm."
            risk="medium"
            onPreview={() => openPreview("Force logout all firm sessions", "force_logout_sessions")}
          />
          <ActionCard
            title="Repair derived document links"
            description="Repairs orphaned checklist links that reference missing uploads."
            risk="medium"
            onPreview={() => openPreview("Repair derived document links", "repair_derived_data")}
          />
          <ActionCard
            title="Reset settings to default"
            description="Resets firm settings fields and clears bank accounts. Pre-action snapshot required."
            risk="high"
            onPreview={() => openPreview("Reset settings to default", "reset_settings_default")}
          />
          <ActionCard
            title="Reset projects module"
            description="Archives all projects if no active cases exist. Pre-action snapshot required."
            risk="high"
            onPreview={() => openPreview("Reset projects module", "reset_projects_module")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Record Reset</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <div className="text-xs text-slate-500 mb-1">Entity</div>
              <Select value={entityType} onValueChange={(v) => { setEntityType(v as SearchEntity); setSelected(null); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="case">Case</SelectItem>
                  <SelectItem value="project">Project</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <div className="text-xs text-slate-500 mb-1">Keyword</div>
              <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Search (min 2 chars)..." />
            </div>
          </div>

          {searchQuery.isError ? (
            <QueryFallback title="Search unavailable" error={searchQuery.error} onRetry={() => searchQuery.refetch()} isRetrying={searchQuery.isFetching} />
          ) : keyword.trim().length < 2 ? (
            <div className="text-sm text-slate-500">Enter at least 2 characters to search.</div>
          ) : searchQuery.isLoading ? (
            <div className="text-sm text-slate-500">Searching...</div>
          ) : searchItems.length === 0 ? (
            <div className="text-sm text-slate-500">No matching records found.</div>
          ) : (
            <div className="rounded border border-slate-200 divide-y">
              {searchItems.map((it) => (
                <button
                  key={`${it.entity_type}:${it.id}`}
                  className={`w-full text-left px-3 py-2 hover:bg-slate-50 ${selected?.id === it.id ? "bg-amber-50" : ""}`}
                  onClick={() => setSelected(it)}
                >
                  <div className="text-sm font-medium text-slate-900">{String(it.label ?? it.name ?? it.referenceNo ?? it.id)}</div>
                  <div className="text-xs text-slate-500">ID: {String(it.id)}</div>
                </button>
              ))}
            </div>
          )}

          {selected ? (
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">Selected</div>
              <div className="text-sm font-medium text-slate-900">{String(selected.label ?? selected.name ?? selected.referenceNo ?? selected.id)}</div>
              {canShowCaseActions ? (
                <div className="mt-3 space-y-2">
                  {recordActions.map((a) => (
                    <div key={a.code} className="rounded border border-slate-200 p-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-medium text-slate-900">{a.title}</div>
                          <RiskBadge level={a.risk} />
                        </div>
                        <div className="text-xs text-slate-500 mt-1">{a.desc}</div>
                      </div>
                      <Button variant="outline" onClick={() => openPreview(a.title, a.code, { entity_type: "case", entity_id: String(selected.id), label: String(selected.label ?? selected.referenceNo ?? selected.id) })}>
                        Preview
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-slate-500 mt-2">Record-level reset for this entity is not implemented in this phase.</div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Module Reset</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ActionCard
            title="Projects"
            description="Archives all projects (blocked if active cases exist)."
            risk="high"
            onPreview={() => openPreview("Reset projects module", "reset_projects_module")}
          />
        </CardContent>
      </Card>

      <DangerActionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={dialogTitle}
        preview={preview}
        requiredConfirmationText={requiredText}
        governance={governance}
        stepUp={stepUp}
        canRequestApproval={hasFounderPermission(user, "founder.approval.request")}
        onRequestApproval={async (payload) => {
          if (!actionId) throw new Error("Missing action_id");
          const res = await apiFetchJson(`/platform/firms/${firmId}/maintenance/request-approval`, {
            method: "POST",
            body: JSON.stringify({ action_id: actionId, reason: payload.reason, detailed_note: payload.detailed_note, emergency_flag: payload.emergency_flag }),
          });
          const data = unwrapApiData<{ approval: { id: string; requestCode: string; status: string } }>(res);
          return data.approval;
        }}
        requireFirmName={requireFirmName}
        firmNameHint={requireFirmName ? firmName : null}
        requireTargetLabel={requireTarget}
        targetLabelHint={targetHint}
        isExecuting={executeMutation.isPending}
        onExecute={(payload) => executeMutation.mutateAsync(payload)}
      />
    </div>
  );
}
