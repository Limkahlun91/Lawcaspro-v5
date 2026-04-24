import crypto from "crypto";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import {
  auditLogsTable,
  caseDocumentChecklistItemsTable,
  caseDocumentsTable,
  caseKeyDatesTable,
  caseLoanStampingItemsTable,
  caseWorkflowDocumentsTable,
  caseWorkflowStepsTable,
  casesTable,
  developersTable,
  documentBatchJobsTable,
  documentExtractionJobsTable,
  documentTemplateApplicabilityRulesTable,
  documentTemplateBindingsTable,
  firmDashboardStatsCacheTable,
  firmBankAccountsTable,
  firmsTable,
  platformMaintenanceActionsTable,
  platformMaintenanceActionStepsTable,
  platformRestoreActionsTable,
  platformRestoreActionStepsTable,
  platformSnapshotItemsTable,
  platformSnapshotRetentionPoliciesTable,
  platformSnapshotsTable,
  projectsTable,
  sessionsTable,
  usersTable,
  type RlsDb,
} from "@workspace/db";
import { SupabaseStorageService, getSupabaseStorageConfigError } from "../lib/objectStorage";
import { ApiError } from "../lib/api-response";
import { computeDashboardStats } from "./dashboard-stats";
import { assertApprovalApproved, assertNoConcurrentDestructive, consumeStepUpChallenge, evaluateDecisionForExecute, markApprovalExecuted } from "./founder-governance";

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const MAINTENANCE_SCOPE_TYPES = ["record", "module", "settings", "firm"] as const;
export type MaintenanceScopeType = (typeof MAINTENANCE_SCOPE_TYPES)[number];

export const MAINTENANCE_ACTION_STATUSES = ["previewed", "snapshotting", "queued", "running", "completed", "failed", "cancelled"] as const;
export type MaintenanceActionStatus = (typeof MAINTENANCE_ACTION_STATUSES)[number];

export const RESTORE_STATUSES = ["previewed", "queued", "running", "completed", "failed", "cancelled"] as const;
export type RestoreStatus = (typeof RESTORE_STATUSES)[number];

export const SNAPSHOT_STATUSES = ["pending", "running", "completed", "failed", "partial", "expired", "deleted"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const INTEGRITY_STATUSES = ["valid", "invalid", "unverified", "corrupted"] as const;
export type SnapshotIntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

export const SNAPSHOT_TRIGGER_TYPES = ["manual", "pre_action", "pre_restore", "scheduled", "incident_recovery", "system_baseline"] as const;
export type SnapshotTriggerType = (typeof SNAPSHOT_TRIGGER_TYPES)[number];

export const SNAPSHOT_TYPES = ["record", "module", "settings", "firm"] as const;
export type SnapshotType = (typeof SNAPSHOT_TYPES)[number];

export const TARGET_ENTITY_TYPES = [
  "case",
  "project",
  "developer",
  "report",
  "report_config",
  "dashboard_cache",
  "settings",
  "document_mapping",
  "generated_document",
  "communication_sync",
  "session",
  "firm",
] as const;
export type TargetEntityType = (typeof TARGET_ENTITY_TYPES)[number];

export const MODULE_CODES = [
  "cases",
  "reports",
  "settings",
  "projects",
  "developers",
  "documents",
  "communications",
  "dashboard",
  "cache",
  "sessions",
] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export const MAINTENANCE_ACTION_CODES = [
  "recalculate_stats",
  "rebuild_reports",
  "reindex_documents",
  "clear_failed_jobs",
  "force_logout_sessions",
  "repair_derived_data",
  "reset_case_workflow",
  "reset_case_generated_docs",
  "reset_case_progress_metadata",
  "reset_case_full_soft",
  "reset_settings_default",
  "reset_settings_last_snapshot",
  "reset_projects_module",
  "reset_developers_module",
  "reset_reports_module",
  "reset_documents_metadata",
  "reset_communications_sync",
  "restore_snapshot",
] as const;
export type MaintenanceActionCode = (typeof MAINTENANCE_ACTION_CODES)[number];

export const RESTORE_OPERATION_CODES = ["restore_snapshot", "rollback_restore"] as const;
export type RestoreOperationCode = (typeof RESTORE_OPERATION_CODES)[number];

export type MaintenanceTarget = {
  entity_type?: TargetEntityType;
  entity_id?: string;
  label?: string;
  module_code?: ModuleCode;
};

export type MaintenancePreview = {
  action_code: MaintenanceActionCode;
  scope_type: MaintenanceScopeType;
  module_code?: ModuleCode;
  target?: { entity_type: TargetEntityType; entity_id: string; label?: string };
  risk_level: RiskLevel;
  requires_snapshot: boolean;
  snapshot_strategy: "none" | "pre_action";
  impact_summary: Record<string, number>;
  dependency_summary: { has_blockers: boolean; blocking_items: Array<{ type: string; id: string; label?: string }> };
  warnings: Array<{ code: string; message: string }>;
  restore_availability: { available: boolean; recommended_snapshot_type?: SnapshotType; notes?: string };
};

export function requiredTypedConfirmation(risk: RiskLevel): string | null {
  if (risk === "medium") return "CONFIRM";
  if (risk === "high") return "RESET";
  if (risk === "critical") return "I UNDERSTAND THIS ACTION";
  return null;
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function getRetentionPolicy(authDb: RlsDb, code: string | null | undefined): Promise<{ code: string; retentionDays: number } | null> {
  if (!code) return null;
  const [row] = await authDb
    .select({ code: platformSnapshotRetentionPoliciesTable.code, retentionDays: platformSnapshotRetentionPoliciesTable.retentionDays })
    .from(platformSnapshotRetentionPoliciesTable)
    .where(eq(platformSnapshotRetentionPoliciesTable.code, code));
  if (!row) return null;
  return { code: row.code, retentionDays: row.retentionDays };
}

function computeExpiresAt(createdAt: Date, retentionDays: number): Date {
  return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

export async function assertFirmExists(authDb: RlsDb, firmId: number): Promise<void> {
  const [firm] = await authDb.select({ id: firmsTable.id }).from(firmsTable).where(eq(firmsTable.id, firmId));
  if (!firm) throw new ApiError({ status: 404, code: "FIRM_NOT_FOUND", message: "Firm not found", retryable: false });
}

export async function createSnapshot(
  authDb: RlsDb,
  opts: {
    firmId: number;
    snapshotType: SnapshotType;
    scopeType: MaintenanceScopeType;
    moduleCode?: ModuleCode;
    targetEntityType?: TargetEntityType;
    targetEntityId?: string;
    targetLabel?: string;
    triggerType: SnapshotTriggerType;
    triggerActionCode?: MaintenanceActionCode | RestoreOperationCode;
    createdByUserId?: number | null;
    createdByEmail?: string | null;
    reason?: string | null;
    note?: string | null;
    retentionPolicyCode?: string | null;
    storage?: SupabaseStorageService;
  }
): Promise<{ snapshotId: string; storageDriver: "db" | "supabase"; storagePath?: string | null; checksum: string; sizeBytes: number }> {
  await assertFirmExists(authDb, opts.firmId);
  const id = crypto.randomUUID();
  const startedAt = new Date();

  const policy = await getRetentionPolicy(authDb, opts.retentionPolicyCode ?? null);
  const expiresAt = policy ? computeExpiresAt(startedAt, policy.retentionDays) : null;

  await authDb.insert(platformSnapshotsTable).values({
    id,
    firmId: opts.firmId,
    snapshotType: opts.snapshotType,
    scopeType: opts.scopeType,
    moduleCode: opts.moduleCode ?? null,
    targetEntityType: opts.targetEntityType ?? null,
    targetEntityId: opts.targetEntityId ?? null,
    targetLabel: opts.targetLabel ?? null,
    triggerType: opts.triggerType,
    triggerActionCode: opts.triggerActionCode ?? null,
    createdByUserId: opts.createdByUserId ?? null,
    createdByEmail: opts.createdByEmail ?? null,
    reason: opts.reason ?? null,
    note: opts.note ?? null,
    status: "running",
    integrityStatus: "unverified",
    startedAt,
    expiresAt,
    retentionPolicyCode: policy?.code ?? null,
    storageDriver: "db",
  });

  try {
    const { payload, items, itemCounts, metadata } = await buildSnapshotPayload(authDb, opts.firmId, {
      snapshotType: opts.snapshotType,
      moduleCode: opts.moduleCode,
      targetEntityType: opts.targetEntityType,
      targetEntityId: opts.targetEntityId,
    });
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const checksum = sha256Buffer(bytes);
    const sizeBytes = bytes.byteLength;

    let storageDriver: "db" | "supabase" = "db";
    let storagePath: string | null = null;
    let payloadStorageKey: string | null = null;
    let payloadJson: unknown | null = payload;

    const preferStorage = sizeBytes > 256_000;
    if (preferStorage && opts.storage) {
      const storageReady = (() => {
        try {
          opts.storage.assertConfigured();
          return true;
        } catch (e) {
          const cfgErr = getSupabaseStorageConfigError(e);
          if (cfgErr) return false;
          throw e;
        }
      })();
      if (storageReady) {
        payloadStorageKey = `snapshots/${opts.firmId}/${id}.json`;
        const objectPath = `/objects/${payloadStorageKey}`;
        await opts.storage.uploadPrivateObject({ objectPath, fileBytes: bytes, contentType: "application/json" });
        storageDriver = "supabase";
        storagePath = objectPath;
        payloadJson = null;
      }
    }

    if (items.length) {
      await authDb.insert(platformSnapshotItemsTable).values(
        items.map((it) => ({
          snapshotId: id,
          firmId: opts.firmId,
          itemType: it.itemType,
          itemId: it.itemId ?? null,
          itemLabel: it.itemLabel ?? null,
          moduleCode: it.moduleCode ?? null,
          stateHash: it.stateHash ?? null,
          payloadFragment: it.payloadFragment ?? null,
        }))
      );
    }

    await authDb.update(platformSnapshotsTable).set({
      status: "completed",
      integrityStatus: "valid",
      completedAt: new Date(),
      checksum,
      sizeBytes,
      storageDriver,
      storagePath,
      payloadStorageKey,
      payloadJson,
      itemCountsJson: itemCounts,
      metadataJson: metadata,
      lastAccessedAt: new Date(),
    }).where(eq(platformSnapshotsTable.id, id));

    return { snapshotId: id, storageDriver, storagePath, checksum, sizeBytes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    await authDb.update(platformSnapshotsTable).set({
      status: "failed",
      integrityStatus: "invalid",
      failedAt: new Date(),
      restorable: false,
      restoreNotes: message.slice(0, 400),
    }).where(eq(platformSnapshotsTable.id, id));
    throw new ApiError({ status: 500, code: "SNAPSHOT_CREATE_FAILED", message: "Snapshot creation failed", retryable: true });
  }
}

type SnapshotBuildOpts = {
  snapshotType: SnapshotType;
  moduleCode?: ModuleCode;
  targetEntityType?: TargetEntityType;
  targetEntityId?: string;
};

function asPlainObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

function readArray(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

function readDate(obj: Record<string, unknown>, key: string): Date | null {
  const v = obj[key];
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

async function buildSnapshotPayload(
  authDb: RlsDb,
  firmId: number,
  opts: SnapshotBuildOpts
): Promise<{
  payload: unknown;
  items: Array<{ itemType: string; itemId?: string; itemLabel?: string; moduleCode?: string; stateHash?: string; payloadFragment?: unknown }>;
  itemCounts: Record<string, number>;
  metadata: Record<string, unknown>;
}> {
  const items: Array<{ itemType: string; itemId?: string; itemLabel?: string; moduleCode?: string; stateHash?: string; payloadFragment?: unknown }> = [];
  const itemCounts: Record<string, number> = {};
  const metadata: Record<string, unknown> = { firmId, snapshotType: opts.snapshotType, moduleCode: opts.moduleCode ?? null };

  if (opts.snapshotType === "settings") {
    const [firm] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, firmId));
    if (!firm) throw new ApiError({ status: 404, code: "FIRM_NOT_FOUND", message: "Firm not found", retryable: false });
    const bankAccounts = await authDb.select().from(firmBankAccountsTable).where(eq(firmBankAccountsTable.firmId, firmId));
    const settingsGroup = opts.targetEntityType === "settings" && opts.targetEntityId ? String(opts.targetEntityId) : null;
    metadata.settingsGroup = settingsGroup;

    const includeFirm = !settingsGroup || settingsGroup === "firm_profile";
    const includeBankAccounts = !settingsGroup || settingsGroup === "bank_accounts";

    itemCounts.firm = includeFirm ? 1 : 0;
    itemCounts.bank_accounts = includeBankAccounts ? bankAccounts.length : 0;

    if (includeFirm) {
      items.push({ itemType: "firm", itemId: String(firm.id), itemLabel: firm.name, moduleCode: "settings", payloadFragment: { firm } });
    }
    if (includeBankAccounts) {
      for (const b of bankAccounts) {
        items.push({ itemType: "bank_account", itemId: String(b.id), itemLabel: b.bankName, moduleCode: "settings", payloadFragment: { bankAccount: b } });
      }
    }

    const payload = { kind: "settings", firm, bankAccounts, settingsGroup };
    return { payload, items, itemCounts, metadata };
  }

  if (opts.snapshotType === "record" && opts.targetEntityType === "case") {
    const caseId = Number.parseInt(opts.targetEntityId ?? "", 10);
    if (!Number.isFinite(caseId)) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid case id", retryable: false });
    const [c] = await authDb.select().from(casesTable).where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)));
    if (!c) throw new ApiError({ status: 404, code: "CASE_NOT_FOUND", message: "Case not found", retryable: false });
    const workflowSteps = await authDb.select().from(caseWorkflowStepsTable).where(eq(caseWorkflowStepsTable.caseId, caseId));
    const [keyDates] = await authDb.select().from(caseKeyDatesTable).where(and(eq(caseKeyDatesTable.caseId, caseId), eq(caseKeyDatesTable.firmId, firmId)));
    const caseDocuments = await authDb.select().from(caseDocumentsTable).where(and(eq(caseDocumentsTable.caseId, caseId), eq(caseDocumentsTable.firmId, firmId)));
    const workflowDocs = await authDb.select().from(caseWorkflowDocumentsTable).where(and(eq(caseWorkflowDocumentsTable.caseId, caseId), eq(caseWorkflowDocumentsTable.firmId, firmId)));
    const stampingItems = await authDb.select().from(caseLoanStampingItemsTable).where(and(eq(caseLoanStampingItemsTable.caseId, caseId), eq(caseLoanStampingItemsTable.firmId, firmId)));

    itemCounts.case = 1;
    itemCounts.workflow_steps = workflowSteps.length;
    itemCounts.key_dates = keyDates ? 1 : 0;
    itemCounts.case_documents = caseDocuments.length;
    itemCounts.workflow_documents = workflowDocs.length;
    itemCounts.loan_stamping_items = stampingItems.length;

    items.push({ itemType: "case", itemId: String(c.id), itemLabel: c.referenceNo, moduleCode: "cases", payloadFragment: { case: c } });
    items.push({ itemType: "case_workflow_steps", itemId: String(c.id), itemLabel: c.referenceNo, moduleCode: "cases", payloadFragment: { workflowStepsCount: workflowSteps.length } });
    items.push({ itemType: "case_documents", itemId: String(c.id), itemLabel: c.referenceNo, moduleCode: "documents", payloadFragment: { caseDocumentsCount: caseDocuments.length } });
    if (keyDates) items.push({ itemType: "case_key_dates", itemId: String(keyDates.id), itemLabel: c.referenceNo, moduleCode: "cases", payloadFragment: { keyDates } });

    const payload = {
      kind: "case",
      firmId,
      case: c,
      workflowSteps,
      keyDates: keyDates ?? null,
      caseDocuments,
      workflowDocuments: workflowDocs,
      loanStampingItems: stampingItems,
    };
    return { payload, items, itemCounts, metadata: { ...metadata, caseId: c.id, referenceNo: c.referenceNo } };
  }

  if (opts.snapshotType === "record" && opts.targetEntityType === "project") {
    const projectId = Number.parseInt(opts.targetEntityId ?? "", 10);
    if (!Number.isFinite(projectId)) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid project id", retryable: false });
    const [p] = await authDb.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.firmId, firmId)));
    if (!p) throw new ApiError({ status: 404, code: "PROJECT_NOT_FOUND", message: "Project not found", retryable: false });
    itemCounts.project = 1;
    items.push({ itemType: "project", itemId: String(p.id), itemLabel: p.name, moduleCode: "projects", payloadFragment: { project: p } });
    const payload = { kind: "project", firmId, project: p };
    return { payload, items, itemCounts, metadata: { ...metadata, projectId: p.id } };
  }

  if (opts.snapshotType === "record" && opts.targetEntityType === "developer") {
    const developerId = Number.parseInt(opts.targetEntityId ?? "", 10);
    if (!Number.isFinite(developerId)) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid developer id", retryable: false });
    const [d] = await authDb.select().from(developersTable).where(and(eq(developersTable.id, developerId), eq(developersTable.firmId, firmId)));
    if (!d) throw new ApiError({ status: 404, code: "DEVELOPER_NOT_FOUND", message: "Developer not found", retryable: false });
    itemCounts.developer = 1;
    items.push({ itemType: "developer", itemId: String(d.id), itemLabel: d.name, moduleCode: "developers", payloadFragment: { developer: d } });
    const payload = { kind: "developer", firmId, developer: d };
    return { payload, items, itemCounts, metadata: { ...metadata, developerId: d.id } };
  }

  if (opts.snapshotType === "module" && opts.moduleCode === "projects") {
    const projects = await authDb.select().from(projectsTable).where(and(eq(projectsTable.firmId, firmId), isNull(projectsTable.archivedAt))).orderBy(desc(projectsTable.createdAt));
    itemCounts.projects = projects.length;
    for (const p of projects) {
      items.push({ itemType: "project", itemId: String(p.id), itemLabel: p.name, moduleCode: "projects", payloadFragment: { project: p } });
    }
    const payload = { kind: "projects_module", firmId, projects };
    return { payload, items, itemCounts, metadata };
  }

  if (opts.snapshotType === "module" && opts.moduleCode === "developers") {
    const developers = await authDb.select().from(developersTable).where(eq(developersTable.firmId, firmId)).orderBy(desc(developersTable.createdAt));
    itemCounts.developers = developers.length;
    for (const d of developers) {
      items.push({ itemType: "developer", itemId: String(d.id), itemLabel: d.name, moduleCode: "developers", payloadFragment: { developer: d } });
    }
    const payload = { kind: "developers_module", firmId, developers };
    return { payload, items, itemCounts, metadata };
  }

  if (opts.snapshotType === "module" && opts.moduleCode === "documents") {
    const bindings = await authDb.select().from(documentTemplateBindingsTable).where(eq(documentTemplateBindingsTable.firmId, firmId)).orderBy(desc(documentTemplateBindingsTable.updatedAt));
    const rules = await authDb.select().from(documentTemplateApplicabilityRulesTable).where(eq(documentTemplateApplicabilityRulesTable.firmId, firmId)).orderBy(desc(documentTemplateApplicabilityRulesTable.updatedAt));
    itemCounts.document_template_bindings = bindings.length;
    itemCounts.document_template_applicability_rules = rules.length;
    items.push({ itemType: "document_template_bindings", itemId: String(firmId), itemLabel: "bindings", moduleCode: "documents", payloadFragment: { count: bindings.length } });
    items.push({ itemType: "document_template_applicability_rules", itemId: String(firmId), itemLabel: "rules", moduleCode: "documents", payloadFragment: { count: rules.length } });
    const payload = { kind: "documents_metadata_module", firmId, bindings, applicabilityRules: rules };
    return { payload, items, itemCounts, metadata };
  }

  if (opts.snapshotType === "firm") {
    const [firm] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, firmId));
    if (!firm) throw new ApiError({ status: 404, code: "FIRM_NOT_FOUND", message: "Firm not found", retryable: false });
    const projects = await authDb.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.firmId, firmId), isNull(projectsTable.archivedAt)));
    const users = await authDb.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.firmId, firmId));
    const cases = await authDb.select({ id: casesTable.id }).from(casesTable).where(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt)));
    itemCounts.projects = projects.length;
    itemCounts.users = users.length;
    itemCounts.cases = cases.length;
    items.push({ itemType: "firm_summary", itemId: String(firm.id), itemLabel: firm.name, moduleCode: "firm", payloadFragment: { counts: itemCounts } });
    const payload = { kind: "firm_summary", firm, counts: itemCounts };
    return { payload, items, itemCounts, metadata };
  }

  throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Snapshot scope not supported", retryable: false });
}

export async function readSnapshotPayload(authDb: RlsDb, snapshotId: string, storage: SupabaseStorageService): Promise<unknown> {
  const [snap] = await authDb.select().from(platformSnapshotsTable).where(eq(platformSnapshotsTable.id, snapshotId));
  if (!snap) throw new ApiError({ status: 404, code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", retryable: false });
  if (snap.deletedAt || snap.status === "deleted") throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot is deleted", retryable: false });
  if (snap.expiresAt && snap.expiresAt < new Date()) throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot expired", retryable: false });
  if (!snap.restorable) throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot is not restorable", retryable: false });
  if (snap.integrityStatus !== "valid") throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot integrity is not valid", retryable: false, details: { integrity_status: snap.integrityStatus } });
  await authDb.update(platformSnapshotsTable).set({ lastAccessedAt: new Date() }).where(eq(platformSnapshotsTable.id, snapshotId));

  if (snap.payloadJson) return snap.payloadJson;

  try {
    storage.assertConfigured();
  } catch (e) {
    const cfgErr = getSupabaseStorageConfigError(e);
    if (cfgErr) throw new ApiError({ status: 503, code: "STORAGE_UNAVAILABLE", message: cfgErr.error, retryable: true });
    throw e;
  }
  if (!snap.storagePath) throw new ApiError({ status: 500, code: "SNAPSHOT_CREATE_FAILED", message: "Snapshot payload missing", retryable: false });

  const resp = await storage.fetchPrivateObjectResponse(snap.storagePath);
  const text = await resp.text();
  return JSON.parse(text) as unknown;
}

export async function previewMaintenanceAction(
  authDb: RlsDb,
  opts: { firmId: number; actionCode: MaintenanceActionCode; target?: MaintenanceTarget }
): Promise<MaintenancePreview> {
  await assertFirmExists(authDb, opts.firmId);

  const warnings: Array<{ code: string; message: string }> = [];
  const impact: Record<string, number> = {};
  const blockers: Array<{ type: string; id: string; label?: string }> = [];

  if (opts.actionCode === "force_logout_sessions") {
    const [row] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(sessionsTable).leftJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
      .where(eq(usersTable.firmId, opts.firmId));
    impact.sessions_to_invalidate = Number((row as any)?.c ?? 0);
    return {
      action_code: opts.actionCode,
      scope_type: "firm",
      module_code: "sessions",
      risk_level: "medium",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: false, notes: "Sessions invalidation cannot be restored." },
    };
  }

  if (opts.actionCode === "recalculate_stats") {
    const [caseCountRow] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(casesTable).where(and(eq(casesTable.firmId, opts.firmId), isNull(casesTable.deletedAt)));
    const [userCountRow] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(usersTable).where(eq(usersTable.firmId, opts.firmId));
    const [projectCountRow] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(projectsTable).where(and(eq(projectsTable.firmId, opts.firmId), isNull(projectsTable.archivedAt)));
    impact.cases = Number((caseCountRow as any)?.c ?? 0);
    impact.users = Number((userCountRow as any)?.c ?? 0);
    impact.projects = Number((projectCountRow as any)?.c ?? 0);
    return {
      action_code: opts.actionCode,
      scope_type: "firm",
      module_code: "dashboard",
      risk_level: "low",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: false },
    };
  }

  if (opts.actionCode === "rebuild_reports") {
    impact.dashboard_cache_refresh = 1;
    return {
      action_code: opts.actionCode,
      scope_type: "module",
      module_code: "dashboard",
      risk_level: "medium",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: false },
    };
  }

  if (opts.actionCode === "reindex_documents") {
    const [row] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(caseDocumentChecklistItemsTable).where(eq(caseDocumentChecklistItemsTable.firmId, opts.firmId));
    impact.checklist_items_to_reindex = Number((row as any)?.c ?? 0);
    return {
      action_code: opts.actionCode,
      scope_type: "module",
      module_code: "documents",
      risk_level: "medium",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: false, notes: "This action resets derived checklist metadata and can be safely rerun." },
    };
  }

  if (opts.actionCode === "clear_failed_jobs") {
    const [batch] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(documentBatchJobsTable).where(and(eq(documentBatchJobsTable.firmId, opts.firmId), eq(documentBatchJobsTable.status, "failed"), isNull(documentBatchJobsTable.archivedAt)));
    const [extract] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(documentExtractionJobsTable).where(and(eq(documentExtractionJobsTable.firmId, opts.firmId), sql`${documentExtractionJobsTable.errorMessage} IS NOT NULL`, isNull(documentExtractionJobsTable.archivedAt)));
    impact.failed_batch_jobs_to_archive = Number((batch as any)?.c ?? 0);
    impact.failed_extraction_jobs_to_archive = Number((extract as any)?.c ?? 0);
    return {
      action_code: opts.actionCode,
      scope_type: "module",
      module_code: "documents",
      risk_level: "low",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: false },
    };
  }

  if (opts.actionCode === "repair_derived_data") {
    const orphanRows = await authDb.execute(sql`
      SELECT COUNT(*)::int AS c
      FROM case_document_checklist_items i
      WHERE i.firm_id = ${opts.firmId}
        AND i.case_document_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM case_documents d
          WHERE d.id = i.case_document_id AND d.firm_id = i.firm_id
        )
    `);
    const orphanCount = Array.isArray(orphanRows) ? Number((orphanRows as any)?.[0]?.c ?? 0) : Number((orphanRows as any)?.rows?.[0]?.c ?? 0);
    impact.orphaned_checklist_links_to_repair = orphanCount;
    if (orphanCount > 0) warnings.push({ code: "ORPHANED_CHECKLIST_LINKS", message: "Some checklist items reference missing uploads and will be repaired." });
    return {
      action_code: opts.actionCode,
      scope_type: "module",
      module_code: "documents",
      risk_level: "medium",
      requires_snapshot: false,
      snapshot_strategy: "none",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: false },
    };
  }

  if (opts.actionCode === "reset_settings_default") {
    const [firm] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, opts.firmId));
    if (!firm) throw new ApiError({ status: 404, code: "FIRM_NOT_FOUND", message: "Firm not found", retryable: false });
    const bankAccounts = await authDb.select().from(firmBankAccountsTable).where(eq(firmBankAccountsTable.firmId, opts.firmId));
    impact.firm_fields_to_reset = 3;
    impact.bank_accounts_to_remove = bankAccounts.length;
    warnings.push({ code: "BANK_ACCOUNTS_WILL_BE_REMOVED", message: "All firm bank accounts will be removed. You can restore from the pre-action snapshot." });
    return {
      action_code: opts.actionCode,
      scope_type: "settings",
      module_code: "settings",
      risk_level: "high",
      requires_snapshot: true,
      snapshot_strategy: "pre_action",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: true, recommended_snapshot_type: "settings" },
    };
  }

  if (opts.actionCode === "reset_projects_module") {
    const projects = await authDb.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(and(eq(projectsTable.firmId, opts.firmId), isNull(projectsTable.archivedAt)));
    impact.projects_to_archive = projects.length;
    const [caseRefs] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(casesTable).where(and(eq(casesTable.firmId, opts.firmId), isNull(casesTable.deletedAt)));
    const activeCases = Number((caseRefs as any)?.c ?? 0);
    if (activeCases > 0) {
      blockers.push({ type: "case", id: String(opts.firmId), label: `${activeCases} active cases exist` });
      warnings.push({ code: "DEPENDENCY_BLOCKED", message: "Projects module reset is blocked while active cases exist. Archive/unlink cases first." });
    }
    return {
      action_code: opts.actionCode,
      scope_type: "module",
      module_code: "projects",
      risk_level: "high",
      requires_snapshot: true,
      snapshot_strategy: "pre_action",
      impact_summary: impact,
      dependency_summary: { has_blockers: blockers.length > 0, blocking_items: blockers },
      warnings,
      restore_availability: { available: true, recommended_snapshot_type: "module" },
    };
  }

  if (opts.actionCode.startsWith("reset_case_")) {
    const caseId = Number.parseInt(opts.target?.entity_id ?? "", 10);
    if (!Number.isFinite(caseId)) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Case target is required", retryable: false });
    const [c] = await authDb.select({ id: casesTable.id, referenceNo: casesTable.referenceNo, status: casesTable.status }).from(casesTable).where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, opts.firmId)));
    if (!c) throw new ApiError({ status: 404, code: "CASE_NOT_FOUND", message: "Case not found", retryable: false });
    const workflowSteps = await authDb.select({ id: caseWorkflowStepsTable.id }).from(caseWorkflowStepsTable).where(eq(caseWorkflowStepsTable.caseId, caseId));
    const caseDocs = await authDb.select({ id: caseDocumentsTable.id }).from(caseDocumentsTable).where(and(eq(caseDocumentsTable.caseId, caseId), eq(caseDocumentsTable.firmId, opts.firmId), sql`${caseDocumentsTable.status} <> 'archived'`));
    impact.workflow_steps_to_reset = workflowSteps.length;
    impact.case_documents_to_archive = caseDocs.length;
    const risk: RiskLevel = opts.actionCode === "reset_case_full_soft" ? "critical" : "high";
    return {
      action_code: opts.actionCode,
      scope_type: "record",
      module_code: "cases",
      target: { entity_type: "case", entity_id: String(c.id), label: c.referenceNo },
      risk_level: risk,
      requires_snapshot: true,
      snapshot_strategy: "pre_action",
      impact_summary: impact,
      dependency_summary: { has_blockers: false, blocking_items: [] },
      warnings,
      restore_availability: { available: true, recommended_snapshot_type: "record", notes: "Restore will reapply case state and related workflow/doc metadata from snapshot." },
    };
  }

  throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Action not supported", retryable: false });
}

export async function createMaintenanceActionPreviewRecord(
  authDb: RlsDb,
  opts: {
    firmId: number;
    preview: MaintenancePreview;
    requestedByUserId: number;
    requestedByEmail?: string | null;
  }
): Promise<string> {
  const actionId = crypto.randomUUID();
  const target = opts.preview.target;
  await authDb.insert(platformMaintenanceActionsTable).values({
    id: actionId,
    firmId: opts.firmId,
    actionCode: opts.preview.action_code,
    scopeType: opts.preview.scope_type,
    moduleCode: opts.preview.module_code ?? null,
    targetEntityType: target?.entity_type ?? null,
    targetEntityId: target?.entity_id ?? null,
    targetLabel: target?.label ?? null,
    riskLevel: opts.preview.risk_level,
    status: "previewed",
    requiresSnapshot: opts.preview.requires_snapshot,
    reason: "preview_only",
    typedConfirmation: null,
    previewPayload: opts.preview as unknown as object,
    requestedByUserId: opts.requestedByUserId,
    requestedByEmail: opts.requestedByEmail ?? null,
  });
  await authDb.insert(platformMaintenanceActionStepsTable).values({
    actionId,
    stepCode: "preview",
    stepOrder: 10,
    status: "completed",
    startedAt: new Date(),
    completedAt: new Date(),
  });
  return actionId;
}

export async function executeMaintenanceAction(
  authDb: RlsDb,
  opts: {
    firmId: number;
    actionId: string;
    reason: string;
    typedConfirmation: string | null;
    confirmFirm?: string | null;
    confirmTarget?: string | null;
    approvalRequestId?: string | null;
    stepUpChallengeId?: string | null;
    stepUpPhrase?: string | null;
    emergencyFlag?: boolean;
    actorPermissions: string[];
    impersonationActive: boolean;
    requestedByUserId: number;
    requestedByEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{ actionId: string; status: MaintenanceActionStatus; snapshotId: string | null; result: unknown }> {
  await assertFirmExists(authDb, opts.firmId);
  const [action] = await authDb.select().from(platformMaintenanceActionsTable).where(and(eq(platformMaintenanceActionsTable.id, opts.actionId), eq(platformMaintenanceActionsTable.firmId, opts.firmId)));
  if (!action) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Action not found", retryable: false });
  if (action.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Action is not in previewed state", retryable: true });

  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });

  const preview = action.previewPayload as unknown as MaintenancePreview | null;
  if (!preview) throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Preview payload missing", retryable: true });
  if (preview.dependency_summary?.has_blockers) throw new ApiError({ status: 409, code: "DEPENDENCY_BLOCKED", message: "Action is blocked by dependencies", retryable: false, details: preview.dependency_summary });

  const required = requiredTypedConfirmation(action.riskLevel as RiskLevel);
  if (required) {
    const typed = String(opts.typedConfirmation ?? "").trim();
    if (typed !== required) throw new ApiError({ status: 400, code: "INVALID_CONFIRMATION_TEXT", message: "Typed confirmation does not match required text", retryable: false, details: { required } });
  }

  const decision = evaluateDecisionForExecute({
    actionCode: String(preview.action_code),
    riskLevel: action.riskLevel as RiskLevel,
    scopeType: action.scopeType as MaintenanceScopeType,
    moduleCode: action.moduleCode ?? null,
    actorPermissions: new Set(opts.actorPermissions ?? []),
    impersonation: Boolean(opts.impersonationActive),
    emergency: Boolean(opts.emergencyFlag),
  });
  if (decision.blockedReason) {
    throw new ApiError({
      status: 403,
      code: decision.blockedReason.code === "IMPERSONATION_RESTRICTED" ? "IMPERSONATION_RESTRICTED" : "POLICY_BLOCKED",
      message: decision.blockedReason.message,
      retryable: false,
      details: { policy: decision.approvalPolicyCode, risk_level: action.riskLevel, action_code: preview.action_code },
    });
  }

  let approval: { id: string } | null = null;
  if (decision.approvalRequired) {
    const id = String(opts.approvalRequestId ?? "").trim();
    if (!id) {
      throw new ApiError({
        status: 409,
        code: "APPROVAL_REQUIRED",
        message: "Approval required before executing this action",
        retryable: false,
        stage: "approval",
        details: { required_approvals: decision.requiredApprovalCount, approval_policy_code: decision.approvalPolicyCode },
        suggestion: "Submit an approval request, then execute again after it is approved.",
      });
    }
    await assertApprovalApproved(authDb, { approvalRequestId: id, operationType: "maintenance_action", operationId: opts.actionId, now: new Date() });
    approval = { id };
  }

  let stepUpConfirmation: string | null = null;
  if (decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0) {
    const challengeId = String(opts.stepUpChallengeId ?? "").trim();
    const phrase = String(opts.stepUpPhrase ?? "").trim();
    if (!challengeId || !phrase) {
      throw new ApiError({
        status: 409,
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required",
        retryable: false,
        stage: "step_up",
      });
    }
    await consumeStepUpChallenge(authDb, { challengeId, firmId: opts.firmId, actionCode: String(preview.action_code), actorUserId: opts.requestedByUserId, providedPhrase: phrase });
    stepUpConfirmation = phrase;
  }

  if (action.riskLevel === "high" || action.riskLevel === "critical") {
    await assertNoConcurrentDestructive(authDb, { firmId: opts.firmId, table: "maintenance", currentId: opts.actionId });
  }

  const storage = new SupabaseStorageService();
  let snapshotId: string | null = null;
  const startedAt = new Date();

  await authDb.update(platformMaintenanceActionsTable).set({
    status: action.requiresSnapshot ? "snapshotting" : "running",
    reason,
    typedConfirmation: opts.typedConfirmation ?? null,
    stepUpConfirmation,
    approvalRequestId: approval?.id ?? null,
    startedAt,
    requestedByUserId: opts.requestedByUserId,
    requestedByEmail: opts.requestedByEmail ?? null,
  }).where(eq(platformMaintenanceActionsTable.id, opts.actionId));

  if (action.requiresSnapshot) {
    await authDb.insert(platformMaintenanceActionStepsTable).values({ actionId: opts.actionId, stepCode: "create_snapshot", stepOrder: 20, status: "running", startedAt: new Date() });
    const snap = await createSnapshot(authDb, {
      firmId: opts.firmId,
      snapshotType: preview.restore_availability?.recommended_snapshot_type ?? "firm",
      scopeType: preview.scope_type,
      moduleCode: preview.module_code,
      targetEntityType: preview.target?.entity_type,
      targetEntityId: preview.target?.entity_id,
      targetLabel: preview.target?.label,
      triggerType: "pre_action",
      triggerActionCode: preview.action_code,
      createdByUserId: opts.requestedByUserId,
      createdByEmail: opts.requestedByEmail ?? null,
      reason,
      note: null,
      retentionPolicyCode: "pre_action",
      storage,
    });
    snapshotId = snap.snapshotId;
    await authDb.update(platformMaintenanceActionsTable).set({ preActionSnapshotId: snapshotId, status: "running" }).where(eq(platformMaintenanceActionsTable.id, opts.actionId));
    await authDb.update(platformMaintenanceActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: { snapshotId } }).where(and(eq(platformMaintenanceActionStepsTable.actionId, opts.actionId), eq(platformMaintenanceActionStepsTable.stepCode, "create_snapshot")));
  }

  await authDb.insert(platformMaintenanceActionStepsTable).values({ actionId: opts.actionId, stepCode: "execute", stepOrder: 30, status: "running", startedAt: new Date() });
  try {
    const result = await runMaintenanceMutation(authDb, opts.firmId, preview, opts.requestedByUserId);
    await authDb.update(platformMaintenanceActionsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result as any }).where(eq(platformMaintenanceActionsTable.id, opts.actionId));
    await authDb.update(platformMaintenanceActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result as any }).where(and(eq(platformMaintenanceActionStepsTable.actionId, opts.actionId), eq(platformMaintenanceActionStepsTable.stepCode, "execute")));
    await authDb.insert(auditLogsTable).values({
      firmId: opts.firmId,
      actorId: opts.requestedByUserId,
      actorType: "founder",
      action: `firm.maintenance.${preview.action_code}`,
      entityType: preview.target?.entity_type ?? preview.module_code ?? "firm",
      entityId: preview.target?.entity_type === "case" ? Number(preview.target.entity_id) : null,
      detail: JSON.stringify({ reason, actionId: opts.actionId, snapshotId, approvalRequestId: approval?.id ?? null }),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    });
    if (approval?.id) await markApprovalExecuted(authDb, approval.id);
    return { actionId: opts.actionId, status: "completed", snapshotId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    await authDb.update(platformMaintenanceActionsTable).set({ status: "failed", failedAt: new Date(), errorCode: "RESET_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(eq(platformMaintenanceActionsTable.id, opts.actionId));
    await authDb.update(platformMaintenanceActionStepsTable).set({ status: "failed", completedAt: new Date(), errorCode: "RESET_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(and(eq(platformMaintenanceActionStepsTable.actionId, opts.actionId), eq(platformMaintenanceActionStepsTable.stepCode, "execute")));
    await authDb.insert(auditLogsTable).values({
      firmId: opts.firmId,
      actorId: opts.requestedByUserId,
      actorType: "founder",
      action: `firm.maintenance.${preview.action_code}.failed`,
      entityType: preview.target?.entity_type ?? preview.module_code ?? "firm",
      entityId: preview.target?.entity_type === "case" ? Number(preview.target.entity_id) : null,
      detail: JSON.stringify({ reason, actionId: opts.actionId, snapshotId, approvalRequestId: approval?.id ?? null, error: msg.slice(0, 180) }),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    });
    throw new ApiError({ status: 500, code: "RESET_EXECUTION_FAILED", message: "Maintenance action failed", retryable: true, details: { actionId: opts.actionId, snapshotId } });
  }
}

async function runMaintenanceMutation(authDb: RlsDb, firmId: number, preview: MaintenancePreview, actorUserId: number): Promise<unknown> {
  if (preview.action_code === "force_logout_sessions") {
    const result = await authDb.execute(sql`
      DELETE FROM sessions s
      USING users u
      WHERE s.user_id = u.id AND u.firm_id = ${firmId}
    `);
    return { summary: "Firm sessions invalidated", raw: result };
  }

  if (preview.action_code === "recalculate_stats") {
    const [caseCountRow] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(casesTable).where(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt)));
    const [userCountRow] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(usersTable).where(eq(usersTable.firmId, firmId));
    const [projectCountRow] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(projectsTable).where(and(eq(projectsTable.firmId, firmId), isNull(projectsTable.archivedAt)));
    return {
      summary: "Counts recalculated",
      counts: { cases: Number((caseCountRow as any)?.c ?? 0), users: Number((userCountRow as any)?.c ?? 0), projects: Number((projectCountRow as any)?.c ?? 0) },
    };
  }

  if (preview.action_code === "rebuild_reports") {
    const payload = await computeDashboardStats(authDb, firmId);
    const ttlSec = (() => {
      const raw = process.env.DASHBOARD_CACHE_TTL_SEC ? Number.parseInt(process.env.DASHBOARD_CACHE_TTL_SEC, 10) : 300;
      return Number.isFinite(raw) ? Math.min(Math.max(raw, 30), 3600) : 300;
    })();
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    await authDb.insert(firmDashboardStatsCacheTable).values({
      firmId,
      payloadJson: payload as any,
      computedAt: new Date(),
      expiresAt,
      schemaVersion: 1,
    }).onConflictDoUpdate({
      target: firmDashboardStatsCacheTable.firmId,
      set: { payloadJson: payload as any, computedAt: new Date(), expiresAt, schemaVersion: 1 },
    });
    return { summary: "Dashboard cache rebuilt", expiresAt: expiresAt.toISOString() };
  }

  if (preview.action_code === "reindex_documents") {
    const result = await authDb.execute(sql`
      UPDATE case_document_checklist_items
      SET
        applicability_result = NULL,
        status = CASE WHEN status = 'waived' THEN status ELSE 'pending' END,
        updated_at = now()
      WHERE firm_id = ${firmId}
    `);
    const rowCount = Array.isArray(result) ? (result as any).length : Number((result as any)?.rowCount ?? 0);
    return { summary: "Documents checklist metadata reindexed", affected: { checklist_items_updated: rowCount } };
  }

  if (preview.action_code === "clear_failed_jobs") {
    const batchResult = await authDb.execute(sql`
      UPDATE document_batch_jobs
      SET archived_at = now(), archived_by = ${actorUserId}, archived_reason = 'maintenance_clear_failed'
      WHERE firm_id = ${firmId} AND status = 'failed' AND archived_at IS NULL
    `);
    const extractResult = await authDb.execute(sql`
      UPDATE document_extraction_jobs
      SET archived_at = now(), archived_by = ${actorUserId}, archived_reason = 'maintenance_clear_failed'
      WHERE firm_id = ${firmId} AND error_message IS NOT NULL AND archived_at IS NULL
    `);
    const batchCount = Array.isArray(batchResult) ? (batchResult as any).length : Number((batchResult as any)?.rowCount ?? 0);
    const extractCount = Array.isArray(extractResult) ? (extractResult as any).length : Number((extractResult as any)?.rowCount ?? 0);
    return { summary: "Failed jobs archived", affected: { batch_jobs_archived: batchCount, extraction_jobs_archived: extractCount } };
  }

  if (preview.action_code === "repair_derived_data") {
    const result = await authDb.execute(sql`
      UPDATE case_document_checklist_items i
      SET
        case_document_id = NULL,
        status = CASE WHEN status = 'waived' THEN status ELSE 'pending' END,
        received_at = CASE WHEN status = 'waived' THEN received_at ELSE NULL END,
        received_by = CASE WHEN status = 'waived' THEN received_by ELSE NULL END,
        completed_at = CASE WHEN status = 'waived' THEN completed_at ELSE NULL END,
        completed_by = CASE WHEN status = 'waived' THEN completed_by ELSE NULL END,
        updated_at = now()
      WHERE i.firm_id = ${firmId}
        AND i.case_document_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM case_documents d
          WHERE d.id = i.case_document_id AND d.firm_id = i.firm_id
        )
    `);
    const rowCount = Array.isArray(result) ? (result as any).length : Number((result as any)?.rowCount ?? 0);
    return { summary: "Derived document checklist links repaired", affected: { checklist_links_repaired: rowCount } };
  }

  if (preview.action_code === "reset_settings_default") {
    await authDb.update(firmsTable).set({ address: null, stNumber: null, tinNumber: null }).where(eq(firmsTable.id, firmId));
    await authDb.delete(firmBankAccountsTable).where(eq(firmBankAccountsTable.firmId, firmId));
    return { summary: "Firm settings reset to defaults", affected: { firm: 1 } };
  }

  if (preview.action_code === "reset_projects_module") {
    const [activeCasesRow] = await authDb.select({ c: sql<number>`COUNT(*)::int` }).from(casesTable).where(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt)));
    const activeCases = Number((activeCasesRow as any)?.c ?? 0);
    if (activeCases > 0) {
      throw new ApiError({ status: 409, code: "DEPENDENCY_BLOCKED", message: "Projects module reset is blocked while active cases exist", retryable: false, details: { activeCases } });
    }
    const now = new Date();
    const updated = await authDb.update(projectsTable).set({ archivedAt: now, archivedBy: actorUserId, archivedReason: "module_reset" })
      .where(and(eq(projectsTable.firmId, firmId), isNull(projectsTable.archivedAt)))
      .returning({ id: projectsTable.id });
    return { summary: "Projects archived", affected: { projects_archived: updated.length } };
  }

  if (preview.action_code.startsWith("reset_case_")) {
    const caseId = Number.parseInt(preview.target?.entity_id ?? "", 10);
    if (!Number.isFinite(caseId)) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid case id", retryable: false });
    const [c] = await authDb.select({ id: casesTable.id, referenceNo: casesTable.referenceNo }).from(casesTable).where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)));
    if (!c) throw new ApiError({ status: 404, code: "CASE_NOT_FOUND", message: "Case not found", retryable: false });

    if (preview.action_code === "reset_case_workflow" || preview.action_code === "reset_case_full_soft" || preview.action_code === "reset_case_progress_metadata") {
      await authDb.update(casesTable).set({ status: "File Opened / SPA Pending Signing" }).where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)));
      await authDb.update(caseWorkflowStepsTable).set({ status: "pending", completedAt: null, completedBy: null, notes: null }).where(eq(caseWorkflowStepsTable.caseId, caseId));
    }

    if (preview.action_code === "reset_case_generated_docs" || preview.action_code === "reset_case_full_soft") {
      await authDb.update(caseDocumentsTable).set({ status: "archived" }).where(and(eq(caseDocumentsTable.caseId, caseId), eq(caseDocumentsTable.firmId, firmId), sql`${caseDocumentsTable.status} <> 'archived'`));
      await authDb.update(caseWorkflowDocumentsTable).set({ deletedAt: new Date() }).where(and(eq(caseWorkflowDocumentsTable.caseId, caseId), eq(caseWorkflowDocumentsTable.firmId, firmId), isNull(caseWorkflowDocumentsTable.deletedAt)));
      await authDb.update(caseLoanStampingItemsTable).set({ deletedAt: new Date() }).where(and(eq(caseLoanStampingItemsTable.caseId, caseId), eq(caseLoanStampingItemsTable.firmId, firmId), isNull(caseLoanStampingItemsTable.deletedAt)));
    }

    if (preview.action_code === "reset_case_progress_metadata" || preview.action_code === "reset_case_full_soft") {
      await authDb.update(caseKeyDatesTable).set({
        spaSignedDate: null,
        spaForwardToDeveloperExecutionOn: null,
        spaDate: null,
        spaStampedDate: null,
        stampedSpaSendToDeveloperOn: null,
        stampedSpaReceivedFromDeveloperOn: null,
        letterOfOfferDate: null,
        letterOfOfferStampedDate: null,
        loanDocsPendingDate: null,
        loanDocsSignedDate: null,
        actingLetterIssuedDate: null,
        developerConfirmationReceivedOn: null,
        developerConfirmationDate: null,
        loanSentBankExecutionDate: null,
        loanBankExecutedDate: null,
        bankLuReceivedDate: null,
        bankLuForwardToDeveloperOn: null,
        developerLuReceivedOn: null,
        developerLuDated: null,
        letterDisclaimerReceivedOn: null,
        letterDisclaimerDated: null,
        letterDisclaimerReferenceNos: null,
        redemptionSum: null,
        loanAgreementDated: null,
        loanAgreementSubmittedStampingDate: null,
        loanAgreementStampedDate: null,
        registerPoaOn: null,
        registeredPoaRegistrationNumber: null,
        noaServedOn: null,
        adviceToBankDate: null,
        bank1stReleaseOn: null,
        firstReleaseAmountRm: null,
        motReceivedDate: null,
        motSignedDate: null,
        motStampedDate: null,
        motRegisteredDate: null,
        progressivePaymentDate: null,
        fullSettlementDate: null,
        completionDate: null,
      }).where(and(eq(caseKeyDatesTable.caseId, caseId), eq(caseKeyDatesTable.firmId, firmId)));
    }

    return { summary: "Case reset completed", affected: { case_id: caseId }, referenceNo: c.referenceNo };
  }

  throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Action not supported", retryable: false });
}

export async function searchTargets(
  authDb: RlsDb,
  opts: { firmId: number; entityType: TargetEntityType; keyword: string; limit: number }
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(opts.limit, 1), 25);
  const q = `%${opts.keyword.trim()}%`;
  if (!opts.keyword.trim()) return [];
  if (opts.entityType === "case") {
    const rows = await authDb.select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      status: casesTable.status,
      updatedAt: casesTable.updatedAt,
    }).from(casesTable).where(and(eq(casesTable.firmId, opts.firmId), isNull(casesTable.deletedAt), ilike(casesTable.referenceNo, q))).orderBy(desc(casesTable.updatedAt)).limit(limit);
    return rows.map((r) => ({ ...r, label: r.referenceNo, entity_type: "case" }));
  }
  if (opts.entityType === "project") {
    const rows = await authDb.select({
      id: projectsTable.id,
      name: projectsTable.name,
      updatedAt: projectsTable.updatedAt,
    }).from(projectsTable).where(and(eq(projectsTable.firmId, opts.firmId), isNull(projectsTable.archivedAt), ilike(projectsTable.name, q))).orderBy(desc(projectsTable.updatedAt)).limit(limit);
    return rows.map((r) => ({ ...r, label: r.name, entity_type: "project" }));
  }
  throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Search entity not supported", retryable: false });
}

export async function listSnapshots(authDb: RlsDb, firmId: number, limit: number): Promise<any[]> {
  const n = Math.min(Math.max(limit, 1), 100);
  return await authDb.select().from(platformSnapshotsTable).where(eq(platformSnapshotsTable.firmId, firmId)).orderBy(desc(platformSnapshotsTable.createdAt)).limit(n);
}

export async function listSnapshotsPaged(
  authDb: RlsDb,
  opts: {
    firmId: number;
    limit: number;
    before?: Date | null;
    snapshotType?: string | null;
    status?: string | null;
    pinned?: boolean | null;
    targetEntityType?: string | null;
    targetEntityId?: string | null;
    triggerType?: string | null;
  }
): Promise<any[]> {
  const n = Math.min(Math.max(opts.limit, 1), 100);
  const where = [
    eq(platformSnapshotsTable.firmId, opts.firmId),
    opts.snapshotType ? eq(platformSnapshotsTable.snapshotType, opts.snapshotType) : null,
    opts.status ? eq(platformSnapshotsTable.status, opts.status) : null,
    opts.triggerType ? eq(platformSnapshotsTable.triggerType, opts.triggerType) : null,
    opts.targetEntityType ? eq(platformSnapshotsTable.targetEntityType, opts.targetEntityType) : null,
    opts.targetEntityId ? eq(platformSnapshotsTable.targetEntityId, opts.targetEntityId) : null,
    opts.pinned === true ? sql`${platformSnapshotsTable.pinnedAt} IS NOT NULL` : null,
    opts.pinned === false ? sql`${platformSnapshotsTable.pinnedAt} IS NULL` : null,
    opts.before ? sql`${platformSnapshotsTable.createdAt} < ${opts.before}` : null,
  ].filter(Boolean) as any[];
  return await authDb.select().from(platformSnapshotsTable).where(and(...where)).orderBy(desc(platformSnapshotsTable.createdAt)).limit(n);
}

export async function getSnapshotDetail(authDb: RlsDb, firmId: number, snapshotId: string): Promise<{ snapshot: any; items: any[] }> {
  const [snapshot] = await authDb.select().from(platformSnapshotsTable).where(and(eq(platformSnapshotsTable.id, snapshotId), eq(platformSnapshotsTable.firmId, firmId)));
  if (!snapshot) throw new ApiError({ status: 404, code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", retryable: false });
  const items = await authDb.select().from(platformSnapshotItemsTable).where(eq(platformSnapshotItemsTable.snapshotId, snapshotId)).orderBy(desc(platformSnapshotItemsTable.createdAt));
  return { snapshot, items };
}

export async function pinSnapshot(authDb: RlsDb, opts: { firmId: number; snapshotId: string; actorUserId: number; reason: string }): Promise<void> {
  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
  const [snap] = await authDb.select().from(platformSnapshotsTable).where(and(eq(platformSnapshotsTable.id, opts.snapshotId), eq(platformSnapshotsTable.firmId, opts.firmId)));
  if (!snap) throw new ApiError({ status: 404, code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", retryable: false });
  if (snap.deletedAt || snap.status === "deleted") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Snapshot is deleted", retryable: false });
  await authDb.update(platformSnapshotsTable).set({
    pinnedAt: new Date(),
    pinnedBy: opts.actorUserId,
    pinnedReason: reason,
    updatedAt: new Date(),
  }).where(eq(platformSnapshotsTable.id, opts.snapshotId));
}

export async function unpinSnapshot(authDb: RlsDb, opts: { firmId: number; snapshotId: string }): Promise<void> {
  const [snap] = await authDb.select().from(platformSnapshotsTable).where(and(eq(platformSnapshotsTable.id, opts.snapshotId), eq(platformSnapshotsTable.firmId, opts.firmId)));
  if (!snap) throw new ApiError({ status: 404, code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", retryable: false });
  await authDb.update(platformSnapshotsTable).set({
    pinnedAt: null,
    pinnedBy: null,
    pinnedReason: null,
    updatedAt: new Date(),
  }).where(eq(platformSnapshotsTable.id, opts.snapshotId));
}

export async function softDeleteSnapshot(authDb: RlsDb, opts: { firmId: number; snapshotId: string; actorUserId: number; reason: string }): Promise<{ storageDriver: string | null; storagePath: string | null }> {
  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
  const [snap] = await authDb.select().from(platformSnapshotsTable).where(and(eq(platformSnapshotsTable.id, opts.snapshotId), eq(platformSnapshotsTable.firmId, opts.firmId)));
  if (!snap) throw new ApiError({ status: 404, code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", retryable: false });
  if (snap.deletedAt || snap.status === "deleted") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Snapshot already deleted", retryable: false });
  if (snap.pinnedAt) throw new ApiError({ status: 409, code: "POLICY_BLOCKED", message: "Pinned snapshots cannot be deleted", retryable: false });

  await authDb.update(platformSnapshotsTable).set({
    status: "deleted",
    restorable: false,
    deletedAt: new Date(),
    deletedBy: opts.actorUserId,
    deletedReason: reason,
    payloadJson: null,
    payloadStorageKey: null,
    storagePath: null,
    sizeBytes: null,
    checksum: null,
    integrityStatus: "invalid",
    updatedAt: new Date(),
  }).where(eq(platformSnapshotsTable.id, opts.snapshotId));

  return { storageDriver: snap.storageDriver ?? null, storagePath: snap.storagePath ?? null };
}

export async function createRestorePreviewRecord(
  authDb: RlsDb,
  opts: {
    firmId: number;
    operationCode?: RestoreOperationCode;
    snapshotId: string;
    rollbackSourceRestoreActionId?: string | null;
    restoreScopeType: MaintenanceScopeType;
    moduleCode?: ModuleCode;
    targetEntityType?: TargetEntityType;
    targetEntityId?: string;
    targetLabel?: string;
    riskLevel: RiskLevel;
    requestedByUserId: number;
    requestedByEmail?: string | null;
    previewPayload: unknown;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await authDb.insert(platformRestoreActionsTable).values({
    id,
    firmId: opts.firmId,
    operationCode: opts.operationCode ?? "restore_snapshot",
    snapshotId: opts.snapshotId,
    rollbackSourceRestoreActionId: opts.rollbackSourceRestoreActionId ?? null,
    restoreScopeType: opts.restoreScopeType,
    moduleCode: opts.moduleCode ?? null,
    targetEntityType: opts.targetEntityType ?? null,
    targetEntityId: opts.targetEntityId ?? null,
    targetLabel: opts.targetLabel ?? null,
    riskLevel: opts.riskLevel,
    status: "previewed",
    reason: "preview_only",
    typedConfirmation: null,
    previewPayload: opts.previewPayload,
    requestedByUserId: opts.requestedByUserId,
    requestedByEmail: opts.requestedByEmail ?? null,
  });
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: id, stepCode: "preview", stepOrder: 10, status: "completed", startedAt: new Date(), completedAt: new Date() });
  return id;
}

export async function restoreSettingsFromSnapshot(
  authDb: RlsDb,
  opts: {
    firmId: number;
    restoreActionId: string;
    reason: string;
    typedConfirmation: string | null;
    approvalRequestId?: string | null;
    stepUpChallengeId?: string | null;
    stepUpPhrase?: string | null;
    emergencyFlag?: boolean;
    actorPermissions: string[];
    impersonationActive: boolean;
    requestedByUserId: number;
    requestedByEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{ restoreActionId: string; preRestoreSnapshotId: string; result: unknown }> {
  const [restore] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, opts.restoreActionId), eq(platformRestoreActionsTable.firmId, opts.firmId)));
  if (!restore) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });
  if (restore.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Restore action is not in previewed state", retryable: true });

  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
  const required = requiredTypedConfirmation(restore.riskLevel as RiskLevel);
  if (required) {
    const typed = String(opts.typedConfirmation ?? "").trim();
    if (typed !== required) throw new ApiError({ status: 400, code: "INVALID_CONFIRMATION_TEXT", message: "Typed confirmation does not match required text", retryable: false, details: { required } });
  }

  const opCode = String(restore.operationCode ?? "restore_snapshot");
  const decision = evaluateDecisionForExecute({
    actionCode: opCode,
    riskLevel: restore.riskLevel as RiskLevel,
    scopeType: restore.restoreScopeType as MaintenanceScopeType,
    moduleCode: restore.moduleCode ?? null,
    actorPermissions: new Set(opts.actorPermissions ?? []),
    impersonation: Boolean(opts.impersonationActive),
    emergency: Boolean(opts.emergencyFlag),
  });
  if (decision.blockedReason) {
    throw new ApiError({
      status: 403,
      code: decision.blockedReason.code === "IMPERSONATION_RESTRICTED" ? "IMPERSONATION_RESTRICTED" : "POLICY_BLOCKED",
      message: decision.blockedReason.message,
      retryable: false,
      details: { policy: decision.approvalPolicyCode, risk_level: restore.riskLevel, action_code: opCode },
    });
  }

  let approval: { id: string } | null = null;
  if (decision.approvalRequired) {
    const id = String(opts.approvalRequestId ?? "").trim();
    if (!id) {
      throw new ApiError({
        status: 409,
        code: "APPROVAL_REQUIRED",
        message: "Approval required before executing this restore",
        retryable: false,
        stage: "approval",
        details: { required_approvals: decision.requiredApprovalCount, approval_policy_code: decision.approvalPolicyCode },
        suggestion: "Submit an approval request, then execute again after it is approved.",
      });
    }
    await assertApprovalApproved(authDb, { approvalRequestId: id, operationType: "restore_action", operationId: opts.restoreActionId, now: new Date() });
    approval = { id };
  }

  let stepUpConfirmation: string | null = null;
  if (decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0) {
    const challengeId = String(opts.stepUpChallengeId ?? "").trim();
    const phrase = String(opts.stepUpPhrase ?? "").trim();
    if (!challengeId || !phrase) {
      throw new ApiError({
        status: 409,
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required",
        retryable: false,
        stage: "step_up",
      });
    }
    await consumeStepUpChallenge(authDb, { challengeId, firmId: opts.firmId, actionCode: opCode, actorUserId: opts.requestedByUserId, providedPhrase: phrase });
    stepUpConfirmation = phrase;
  }

  if (restore.riskLevel === "high" || restore.riskLevel === "critical") {
    await assertNoConcurrentDestructive(authDb, { firmId: opts.firmId, table: "restore", currentId: opts.restoreActionId });
  }

  const storage = new SupabaseStorageService();
  await authDb.update(platformRestoreActionsTable).set({
    status: "running",
    reason,
    typedConfirmation: opts.typedConfirmation ?? null,
    stepUpConfirmation,
    approvalRequestId: approval?.id ?? null,
    startedAt: new Date(),
  }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "create_pre_restore_snapshot", stepOrder: 20, status: "running", startedAt: new Date() });

  const preRestoreSnapshot = await createSnapshot(authDb, {
    firmId: opts.firmId,
    snapshotType: "settings",
    scopeType: "settings",
    moduleCode: "settings",
    targetEntityType: "settings",
    targetEntityId: String(opts.firmId),
    targetLabel: opCode === "rollback_restore" ? "pre_rollback_settings" : "pre_restore_settings",
    triggerType: "pre_restore",
    triggerActionCode: opCode as RestoreOperationCode,
    createdByUserId: opts.requestedByUserId,
    createdByEmail: opts.requestedByEmail ?? null,
    reason,
    note: null,
    retentionPolicyCode: "pre_restore",
    storage,
  });

  await authDb.update(platformRestoreActionsTable).set({ preRestoreSnapshotId: preRestoreSnapshot.snapshotId }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));

  await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: { snapshotId: preRestoreSnapshot.snapshotId } }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "create_pre_restore_snapshot")));

  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "apply_restore", stepOrder: 30, status: "running", startedAt: new Date() });
  try {
    const payload = await readSnapshotPayload(authDb, restore.snapshotId, storage);
    const kind = (payload as any)?.kind;
    if (kind !== "settings") throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot does not contain settings payload", retryable: false });
    const firm = (payload as any)?.firm;
    const bankAccounts = Array.isArray((payload as any)?.bankAccounts) ? (payload as any).bankAccounts : [];
    const settingsGroupRaw = (payload as any)?.settingsGroup;
    const settingsGroup = typeof settingsGroupRaw === "string" && settingsGroupRaw.trim() ? settingsGroupRaw.trim() : null;

    if (!settingsGroup || settingsGroup === "firm_profile") {
      await authDb.update(firmsTable).set({
        ...(settingsGroup ? {} : { name: typeof firm?.name === "string" ? firm.name : undefined }),
        address: firm?.address ?? null,
        stNumber: firm?.stNumber ?? null,
        tinNumber: firm?.tinNumber ?? null,
        ...(settingsGroup ? {} : {
          subscriptionPlan: typeof firm?.subscriptionPlan === "string" ? firm.subscriptionPlan : undefined,
          status: typeof firm?.status === "string" ? firm.status : undefined,
        }),
      }).where(eq(firmsTable.id, opts.firmId));
    }

    if (!settingsGroup || settingsGroup === "bank_accounts") {
      await authDb.delete(firmBankAccountsTable).where(eq(firmBankAccountsTable.firmId, opts.firmId));
      for (const b of bankAccounts) {
        if (!b || typeof b !== "object") continue;
        if (typeof (b as any).bankName !== "string" || typeof (b as any).accountNo !== "string") continue;
        await authDb.insert(firmBankAccountsTable).values({
          firmId: opts.firmId,
          bankName: String((b as any).bankName),
          accountNo: String((b as any).accountNo),
          accountType: typeof (b as any).accountType === "string" ? String((b as any).accountType) : "office",
          isDefault: !!(b as any).isDefault,
        });
      }
    }

    const result = {
      summary: settingsGroup ? `Settings group restored: ${settingsGroup}` : "Settings restored",
      restored: {
        settings_group: settingsGroup,
        bank_accounts: (!settingsGroup || settingsGroup === "bank_accounts") ? bankAccounts.length : 0,
      },
    };
    await authDb.update(platformRestoreActionsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    await authDb.insert(auditLogsTable).values({
      firmId: opts.firmId,
      actorId: opts.requestedByUserId,
      actorType: "founder",
      action: opCode === "rollback_restore" ? "firm.recovery.rollback.settings" : "firm.restore.settings",
      entityType: "firm",
      entityId: opts.firmId,
      detail: JSON.stringify({ reason, restoreActionId: opts.restoreActionId, operationCode: opCode, snapshotId: restore.snapshotId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, approvalRequestId: approval?.id ?? null }),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    });
    if (approval?.id) await markApprovalExecuted(authDb, approval.id);
    return { restoreActionId: opts.restoreActionId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    await authDb.update(platformRestoreActionsTable).set({ status: "failed", failedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "failed", completedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    throw new ApiError({ status: 500, code: "RESTORE_EXECUTION_FAILED", message: "Restore failed", retryable: true, details: { restoreActionId: opts.restoreActionId } });
  }
}

export async function restoreProjectsModuleFromSnapshot(
  authDb: RlsDb,
  opts: {
    firmId: number;
    restoreActionId: string;
    reason: string;
    typedConfirmation: string | null;
    approvalRequestId?: string | null;
    stepUpChallengeId?: string | null;
    stepUpPhrase?: string | null;
    emergencyFlag?: boolean;
    actorPermissions: string[];
    impersonationActive: boolean;
    requestedByUserId: number;
    requestedByEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{ restoreActionId: string; preRestoreSnapshotId: string; result: unknown }> {
  const [restore] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, opts.restoreActionId), eq(platformRestoreActionsTable.firmId, opts.firmId)));
  if (!restore) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });
  if (restore.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Restore action is not in previewed state", retryable: true });
  if (restore.restoreScopeType !== "module" || restore.moduleCode !== "projects") {
    throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Restore action is not a projects module restore", retryable: false });
  }

  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
  const required = requiredTypedConfirmation(restore.riskLevel as RiskLevel);
  if (required) {
    const typed = String(opts.typedConfirmation ?? "").trim();
    if (typed !== required) throw new ApiError({ status: 400, code: "INVALID_CONFIRMATION_TEXT", message: "Typed confirmation does not match required text", retryable: false, details: { required } });
  }

  const opCode = String(restore.operationCode ?? "restore_snapshot");
  const decision = evaluateDecisionForExecute({
    actionCode: opCode,
    riskLevel: restore.riskLevel as RiskLevel,
    scopeType: restore.restoreScopeType as MaintenanceScopeType,
    moduleCode: restore.moduleCode ?? null,
    actorPermissions: new Set(opts.actorPermissions ?? []),
    impersonation: Boolean(opts.impersonationActive),
    emergency: Boolean(opts.emergencyFlag),
  });
  if (decision.blockedReason) {
    throw new ApiError({
      status: 403,
      code: decision.blockedReason.code === "IMPERSONATION_RESTRICTED" ? "IMPERSONATION_RESTRICTED" : "POLICY_BLOCKED",
      message: decision.blockedReason.message,
      retryable: false,
      details: { policy: decision.approvalPolicyCode, risk_level: restore.riskLevel, action_code: opCode },
    });
  }

  let approval: { id: string } | null = null;
  if (decision.approvalRequired) {
    const id = String(opts.approvalRequestId ?? "").trim();
    if (!id) {
      throw new ApiError({
        status: 409,
        code: "APPROVAL_REQUIRED",
        message: "Approval required before executing this restore",
        retryable: false,
        stage: "approval",
        details: { required_approvals: decision.requiredApprovalCount, approval_policy_code: decision.approvalPolicyCode },
        suggestion: "Submit an approval request, then execute again after it is approved.",
      });
    }
    await assertApprovalApproved(authDb, { approvalRequestId: id, operationType: "restore_action", operationId: opts.restoreActionId, now: new Date() });
    approval = { id };
  }

  let stepUpConfirmation: string | null = null;
  if (decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0) {
    const challengeId = String(opts.stepUpChallengeId ?? "").trim();
    const phrase = String(opts.stepUpPhrase ?? "").trim();
    if (!challengeId || !phrase) {
      throw new ApiError({
        status: 409,
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required",
        retryable: false,
        stage: "step_up",
      });
    }
    await consumeStepUpChallenge(authDb, { challengeId, firmId: opts.firmId, actionCode: opCode, actorUserId: opts.requestedByUserId, providedPhrase: phrase });
    stepUpConfirmation = phrase;
  }

  if (restore.riskLevel === "high" || restore.riskLevel === "critical") {
    await assertNoConcurrentDestructive(authDb, { firmId: opts.firmId, table: "restore", currentId: opts.restoreActionId });
  }

  const storage = new SupabaseStorageService();
  await authDb.update(platformRestoreActionsTable).set({
    status: "running",
    reason,
    typedConfirmation: opts.typedConfirmation ?? null,
    stepUpConfirmation,
    approvalRequestId: approval?.id ?? null,
    startedAt: new Date(),
  }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "create_pre_restore_snapshot", stepOrder: 20, status: "running", startedAt: new Date() });

  const preRestoreSnapshot = await createSnapshot(authDb, {
    firmId: opts.firmId,
    snapshotType: "module",
    scopeType: "module",
    moduleCode: "projects",
    targetEntityType: "firm",
    targetEntityId: String(opts.firmId),
    targetLabel: opCode === "rollback_restore" ? "pre_rollback_projects_module" : "pre_restore_projects_module",
    triggerType: "pre_restore",
    triggerActionCode: opCode as RestoreOperationCode,
    createdByUserId: opts.requestedByUserId,
    createdByEmail: opts.requestedByEmail ?? null,
    reason,
    note: null,
    retentionPolicyCode: "pre_restore",
    storage,
  });

  await authDb.update(platformRestoreActionsTable).set({ preRestoreSnapshotId: preRestoreSnapshot.snapshotId }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));

  await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: { snapshotId: preRestoreSnapshot.snapshotId } }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "create_pre_restore_snapshot")));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "apply_restore", stepOrder: 30, status: "running", startedAt: new Date() });

  try {
    const payload = await readSnapshotPayload(authDb, restore.snapshotId, storage);
    const kind = (payload as any)?.kind;
    if (kind !== "projects_module") throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot does not contain projects module payload", retryable: false });
    const snapProjects = Array.isArray((payload as any)?.projects) ? (payload as any).projects : [];
    const snapshotIds = new Set<number>(snapProjects.map((p: any) => Number(p?.id)).filter((n: any) => Number.isFinite(n)));

    const existing = await authDb.select().from(projectsTable).where(eq(projectsTable.firmId, opts.firmId));
    const now = new Date();
    const toArchive = existing.filter((p) => !p.archivedAt && !snapshotIds.has(p.id));
    for (const p of toArchive) {
      await authDb.update(projectsTable).set({ archivedAt: now, archivedBy: opts.requestedByUserId, archivedReason: "restore_replace_not_in_snapshot" }).where(and(eq(projectsTable.firmId, opts.firmId), eq(projectsTable.id, p.id)));
    }

    let updatedCount = 0;
    for (const p of snapProjects) {
      if (!p || typeof p !== "object") continue;
      const id = Number((p as any).id);
      if (!Number.isFinite(id)) continue;
      const [exists] = await authDb.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.firmId, opts.firmId), eq(projectsTable.id, id)));
      if (!exists) continue;
      await authDb.update(projectsTable).set({
        developerId: Number.isFinite(Number((p as any).developerId)) ? Number((p as any).developerId) : undefined,
        name: typeof (p as any).name === "string" ? String((p as any).name) : undefined,
        phase: (p as any).phase ?? null,
        developerName: (p as any).developerName ?? null,
        projectType: typeof (p as any).projectType === "string" ? String((p as any).projectType) : undefined,
        titleType: typeof (p as any).titleType === "string" ? String((p as any).titleType) : undefined,
        titleSubtype: (p as any).titleSubtype ?? null,
        masterTitleNumber: (p as any).masterTitleNumber ?? null,
        masterTitleLandSize: (p as any).masterTitleLandSize ?? null,
        mukim: (p as any).mukim ?? null,
        daerah: (p as any).daerah ?? null,
        negeri: (p as any).negeri ?? null,
        landUse: (p as any).landUse ?? null,
        developmentCondition: (p as any).developmentCondition ?? null,
        unitCategory: (p as any).unitCategory ?? null,
        extraFields: (p as any).extraFields ?? {},
        archivedAt: null,
        archivedBy: null,
        archivedReason: null,
      }).where(and(eq(projectsTable.firmId, opts.firmId), eq(projectsTable.id, id)));
      updatedCount++;
    }

    const result = {
      summary: "Projects module restored",
      restored: {
        projects_in_snapshot: snapshotIds.size,
        projects_updated: updatedCount,
        projects_archived_not_in_snapshot: toArchive.length,
      },
    };
    await authDb.update(platformRestoreActionsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    await authDb.insert(auditLogsTable).values({
      firmId: opts.firmId,
      actorId: opts.requestedByUserId,
      actorType: "founder",
      action: opCode === "rollback_restore" ? "firm.recovery.rollback.projects_module" : "firm.restore.projects_module",
      entityType: "firm",
      entityId: opts.firmId,
      detail: JSON.stringify({ reason, restoreActionId: opts.restoreActionId, operationCode: opCode, snapshotId: restore.snapshotId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, approvalRequestId: approval?.id ?? null }),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    });
    if (approval?.id) await markApprovalExecuted(authDb, approval.id);
    return { restoreActionId: opts.restoreActionId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    await authDb.update(platformRestoreActionsTable).set({ status: "failed", failedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "failed", completedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    throw new ApiError({ status: 500, code: "RESTORE_EXECUTION_FAILED", message: "Restore failed", retryable: true, details: { restoreActionId: opts.restoreActionId } });
  }
}

export async function restoreCaseRecordFromSnapshot(
  authDb: RlsDb,
  opts: {
    firmId: number;
    restoreActionId: string;
    reason: string;
    typedConfirmation: string | null;
    approvalRequestId?: string | null;
    stepUpChallengeId?: string | null;
    stepUpPhrase?: string | null;
    emergencyFlag?: boolean;
    actorPermissions: string[];
    impersonationActive: boolean;
    requestedByUserId: number;
    requestedByEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{ restoreActionId: string; preRestoreSnapshotId: string; result: unknown }> {
  const [restore] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, opts.restoreActionId), eq(platformRestoreActionsTable.firmId, opts.firmId)));
  if (!restore) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });
  if (restore.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Restore action is not in previewed state", retryable: true });
  if (restore.restoreScopeType !== "record" || restore.targetEntityType !== "case" || !restore.targetEntityId) {
    throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Restore action is not a case record restore", retryable: false });
  }

  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
  const required = requiredTypedConfirmation(restore.riskLevel as RiskLevel);
  if (required) {
    const typed = String(opts.typedConfirmation ?? "").trim();
    if (typed !== required) throw new ApiError({ status: 400, code: "INVALID_CONFIRMATION_TEXT", message: "Typed confirmation does not match required text", retryable: false, details: { required } });
  }

  const opCode = String(restore.operationCode ?? "restore_snapshot");
  const decision = evaluateDecisionForExecute({
    actionCode: opCode,
    riskLevel: restore.riskLevel as RiskLevel,
    scopeType: restore.restoreScopeType as MaintenanceScopeType,
    moduleCode: restore.moduleCode ?? null,
    actorPermissions: new Set(opts.actorPermissions ?? []),
    impersonation: Boolean(opts.impersonationActive),
    emergency: Boolean(opts.emergencyFlag),
  });
  if (decision.blockedReason) {
    throw new ApiError({
      status: 403,
      code: decision.blockedReason.code === "IMPERSONATION_RESTRICTED" ? "IMPERSONATION_RESTRICTED" : "POLICY_BLOCKED",
      message: decision.blockedReason.message,
      retryable: false,
      details: { policy: decision.approvalPolicyCode, risk_level: restore.riskLevel, action_code: opCode },
    });
  }

  let approval: { id: string } | null = null;
  if (decision.approvalRequired) {
    const id = String(opts.approvalRequestId ?? "").trim();
    if (!id) {
      throw new ApiError({
        status: 409,
        code: "APPROVAL_REQUIRED",
        message: "Approval required before executing this restore",
        retryable: false,
        stage: "approval",
        details: { required_approvals: decision.requiredApprovalCount, approval_policy_code: decision.approvalPolicyCode },
        suggestion: "Submit an approval request, then execute again after it is approved.",
      });
    }
    await assertApprovalApproved(authDb, { approvalRequestId: id, operationType: "restore_action", operationId: opts.restoreActionId, now: new Date() });
    approval = { id };
  }

  let stepUpConfirmation: string | null = null;
  if (decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0) {
    const challengeId = String(opts.stepUpChallengeId ?? "").trim();
    const phrase = String(opts.stepUpPhrase ?? "").trim();
    if (!challengeId || !phrase) {
      throw new ApiError({
        status: 409,
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required",
        retryable: false,
        stage: "step_up",
      });
    }
    await consumeStepUpChallenge(authDb, { challengeId, firmId: opts.firmId, actionCode: opCode, actorUserId: opts.requestedByUserId, providedPhrase: phrase });
    stepUpConfirmation = phrase;
  }

  if (restore.riskLevel === "high" || restore.riskLevel === "critical") {
    await assertNoConcurrentDestructive(authDb, { firmId: opts.firmId, table: "restore", currentId: opts.restoreActionId });
  }

  const storage = new SupabaseStorageService();
  await authDb.update(platformRestoreActionsTable).set({
    status: "running",
    reason,
    typedConfirmation: opts.typedConfirmation ?? null,
    stepUpConfirmation,
    approvalRequestId: approval?.id ?? null,
    startedAt: new Date(),
  }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "create_pre_restore_snapshot", stepOrder: 20, status: "running", startedAt: new Date() });

  const preRestoreSnapshot = await createSnapshot(authDb, {
    firmId: opts.firmId,
    snapshotType: "record",
    scopeType: "record",
    moduleCode: "cases",
    targetEntityType: "case",
    targetEntityId: String(restore.targetEntityId),
    targetLabel: opCode === "rollback_restore" ? "pre_rollback_case" : "pre_restore_case",
    triggerType: "pre_restore",
    triggerActionCode: opCode as RestoreOperationCode,
    createdByUserId: opts.requestedByUserId,
    createdByEmail: opts.requestedByEmail ?? null,
    reason,
    note: null,
    retentionPolicyCode: "pre_restore",
    storage,
  });

  await authDb.update(platformRestoreActionsTable).set({ preRestoreSnapshotId: preRestoreSnapshot.snapshotId }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));

  await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: { snapshotId: preRestoreSnapshot.snapshotId } }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "create_pre_restore_snapshot")));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "apply_restore", stepOrder: 30, status: "running", startedAt: new Date() });

  try {
    const payload = await readSnapshotPayload(authDb, restore.snapshotId, storage);
    const kind = (payload as any)?.kind;
    if (kind !== "case") throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot does not contain case payload", retryable: false });
    const snapCase = (payload as any)?.case;
    const caseId = Number(snapCase?.id);
    if (!Number.isFinite(caseId)) throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot case id missing", retryable: false });
    if (String(caseId) !== String(restore.targetEntityId)) throw new ApiError({ status: 409, code: "TARGET_MISMATCH", message: "Snapshot case id does not match restore target", retryable: false });

    const workflowSteps = Array.isArray((payload as any)?.workflowSteps) ? (payload as any).workflowSteps : [];
    const keyDates = (payload as any)?.keyDates ?? null;
    const caseDocuments = Array.isArray((payload as any)?.caseDocuments) ? (payload as any).caseDocuments : [];
    const workflowDocuments = Array.isArray((payload as any)?.workflowDocuments) ? (payload as any).workflowDocuments : [];
    const loanStampingItems = Array.isArray((payload as any)?.loanStampingItems) ? (payload as any).loanStampingItems : [];

    if (typeof snapCase?.status === "string") {
      await authDb.update(casesTable).set({ status: String(snapCase.status) }).where(and(eq(casesTable.firmId, opts.firmId), eq(casesTable.id, caseId)));
    }

    let stepsUpdated = 0;
    for (const s of workflowSteps) {
      if (!s || typeof s !== "object") continue;
      const id = Number((s as any).id);
      if (!Number.isFinite(id)) continue;
      await authDb.update(caseWorkflowStepsTable).set({
        status: typeof (s as any).status === "string" ? String((s as any).status) : undefined,
        completedAt: (s as any).completedAt ?? null,
        completedBy: (s as any).completedBy ?? null,
        notes: (s as any).notes ?? null,
      }).where(and(eq(caseWorkflowStepsTable.caseId, caseId), eq(caseWorkflowStepsTable.id, id)));
      stepsUpdated++;
    }

    let docsUpdated = 0;
    for (const d of caseDocuments) {
      if (!d || typeof d !== "object") continue;
      const id = Number((d as any).id);
      if (!Number.isFinite(id)) continue;
      await authDb.update(caseDocumentsTable).set({
        status: typeof (d as any).status === "string" ? String((d as any).status) : undefined,
      }).where(and(eq(caseDocumentsTable.firmId, opts.firmId), eq(caseDocumentsTable.caseId, caseId), eq(caseDocumentsTable.id, id)));
      docsUpdated++;
    }

    let wfDocsUpdated = 0;
    for (const d of workflowDocuments) {
      if (!d || typeof d !== "object") continue;
      const id = Number((d as any).id);
      if (!Number.isFinite(id)) continue;
      await authDb.update(caseWorkflowDocumentsTable).set({
        deletedAt: (d as any).deletedAt ?? null,
      }).where(and(eq(caseWorkflowDocumentsTable.firmId, opts.firmId), eq(caseWorkflowDocumentsTable.caseId, caseId), eq(caseWorkflowDocumentsTable.id, id)));
      wfDocsUpdated++;
    }

    let stampingUpdated = 0;
    for (const it of loanStampingItems) {
      if (!it || typeof it !== "object") continue;
      const id = Number((it as any).id);
      if (!Number.isFinite(id)) continue;
      await authDb.update(caseLoanStampingItemsTable).set({
        deletedAt: (it as any).deletedAt ?? null,
      }).where(and(eq(caseLoanStampingItemsTable.firmId, opts.firmId), eq(caseLoanStampingItemsTable.caseId, caseId), eq(caseLoanStampingItemsTable.id, id)));
      stampingUpdated++;
    }

    if (keyDates && typeof keyDates === "object") {
      await authDb.update(caseKeyDatesTable).set({
        spaSignedDate: (keyDates as any).spaSignedDate ?? null,
        spaForwardToDeveloperExecutionOn: (keyDates as any).spaForwardToDeveloperExecutionOn ?? null,
        spaDate: (keyDates as any).spaDate ?? null,
        spaStampedDate: (keyDates as any).spaStampedDate ?? null,
        stampedSpaSendToDeveloperOn: (keyDates as any).stampedSpaSendToDeveloperOn ?? null,
        stampedSpaReceivedFromDeveloperOn: (keyDates as any).stampedSpaReceivedFromDeveloperOn ?? null,
        letterOfOfferDate: (keyDates as any).letterOfOfferDate ?? null,
        letterOfOfferStampedDate: (keyDates as any).letterOfOfferStampedDate ?? null,
        loanDocsPendingDate: (keyDates as any).loanDocsPendingDate ?? null,
        loanDocsSignedDate: (keyDates as any).loanDocsSignedDate ?? null,
        actingLetterIssuedDate: (keyDates as any).actingLetterIssuedDate ?? null,
        developerConfirmationReceivedOn: (keyDates as any).developerConfirmationReceivedOn ?? null,
        developerConfirmationDate: (keyDates as any).developerConfirmationDate ?? null,
        loanSentBankExecutionDate: (keyDates as any).loanSentBankExecutionDate ?? null,
        loanBankExecutedDate: (keyDates as any).loanBankExecutedDate ?? null,
        bankLuReceivedDate: (keyDates as any).bankLuReceivedDate ?? null,
        bankLuForwardToDeveloperOn: (keyDates as any).bankLuForwardToDeveloperOn ?? null,
        developerLuReceivedOn: (keyDates as any).developerLuReceivedOn ?? null,
        developerLuDated: (keyDates as any).developerLuDated ?? null,
        letterDisclaimerReceivedOn: (keyDates as any).letterDisclaimerReceivedOn ?? null,
        letterDisclaimerDated: (keyDates as any).letterDisclaimerDated ?? null,
        letterDisclaimerReferenceNos: (keyDates as any).letterDisclaimerReferenceNos ?? null,
        redemptionSum: (keyDates as any).redemptionSum ?? null,
        loanAgreementDated: (keyDates as any).loanAgreementDated ?? null,
        loanAgreementSubmittedStampingDate: (keyDates as any).loanAgreementSubmittedStampingDate ?? null,
        loanAgreementStampedDate: (keyDates as any).loanAgreementStampedDate ?? null,
        registerPoaOn: (keyDates as any).registerPoaOn ?? null,
        registeredPoaRegistrationNumber: (keyDates as any).registeredPoaRegistrationNumber ?? null,
        noaServedOn: (keyDates as any).noaServedOn ?? null,
        adviceToBankDate: (keyDates as any).adviceToBankDate ?? null,
        bank1stReleaseOn: (keyDates as any).bank1stReleaseOn ?? null,
        firstReleaseAmountRm: (keyDates as any).firstReleaseAmountRm ?? null,
        motReceivedDate: (keyDates as any).motReceivedDate ?? null,
        motSignedDate: (keyDates as any).motSignedDate ?? null,
        motStampedDate: (keyDates as any).motStampedDate ?? null,
        motRegisteredDate: (keyDates as any).motRegisteredDate ?? null,
        progressivePaymentDate: (keyDates as any).progressivePaymentDate ?? null,
        fullSettlementDate: (keyDates as any).fullSettlementDate ?? null,
        completionDate: (keyDates as any).completionDate ?? null,
      }).where(and(eq(caseKeyDatesTable.firmId, opts.firmId), eq(caseKeyDatesTable.caseId, caseId)));
    }

    const result = {
      summary: "Case restored",
      restored: {
        case_id: caseId,
        workflow_steps_updated: stepsUpdated,
        case_documents_updated: docsUpdated,
        workflow_documents_updated: wfDocsUpdated,
        loan_stamping_items_updated: stampingUpdated,
        key_dates_updated: keyDates ? 1 : 0,
      },
    };
    await authDb.update(platformRestoreActionsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    await authDb.insert(auditLogsTable).values({
      firmId: opts.firmId,
      actorId: opts.requestedByUserId,
      actorType: "founder",
      action: opCode === "rollback_restore" ? "firm.recovery.rollback.case" : "firm.restore.case",
      entityType: "case",
      entityId: caseId,
      detail: JSON.stringify({ reason, restoreActionId: opts.restoreActionId, operationCode: opCode, snapshotId: restore.snapshotId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, approvalRequestId: approval?.id ?? null }),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    });
    if (approval?.id) await markApprovalExecuted(authDb, approval.id);
    return { restoreActionId: opts.restoreActionId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    await authDb.update(platformRestoreActionsTable).set({ status: "failed", failedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "failed", completedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    throw new ApiError({ status: 500, code: "RESTORE_EXECUTION_FAILED", message: "Restore failed", retryable: true, details: { restoreActionId: opts.restoreActionId } });
  }
}

export async function restoreProjectRecordFromSnapshot(
  authDb: RlsDb,
  opts: {
    firmId: number;
    restoreActionId: string;
    reason: string;
    typedConfirmation: string | null;
    approvalRequestId?: string | null;
    stepUpChallengeId?: string | null;
    stepUpPhrase?: string | null;
    emergencyFlag?: boolean;
    actorPermissions: string[];
    impersonationActive: boolean;
    requestedByUserId: number;
    requestedByEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{ restoreActionId: string; preRestoreSnapshotId: string; result: unknown }> {
  const [restore] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, opts.restoreActionId), eq(platformRestoreActionsTable.firmId, opts.firmId)));
  if (!restore) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });
  if (restore.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Restore action is not in previewed state", retryable: true });
  if (restore.restoreScopeType !== "record" || restore.targetEntityType !== "project" || !restore.targetEntityId) {
    throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Restore action is not a project record restore", retryable: false });
  }

  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
  const required = requiredTypedConfirmation(restore.riskLevel as RiskLevel);
  if (required) {
    const typed = String(opts.typedConfirmation ?? "").trim();
    if (typed !== required) throw new ApiError({ status: 400, code: "INVALID_CONFIRMATION_TEXT", message: "Typed confirmation does not match required text", retryable: false, details: { required } });
  }

  const opCode = String(restore.operationCode ?? "restore_snapshot");
  const decision = evaluateDecisionForExecute({
    actionCode: opCode,
    riskLevel: restore.riskLevel as RiskLevel,
    scopeType: restore.restoreScopeType as MaintenanceScopeType,
    moduleCode: restore.moduleCode ?? null,
    actorPermissions: new Set(opts.actorPermissions ?? []),
    impersonation: Boolean(opts.impersonationActive),
    emergency: Boolean(opts.emergencyFlag),
  });
  if (decision.blockedReason) {
    throw new ApiError({
      status: 403,
      code: decision.blockedReason.code === "IMPERSONATION_RESTRICTED" ? "IMPERSONATION_RESTRICTED" : "POLICY_BLOCKED",
      message: decision.blockedReason.message,
      retryable: false,
      details: { policy: decision.approvalPolicyCode, risk_level: restore.riskLevel, action_code: opCode },
    });
  }

  let approval: { id: string } | null = null;
  if (decision.approvalRequired) {
    const id = String(opts.approvalRequestId ?? "").trim();
    if (!id) {
      throw new ApiError({
        status: 409,
        code: "APPROVAL_REQUIRED",
        message: "Approval required before executing this restore",
        retryable: false,
        stage: "approval",
        details: { required_approvals: decision.requiredApprovalCount, approval_policy_code: decision.approvalPolicyCode },
        suggestion: "Submit an approval request, then execute again after it is approved.",
      });
    }
    await assertApprovalApproved(authDb, { approvalRequestId: id, operationType: "restore_action", operationId: opts.restoreActionId, now: new Date() });
    approval = { id };
  }

  let stepUpConfirmation: string | null = null;
  if (decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0) {
    const challengeId = String(opts.stepUpChallengeId ?? "").trim();
    const phrase = String(opts.stepUpPhrase ?? "").trim();
    if (!challengeId || !phrase) {
      throw new ApiError({
        status: 409,
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required",
        retryable: false,
        stage: "step_up",
      });
    }
    await consumeStepUpChallenge(authDb, { challengeId, firmId: opts.firmId, actionCode: opCode, actorUserId: opts.requestedByUserId, providedPhrase: phrase });
    stepUpConfirmation = phrase;
  }

  if (restore.riskLevel === "high" || restore.riskLevel === "critical") {
    await assertNoConcurrentDestructive(authDb, { firmId: opts.firmId, table: "restore", currentId: opts.restoreActionId });
  }

  const storage = new SupabaseStorageService();
  await authDb.update(platformRestoreActionsTable).set({
    status: "running",
    reason,
    typedConfirmation: opts.typedConfirmation ?? null,
    stepUpConfirmation,
    approvalRequestId: approval?.id ?? null,
    startedAt: new Date(),
  }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "create_pre_restore_snapshot", stepOrder: 20, status: "running", startedAt: new Date() });

  const preRestoreSnapshot = await createSnapshot(authDb, {
    firmId: opts.firmId,
    snapshotType: "record",
    scopeType: "record",
    moduleCode: "projects",
    targetEntityType: "project",
    targetEntityId: String(restore.targetEntityId),
    targetLabel: opCode === "rollback_restore" ? "pre_rollback_project" : "pre_restore_project",
    triggerType: "pre_restore",
    triggerActionCode: opCode as RestoreOperationCode,
    createdByUserId: opts.requestedByUserId,
    createdByEmail: opts.requestedByEmail ?? null,
    reason,
    note: null,
    retentionPolicyCode: "pre_restore",
    storage,
  });
  await authDb.update(platformRestoreActionsTable).set({ preRestoreSnapshotId: preRestoreSnapshot.snapshotId }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));

  await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: { snapshotId: preRestoreSnapshot.snapshotId } }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "create_pre_restore_snapshot")));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "apply_restore", stepOrder: 30, status: "running", startedAt: new Date() });

  try {
    const payload = await readSnapshotPayload(authDb, restore.snapshotId, storage);
    const payloadObj = asPlainObject(payload);
    if (!payloadObj) throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot payload invalid", retryable: false });
    const kind = readString(payloadObj, "kind");
    if (kind !== "project") throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot does not contain project payload", retryable: false });
    const snapProjectObj = asPlainObject(payloadObj["project"]);
    if (!snapProjectObj) throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot project payload missing", retryable: false });
    const projectId = readNumber(snapProjectObj, "id");
    if (!projectId) throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot project id missing", retryable: false });
    if (String(projectId) !== String(restore.targetEntityId)) throw new ApiError({ status: 409, code: "TARGET_MISMATCH", message: "Snapshot project id does not match restore target", retryable: false });

    const [current] = await authDb.select().from(projectsTable).where(and(eq(projectsTable.firmId, opts.firmId), eq(projectsTable.id, projectId)));
    if (!current) throw new ApiError({ status: 404, code: "PROJECT_NOT_FOUND", message: "Project not found", retryable: false });

    const snapDeveloperId = readNumber(snapProjectObj, "developerId");
    const useDeveloperId = snapDeveloperId
      ? (await authDb.select({ id: developersTable.id }).from(developersTable).where(and(eq(developersTable.firmId, opts.firmId), eq(developersTable.id, snapDeveloperId)))).length
        ? snapDeveloperId
        : current.developerId
      : current.developerId;

    const name = readString(snapProjectObj, "name") ?? current.name;
    const phase = readString(snapProjectObj, "phase");
    const developerName = readString(snapProjectObj, "developerName");
    const projectType = readString(snapProjectObj, "projectType") ?? current.projectType;
    const titleType = readString(snapProjectObj, "titleType") ?? current.titleType;
    const titleSubtype = readString(snapProjectObj, "titleSubtype");
    const masterTitleNumber = readString(snapProjectObj, "masterTitleNumber");
    const masterTitleLandSize = readString(snapProjectObj, "masterTitleLandSize");
    const mukim = readString(snapProjectObj, "mukim");
    const daerah = readString(snapProjectObj, "daerah");
    const negeri = readString(snapProjectObj, "negeri");
    const landUse = readString(snapProjectObj, "landUse");
    const developmentCondition = readString(snapProjectObj, "developmentCondition");
    const unitCategory = readString(snapProjectObj, "unitCategory");
    const archivedAt = readDate(snapProjectObj, "archivedAt");
    const archivedBy = (() => {
      const v = readNumber(snapProjectObj, "archivedBy");
      return v ? v : null;
    })();
    const archivedReason = readString(snapProjectObj, "archivedReason");
    const extraFieldsVal = snapProjectObj["extraFields"];
    const extraFields = extraFieldsVal && typeof extraFieldsVal === "object" ? extraFieldsVal : current.extraFields;

    await authDb.update(projectsTable).set({
      developerId: useDeveloperId,
      name,
      phase,
      developerName,
      projectType,
      titleType,
      titleSubtype,
      masterTitleNumber,
      masterTitleLandSize,
      mukim,
      daerah,
      negeri,
      landUse,
      developmentCondition,
      unitCategory,
      extraFields,
      archivedAt,
      archivedBy,
      archivedReason,
      updatedAt: new Date(),
    }).where(and(eq(projectsTable.firmId, opts.firmId), eq(projectsTable.id, projectId)));

    const result = {
      summary: "Project restored",
      restored: {
        project_id: projectId,
        developer_id: useDeveloperId,
        note: snapDeveloperId && useDeveloperId !== snapDeveloperId ? "Developer id in snapshot not found; kept current developerId" : null,
      },
    };
    await authDb.update(platformRestoreActionsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    await authDb.insert(auditLogsTable).values({
      firmId: opts.firmId,
      actorId: opts.requestedByUserId,
      actorType: "founder",
      action: opCode === "rollback_restore" ? "firm.recovery.rollback.project" : "firm.restore.project",
      entityType: "project",
      entityId: projectId,
      detail: JSON.stringify({ reason, restoreActionId: opts.restoreActionId, operationCode: opCode, snapshotId: restore.snapshotId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, approvalRequestId: approval?.id ?? null }),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    });
    if (approval?.id) await markApprovalExecuted(authDb, approval.id);
    return { restoreActionId: opts.restoreActionId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    await authDb.update(platformRestoreActionsTable).set({ status: "failed", failedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "failed", completedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    throw new ApiError({ status: 500, code: "RESTORE_EXECUTION_FAILED", message: "Restore failed", retryable: true, details: { restoreActionId: opts.restoreActionId } });
  }
}

export async function restoreDeveloperRecordFromSnapshot(
  authDb: RlsDb,
  opts: {
    firmId: number;
    restoreActionId: string;
    reason: string;
    typedConfirmation: string | null;
    approvalRequestId?: string | null;
    stepUpChallengeId?: string | null;
    stepUpPhrase?: string | null;
    emergencyFlag?: boolean;
    actorPermissions: string[];
    impersonationActive: boolean;
    requestedByUserId: number;
    requestedByEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<{ restoreActionId: string; preRestoreSnapshotId: string; result: unknown }> {
  const [restore] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, opts.restoreActionId), eq(platformRestoreActionsTable.firmId, opts.firmId)));
  if (!restore) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });
  if (restore.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Restore action is not in previewed state", retryable: true });
  if (restore.restoreScopeType !== "record" || restore.targetEntityType !== "developer" || !restore.targetEntityId) {
    throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Restore action is not a developer record restore", retryable: false });
  }

  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
  const required = requiredTypedConfirmation(restore.riskLevel as RiskLevel);
  if (required) {
    const typed = String(opts.typedConfirmation ?? "").trim();
    if (typed !== required) throw new ApiError({ status: 400, code: "INVALID_CONFIRMATION_TEXT", message: "Typed confirmation does not match required text", retryable: false, details: { required } });
  }

  const opCode = String(restore.operationCode ?? "restore_snapshot");
  const decision = evaluateDecisionForExecute({
    actionCode: opCode,
    riskLevel: restore.riskLevel as RiskLevel,
    scopeType: restore.restoreScopeType as MaintenanceScopeType,
    moduleCode: restore.moduleCode ?? null,
    actorPermissions: new Set(opts.actorPermissions ?? []),
    impersonation: Boolean(opts.impersonationActive),
    emergency: Boolean(opts.emergencyFlag),
  });
  if (decision.blockedReason) {
    throw new ApiError({
      status: 403,
      code: decision.blockedReason.code === "IMPERSONATION_RESTRICTED" ? "IMPERSONATION_RESTRICTED" : "POLICY_BLOCKED",
      message: decision.blockedReason.message,
      retryable: false,
      details: { policy: decision.approvalPolicyCode, risk_level: restore.riskLevel, action_code: opCode },
    });
  }

  let approval: { id: string } | null = null;
  if (decision.approvalRequired) {
    const id = String(opts.approvalRequestId ?? "").trim();
    if (!id) {
      throw new ApiError({
        status: 409,
        code: "APPROVAL_REQUIRED",
        message: "Approval required before executing this restore",
        retryable: false,
        stage: "approval",
        details: { required_approvals: decision.requiredApprovalCount, approval_policy_code: decision.approvalPolicyCode },
        suggestion: "Submit an approval request, then execute again after it is approved.",
      });
    }
    await assertApprovalApproved(authDb, { approvalRequestId: id, operationType: "restore_action", operationId: opts.restoreActionId, now: new Date() });
    approval = { id };
  }

  let stepUpConfirmation: string | null = null;
  if (decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0) {
    const challengeId = String(opts.stepUpChallengeId ?? "").trim();
    const phrase = String(opts.stepUpPhrase ?? "").trim();
    if (!challengeId || !phrase) {
      throw new ApiError({
        status: 409,
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required",
        retryable: false,
        stage: "step_up",
      });
    }
    await consumeStepUpChallenge(authDb, { challengeId, firmId: opts.firmId, actionCode: opCode, actorUserId: opts.requestedByUserId, providedPhrase: phrase });
    stepUpConfirmation = phrase;
  }

  if (restore.riskLevel === "high" || restore.riskLevel === "critical") {
    await assertNoConcurrentDestructive(authDb, { firmId: opts.firmId, table: "restore", currentId: opts.restoreActionId });
  }

  const storage = new SupabaseStorageService();
  await authDb.update(platformRestoreActionsTable).set({
    status: "running",
    reason,
    typedConfirmation: opts.typedConfirmation ?? null,
    stepUpConfirmation,
    approvalRequestId: approval?.id ?? null,
    startedAt: new Date(),
  }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "create_pre_restore_snapshot", stepOrder: 20, status: "running", startedAt: new Date() });

  const preRestoreSnapshot = await createSnapshot(authDb, {
    firmId: opts.firmId,
    snapshotType: "record",
    scopeType: "record",
    moduleCode: "developers",
    targetEntityType: "developer",
    targetEntityId: String(restore.targetEntityId),
    targetLabel: opCode === "rollback_restore" ? "pre_rollback_developer" : "pre_restore_developer",
    triggerType: "pre_restore",
    triggerActionCode: opCode as RestoreOperationCode,
    createdByUserId: opts.requestedByUserId,
    createdByEmail: opts.requestedByEmail ?? null,
    reason,
    note: null,
    retentionPolicyCode: "pre_restore",
    storage,
  });
  await authDb.update(platformRestoreActionsTable).set({ preRestoreSnapshotId: preRestoreSnapshot.snapshotId }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));

  await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: { snapshotId: preRestoreSnapshot.snapshotId } }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "create_pre_restore_snapshot")));
  await authDb.insert(platformRestoreActionStepsTable).values({ restoreActionId: opts.restoreActionId, stepCode: "apply_restore", stepOrder: 30, status: "running", startedAt: new Date() });

  try {
    const payload = await readSnapshotPayload(authDb, restore.snapshotId, storage);
    const payloadObj = asPlainObject(payload);
    if (!payloadObj) throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot payload invalid", retryable: false });
    const kind = readString(payloadObj, "kind");
    if (kind !== "developer") throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot does not contain developer payload", retryable: false });
    const snapDeveloperObj = asPlainObject(payloadObj["developer"]);
    if (!snapDeveloperObj) throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot developer payload missing", retryable: false });
    const developerId = readNumber(snapDeveloperObj, "id");
    if (!developerId) throw new ApiError({ status: 422, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot developer id missing", retryable: false });
    if (String(developerId) !== String(restore.targetEntityId)) throw new ApiError({ status: 409, code: "TARGET_MISMATCH", message: "Snapshot developer id does not match restore target", retryable: false });

    const [current] = await authDb.select().from(developersTable).where(and(eq(developersTable.firmId, opts.firmId), eq(developersTable.id, developerId)));
    if (!current) throw new ApiError({ status: 404, code: "DEVELOPER_NOT_FOUND", message: "Developer not found", retryable: false });

    const name = readString(snapDeveloperObj, "name") ?? current.name;
    const companyRegNo = readString(snapDeveloperObj, "companyRegNo");
    const address = readString(snapDeveloperObj, "address");
    const businessAddress = readString(snapDeveloperObj, "businessAddress");
    const contacts = readString(snapDeveloperObj, "contacts");
    const contactPerson = readString(snapDeveloperObj, "contactPerson");
    const phone = readString(snapDeveloperObj, "phone");
    const email = readString(snapDeveloperObj, "email");

    await authDb.update(developersTable).set({
      name,
      companyRegNo,
      address,
      businessAddress,
      contacts,
      contactPerson,
      phone,
      email,
      updatedAt: new Date(),
    }).where(and(eq(developersTable.firmId, opts.firmId), eq(developersTable.id, developerId)));

    const result = { summary: "Developer restored", restored: { developer_id: developerId } };
    await authDb.update(platformRestoreActionsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "completed", completedAt: new Date(), resultPayload: result }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    await authDb.insert(auditLogsTable).values({
      firmId: opts.firmId,
      actorId: opts.requestedByUserId,
      actorType: "founder",
      action: opCode === "rollback_restore" ? "firm.recovery.rollback.developer" : "firm.restore.developer",
      entityType: "developer",
      entityId: developerId,
      detail: JSON.stringify({ reason, restoreActionId: opts.restoreActionId, operationCode: opCode, snapshotId: restore.snapshotId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, approvalRequestId: approval?.id ?? null }),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    });
    if (approval?.id) await markApprovalExecuted(authDb, approval.id);
    return { restoreActionId: opts.restoreActionId, preRestoreSnapshotId: preRestoreSnapshot.snapshotId, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    await authDb.update(platformRestoreActionsTable).set({ status: "failed", failedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(eq(platformRestoreActionsTable.id, opts.restoreActionId));
    await authDb.update(platformRestoreActionStepsTable).set({ status: "failed", completedAt: new Date(), errorCode: "RESTORE_EXECUTION_FAILED", errorMessage: msg.slice(0, 400) }).where(and(eq(platformRestoreActionStepsTable.restoreActionId, opts.restoreActionId), eq(platformRestoreActionStepsTable.stepCode, "apply_restore")));
    throw new ApiError({ status: 500, code: "RESTORE_EXECUTION_FAILED", message: "Restore failed", retryable: true, details: { restoreActionId: opts.restoreActionId } });
  }
}
