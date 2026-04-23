import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { RiskBadge, type RiskLevel } from "@/components/risk-badge";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";

export type ImpactSummary = Record<string, number>;

export type GovernanceDecision = {
  allowedDirectExecute: boolean;
  approvalRequired: boolean;
  requiredApprovalCount: number;
  selfApprovalAllowed: boolean;
  typedConfirmationRequired: boolean;
  challengePhraseRequired: boolean;
  cooldownSecondsRequired: number;
  missingPermissions?: string[];
  blockedReason?: { code: string; message: string };
  approvalPolicyCode: string;
};

export type StepUpInfo = {
  id: string;
  requiredPhrase: string;
  expiresAt: string;
  notBeforeAt: string | null;
};

export type DangerPreview = {
  action_code: string;
  scope_type: string;
  module_code?: string;
  target?: { entity_type: string; entity_id: string; label?: string };
  risk_level: RiskLevel;
  requires_snapshot: boolean;
  snapshot_strategy?: string;
  impact_summary: ImpactSummary;
  dependency_summary?: { has_blockers: boolean; blocking_items: Array<{ type: string; id: string; label?: string }> };
  warnings?: Array<{ code: string; message: string }>;
  restore_availability?: { available: boolean; recommended_snapshot_type?: string; notes?: string };
};

export function DangerActionDialog({
  open,
  onOpenChange,
  title,
  preview,
  requiredConfirmationText,
  governance,
  stepUp,
  canRequestApproval,
  onRequestApproval,
  requireFirmName,
  firmNameHint,
  requireTargetLabel,
  targetLabelHint,
  onExecute,
  isExecuting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  preview: DangerPreview | null;
  requiredConfirmationText: string | null;
  governance?: GovernanceDecision | null;
  stepUp?: StepUpInfo | null;
  canRequestApproval?: boolean;
  onRequestApproval?: (payload: { reason: string; detailed_note: string | null; emergency_flag: boolean }) => Promise<{ id: string; requestCode: string; status: string }>;
  requireFirmName?: boolean;
  firmNameHint?: string | null;
  requireTargetLabel?: boolean;
  targetLabelHint?: string | null;
  onExecute: (payload: { reason: string; typed_confirmation: string | null; confirm_firm: string | null; confirm_target: string | null; approval_request_id: string | null; step_up_challenge_id: string | null; step_up_phrase: string | null; emergency_flag: boolean }) => Promise<unknown>;
  isExecuting?: boolean;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [confirmFirm, setConfirmFirm] = useState("");
  const [confirmTarget, setConfirmTarget] = useState("");
  const [approvalRequestId, setApprovalRequestId] = useState("");
  const [stepUpPhrase, setStepUpPhrase] = useState("");
  const [approval, setApproval] = useState<{ id: string; requestCode: string; status: string } | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [emergencyFlag, setEmergencyFlag] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const blockers = preview?.dependency_summary?.blocking_items ?? [];
  const hasBlockers = !!preview?.dependency_summary?.has_blockers;

  const impactPairs = useMemo(() => {
    const obj = preview?.impact_summary ?? {};
    return Object.entries(obj).filter(([, v]) => Number(v) !== 0);
  }, [preview]);

  const canContinueReason = reason.trim().length >= 10;
  const canContinueConfirm = (() => {
    if (!preview) return false;
    if (requiredConfirmationText && typed.trim() !== requiredConfirmationText) return false;
    if (requireFirmName && firmNameHint && confirmFirm.trim() !== firmNameHint.trim()) return false;
    if (requireTargetLabel && targetLabelHint && confirmTarget.trim() !== targetLabelHint.trim()) return false;
    if (governance?.challengePhraseRequired) {
      if (!stepUp) return false;
      if (stepUpPhrase.trim() !== stepUp.requiredPhrase.trim()) return false;
      if (stepUp.notBeforeAt && nowMs < new Date(stepUp.notBeforeAt).getTime()) return false;
    }
    return true;
  })();

  const reset = () => {
    setStep(1);
    setReason("");
    setTyped("");
    setConfirmFirm("");
    setConfirmTarget("");
    setApprovalRequestId("");
    setStepUpPhrase("");
    setApproval(null);
    setApprovalNote("");
    setEmergencyFlag(false);
    setResult(null);
  };

  const close = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const execute = async () => {
    try {
      const r = await onExecute({
        reason: reason.trim(),
        typed_confirmation: requiredConfirmationText ? typed.trim() : null,
        confirm_firm: requireFirmName ? confirmFirm.trim() : null,
        confirm_target: requireTargetLabel ? confirmTarget.trim() : null,
        approval_request_id: approvalRequestId.trim() ? approvalRequestId.trim() : null,
        step_up_challenge_id: stepUp?.id ?? null,
        step_up_phrase: stepUpPhrase.trim() ? stepUpPhrase.trim() : null,
        emergency_flag: emergencyFlag,
      });
      setResult(r);
      setStep(4);
      toast({ title: "Action executed", description: "Operation completed. Review Action History for details." });
    } catch (e) {
      toastError(toast, e, "Execution failed");
    }
  };

  const requestApproval = async () => {
    if (!onRequestApproval) return;
    try {
      const r = await onRequestApproval({
        reason: reason.trim(),
        detailed_note: approvalNote.trim() ? approvalNote.trim() : null,
        emergency_flag: emergencyFlag,
      });
      setApproval(r);
      toast({ title: "Approval requested", description: `Request ${r.requestCode} submitted.` });
    } catch (e) {
      toastError(toast, e, "Failed to request approval");
    }
  };

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3">
            <span className="truncate">{title}</span>
            {preview ? <RiskBadge level={preview.risk_level} /> : null}
          </DialogTitle>
        </DialogHeader>

        {!preview ? (
          <div className="text-sm text-slate-500">Loading preview...</div>
        ) : step === 1 ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded border border-slate-200 p-3">
                <div className="text-xs text-slate-500">Scope</div>
                <div className="text-sm font-medium text-slate-900">
                  {preview.scope_type}{preview.module_code ? ` · ${preview.module_code}` : ""}
                </div>
              </div>
              <div className="rounded border border-slate-200 p-3">
                <div className="text-xs text-slate-500">Target</div>
                <div className="text-sm font-medium text-slate-900">
                  {preview.target?.label ?? ((`${preview.target?.entity_type ?? "firm"} ${preview.target?.entity_id ?? ""}`.trim()) || "Firm")}
                </div>
              </div>
            </div>

            <div className="rounded border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-900">Impact summary</div>
                <div className="text-xs text-slate-500">{preview.requires_snapshot ? "Pre-action snapshot required" : "No snapshot required"}</div>
              </div>
              <Separator className="my-2" />
              {impactPairs.length === 0 ? (
                <div className="text-sm text-slate-500">No direct changes detected.</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {impactPairs.map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1">
                      <span className="text-xs text-slate-600">{k}</span>
                      <span className="text-xs font-medium text-slate-900">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {preview.warnings?.length ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-3">
                <div className="text-sm font-medium text-amber-900">Warnings</div>
                <ul className="mt-2 space-y-1">
                  {preview.warnings.map((w) => (
                    <li key={w.code} className="text-sm text-amber-800">{w.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {hasBlockers ? (
              <div className="rounded border border-red-200 bg-red-50 p-3">
                <div className="text-sm font-medium text-red-900">Blocked by dependencies</div>
                <ul className="mt-2 space-y-1">
                  {blockers.map((b) => (
                    <li key={`${b.type}:${b.id}`} className="text-sm text-red-800">{b.label ?? `${b.type} ${b.id}`}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : step === 2 ? (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium text-slate-900">Reason</div>
              <div className="text-xs text-slate-500">Explain why this action is needed (min 10 characters).</div>
            </div>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason..." className="min-h-[120px]" />
          </div>
        ) : step === 3 ? (
          <div className="space-y-4">
            <div className="text-sm text-slate-600">
              Type the confirmation text to proceed.
            </div>
            {requiredConfirmationText ? (
              <div className="space-y-2">
                <div className="text-xs text-slate-500">Required</div>
                <div className="rounded bg-slate-50 px-2 py-1 text-sm font-mono text-slate-900">{requiredConfirmationText}</div>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type confirmation..." />
              </div>
            ) : null}

            {requireFirmName ? (
              <div className="space-y-2">
                <div className="text-xs text-slate-500">Confirm firm name</div>
                <Input value={confirmFirm} onChange={(e) => setConfirmFirm(e.target.value)} placeholder={firmNameHint ?? "Firm name"} />
              </div>
            ) : null}

            {requireTargetLabel ? (
              <div className="space-y-2">
                <div className="text-xs text-slate-500">Confirm target identifier</div>
                <Input value={confirmTarget} onChange={(e) => setConfirmTarget(e.target.value)} placeholder={targetLabelHint ?? "Target identifier"} />
              </div>
            ) : null}

            {governance?.approvalRequired ? (
              <div className="space-y-2">
                <div className="text-xs text-slate-500">Approval required</div>
                <div className="text-sm text-slate-700">
                  This action requires approval before execution.
                </div>
                <Input value={approvalRequestId} onChange={(e) => setApprovalRequestId(e.target.value)} placeholder="Approval request ID (after approval)" />
                {approval ? (
                  <div className="text-xs text-slate-500">Requested: {approval.requestCode} ({approval.status})</div>
                ) : null}
                {canRequestApproval ? (
                  <div className="space-y-2">
                    <Input value={approvalNote} onChange={(e) => setApprovalNote(e.target.value)} placeholder="Optional note for approver" />
                    <Button variant="outline" onClick={requestApproval} disabled={!canContinueReason || !!approval || !!isExecuting}>
                      Submit for Approval
                    </Button>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">You do not have permission to submit approval requests.</div>
                )}
              </div>
            ) : null}

            {governance?.challengePhraseRequired && stepUp ? (
              <div className="space-y-2">
                <div className="text-xs text-slate-500">Challenge phrase</div>
                <div className="rounded bg-slate-50 px-2 py-1 text-sm font-mono text-slate-900">{stepUp.requiredPhrase}</div>
                {stepUp.notBeforeAt ? (
                  <div className="text-xs text-slate-500">
                    Earliest execute time: {new Date(stepUp.notBeforeAt).toLocaleString()}
                  </div>
                ) : null}
                <Input value={stepUpPhrase} onChange={(e) => setStepUpPhrase(e.target.value)} placeholder="Type the challenge phrase..." />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm font-medium text-slate-900">Result</div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <pre className="text-xs whitespace-pre-wrap break-words text-slate-700">{JSON.stringify(result, null, 2)}</pre>
            </div>
            <div className="text-sm text-slate-500">Action History contains the full trace.</div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={() => close(false)}>Close</Button>
              <Button disabled={!preview || hasBlockers} onClick={() => setStep(2)}>Continue</Button>
            </>
          ) : step === 2 ? (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button disabled={!canContinueReason} onClick={() => setStep(3)}>Continue</Button>
            </>
          ) : step === 3 ? (
            <>
              <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
              <Button disabled={!canContinueConfirm || !!isExecuting || (governance?.approvalRequired && !approvalRequestId.trim())} onClick={execute}>
                {isExecuting ? "Executing..." : (governance?.approvalRequired ? "Execute (with Approval)" : "Final Execute")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>Close</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
