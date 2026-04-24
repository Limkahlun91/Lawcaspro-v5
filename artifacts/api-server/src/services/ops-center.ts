import crypto from "crypto";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import {
  auditLogsTable,
  firmsTable,
  platformApprovalEventsTable,
  platformApprovalRequestsTable,
  platformIncidentsTable,
  platformIncidentNotesTable,
  platformMaintenanceActionsTable,
  platformRestoreActionsTable,
  platformSnapshotsTable,
  platformStepUpChallengesTable,
  usersTable,
  type RlsDb,
} from "@workspace/db";
import { ApiError } from "../lib/api-response";

export type OpsSeverity = "low" | "medium" | "high" | "critical";
export type OpsEventCategory = "maintenance" | "governance" | "safety" | "system" | "incident";
export type OpsLogStatus = "success" | "failed" | "blocked" | "pending";

export type OpsLogItem = {
  id: string;
  event_code: string;
  event_category: OpsEventCategory;
  severity: OpsSeverity;
  action_code: string | null;
  risk_level: OpsSeverity | null;
  status: OpsLogStatus;
  actor_user_id: number | null;
  actor_name: string | null;
  founder_role: string | null;
  firm_id: number | null;
  firm_name: string | null;
  scope_type: string | null;
  module_code: string | null;
  entity_type: string | null;
  entity_id: string | null;
  snapshot_id: string | null;
  approval_request_id: string | null;
  operation_id: string | null;
  correlation_id: string | null;
  source: "ui" | "api" | "system" | "job";
  impersonation_flag: boolean;
  emergency_flag: boolean;
  policy_result: unknown | null;
  error_code: string | null;
  error_message: string | null;
  summary: string | null;
  detail_json: unknown | null;
  created_at: Date;
};

export type PageInfo = { limit: number; has_more: boolean; next_before: string | null };

const normalizeSeverity = (v: unknown): OpsSeverity => {
  const s = typeof v === "string" ? v : "";
  if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
  return "low";
};

const logStatusFromAction = (status: string): OpsLogStatus => {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "blocked";
  if (status === "previewed" || status === "queued" || status === "running" || status === "snapshotting" || status === "requested" || status === "approved") return "pending";
  return "success";
};

const severityFromStatusAndRisk = (status: OpsLogStatus, risk: OpsSeverity | null): OpsSeverity => {
  if (status === "failed") return risk ?? "high";
  if (status === "blocked") return risk ?? "medium";
  return risk ?? "low";
};

const ilikeOrNull = (col: any, q: string | null): any => (q ? ilike(col, `%${q}%`) : null);

export async function listOpsLogs(
  authDb: RlsDb,
  opts: {
    limit: number;
    before?: Date | null;
    firmId?: number | null;
    moduleCode?: string | null;
    category?: OpsEventCategory | null;
    severity?: OpsSeverity | null;
    riskLevel?: OpsSeverity | null;
    actorUserId?: number | null;
    status?: OpsLogStatus | null;
    emergencyOnly?: boolean | null;
    impersonationOnly?: boolean | null;
    approvalState?: string | null;
    q?: string | null;
  }
): Promise<{ items: OpsLogItem[]; page_info: PageInfo }> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const perKind = Math.min(limit * 3, 300);
  const before = opts.before ?? null;

  const firmsById = new Map<number, string>();
  const preloadFirmName = async (firmId: number | null): Promise<string | null> => {
    if (!firmId) return null;
    const cached = firmsById.get(firmId);
    if (cached) return cached;
    const [row] = await authDb.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, firmId)).limit(1);
    const name = row?.name ?? null;
    if (name) firmsById.set(firmId, name);
    return name;
  };

  const usersById = new Map<number, string>();
  const preloadUserName = async (userId: number | null): Promise<string | null> => {
    if (!userId) return null;
    const cached = usersById.get(userId);
    if (cached) return cached;
    const [row] = await authDb.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const name = row?.name ?? null;
    if (name) usersById.set(userId, name);
    return name;
  };

  const items: OpsLogItem[] = [];
  const q = opts.q ? String(opts.q).trim() : null;

  if (!opts.category || opts.category === "maintenance") {
    const where = [
      opts.firmId ? eq(platformMaintenanceActionsTable.firmId, opts.firmId) : null,
      opts.moduleCode ? eq(platformMaintenanceActionsTable.moduleCode, opts.moduleCode) : null,
      opts.actorUserId ? eq(platformMaintenanceActionsTable.requestedByUserId, opts.actorUserId) : null,
      before ? sql`${platformMaintenanceActionsTable.createdAt} < ${before}` : null,
      q ? ilikeOrNull(platformMaintenanceActionsTable.actionCode, q) : null,
      q ? ilikeOrNull(platformMaintenanceActionsTable.targetLabel, q) : null,
      q ? ilikeOrNull(platformMaintenanceActionsTable.reason, q) : null,
    ].filter(Boolean) as any[];
    const rows = await authDb.select().from(platformMaintenanceActionsTable).where(and(...where)).orderBy(desc(platformMaintenanceActionsTable.createdAt)).limit(perKind);
    for (const r of rows) {
      const status = logStatusFromAction(String(r.status ?? ""));
      const risk = normalizeSeverity(r.riskLevel);
      if (opts.status && opts.status !== status) continue;
      if (opts.riskLevel && opts.riskLevel !== risk) continue;
      if (opts.severity && opts.severity !== severityFromStatusAndRisk(status, risk)) continue;
      if (opts.emergencyOnly && !(r.executionPayload as any)?.emergency_flag && !(r.previewPayload as any)?.emergency_flag) continue;
      if (opts.impersonationOnly && !(r.executionPayload as any)?.impersonation_flag && !(r.previewPayload as any)?.impersonation_flag) continue;
      const firmName = await preloadFirmName(r.firmId);
      const actorName = await preloadUserName(r.requestedByUserId);
      items.push({
        id: `maintenance:${String(r.id)}`,
        event_code: status === "failed" ? "maintenance_failed" : status === "pending" ? "maintenance_pending" : "maintenance_completed",
        event_category: "maintenance",
        severity: severityFromStatusAndRisk(status, risk),
        action_code: r.actionCode ?? null,
        risk_level: risk,
        status,
        actor_user_id: r.requestedByUserId ?? null,
        actor_name: actorName,
        founder_role: null,
        firm_id: r.firmId ?? null,
        firm_name: firmName,
        scope_type: r.scopeType ?? null,
        module_code: r.moduleCode ?? null,
        entity_type: r.targetEntityType ?? null,
        entity_id: r.targetEntityId ?? null,
        snapshot_id: r.preActionSnapshotId ? String(r.preActionSnapshotId) : null,
        approval_request_id: r.approvalRequestId ? String(r.approvalRequestId) : null,
        operation_id: String(r.id),
        correlation_id: String(r.id),
        source: "api",
        impersonation_flag: !!(r.executionPayload as any)?.impersonation_flag,
        emergency_flag: !!(r.executionPayload as any)?.emergency_flag,
        policy_result: (r.executionPayload as any)?.policy_result ?? null,
        error_code: r.errorCode ?? null,
        error_message: r.errorMessage ?? null,
        summary: r.targetLabel ? String(r.targetLabel) : null,
        detail_json: { preview: r.previewPayload ?? null, execution: r.executionPayload ?? null, result: r.resultPayload ?? null },
        created_at: r.createdAt ?? new Date(),
      });
    }
  }

  if (!opts.category || opts.category === "governance") {
    const where = [
      opts.firmId ? eq(platformApprovalRequestsTable.firmId, opts.firmId) : null,
      opts.moduleCode ? eq(platformApprovalRequestsTable.moduleCode, opts.moduleCode) : null,
      opts.actorUserId ? eq(platformApprovalRequestsTable.requestedByUserId, opts.actorUserId) : null,
      before ? sql`${platformApprovalRequestsTable.createdAt} < ${before}` : null,
      opts.approvalState ? eq(platformApprovalRequestsTable.status, opts.approvalState) : null,
      q ? ilikeOrNull(platformApprovalRequestsTable.requestCode, q) : null,
      q ? ilikeOrNull(platformApprovalRequestsTable.actionCode, q) : null,
      q ? ilikeOrNull(platformApprovalRequestsTable.reason, q) : null,
    ].filter(Boolean) as any[];
    const rows = await authDb.select().from(platformApprovalRequestsTable).where(and(...where)).orderBy(desc(platformApprovalRequestsTable.createdAt)).limit(perKind);
    for (const r of rows) {
      const status = logStatusFromAction(String(r.status ?? ""));
      const risk = normalizeSeverity(r.riskLevel);
      if (opts.status && opts.status !== status) continue;
      if (opts.riskLevel && opts.riskLevel !== risk) continue;
      if (opts.severity && opts.severity !== severityFromStatusAndRisk(status, risk)) continue;
      if (opts.emergencyOnly && !r.emergencyFlag) continue;
      if (opts.impersonationOnly && !r.impersonationFlag) continue;
      const firmName = await preloadFirmName(r.firmId);
      const actorName = await preloadUserName(r.requestedByUserId);
      items.push({
        id: `approval:${String(r.id)}`,
        event_code:
          r.status === "requested" ? "approval_requested" :
          r.status === "approved" ? "approval_approved" :
          r.status === "rejected" ? "approval_rejected" :
          r.status === "expired" ? "approval_expired" :
          r.status === "executed" ? "approval_executed" : "approval_event",
        event_category: "governance",
        severity: severityFromStatusAndRisk(status, risk),
        action_code: r.actionCode ?? null,
        risk_level: risk,
        status,
        actor_user_id: r.requestedByUserId ?? null,
        actor_name: actorName,
        founder_role: null,
        firm_id: r.firmId ?? null,
        firm_name: firmName,
        scope_type: r.scopeType ?? null,
        module_code: r.moduleCode ?? null,
        entity_type: r.targetEntityType ?? null,
        entity_id: r.targetEntityId ?? null,
        snapshot_id: r.snapshotId ? String(r.snapshotId) : null,
        approval_request_id: String(r.id),
        operation_id: String(r.operationId),
        correlation_id: String(r.id),
        source: "api",
        impersonation_flag: !!r.impersonationFlag,
        emergency_flag: !!r.emergencyFlag,
        policy_result: r.policyResultJson ?? null,
        error_code: null,
        error_message: null,
        summary: r.targetLabel ? String(r.targetLabel) : r.requestCode,
        detail_json: { request: r },
        created_at: r.createdAt ?? new Date(),
      });
    }
  }

  if (!opts.category || opts.category === "maintenance") {
    const where = [
      opts.firmId ? eq(platformRestoreActionsTable.firmId, opts.firmId) : null,
      opts.moduleCode ? eq(platformRestoreActionsTable.moduleCode, opts.moduleCode) : null,
      opts.actorUserId ? eq(platformRestoreActionsTable.requestedByUserId, opts.actorUserId) : null,
      before ? sql`${platformRestoreActionsTable.createdAt} < ${before}` : null,
      q ? ilikeOrNull(platformRestoreActionsTable.operationCode, q) : null,
      q ? ilikeOrNull(platformRestoreActionsTable.targetLabel, q) : null,
      q ? ilikeOrNull(platformRestoreActionsTable.reason, q) : null,
    ].filter(Boolean) as any[];
    const rows = await authDb.select().from(platformRestoreActionsTable).where(and(...where)).orderBy(desc(platformRestoreActionsTable.createdAt)).limit(perKind);
    for (const r of rows) {
      const status = logStatusFromAction(String(r.status ?? ""));
      const risk = normalizeSeverity(r.riskLevel);
      if (opts.status && opts.status !== status) continue;
      if (opts.riskLevel && opts.riskLevel !== risk) continue;
      if (opts.severity && opts.severity !== severityFromStatusAndRisk(status, risk)) continue;
      if (opts.emergencyOnly && !(r.executionPayload as any)?.emergency_flag) continue;
      if (opts.impersonationOnly && !(r.executionPayload as any)?.impersonation_flag) continue;
      const firmName = await preloadFirmName(r.firmId);
      const actorName = await preloadUserName(r.requestedByUserId);
      const opCode = String(r.operationCode ?? "restore_snapshot");
      items.push({
        id: `restore:${String(r.id)}`,
        event_code: status === "failed" ? `${opCode}_failed` : status === "pending" ? `${opCode}_pending` : `${opCode}_completed`,
        event_category: "maintenance",
        severity: severityFromStatusAndRisk(status, risk),
        action_code: opCode,
        risk_level: risk,
        status,
        actor_user_id: r.requestedByUserId ?? null,
        actor_name: actorName,
        founder_role: null,
        firm_id: r.firmId ?? null,
        firm_name: firmName,
        scope_type: r.restoreScopeType ?? null,
        module_code: r.moduleCode ?? null,
        entity_type: r.targetEntityType ?? null,
        entity_id: r.targetEntityId ?? null,
        snapshot_id: r.snapshotId ? String(r.snapshotId) : null,
        approval_request_id: r.approvalRequestId ? String(r.approvalRequestId) : null,
        operation_id: String(r.id),
        correlation_id: String(r.id),
        source: "api",
        impersonation_flag: !!(r.executionPayload as any)?.impersonation_flag,
        emergency_flag: !!(r.executionPayload as any)?.emergency_flag,
        policy_result: (r.executionPayload as any)?.policy_result ?? null,
        error_code: r.errorCode ?? null,
        error_message: r.errorMessage ?? null,
        summary: r.targetLabel ? String(r.targetLabel) : null,
        detail_json: { preview: r.previewPayload ?? null, execution: r.executionPayload ?? null, result: r.resultPayload ?? null },
        created_at: r.createdAt ?? new Date(),
      });
    }
  }

  if (!opts.category || opts.category === "safety" || opts.category === "system" || opts.category === "governance") {
    const where = [
      opts.firmId ? eq(auditLogsTable.firmId, opts.firmId) : null,
      opts.actorUserId ? eq(auditLogsTable.actorId, opts.actorUserId) : null,
      before ? sql`${auditLogsTable.createdAt} < ${before}` : null,
      sql`(${auditLogsTable.action} ILIKE 'founder.%' OR ${auditLogsTable.action} ILIKE 'firm.%')`,
      sql`(${auditLogsTable.action} = 'founder.permission.denied' OR COALESCE(${auditLogsTable.detail}, '') ILIKE '%policy=%blocked=%' OR ${auditLogsTable.action} ILIKE 'firm.snapshot.%' OR ${auditLogsTable.action} ILIKE 'firm.restore.%' OR ${auditLogsTable.action} ILIKE 'firm.recovery.rollback.%' OR ${auditLogsTable.action} ILIKE 'firm.maintenance.%')`,
      q ? sql`(${auditLogsTable.action} ILIKE ${`%${q}%`} OR COALESCE(${auditLogsTable.detail}, '') ILIKE ${`%${q}%`})` : null,
    ].filter(Boolean) as any[];
    const rows = await authDb.select().from(auditLogsTable).where(and(...where)).orderBy(desc(auditLogsTable.createdAt)).limit(perKind);
    for (const r of rows) {
      const action = String((r as any).action ?? "");
      const detail = (r as any).detail ? String((r as any).detail) : "";
      const isPermissionDenied = action === "founder.permission.denied";
      const isPolicyBlocked = detail.includes("policy=") && detail.includes("blocked=");
      const category: OpsEventCategory = isPermissionDenied ? "safety" : isPolicyBlocked ? "governance" : action.includes("snapshot") ? "maintenance" : "system";
      if (opts.category && opts.category !== category) continue;
      const status: OpsLogStatus = isPermissionDenied || isPolicyBlocked ? "blocked" : "success";
      if (opts.status && opts.status !== status) continue;
      const sev: OpsSeverity = isPermissionDenied ? "high" : isPolicyBlocked ? "high" : "low";
      if (opts.severity && opts.severity !== sev) continue;
      if (opts.emergencyOnly && !detail.toLowerCase().includes("emergency")) continue;
      if (opts.impersonationOnly && !detail.toLowerCase().includes("impersonation")) continue;

      const firmName = await preloadFirmName((r as any).firmId ?? null);
      const actorName = await preloadUserName((r as any).actorId ?? null);
      items.push({
        id: `audit:${String((r as any).id)}`,
        event_code: isPermissionDenied ? "permission_denied" : isPolicyBlocked ? "policy_blocked" : action.replace(/^firm\./, "").replace(/^founder\./, ""),
        event_category: category,
        severity: sev,
        action_code: action,
        risk_level: null,
        status,
        actor_user_id: (r as any).actorId ?? null,
        actor_name: actorName,
        founder_role: null,
        firm_id: (r as any).firmId ?? null,
        firm_name: firmName,
        scope_type: null,
        module_code: null,
        entity_type: (r as any).entityType ?? null,
        entity_id: (r as any).entityId != null ? String((r as any).entityId) : null,
        snapshot_id: null,
        approval_request_id: null,
        operation_id: null,
        correlation_id: String((r as any).id),
        source: "system",
        impersonation_flag: detail.toLowerCase().includes("impersonation"),
        emergency_flag: detail.toLowerCase().includes("emergency"),
        policy_result: isPolicyBlocked ? detail : null,
        error_code: null,
        error_message: null,
        summary: detail ? detail.slice(0, 200) : action,
        detail_json: { action, detail },
        created_at: (r as any).createdAt ?? new Date(),
      });
    }
  }

  const merged = items
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

  const pageItems = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const nextBefore = pageItems.length ? pageItems[pageItems.length - 1].created_at.toISOString() : null;
  return { items: pageItems, page_info: { limit, has_more: hasMore, next_before: nextBefore } };
}

export async function upsertIncidentFromFailure(authDb: RlsDb, params: {
  firmId: number;
  moduleCode: string | null;
  incidentType: string;
  severity: OpsSeverity;
  sourceEventId: string;
  sourceOperationId: string;
  snapshotId: string | null;
  relatedRequestId: string | null;
  entityType: string | null;
  entityId: string | null;
  title: string;
  summary: string | null;
  technicalSummary: string | null;
  suggestedActionCode: string | null;
  suggestedSnapshotId: string | null;
  aggregationKey: string;
}): Promise<string> {
  const now = new Date();
  const id = crypto.randomUUID();
  const incidentCode = `INC-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${id.slice(0, 8)}`;

  const existing = await authDb
    .select({ id: platformIncidentsTable.id, status: platformIncidentsTable.status, eventCount: platformIncidentsTable.eventCount })
    .from(platformIncidentsTable)
    .where(and(eq(platformIncidentsTable.aggregationKey, params.aggregationKey), sql`${platformIncidentsTable.status} IN ('open','investigating','awaiting-approval','awaiting-execution')`))
    .limit(1);

  const hit = existing[0] ?? null;
  if (hit) {
    await authDb.update(platformIncidentsTable).set({
      severity: params.severity,
      title: params.title,
      summary: params.summary,
      technicalSummary: params.technicalSummary,
      moduleCode: params.moduleCode,
      entityType: params.entityType,
      entityId: params.entityId,
      snapshotId: params.snapshotId,
      relatedRequestId: params.relatedRequestId,
      sourceEventId: params.sourceEventId,
      sourceOperationId: params.sourceOperationId,
      suggestedActionCode: params.suggestedActionCode,
      suggestedSnapshotId: params.suggestedSnapshotId,
      lastEventAt: now,
      eventCount: (hit.eventCount ?? 1) + 1,
      updatedAt: now,
    }).where(eq(platformIncidentsTable.id, hit.id));
    return String(hit.id);
  }

  await authDb.insert(platformIncidentsTable).values({
    id,
    incidentCode,
    title: params.title,
    incidentType: params.incidentType,
    severity: params.severity,
    status: "open",
    sourceEventId: params.sourceEventId,
    sourceOperationId: params.sourceOperationId,
    firmId: params.firmId,
    moduleCode: params.moduleCode,
    entityType: params.entityType,
    entityId: params.entityId,
    snapshotId: params.snapshotId,
    relatedRequestId: params.relatedRequestId,
    summary: params.summary,
    technicalSummary: params.technicalSummary,
    userImpactSummary: null,
    suggestedActionCode: params.suggestedActionCode,
    suggestedSnapshotId: params.suggestedSnapshotId,
    detectedAt: now,
    aggregationKey: params.aggregationKey,
    lastEventAt: now,
    eventCount: 1,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function listIncidents(authDb: RlsDb, opts: {
  limit: number;
  before?: Date | null;
  status?: string | null;
  severity?: OpsSeverity | null;
  firmId?: number | null;
  moduleCode?: string | null;
  q?: string | null;
}): Promise<{ items: any[]; page_info: PageInfo }> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const before = opts.before ?? null;
  const q = opts.q ? String(opts.q).trim() : null;
  const where = [
    opts.firmId ? eq(platformIncidentsTable.firmId, opts.firmId) : null,
    opts.status ? eq(platformIncidentsTable.status, opts.status) : null,
    opts.severity ? eq(platformIncidentsTable.severity, opts.severity) : null,
    opts.moduleCode ? eq(platformIncidentsTable.moduleCode, opts.moduleCode) : null,
    before ? sql`${platformIncidentsTable.detectedAt} < ${before}` : null,
    q ? ilikeOrNull(platformIncidentsTable.title, q) : null,
  ].filter(Boolean) as any[];
  const rows = await authDb.select().from(platformIncidentsTable).where(and(...where)).orderBy(desc(platformIncidentsTable.detectedAt)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const nextBefore = items.length ? (items[items.length - 1] as any).detectedAt?.toISOString?.() ?? null : null;
  return { items, page_info: { limit, has_more: hasMore, next_before: nextBefore } };
}

export async function getIncidentDetail(authDb: RlsDb, id: string): Promise<{ incident: any; notes: any[] }> {
  const [incident] = await authDb.select().from(platformIncidentsTable).where(eq(platformIncidentsTable.id, id)).limit(1);
  if (!incident) throw new ApiError({ status: 404, code: "INCIDENT_NOT_FOUND", message: "Incident not found", retryable: false });
  const notes = await authDb.select().from(platformIncidentNotesTable).where(eq(platformIncidentNotesTable.incidentId, id)).orderBy(desc(platformIncidentNotesTable.createdAt)).limit(100);
  return { incident, notes };
}

export async function addIncidentNote(authDb: RlsDb, params: { incidentId: string; authorUserId: number; note: string }): Promise<void> {
  const note = String(params.note ?? "").trim();
  if (note.length < 3) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Note is too short", retryable: false });
  await authDb.insert(platformIncidentNotesTable).values({ id: crypto.randomUUID(), incidentId: params.incidentId, authorUserId: params.authorUserId, note, createdAt: new Date() });
  await authDb.update(platformIncidentsTable).set({ updatedAt: new Date() }).where(eq(platformIncidentsTable.id, params.incidentId));
}

export async function setIncidentStatus(authDb: RlsDb, params: { incidentId: string; status: string; actorUserId: number; note?: string | null }): Promise<void> {
  const now = new Date();
  const status = String(params.status ?? "").trim();
  const patch: Record<string, unknown> = { status, updatedAt: now };
  if (status === "investigating") {
    patch["acknowledgedAt"] = now;
    patch["acknowledgedBy"] = params.actorUserId;
  }
  if (status === "resolved" || status === "dismissed" || status === "mitigated") {
    patch["resolvedAt"] = now;
    patch["resolvedBy"] = params.actorUserId;
    patch["resolutionNote"] = params.note ? String(params.note) : null;
  }
  await authDb.update(platformIncidentsTable).set(patch as any).where(eq(platformIncidentsTable.id, params.incidentId));
}

export type RecommendationItem = {
  recommendation_code: string;
  title: string;
  severity: OpsSeverity;
  reason: string;
  confidence_level: "high" | "medium" | "low";
  applies_to_scope: { firm_id: number | null; module_code: string | null; entity_type: string | null; entity_id: string | null };
  recommended_next_action: string;
  can_execute_directly: boolean;
  required_permission: string | null;
  required_approval: boolean;
  related_snapshot_id: string | null;
  related_incident_id: string | null;
  supporting_signals: unknown;
  note: string | null;
};

export async function computeRecommendationsForIncident(authDb: RlsDb, incident: any): Promise<RecommendationItem[]> {
  const out: RecommendationItem[] = [];
  const firmId = Number(incident.firmId);
  const moduleCode = incident.moduleCode ? String(incident.moduleCode) : null;
  const entityType = incident.entityType ? String(incident.entityType) : null;
  const entityId = incident.entityId ? String(incident.entityId) : null;
  const snapshotId = incident.snapshotId ? String(incident.snapshotId) : null;

  const signals: Record<string, unknown> = {
    incident_type: incident.incidentType,
    source_event_id: incident.sourceEventId,
    source_operation_id: incident.sourceOperationId,
    suggested_action_code: incident.suggestedActionCode,
  };

  const [latestValidSnapshot] = await authDb
    .select({ id: platformSnapshotsTable.id, createdAt: platformSnapshotsTable.createdAt, integrityStatus: platformSnapshotsTable.integrityStatus, status: platformSnapshotsTable.status, restorable: platformSnapshotsTable.restorable })
    .from(platformSnapshotsTable)
    .where(and(eq(platformSnapshotsTable.firmId, firmId), eq(platformSnapshotsTable.status, "completed"), eq(platformSnapshotsTable.integrityStatus, "valid"), eq(platformSnapshotsTable.restorable, true)))
    .orderBy(desc(platformSnapshotsTable.createdAt))
    .limit(1);

  const hasValidSnapshot = !!latestValidSnapshot?.id;

  if (String(incident.incidentType).includes("no_valid_snapshot") || !hasValidSnapshot) {
    out.push({
      recommendation_code: "create_snapshot_first",
      title: "Create snapshot first",
      severity: "high",
      reason: "No valid restorable snapshot is available for this firm/module.",
      confidence_level: "high",
      applies_to_scope: { firm_id: firmId, module_code: moduleCode, entity_type: entityType, entity_id: entityId },
      recommended_next_action: "Create a new snapshot (manual) before attempting destructive operations.",
      can_execute_directly: true,
      required_permission: "founder.snapshot.create",
      required_approval: false,
      related_snapshot_id: latestValidSnapshot?.id ? String(latestValidSnapshot.id) : null,
      related_incident_id: String(incident.id),
      supporting_signals: { ...signals, latest_valid_snapshot_id: latestValidSnapshot?.id ?? null },
      note: "If the action is high/critical, keep support session active and document the reason.",
    });
  }

  if (String(incident.incidentType).includes("integrity") || String(incident.technicalSummary ?? "").toLowerCase().includes("integrity")) {
    out.push({
      recommendation_code: "restore_from_snapshot",
      title: "Restore from a valid snapshot",
      severity: "high",
      reason: "Snapshot integrity failed/mismatched for the attempted restore; prefer a valid integrity snapshot.",
      confidence_level: hasValidSnapshot ? "high" : "medium",
      applies_to_scope: { firm_id: firmId, module_code: moduleCode, entity_type: entityType, entity_id: entityId },
      recommended_next_action: hasValidSnapshot ? `Preview restore using snapshot ${String(latestValidSnapshot!.id).slice(0, 8)}.` : "Recreate snapshot or revalidate integrity before restore.",
      can_execute_directly: false,
      required_permission: "founder.snapshot.restore.preview",
      required_approval: true,
      related_snapshot_id: latestValidSnapshot?.id ? String(latestValidSnapshot.id) : snapshotId,
      related_incident_id: String(incident.id),
      supporting_signals: { ...signals, has_valid_snapshot: hasValidSnapshot },
      note: "Do not retry restore on an invalid integrity snapshot.",
    });
  }

  if (String(incident.incidentType).includes("approval") || String(incident.title).toLowerCase().includes("approval")) {
    out.push({
      recommendation_code: "resolve_approval_deadlock",
      title: "Resolve approval deadlock",
      severity: "medium",
      reason: "Approval is overdue/expired or blocked; re-submit or escalate to a higher founder role.",
      confidence_level: "medium",
      applies_to_scope: { firm_id: firmId, module_code: moduleCode, entity_type: entityType, entity_id: entityId },
      recommended_next_action: "Re-submit approval request or have a higher-level founder approve/reject.",
      can_execute_directly: false,
      required_permission: "founder.approval.request",
      required_approval: false,
      related_snapshot_id: snapshotId,
      related_incident_id: String(incident.id),
      supporting_signals: signals,
      note: "Check if the request expired and whether self-approval is allowed by policy.",
    });
  }

  if (String(incident.incidentType).includes("resource_locked") || String(incident.technicalSummary ?? "").toLowerCase().includes("locked")) {
    out.push({
      recommendation_code: "wait_for_lock_release",
      title: "Wait for lock release",
      severity: "medium",
      reason: "Another high-risk operation is currently running; the system prevents concurrent destructive actions.",
      confidence_level: "high",
      applies_to_scope: { firm_id: firmId, module_code: moduleCode, entity_type: entityType, entity_id: entityId },
      recommended_next_action: "Wait for the running operation to complete, then retry.",
      can_execute_directly: false,
      required_permission: null,
      required_approval: false,
      related_snapshot_id: snapshotId,
      related_incident_id: String(incident.id),
      supporting_signals: signals,
      note: null,
    });
  }

  out.push({
    recommendation_code: "manual_review_required",
    title: "Manual review required",
    severity: normalizeSeverity(incident.severity),
    reason: "Investigate the timeline, linked operation and audit trail to identify root cause.",
    confidence_level: "low",
    applies_to_scope: { firm_id: firmId, module_code: moduleCode, entity_type: entityType, entity_id: entityId },
    recommended_next_action: "Review operation steps, policy result and audit trail; then decide on retry/restore/rollback.",
    can_execute_directly: false,
    required_permission: null,
    required_approval: false,
    related_snapshot_id: snapshotId,
    related_incident_id: String(incident.id),
    supporting_signals: signals,
    note: null,
  });

  return out;
}

export async function recomputeIncidents(authDb: RlsDb, opts: { since: Date; limit: number }): Promise<{ created: number; updated: number }> {
  const since = opts.since;
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  let created = 0;
  let updated = 0;

  const failuresMaint = await authDb
    .select()
    .from(platformMaintenanceActionsTable)
    .where(and(eq(platformMaintenanceActionsTable.status, "failed"), sql`${platformMaintenanceActionsTable.createdAt} >= ${since}`))
    .orderBy(desc(platformMaintenanceActionsTable.createdAt))
    .limit(limit);

  for (const a of failuresMaint) {
    const key = `firm:${a.firmId}|maintenance|${String(a.actionCode ?? "")}|${String(a.moduleCode ?? "")}|${String(a.targetEntityType ?? "")}|${String(a.targetEntityId ?? "")}|${String(a.errorCode ?? "UNKNOWN")}`;
    const id = await upsertIncidentFromFailure(authDb, {
      firmId: a.firmId,
      moduleCode: a.moduleCode ?? null,
      incidentType: "maintenance_failed",
      severity: normalizeSeverity(a.riskLevel),
      sourceEventId: `maintenance:${String(a.id)}`,
      sourceOperationId: String(a.id),
      snapshotId: a.preActionSnapshotId ? String(a.preActionSnapshotId) : null,
      relatedRequestId: a.approvalRequestId ? String(a.approvalRequestId) : null,
      entityType: a.targetEntityType ?? null,
      entityId: a.targetEntityId ?? null,
      title: `Maintenance failed: ${String(a.actionCode ?? "").trim() || "action"}`,
      summary: a.targetLabel ? String(a.targetLabel) : null,
      technicalSummary: a.errorMessage ? String(a.errorMessage) : null,
      suggestedActionCode: "retry_operation",
      suggestedSnapshotId: a.preActionSnapshotId ? String(a.preActionSnapshotId) : null,
      aggregationKey: key,
    });
    if (id) updated += 1;
  }

  const failuresRestore = await authDb
    .select()
    .from(platformRestoreActionsTable)
    .where(and(eq(platformRestoreActionsTable.status, "failed"), sql`${platformRestoreActionsTable.createdAt} >= ${since}`))
    .orderBy(desc(platformRestoreActionsTable.createdAt))
    .limit(limit);

  for (const a of failuresRestore) {
    const op = String(a.operationCode ?? "restore_snapshot");
    const key = `firm:${a.firmId}|restore|${op}|${String(a.moduleCode ?? "")}|${String(a.targetEntityType ?? "")}|${String(a.targetEntityId ?? "")}|${String(a.errorCode ?? "UNKNOWN")}`;
    const id = await upsertIncidentFromFailure(authDb, {
      firmId: a.firmId,
      moduleCode: a.moduleCode ?? null,
      incidentType: `${op}_failed`,
      severity: normalizeSeverity(a.riskLevel),
      sourceEventId: `restore:${String(a.id)}`,
      sourceOperationId: String(a.id),
      snapshotId: a.snapshotId ? String(a.snapshotId) : null,
      relatedRequestId: a.approvalRequestId ? String(a.approvalRequestId) : null,
      entityType: a.targetEntityType ?? null,
      entityId: a.targetEntityId ?? null,
      title: `Restore failed: ${op}`,
      summary: a.targetLabel ? String(a.targetLabel) : null,
      technicalSummary: a.errorMessage ? String(a.errorMessage) : null,
      suggestedActionCode: op === "rollback_restore" ? "manual_review_required" : "restore_from_snapshot",
      suggestedSnapshotId: a.snapshotId ? String(a.snapshotId) : null,
      aggregationKey: key,
    });
    if (id) updated += 1;
  }

  const overdueApprovals = await authDb
    .select()
    .from(platformApprovalRequestsTable)
    .where(and(eq(platformApprovalRequestsTable.status, "requested"), sql`${platformApprovalRequestsTable.expiresAt} IS NOT NULL AND ${platformApprovalRequestsTable.expiresAt} < now()`))
    .orderBy(desc(platformApprovalRequestsTable.createdAt))
    .limit(limit);

  for (const r of overdueApprovals) {
    const key = `firm:${r.firmId}|approval|deadlock|${String(r.requestCode)}|${String(r.actionCode)}|${String(r.operationId)}`;
    const id = await upsertIncidentFromFailure(authDb, {
      firmId: r.firmId,
      moduleCode: r.moduleCode ?? null,
      incidentType: "approval_deadlock_overdue",
      severity: normalizeSeverity(r.riskLevel),
      sourceEventId: `approval:${String(r.id)}`,
      sourceOperationId: String(r.operationId),
      snapshotId: r.snapshotId ? String(r.snapshotId) : null,
      relatedRequestId: String(r.id),
      entityType: r.targetEntityType ?? null,
      entityId: r.targetEntityId ?? null,
      title: `Approval overdue: ${String(r.requestCode)}`,
      summary: r.targetLabel ? String(r.targetLabel) : null,
      technicalSummary: "Approval request expired/overdue; action cannot proceed.",
      suggestedActionCode: "resolve_approval_deadlock",
      suggestedSnapshotId: r.snapshotId ? String(r.snapshotId) : null,
      aggregationKey: key,
    });
    if (id) updated += 1;
  }

  const blockedRows: unknown = await authDb.execute(sql`
    SELECT firm_id, action, COUNT(*)::int AS c, MAX(created_at) AS last_at
    FROM audit_logs
    WHERE created_at >= ${since}
      AND COALESCE(detail, '') ILIKE '%policy=%blocked=%'
    GROUP BY firm_id, action
    HAVING COUNT(*) >= 3
    ORDER BY last_at DESC
    LIMIT ${limit}
  `);
  const blocked = Array.isArray((blockedRows as any)?.rows) ? (blockedRows as any).rows : Array.isArray(blockedRows) ? blockedRows : [];
  for (const b of blocked) {
    const firmId = Number((b as any).firm_id);
    if (!Number.isFinite(firmId) || firmId <= 0) continue;
    const action = String((b as any).action ?? "policy_blocked");
    const key = `firm:${firmId}|policy_blocked|${action}`;
    const id = await upsertIncidentFromFailure(authDb, {
      firmId,
      moduleCode: null,
      incidentType: "policy_blocked_repeated",
      severity: "medium",
      sourceEventId: `audit:${action}`,
      sourceOperationId: action,
      snapshotId: null,
      relatedRequestId: null,
      entityType: "firm",
      entityId: String(firmId),
      title: "Policy blocked repeatedly",
      summary: action,
      technicalSummary: `Policy blocked events repeated (count=${String((b as any).c ?? "")}).`,
      suggestedActionCode: "manual_review_required",
      suggestedSnapshotId: null,
      aggregationKey: key,
    });
    if (id) updated += 1;
  }

  created = 0;
  return { created, updated };
}

export async function computeReadiness(authDb: RlsDb, opts: { limit: number; firmId?: number | null }): Promise<{ items: any[] }> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const firmFilter = opts.firmId ?? null;
  const firms = await authDb
    .select({ id: firmsTable.id, name: firmsTable.name })
    .from(firmsTable)
    .where(firmFilter ? eq(firmsTable.id, firmFilter) : sql`true`)
    .orderBy(desc(firmsTable.createdAt))
    .limit(limit);

  const out: any[] = [];
  for (const f of firms) {
    const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [latestSnapshot] = await authDb.select().from(platformSnapshotsTable).where(eq(platformSnapshotsTable.firmId, f.id)).orderBy(desc(platformSnapshotsTable.createdAt)).limit(1);
    const [latestValidSnapshot] = await authDb
      .select()
      .from(platformSnapshotsTable)
      .where(and(eq(platformSnapshotsTable.firmId, f.id), eq(platformSnapshotsTable.status, "completed"), eq(platformSnapshotsTable.integrityStatus, "valid"), eq(platformSnapshotsTable.restorable, true)))
      .orderBy(desc(platformSnapshotsTable.createdAt))
      .limit(1);
    const [countRow] = await authDb
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(platformSnapshotsTable)
      .where(and(eq(platformSnapshotsTable.firmId, f.id), sql`${platformSnapshotsTable.createdAt} >= ${windowStart}`));

    const runningMaint = await authDb.select({ id: platformMaintenanceActionsTable.id }).from(platformMaintenanceActionsTable).where(and(eq(platformMaintenanceActionsTable.firmId, f.id), sql`status IN ('snapshotting','queued','running')`, sql`risk_level IN ('high','critical')`)).limit(1);
    const runningRestore = await authDb.select({ id: platformRestoreActionsTable.id }).from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.firmId, f.id), sql`status IN ('queued','running')`, sql`risk_level IN ('high','critical')`)).limit(1);
    const lockFree = runningMaint.length === 0 && runningRestore.length === 0;

    const hasValidSnapshot = !!latestValidSnapshot?.id;
    const restoreEligible = hasValidSnapshot && lockFree;

    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!hasValidSnapshot) blockers.push("no_valid_snapshot");
    if (!lockFree) blockers.push("system_lock_active");
    if (latestSnapshot && String((latestSnapshot as any).integrityStatus ?? "valid") !== "valid") warnings.push("latest_snapshot_integrity_not_valid");
    if (latestSnapshot && String((latestSnapshot as any).status ?? "") !== "completed") warnings.push("latest_snapshot_not_completed");

    const readiness = (() => {
      if (blockers.length) return "blocked";
      if (warnings.length) return "ready_with_warning";
      if (restoreEligible) return "ready";
      return "unknown";
    })();

    out.push({
      firm_id: f.id,
      firm_name: f.name,
      latest_snapshot_at: latestSnapshot?.createdAt ?? null,
      latest_successful_snapshot: latestValidSnapshot?.id ? { id: latestValidSnapshot.id, created_at: latestValidSnapshot.createdAt } : null,
      latest_integrity_pass: latestValidSnapshot?.id ? { id: latestValidSnapshot.id, created_at: latestValidSnapshot.createdAt } : null,
      snapshot_count_30d: Number((countRow as any)?.c ?? 0),
      restore_eligible: restoreEligible,
      approval_ready: true,
      lock_free: lockFree,
      dependency_healthy: true,
      warnings_count: warnings.length,
      critical_blockers_count: blockers.length,
      readiness,
      blockers,
      warnings,
    });
  }
  return { items: out };
}

export async function computePending(authDb: RlsDb, opts: { limit: number }): Promise<any> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const pendingApprovals = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.status, "requested")).orderBy(desc(platformApprovalRequestsTable.createdAt)).limit(limit);
  const approvedNotExecuted = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.status, "approved")).orderBy(desc(platformApprovalRequestsTable.createdAt)).limit(limit);
  const pendingMaintenance = await authDb.select().from(platformMaintenanceActionsTable).where(sql`status IN ('previewed','snapshotting','queued','running')`).orderBy(desc(platformMaintenanceActionsTable.createdAt)).limit(limit);
  const pendingRestore = await authDb.select().from(platformRestoreActionsTable).where(sql`status IN ('previewed','queued','running')`).orderBy(desc(platformRestoreActionsTable.createdAt)).limit(limit);
  const now = new Date();
  const cooldown = await authDb.select().from(platformStepUpChallengesTable).where(and(sql`${platformStepUpChallengesTable.consumedAt} IS NULL`, sql`${platformStepUpChallengesTable.notBeforeAt} IS NOT NULL`, sql`${platformStepUpChallengesTable.notBeforeAt} > ${now}`)).orderBy(desc(platformStepUpChallengesTable.issuedAt)).limit(limit);
  return { approvals: { requested: pendingApprovals, approved: approvedNotExecuted }, operations: { maintenance: pendingMaintenance, restore: pendingRestore }, cooldown };
}

export async function computeOverview(authDb: RlsDb, opts: { range: "24h" | "7d" | "30d" }): Promise<any> {
  const now = new Date();
  const ms = opts.range === "24h" ? 24 * 60 * 60 * 1000 : opts.range === "30d" ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const since = new Date(now.getTime() - ms);

  const [maintTotal] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformMaintenanceActionsTable).where(sql`${platformMaintenanceActionsTable.createdAt} >= ${since}`);
  const [restoreTotal] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformRestoreActionsTable).where(sql`${platformRestoreActionsTable.createdAt} >= ${since}`);
  const [approvalTotal] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformApprovalRequestsTable).where(sql`${platformApprovalRequestsTable.createdAt} >= ${since}`);

  const [maintFailed] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformMaintenanceActionsTable).where(and(eq(platformMaintenanceActionsTable.status, "failed"), sql`${platformMaintenanceActionsTable.createdAt} >= ${since}`));
  const [restoreFailed] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.status, "failed"), sql`${platformRestoreActionsTable.createdAt} >= ${since}`));
  const [approvalFailed] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformApprovalRequestsTable).where(and(sql`status IN ('rejected','expired','cancelled')`, sql`${platformApprovalRequestsTable.createdAt} >= ${since}`));

  const [openIncidents] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformIncidentsTable).where(sql`status IN ('open','investigating','awaiting-approval','awaiting-execution')`);
  const [criticalIncidents] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformIncidentsTable).where(and(eq(platformIncidentsTable.severity, "critical"), sql`status IN ('open','investigating','awaiting-approval','awaiting-execution')`));

  const [pendingApprovals] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.status, "requested"));
  const [pendingRecoveries] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformRestoreActionsTable).where(sql`status IN ('previewed','queued','running')`);
  const [highRiskActions] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformMaintenanceActionsTable).where(and(sql`${platformMaintenanceActionsTable.createdAt} >= ${since}`, sql`risk_level IN ('high','critical')`));

  const [emergency7d] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(platformApprovalRequestsTable).where(and(eq(platformApprovalRequestsTable.emergencyFlag, true), sql`${platformApprovalRequestsTable.createdAt} >= ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)}`));

  const topFailingFirms = await authDb.execute(sql`
    SELECT firm_id, COUNT(*)::int AS c
    FROM platform_restore_actions
    WHERE status = 'failed' AND created_at >= ${since}
    GROUP BY firm_id
    ORDER BY c DESC
    LIMIT 10
  `) as any;

  const topFailingModules = await authDb.execute(sql`
    SELECT COALESCE(module_code, 'unknown') AS module_code, COUNT(*)::int AS c
    FROM platform_maintenance_actions
    WHERE status = 'failed' AND created_at >= ${since}
    GROUP BY COALESCE(module_code, 'unknown')
    ORDER BY c DESC
    LIMIT 10
  `) as any;

  const opsByDay = await authDb.execute(sql`
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS c
    FROM (
      SELECT created_at FROM platform_maintenance_actions WHERE created_at >= ${since}
      UNION ALL
      SELECT created_at FROM platform_restore_actions WHERE created_at >= ${since}
      UNION ALL
      SELECT created_at FROM platform_approval_requests WHERE created_at >= ${since}
    ) t
    GROUP BY day
    ORDER BY day ASC
    LIMIT 60
  `) as any;

  const incidentsByDay = await authDb.execute(sql`
    SELECT to_char(date_trunc('day', detected_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS c
    FROM platform_incidents
    WHERE detected_at >= ${since}
    GROUP BY day
    ORDER BY day ASC
    LIMIT 60
  `) as any;

  const readiness = await computeReadiness(authDb, { limit: 50 });
  const restoreReadyFirms = readiness.items.filter((r: any) => r.readiness === "ready" || r.readiness === "ready_with_warning").length;
  const firmsNoValidSnapshot = readiness.items.filter((r: any) => (r.blockers ?? []).includes("no_valid_snapshot")).length;

  return {
    range: opts.range,
    kpi: {
      total_operations: Number((maintTotal as any)?.c ?? 0) + Number((restoreTotal as any)?.c ?? 0) + Number((approvalTotal as any)?.c ?? 0),
      failed_operations: Number((maintFailed as any)?.c ?? 0) + Number((restoreFailed as any)?.c ?? 0) + Number((approvalFailed as any)?.c ?? 0),
      open_incidents: Number((openIncidents as any)?.c ?? 0),
      critical_incidents: Number((criticalIncidents as any)?.c ?? 0),
      pending_approvals: Number((pendingApprovals as any)?.c ?? 0),
      pending_recoveries: Number((pendingRecoveries as any)?.c ?? 0),
      high_risk_actions: Number((highRiskActions as any)?.c ?? 0),
      restore_ready_firms: restoreReadyFirms,
      firms_with_no_valid_snapshot: firmsNoValidSnapshot,
      emergency_overrides_7d: Number((emergency7d as any)?.c ?? 0),
    },
    trends: {
      operations_by_day: Array.isArray((opsByDay as any)?.rows) ? (opsByDay as any).rows : Array.isArray(opsByDay) ? opsByDay : [],
      incidents_by_day: Array.isArray((incidentsByDay as any)?.rows) ? (incidentsByDay as any).rows : Array.isArray(incidentsByDay) ? incidentsByDay : [],
    },
    risk_lists: {
      top_failing_firms: Array.isArray((topFailingFirms as any)?.rows) ? (topFailingFirms as any).rows : Array.isArray(topFailingFirms) ? topFailingFirms : [],
      top_failing_modules: Array.isArray((topFailingModules as any)?.rows) ? (topFailingModules as any).rows : Array.isArray(topFailingModules) ? topFailingModules : [],
    },
  };
}

export async function getApprovalEventActors(authDb: RlsDb, approvalId: string): Promise<any[]> {
  return await authDb.select().from(platformApprovalEventsTable).where(eq(platformApprovalEventsTable.requestId, approvalId)).orderBy(desc(platformApprovalEventsTable.createdAt)).limit(100);
}
