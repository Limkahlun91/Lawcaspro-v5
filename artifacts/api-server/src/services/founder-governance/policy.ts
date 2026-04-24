export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ScopeType = "record" | "module" | "settings" | "firm";

export type FounderRoleLevel = "viewer" | "operator" | "admin" | "super_admin";

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

const has = (perms: Set<string>, code: string): boolean => perms.has(code);

function requiredExecutePermission(actionCode: string): string | null {
  if (actionCode.startsWith("reset_case_")) return "founder.maintenance.reset.record";
  if (actionCode === "reset_projects_module") return "founder.maintenance.reset.module";
  if (actionCode === "reset_settings_default" || actionCode === "reset_settings_last_snapshot") return "founder.maintenance.reset.firm";
  if (actionCode === "force_logout_sessions") return "founder.maintenance.bulk.execute";
  if (
    actionCode === "recalculate_stats" ||
    actionCode === "rebuild_reports" ||
    actionCode === "reindex_documents" ||
    actionCode === "clear_failed_jobs" ||
    actionCode === "repair_derived_data"
  ) {
    return "founder.maintenance.rebuild";
  }
  if (actionCode === "rollback_restore") return "founder.recovery.execute";
  if (actionCode.startsWith("restore") || actionCode === "restore_snapshot") return "founder.snapshot.restore.execute";
  return null;
}

export function evaluateGovernancePolicy(params: {
  actionCode: string;
  riskLevel: RiskLevel;
  scopeType: ScopeType;
  moduleCode?: string | null;
  actorPermissions: Set<string>;
  impersonation: boolean;
  emergency: boolean;
  stage: "preview" | "execute";
}): GovernanceDecision {
  const perms = params.actorPermissions;
  const requiredPerm = requiredExecutePermission(params.actionCode);
  const missing = requiredPerm && !has(perms, requiredPerm) ? [requiredPerm] : [];

  const typedRequired = params.riskLevel !== "low";
  const supportMode = params.impersonation;
  const challengeRequired = params.riskLevel === "critical" || (supportMode && params.riskLevel === "high");
  const cooldown = params.riskLevel === "critical" || (supportMode && params.riskLevel === "high") ? 10 : 0;

  if (missing.length && params.stage === "execute") {
    return {
      allowedDirectExecute: false,
      approvalRequired: false,
      requiredApprovalCount: 0,
      selfApprovalAllowed: false,
      typedConfirmationRequired: typedRequired,
      challengePhraseRequired: challengeRequired,
      cooldownSecondsRequired: cooldown,
      missingPermissions: missing,
      blockedReason: { code: "PERMISSION_DENIED", message: "Execution permission denied for this action" },
      approvalPolicyCode: "permission_denied",
    };
  }

  if (params.emergency) {
    if (!has(perms, "founder.approval.emergency")) {
      return {
        allowedDirectExecute: false,
        approvalRequired: false,
        requiredApprovalCount: 0,
        selfApprovalAllowed: false,
        typedConfirmationRequired: true,
        challengePhraseRequired: true,
        cooldownSecondsRequired: 10,
        missingPermissions: missing.length ? missing : undefined,
        blockedReason: { code: "PERMISSION_DENIED", message: "Emergency mode requires additional permissions." },
        approvalPolicyCode: "emergency_denied",
      };
    }
  }

  if (params.riskLevel === "low") {
    return {
      allowedDirectExecute: true,
      approvalRequired: false,
      requiredApprovalCount: 0,
      selfApprovalAllowed: false,
      typedConfirmationRequired: false,
      challengePhraseRequired: false,
      cooldownSecondsRequired: 0,
      missingPermissions: missing.length ? missing : undefined,
      approvalPolicyCode: "direct_low",
    };
  }

  if (params.riskLevel === "medium") {
    return {
      allowedDirectExecute: missing.length === 0,
      approvalRequired: false,
      requiredApprovalCount: 0,
      selfApprovalAllowed: false,
      typedConfirmationRequired: typedRequired,
      challengePhraseRequired: false,
      cooldownSecondsRequired: 0,
      missingPermissions: missing.length ? missing : undefined,
      approvalPolicyCode: "direct_medium",
    };
  }

  if (params.riskLevel === "high") {
    const allowed = has(perms, "founder.maintenance.reset.module")
      || has(perms, "founder.maintenance.reset.firm")
      || has(perms, "founder.snapshot.restore.execute")
      || has(perms, "founder.recovery.execute");

    if (!allowed || missing.length) {
      return {
        allowedDirectExecute: false,
        approvalRequired: params.stage === "preview",
        requiredApprovalCount: params.stage === "preview" ? 1 : 0,
        selfApprovalAllowed: false,
        typedConfirmationRequired: true,
        challengePhraseRequired: false,
        cooldownSecondsRequired: 0,
        missingPermissions: missing.length ? missing : undefined,
        blockedReason: params.stage === "execute" ? { code: "PERMISSION_DENIED", message: "High-risk execution permission required." } : undefined,
        approvalPolicyCode: params.stage === "preview" ? "approval_high" : "high_denied",
      };
    }

    return {
      allowedDirectExecute: false,
      approvalRequired: true,
      requiredApprovalCount: 1,
      selfApprovalAllowed: false,
      typedConfirmationRequired: typedRequired,
      challengePhraseRequired: false,
      cooldownSecondsRequired: 0,
      missingPermissions: undefined,
      approvalPolicyCode: "approval_high",
    };
  }

  const criticalAllowed = has(perms, "founder.snapshot.restore.critical") || has(perms, "founder.recovery.critical");
  if ((!criticalAllowed || missing.length) && !params.emergency) {
    return {
      allowedDirectExecute: false,
      approvalRequired: params.stage === "preview",
      requiredApprovalCount: params.stage === "preview" ? 2 : 0,
      selfApprovalAllowed: false,
      typedConfirmationRequired: true,
      challengePhraseRequired: true,
      cooldownSecondsRequired: 10,
      missingPermissions: missing.length ? missing : undefined,
      blockedReason: params.stage === "execute" ? { code: "CRITICAL_PERMISSION_REQUIRED", message: "Critical execution permission required." } : undefined,
      approvalPolicyCode: params.stage === "preview" ? "approval_critical" : "critical_denied",
    };
  }

  return {
    allowedDirectExecute: false,
    approvalRequired: true,
    requiredApprovalCount: params.emergency ? 1 : 2,
    selfApprovalAllowed: false,
    typedConfirmationRequired: true,
    challengePhraseRequired: challengeRequired,
    cooldownSecondsRequired: cooldown,
    missingPermissions: undefined,
    approvalPolicyCode: params.emergency ? "emergency_critical" : "approval_critical",
  };
}
