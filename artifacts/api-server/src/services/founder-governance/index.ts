import crypto from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  platformApprovalEventsTable,
  platformApprovalRequestsTable,
  platformFounderRolePermissionsTable,
  platformFounderRolesTable,
  platformFounderUserRolesTable,
  platformStepUpChallengesTable,
  supportSessionsTable,
  type RlsDb,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response";
import { writeAuditLog, type AuthRequest } from "../../lib/auth";
import { evaluateGovernancePolicy, type GovernanceDecision, type RiskLevel, type ScopeType } from "./policy";

export type FounderGovernanceContext = {
  actorUserId: number;
  actorEmail: string | null;
  impersonation: { active: boolean; supportSessionId: number | null; targetFirmId: number | null };
  permissions: Set<string>;
  highestRoleLevel: string | null;
};

export async function getImpersonationContext(authDb: RlsDb, req: AuthRequest): Promise<FounderGovernanceContext["impersonation"]> {
  const header = req.headers["x-support-session-id"];
  const cookie = (req.cookies?.["support_session_id"] ?? req.cookies?.["supportSessionId"]) as unknown;
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : typeof cookie === "string" ? cookie : undefined;
  const id = raw ? Number.parseInt(String(raw), 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) return { active: false, supportSessionId: null, targetFirmId: null };

  const [s] = await authDb.select().from(supportSessionsTable).where(eq(supportSessionsTable.id, id));
  const now = new Date();
  const expired = s?.expiresAt ? s.expiresAt < now : false;
  const approved = s?.status === "approved";
  const ownedByCaller = !!s && s.founderId === req.userId;
  const ended = !!s?.endedAt;
  const active = !!s && approved && ownedByCaller && !ended && !expired;
  if (!active) return { active: false, supportSessionId: id, targetFirmId: s?.targetFirmId ?? null };

  return { active: true, supportSessionId: s.id, targetFirmId: s.targetFirmId };
}

export async function loadFounderGovernanceContext(authDb: RlsDb, req: AuthRequest): Promise<FounderGovernanceContext> {
  if (!req.userId || req.userType !== "founder") {
    throw new ApiError({ status: 403, code: "FOUNDER_ROLE_REQUIRED", message: "Founder access required", retryable: false });
  }

  const rows = await authDb
    .select({
      perm: platformFounderRolePermissionsTable.permissionCode,
      level: platformFounderRolesTable.level,
    })
    .from(platformFounderUserRolesTable)
    .innerJoin(platformFounderRolesTable, eq(platformFounderUserRolesTable.roleId, platformFounderRolesTable.id))
    .innerJoin(platformFounderRolePermissionsTable, eq(platformFounderRolesTable.id, platformFounderRolePermissionsTable.roleId))
    .where(eq(platformFounderUserRolesTable.userId, req.userId));

  const permissions = new Set(rows.map((r) => r.perm).filter((p): p is string => typeof p === "string" && p.length > 0));
  const highestRoleLevel = rows.reduce<string | null>((acc, r) => {
    const lvl = typeof r.level === "string" ? r.level : null;
    if (!acc) return lvl;
    const rank = (x: string | null): number => x === "super_admin" ? 4 : x === "admin" ? 3 : x === "operator" ? 2 : x === "viewer" ? 1 : 0;
    return rank(lvl) > rank(acc) ? lvl : acc;
  }, null);

  const impersonation = await getImpersonationContext(authDb, req);

  return {
    actorUserId: req.userId,
    actorEmail: req.email ?? null,
    impersonation,
    permissions,
    highestRoleLevel,
  };
}

export function assertFounderPermission(ctx: FounderGovernanceContext, permissionCode: string): void {
  if (!ctx.permissions.has(permissionCode)) {
    throw new ApiError({ status: 403, code: "PERMISSION_DENIED", message: "Permission denied", retryable: false, details: { permission: permissionCode } });
  }
}

export function assertActiveSupportSessionForFirm(ctx: FounderGovernanceContext, firmId: number): void {
  if (!ctx.impersonation.active || ctx.impersonation.targetFirmId !== firmId) {
    throw new ApiError({
      status: 403,
      code: "SUPPORT_SESSION_REQUIRED",
      message: "Active, firm-approved support session is required for this action",
      retryable: false,
      details: { firm_id: firmId, support_session_id: ctx.impersonation.supportSessionId, target_firm_id: ctx.impersonation.targetFirmId },
    });
  }
}

function makeRequestCode(prefix: string): string {
  const raw = crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
  return `${prefix}-${raw}`;
}

export async function createStepUpChallenge(authDb: RlsDb, params: {
  firmId: number;
  actionCode: string;
  riskLevel: RiskLevel;
  scopeType: ScopeType;
  moduleCode?: string | null;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  requiredPhrase: string;
  cooldownSeconds: number;
  expiresInSeconds: number;
  issuedToUserId: number;
  issuedToEmail: string | null;
}): Promise<{ id: string; requiredPhrase: string; expiresAt: string; notBeforeAt: string | null }> {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + params.expiresInSeconds * 1000);
  const notBeforeAt = params.cooldownSeconds > 0 ? new Date(issuedAt.getTime() + params.cooldownSeconds * 1000) : null;
  const id = crypto.randomUUID();

  await authDb.insert(platformStepUpChallengesTable).values({
    id,
    firmId: params.firmId,
    actionCode: params.actionCode,
    riskLevel: params.riskLevel,
    scopeType: params.scopeType,
    moduleCode: params.moduleCode ?? null,
    targetEntityType: params.targetEntityType ?? null,
    targetEntityId: params.targetEntityId ?? null,
    issuedToUserId: params.issuedToUserId,
    issuedToEmail: params.issuedToEmail ?? null,
    issuedAt,
    notBeforeAt,
    expiresAt,
    requiredPhrase: params.requiredPhrase,
  });

  return {
    id,
    requiredPhrase: params.requiredPhrase,
    expiresAt: expiresAt.toISOString(),
    notBeforeAt: notBeforeAt ? notBeforeAt.toISOString() : null,
  };
}

export async function consumeStepUpChallenge(authDb: RlsDb, params: {
  challengeId: string;
  firmId: number;
  actionCode: string;
  actorUserId: number;
  providedPhrase: string;
}): Promise<void> {
  const [c] = await authDb.select().from(platformStepUpChallengesTable).where(eq(platformStepUpChallengesTable.id, params.challengeId));
  if (!c) throw new ApiError({ status: 404, code: "STEP_UP_REQUIRED", message: "Step-up verification required", retryable: false });
  if (c.firmId !== params.firmId || c.actionCode !== params.actionCode || c.issuedToUserId !== params.actorUserId) {
    throw new ApiError({ status: 403, code: "STEP_UP_REQUIRED", message: "Step-up verification required", retryable: false });
  }
  if (c.consumedAt) throw new ApiError({ status: 409, code: "STEP_UP_REQUIRED", message: "Step-up verification required", retryable: false });
  if (c.expiresAt < new Date()) throw new ApiError({ status: 409, code: "STEP_UP_REQUIRED", message: "Step-up verification expired", retryable: false });
  if (c.notBeforeAt && c.notBeforeAt > new Date()) {
    throw new ApiError({ status: 409, code: "STEP_UP_REQUIRED", message: "Please wait before executing this action", retryable: true, details: { not_before_at: c.notBeforeAt.toISOString() } });
  }
  if (String(params.providedPhrase).trim() !== String(c.requiredPhrase).trim()) {
    throw new ApiError({ status: 400, code: "STEP_UP_REQUIRED", message: "Step-up verification text does not match", retryable: false });
  }

  await authDb.update(platformStepUpChallengesTable).set({
    consumedAt: new Date(),
    consumedByUserId: params.actorUserId,
  }).where(eq(platformStepUpChallengesTable.id, params.challengeId));
}

export function defaultStepUpPhrase(params: { actionCode: string; firmSlugOrName?: string | null; snapshotCodeOrId?: string | null }): string {
  if (params.actionCode.includes("restore")) {
    const snap = params.snapshotCodeOrId ? String(params.snapshotCodeOrId) : "<snapshot>";
    return `RESTORE FROM SNAPSHOT ${snap}`;
  }
  const firm = params.firmSlugOrName ? String(params.firmSlugOrName) : "<firm>";
  return `RESET FIRM ${firm}`;
}

export async function createApprovalRequest(authDb: RlsDb, params: {
  firmId: number;
  actionCode: string;
  riskLevel: RiskLevel;
  scopeType: ScopeType;
  moduleCode?: string | null;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  targetLabel?: string | null;
  snapshotId?: string | null;
  operationType: "maintenance_action" | "restore_action";
  operationId: string;
  requestedByUserId: number;
  requestedByEmail: string | null;
  reason: string;
  detailedNote?: string | null;
  approvalPolicyCode: string;
  requiredApprovals: number;
  selfApprovalAllowed: boolean;
  expiresAt?: Date | null;
  emergencyFlag: boolean;
  impersonationFlag: boolean;
  policyResultJson?: unknown;
}): Promise<{ id: string; requestCode: string; status: string }> {
  const id = crypto.randomUUID();
  const requestCode = makeRequestCode("APR");

  await authDb.insert(platformApprovalRequestsTable).values({
    id,
    requestCode,
    firmId: params.firmId,
    actionCode: params.actionCode,
    riskLevel: params.riskLevel,
    scopeType: params.scopeType,
    moduleCode: params.moduleCode ?? null,
    targetEntityType: params.targetEntityType ?? null,
    targetEntityId: params.targetEntityId ?? null,
    targetLabel: params.targetLabel ?? null,
    snapshotId: params.snapshotId ?? null,
    operationType: params.operationType,
    operationId: params.operationId,
    requestedByUserId: params.requestedByUserId,
    requestedByEmail: params.requestedByEmail ?? null,
    reason: params.reason,
    detailedNote: params.detailedNote ?? null,
    status: "requested",
    approvalPolicyCode: params.approvalPolicyCode,
    requiredApprovals: params.requiredApprovals,
    currentApprovals: 0,
    selfApprovalAllowed: params.selfApprovalAllowed,
    expiresAt: params.expiresAt ?? null,
    emergencyFlag: params.emergencyFlag,
    impersonationFlag: params.impersonationFlag,
    policyResultJson: params.policyResultJson ?? null,
  });

  return { id, requestCode, status: "requested" };
}

export async function approveRequest(authDb: RlsDb, params: { requestId: string; actorUserId: number; note?: string | null; allowSelfApproval: boolean }): Promise<void> {
  const [r] = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, params.requestId));
  if (!r) throw new ApiError({ status: 404, code: "APPROVAL_NOT_FOUND", message: "Approval request not found", retryable: false });
  if (r.status !== "requested") throw new ApiError({ status: 409, code: "APPROVAL_STATE_CONFLICT", message: "Approval request is not pending", retryable: false });
  if (r.expiresAt && r.expiresAt < new Date()) throw new ApiError({ status: 409, code: "APPROVAL_EXPIRED", message: "Approval request expired", retryable: false });
  if (!params.allowSelfApproval && r.requestedByUserId === params.actorUserId) {
    throw new ApiError({ status: 403, code: "APPROVAL_SELF_REVIEW_FORBIDDEN", message: "Requester cannot approve their own request", retryable: false });
  }

  await authDb.insert(platformApprovalEventsTable).values({
    id: crypto.randomUUID(),
    requestId: r.id,
    actorUserId: params.actorUserId,
    action: "approve",
    note: params.note ?? null,
    createdAt: new Date(),
  });

  const nextCount = (r.currentApprovals ?? 0) + 1;
  const approved = nextCount >= (r.requiredApprovals ?? 1);

  await authDb.update(platformApprovalRequestsTable).set({
    currentApprovals: nextCount,
    status: approved ? "approved" : "requested",
    approvedAt: approved ? new Date() : r.approvedAt,
    updatedAt: new Date(),
  }).where(eq(platformApprovalRequestsTable.id, r.id));
}

export async function rejectRequest(authDb: RlsDb, params: { requestId: string; actorUserId: number; note?: string | null; allowSelfApproval: boolean }): Promise<void> {
  const [r] = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, params.requestId));
  if (!r) throw new ApiError({ status: 404, code: "APPROVAL_NOT_FOUND", message: "Approval request not found", retryable: false });
  if (r.status !== "requested") throw new ApiError({ status: 409, code: "APPROVAL_STATE_CONFLICT", message: "Approval request is not pending", retryable: false });
  if (r.expiresAt && r.expiresAt < new Date()) throw new ApiError({ status: 409, code: "APPROVAL_EXPIRED", message: "Approval request expired", retryable: false });
  if (!params.allowSelfApproval && r.requestedByUserId === params.actorUserId) {
    throw new ApiError({ status: 403, code: "APPROVAL_SELF_REVIEW_FORBIDDEN", message: "Requester cannot reject their own request", retryable: false });
  }

  await authDb.insert(platformApprovalEventsTable).values({
    id: crypto.randomUUID(),
    requestId: r.id,
    actorUserId: params.actorUserId,
    action: "reject",
    note: params.note ?? null,
    createdAt: new Date(),
  });

  await authDb.update(platformApprovalRequestsTable).set({
    status: "rejected",
    rejectedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(platformApprovalRequestsTable.id, r.id));
}

export async function getApprovalRequest(authDb: RlsDb, id: string) {
  const [r] = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, id));
  if (!r) throw new ApiError({ status: 404, code: "APPROVAL_NOT_FOUND", message: "Approval request not found", retryable: false });
  const events = await authDb
    .select()
    .from(platformApprovalEventsTable)
    .where(eq(platformApprovalEventsTable.requestId, r.id))
    .orderBy(desc(platformApprovalEventsTable.createdAt));
  return { request: r, events };
}

export async function listApprovalRequests(authDb: RlsDb, params: { firmId: number; status?: string | null; limit: number }) {
  const limit = Math.min(Math.max(params.limit, 1), 100);
  const where = params.status
    ? and(eq(platformApprovalRequestsTable.firmId, params.firmId), eq(platformApprovalRequestsTable.status, params.status))
    : eq(platformApprovalRequestsTable.firmId, params.firmId);
  const items = await authDb
    .select()
    .from(platformApprovalRequestsTable)
    .where(where)
    .orderBy(desc(platformApprovalRequestsTable.createdAt))
    .limit(limit);
  return items;
}

export async function assertApprovalApproved(authDb: RlsDb, params: { approvalRequestId: string; operationType: "maintenance_action" | "restore_action"; operationId: string; now: Date }): Promise<typeof platformApprovalRequestsTable.$inferSelect> {
  const [r] = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, params.approvalRequestId));
  if (!r) throw new ApiError({ status: 404, code: "APPROVAL_NOT_FOUND", message: "Approval request not found", retryable: false });
  if (r.operationType !== params.operationType || r.operationId !== params.operationId) {
    throw new ApiError({ status: 409, code: "APPROVAL_STATE_CONFLICT", message: "Approval does not match the requested operation", retryable: false });
  }
  if (r.status === "rejected") throw new ApiError({ status: 409, code: "APPROVAL_REJECTED", message: "Approval request rejected", retryable: false });
  if (r.status === "cancelled") throw new ApiError({ status: 409, code: "APPROVAL_CANCELLED", message: "Approval request cancelled", retryable: false });
  if (r.status === "expired" || (r.expiresAt && r.expiresAt < params.now)) {
    throw new ApiError({ status: 409, code: "APPROVAL_EXPIRED", message: "Approval request expired", retryable: false });
  }
  if (r.status !== "approved") throw new ApiError({ status: 409, code: "APPROVAL_REQUIRED", message: "Approval required", retryable: false });
  if (r.executedAt) throw new ApiError({ status: 409, code: "DUPLICATE_REQUEST", message: "Approval already used", retryable: false });
  return r;
}

export async function markApprovalExecuted(authDb: RlsDb, approvalRequestId: string): Promise<void> {
  await authDb.update(platformApprovalRequestsTable).set({
    status: "executed",
    executedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(platformApprovalRequestsTable.id, approvalRequestId));
}

export function evaluateDecisionForExecute(params: {
  actionCode: string;
  riskLevel: RiskLevel;
  scopeType: ScopeType;
  moduleCode?: string | null;
  actorPermissions: Set<string>;
  impersonation: boolean;
  emergency: boolean;
}): GovernanceDecision {
  return evaluateGovernancePolicy({
    actionCode: params.actionCode,
    riskLevel: params.riskLevel,
    scopeType: params.scopeType,
    moduleCode: params.moduleCode ?? null,
    actorPermissions: params.actorPermissions,
    impersonation: params.impersonation,
    emergency: params.emergency,
    stage: "execute",
  });
}

export function evaluateDecisionForPreview(params: {
  actionCode: string;
  riskLevel: RiskLevel;
  scopeType: ScopeType;
  moduleCode?: string | null;
  actorPermissions: Set<string>;
  impersonation: boolean;
}): GovernanceDecision {
  return evaluateGovernancePolicy({
    actionCode: params.actionCode,
    riskLevel: params.riskLevel,
    scopeType: params.scopeType,
    moduleCode: params.moduleCode ?? null,
    actorPermissions: params.actorPermissions,
    impersonation: params.impersonation,
    emergency: false,
    stage: "preview",
  });
}

export async function auditPolicyBlocked(params: {
  req: AuthRequest;
  firmId: number;
  action: string;
  policyCode: string;
  blockedCode: string;
  blockedMessage: string;
  details?: string;
}): Promise<void> {
  await writeAuditLog({
    firmId: params.firmId,
    actorId: params.req.userId ?? null,
    actorType: params.req.userType ?? "unknown",
    action: params.action,
    entityType: "firm",
    entityId: params.firmId,
    detail: `policy=${params.policyCode} blocked=${params.blockedCode} msg="${params.blockedMessage}" ${params.details ?? ""}`.trim(),
    ipAddress: params.req.ip,
    userAgent: params.req.headers["user-agent"],
  });
}

export async function assertNoConcurrentDestructive(authDb: RlsDb, params: { firmId: number; table: "maintenance" | "restore"; currentId?: string | null }): Promise<void> {
  if (params.table === "maintenance") {
    const rows: unknown = await authDb.execute(sql`
      SELECT id FROM platform_maintenance_actions
      WHERE firm_id = ${params.firmId}
        AND status IN ('snapshotting','queued','running')
        AND risk_level IN ('high','critical')
        ${params.currentId ? sql`AND id <> ${params.currentId}::uuid` : sql``}
      LIMIT 1
    `);
    const hit = Array.isArray(rows) ? (rows as any)[0] : (rows as any)?.rows?.[0];
    if (hit?.id) throw new ApiError({ status: 409, code: "RESOURCE_LOCKED", message: "Another high-risk maintenance action is already running for this firm", retryable: true });
    return;
  }

  const rows: unknown = await authDb.execute(sql`
    SELECT id FROM platform_restore_actions
    WHERE firm_id = ${params.firmId}
      AND status IN ('queued','running')
      AND risk_level IN ('high','critical')
      ${params.currentId ? sql`AND id <> ${params.currentId}::uuid` : sql``}
    LIMIT 1
  `);
  const hit = Array.isArray(rows) ? (rows as any)[0] : (rows as any)?.rows?.[0];
  if (hit?.id) throw new ApiError({ status: 409, code: "RESOURCE_LOCKED", message: "Another high-risk restore action is already running for this firm", retryable: true });
}
