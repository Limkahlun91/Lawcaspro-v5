import express, { type Router as ExpressRouter } from "express";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { auditLogsTable, platformApprovalEventsTable, platformApprovalRequestsTable, platformMaintenanceActionStepsTable, platformMaintenanceActionsTable, platformRestoreActionStepsTable, platformRestoreActionsTable } from "@workspace/db";
import { isTransientDbConnectionError, withAuthSafeDb } from "../lib/auth-safe-db.js";
import { requireAuth, requireFounder, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { ApiError, parseIntParam, sendError, sendOk } from "../lib/api-response.js";
import { assertActiveSupportSessionForFirm, assertFounderPermission, createApprovalRequest, createStepUpChallenge, defaultStepUpPhrase, evaluateDecisionForExecute, evaluateDecisionForPreview, loadFounderGovernanceContext } from "../services/founder-governance/index.js";
import { FOUNDER_ACTION_REGISTRY, FOUNDER_RESTORE_OPERATION_REGISTRY } from "../services/platform-action-registry.js";
import {
  createMaintenanceActionPreviewRecord,
  createRestorePreviewRecord,
  createSnapshot,
  executeMaintenanceAction,
  getSnapshotDetail,
  listSnapshots,
  listSnapshotsPaged,
  MODULE_CODES,
  pinSnapshot,
  previewMaintenanceAction,
  restoreCaseRecordFromSnapshot,
  restoreDeveloperRecordFromSnapshot,
  restoreProjectRecordFromSnapshot,
  restoreProjectsModuleFromSnapshot,
  restoreSettingsFromSnapshot,
  searchTargets,
  softDeleteSnapshot,
  TARGET_ENTITY_TYPES,
  type MaintenanceActionCode,
  type MaintenanceScopeType,
  type ModuleCode,
  type SnapshotTriggerType,
  type SnapshotType,
  type TargetEntityType,
  unpinSnapshot,
  requiredTypedConfirmation,
} from "../services/platform-ops.js";
import { SupabaseStorageService } from "../lib/objectStorage.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const getPgCode = (err: unknown): string | null => {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && code) return code;
  return null;
};

const isUndefinedTableError = (err: unknown): boolean => getPgCode(err) === "42P01";
const isUndefinedColumnError = (err: unknown): boolean => getPgCode(err) === "42703";
const isPermissionDeniedError = (err: unknown): boolean => getPgCode(err) === "42501" || (err instanceof Error && /permission denied/i.test(err.message));

router.get("/platform/firms/:firmId/ops/summary", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [latestMaintenance] = await authDb
        .select()
        .from(platformMaintenanceActionsTable)
        .where(eq(platformMaintenanceActionsTable.firmId, firmId))
        .orderBy(desc(platformMaintenanceActionsTable.createdAt))
        .limit(1);

      const [latestRestore] = await authDb
        .select()
        .from(platformRestoreActionsTable)
        .where(eq(platformRestoreActionsTable.firmId, firmId))
        .orderBy(desc(platformRestoreActionsTable.createdAt))
        .limit(1);

      const [latestRollback] = await authDb
        .select()
        .from(platformRestoreActionsTable)
        .where(and(eq(platformRestoreActionsTable.firmId, firmId), eq(platformRestoreActionsTable.operationCode, "rollback_restore")))
        .orderBy(desc(platformRestoreActionsTable.createdAt))
        .limit(1);

      const [pendingApprovalsRow] = await authDb
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(platformApprovalRequestsTable)
        .where(and(eq(platformApprovalRequestsTable.firmId, firmId), eq(platformApprovalRequestsTable.status, "requested")));
      const pendingApprovals = Number((pendingApprovalsRow as any)?.c ?? 0);

      const [runningMaintenanceRow] = await authDb
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(platformMaintenanceActionsTable)
        .where(and(eq(platformMaintenanceActionsTable.firmId, firmId), sql`status IN ('queued','running','snapshotting')`));
      const runningMaintenance = Number((runningMaintenanceRow as any)?.c ?? 0);

      const [runningRestoreRow] = await authDb
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(platformRestoreActionsTable)
        .where(and(eq(platformRestoreActionsTable.firmId, firmId), sql`status IN ('queued','running')`));
      const runningRestore = Number((runningRestoreRow as any)?.c ?? 0);

      const snaps = await listSnapshots(authDb, firmId, 1);
      const latestSnapshot = snaps[0] ?? null;

      return {
        latest_snapshot: latestSnapshot,
        latest_maintenance: latestMaintenance ?? null,
        latest_restore: latestRestore ?? null,
        latest_rollback: latestRollback ?? null,
        counts: {
          pending_approvals: pendingApprovals,
          running_maintenance: runningMaintenance,
          running_restore: runningRestore,
        },
      };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/ops/summary", firmId } });

    sendOk(res, result);
  } catch (err) {
    if (isUndefinedTableError(err) || isUndefinedColumnError(err) || isPermissionDeniedError(err)) {
      sendOk(
        res,
        {
          latest_snapshot: null,
          latest_maintenance: null,
          latest_restore: null,
          latest_rollback: null,
          counts: { pending_approvals: 0, running_maintenance: 0, running_restore: 0 },
        },
        { warnings: [{ code: "DB_FEATURE_UNAVAILABLE", message: "Platform ops data store is unavailable; returned degraded summary." }] },
      );
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.get("/platform/action-registry", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      return { actions: FOUNDER_ACTION_REGISTRY, restore_operations: FOUNDER_RESTORE_OPERATION_REGISTRY };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/action-registry", firmId: null } });

    sendOk(res, result);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/maintenance/actions", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const limit = (() => {
      const v = req.query.limit;
      const raw = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const items = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);
      return await authDb
        .select()
        .from(platformMaintenanceActionsTable)
        .where(eq(platformMaintenanceActionsTable.firmId, firmId))
        .orderBy(desc(platformMaintenanceActionsTable.createdAt))
        .limit(limit);
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/maintenance/actions", firmId } });
    sendOk(res, { items });
  } catch (err) {
    if (isUndefinedTableError(err) || isPermissionDeniedError(err)) {
      sendOk(res, { items: [] }, { warnings: [{ code: "DB_FEATURE_UNAVAILABLE", message: "Maintenance actions store is unavailable; returned empty list." }] });
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/actions", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const limit = (() => {
      const v = req.query.limit;
      const raw = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const items = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);
      return await authDb
        .select()
        .from(platformMaintenanceActionsTable)
        .where(eq(platformMaintenanceActionsTable.firmId, firmId))
        .orderBy(desc(platformMaintenanceActionsTable.createdAt))
        .limit(limit);
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/actions", firmId } });
    sendOk(res, { items });
  } catch (err) {
    if (isUndefinedTableError(err) || isUndefinedColumnError(err) || isPermissionDeniedError(err)) {
      sendOk(res, { items: [] }, { warnings: [{ code: "DB_FEATURE_UNAVAILABLE", message: "Maintenance actions store is unavailable; returned empty list." }] });
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/maintenance/actions/:actionId", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const actionId = String(req.params.actionId ?? "").trim();
    if (!actionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "actionId is required", retryable: false });

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [action] = await authDb
        .select()
        .from(platformMaintenanceActionsTable)
        .where(and(eq(platformMaintenanceActionsTable.id, actionId), eq(platformMaintenanceActionsTable.firmId, firmId)));
      if (!action) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Action not found", retryable: false });
      const steps = await authDb
        .select()
        .from(platformMaintenanceActionStepsTable)
        .where(eq(platformMaintenanceActionStepsTable.actionId, actionId))
        .orderBy(desc(platformMaintenanceActionStepsTable.stepOrder), desc(platformMaintenanceActionStepsTable.id));

      const approval = action.approvalRequestId
        ? (await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, action.approvalRequestId)))[0] ?? null
        : null;
      const pattern = `%${actionId}%`;
      const audit = await authDb
        .select()
        .from(auditLogsTable)
        .where(and(eq(auditLogsTable.firmId, firmId), sql`COALESCE(${auditLogsTable.detail}, '') ILIKE ${pattern}`))
        .orderBy(desc(auditLogsTable.createdAt))
        .limit(50);
      return { action, steps, approval, audit };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/maintenance/actions/:actionId", firmId } });

    sendOk(res, result);
  } catch (err) {
    if (isUndefinedTableError(err) || isPermissionDeniedError(err)) {
      sendError(res, new ApiError({ status: 503, code: "MAINTENANCE_ACTIONS_UNAVAILABLE", message: "Maintenance actions are temporarily unavailable", retryable: true }));
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/restore/actions/:restoreActionId", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const restoreActionId = String(req.params.restoreActionId ?? "").trim();
    if (!restoreActionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "restoreActionId is required", retryable: false });

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.restore.preview");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [action] = await authDb
        .select()
        .from(platformRestoreActionsTable)
        .where(and(eq(platformRestoreActionsTable.id, restoreActionId), eq(platformRestoreActionsTable.firmId, firmId)));
      if (!action) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });
      const steps = await authDb
        .select()
        .from(platformRestoreActionStepsTable)
        .where(eq(platformRestoreActionStepsTable.restoreActionId, restoreActionId))
        .orderBy(desc(platformRestoreActionStepsTable.stepOrder), desc(platformRestoreActionStepsTable.id));

      const approval = action.approvalRequestId
        ? (await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, action.approvalRequestId)))[0] ?? null
        : null;
      const pattern = `%${restoreActionId}%`;
      const audit = await authDb
        .select()
        .from(auditLogsTable)
        .where(and(eq(auditLogsTable.firmId, firmId), sql`COALESCE(${auditLogsTable.detail}, '') ILIKE ${pattern}`))
        .orderBy(desc(auditLogsTable.createdAt))
        .limit(50);
      return { action, steps, approval, audit };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/restore/actions/:restoreActionId", firmId } });

    sendOk(res, result);
  } catch (err) {
    if (isUndefinedTableError(err) || isPermissionDeniedError(err)) {
      sendError(res, new ApiError({ status: 503, code: "RESTORE_ACTIONS_UNAVAILABLE", message: "Restore actions are temporarily unavailable", retryable: true }));
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/maintenance/preview", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as {
      action_code?: MaintenanceActionCode;
      target?: { entity_type?: TargetEntityType; entity_id?: string; label?: string; module_code?: ModuleCode };
    };
    const actionCode = body?.action_code;
    if (!actionCode) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "action_code is required", retryable: false });

    const preview = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const p = await previewMaintenanceAction(authDb, { firmId, actionCode, target: body.target });
      const actionId = await createMaintenanceActionPreviewRecord(authDb, { firmId, preview: p, requestedByUserId: req.userId!, requestedByEmail: req.email ?? null });

      const decision = evaluateDecisionForPreview({
        actionCode: p.action_code,
        riskLevel: p.risk_level,
        scopeType: p.scope_type,
        moduleCode: p.module_code ?? null,
        actorPermissions: ctx.permissions,
        impersonation: ctx.impersonation.active,
      });

      const stepUp = decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0
        ? await createStepUpChallenge(authDb, {
          firmId,
          actionCode: p.action_code,
          riskLevel: p.risk_level,
          scopeType: p.scope_type,
          moduleCode: p.module_code ?? null,
          targetEntityType: p.target?.entity_type ?? null,
          targetEntityId: p.target?.entity_id ?? null,
          requiredPhrase: defaultStepUpPhrase({ actionCode: p.action_code, firmSlugOrName: String(firmId) }),
          cooldownSeconds: decision.cooldownSecondsRequired,
          expiresInSeconds: 15 * 60,
          issuedToUserId: req.userId!,
          issuedToEmail: req.email ?? null,
        })
        : null;

      await writeAuditLog(
        {
          firmId,
          actorId: req.userId,
          actorType: req.userType,
          action: "firm.maintenance.previewed",
          entityType: p.target?.entity_type ?? p.module_code ?? "firm",
          entityId: p.target?.entity_type === "case" ? Number(p.target.entity_id) : undefined,
          detail: JSON.stringify({ actionId, actionCode, scopeType: p.scope_type, policy: decision.approvalPolicyCode }),
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: false }
      );
      return { preview: p, action_id: actionId, governance: decision, step_up: stepUp };
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/maintenance/preview", firmId } });

    sendOk(res, { preview: preview.preview, action_id: preview.action_id, required_confirmation: requiredTypedConfirmation(preview.preview.risk_level), governance: preview.governance, step_up: preview.step_up });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/maintenance/execute", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as {
      action_id?: string;
      reason?: string;
      typed_confirmation?: string;
      confirm_firm?: string;
      confirm_target?: string;
      approval_request_id?: string;
      step_up_challenge_id?: string;
      step_up_phrase?: string;
      emergency_flag?: boolean;
    };
    const actionId = String(body?.action_id ?? "").trim();
    if (!actionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "action_id is required", retryable: false });
    const reason = String(body?.reason ?? "").trim();
    const typed = body?.typed_confirmation ? String(body.typed_confirmation) : null;

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);
      return await executeMaintenanceAction(authDb, {
        firmId,
        actionId,
        reason,
        typedConfirmation: typed,
        confirmFirm: body?.confirm_firm ?? null,
        confirmTarget: body?.confirm_target ?? null,
        approvalRequestId: body.approval_request_id ? String(body.approval_request_id) : null,
        stepUpChallengeId: body.step_up_challenge_id ? String(body.step_up_challenge_id) : null,
        stepUpPhrase: body.step_up_phrase ? String(body.step_up_phrase) : null,
        emergencyFlag: !!body.emergency_flag,
        actorPermissions: Array.from(ctx.permissions),
        impersonationActive: ctx.impersonation.active,
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/maintenance/execute", firmId, reqId: (res.locals as any)?.requestId } });

    sendOk(res, { operation: { id: result.actionId, type: "maintenance_action", status: result.status }, snapshot: { id: result.snapshotId, created: !!result.snapshotId }, result: result.result });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/maintenance/search", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const entityType = (() => {
      const raw = typeof req.query.entity_type === "string" ? req.query.entity_type : Array.isArray(req.query.entity_type) ? req.query.entity_type[0] : "";
      return String(raw || "").trim() as TargetEntityType;
    })();
    const keyword = (() => {
      const raw = typeof req.query.q === "string" ? req.query.q : Array.isArray(req.query.q) ? req.query.q[0] : "";
      return String(raw || "");
    })();
    const limit = (() => {
      const v = req.query.limit;
      const raw = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
      const n = raw ? Number.parseInt(raw, 10) : 10;
      return Number.isFinite(n) ? n : 10;
    })();
    if (!entityType) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "entity_type is required", retryable: false });
    const items = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);
      return await searchTargets(authDb, { firmId, entityType, keyword, limit });
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/maintenance/search", firmId } });
    sendOk(res, { items, query: { keyword, entity_type: entityType } });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/snapshots", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const one = (v: unknown): string | undefined =>
      typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
    const limit = (() => {
      const v = req.query.limit;
      const raw = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const snapshotType = (() => {
      const raw = one((req.query as any).snapshot_type);
      return raw ? String(raw).trim() : null;
    })();
    const status = (() => {
      const raw = one((req.query as any).status);
      return raw ? String(raw).trim() : null;
    })();
    const triggerType = (() => {
      const raw = one((req.query as any).trigger_type);
      return raw ? String(raw).trim() : null;
    })();
    const pinned = (() => {
      const raw = one((req.query as any).pinned);
      if (!raw) return null;
      const v = String(raw).trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "no") return false;
      return null;
    })();
    const targetEntityType = (() => {
      const raw = one((req.query as any).target_entity_type);
      return raw ? String(raw).trim() : null;
    })();
    const targetEntityId = (() => {
      const raw = one((req.query as any).target_entity_id);
      return raw ? String(raw).trim() : null;
    })();
    const before = (() => {
      const raw = one((req.query as any).before);
      if (!raw) return null;
      const d = new Date(String(raw));
      return Number.isFinite(d.getTime()) ? d : null;
    })();

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.read");
      assertActiveSupportSessionForFirm(ctx, firmId);
      const rows = await listSnapshotsPaged(authDb, { firmId, limit: Math.min(limit + 1, 101), before, snapshotType, status, pinned, targetEntityType, targetEntityId, triggerType });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const nextBefore = items.length ? (items[items.length - 1] as any).createdAt : null;
      return { items, page_info: { limit, has_more: hasMore, next_before: nextBefore }, filters_applied: { snapshot_type: snapshotType, status, pinned, target_entity_type: targetEntityType, target_entity_id: targetEntityId, trigger_type: triggerType, before } };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/snapshots", firmId } });
    sendOk(res, result);
  } catch (err) {
    if (isUndefinedTableError(err) || isUndefinedColumnError(err) || isPermissionDeniedError(err)) {
      sendOk(
        res,
        { items: [], page_info: { limit: 50, has_more: false, next_before: null }, filters_applied: { snapshot_type: null, status: null, pinned: null, target_entity_type: null, target_entity_id: null, trigger_type: null, before: null } },
        { warnings: [{ code: "DB_FEATURE_UNAVAILABLE", message: "Snapshots store is unavailable; returned empty list." }] },
      );
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/snapshots", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as {
      snapshot_type?: SnapshotType;
      scope_type?: MaintenanceScopeType;
      module_code?: ModuleCode;
      target_entity_type?: TargetEntityType;
      target_entity_id?: string;
      target_label?: string;
      trigger_type?: SnapshotTriggerType;
      reason?: string;
      note?: string;
    };
    const snapshotType = body.snapshot_type;
    const scopeType = body.scope_type;
    if (!snapshotType) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "snapshot_type is required", retryable: false });
    if (!scopeType) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "scope_type is required", retryable: false });
    const reason = String(body.reason ?? "").trim();
    if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
    const storage = new SupabaseStorageService();
    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.create");
      assertActiveSupportSessionForFirm(ctx, firmId);
      const snap = await createSnapshot(authDb, {
        firmId,
        snapshotType,
        scopeType,
        moduleCode: body.module_code,
        targetEntityType: body.target_entity_type,
        targetEntityId: body.target_entity_id,
        targetLabel: body.target_label,
        triggerType: body.trigger_type ?? "manual",
        triggerActionCode: undefined,
        createdByUserId: req.userId!,
        createdByEmail: req.email ?? null,
        reason,
        note: body.note ?? null,
        retentionPolicyCode: body.trigger_type === "scheduled" ? "scheduled_daily" : "manual",
        storage,
      });
      await writeAuditLog(
        {
          firmId,
          actorId: req.userId,
          actorType: req.userType,
          action: "firm.snapshot.create.manual",
          entityType: "platform_snapshot",
          entityId: undefined,
          detail: JSON.stringify({ snapshotId: snap.snapshotId, snapshotType, scopeType }),
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: false }
      );
      return snap;
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/snapshots", firmId } });
    sendOk(res, { snapshot: { id: result.snapshotId, storage_driver: result.storageDriver, storage_path: result.storagePath, checksum: result.checksum, size_bytes: result.sizeBytes } }, { status: 201 });
  } catch (err) {
    if (isUndefinedTableError(err) || isPermissionDeniedError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SNAPSHOT_STORE_UNAVAILABLE", message: "Snapshots are temporarily unavailable", retryable: true }));
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err, { status: 500, code: "SNAPSHOT_CREATE_FAILED", message: "Snapshot creation failed" });
  }
});

router.get("/platform/firms/:firmId/snapshots/:snapshotId", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const snapshotId = String(req.params.snapshotId ?? "").trim();
    if (!snapshotId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "snapshotId is required", retryable: false });
    const data = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.read");
      assertActiveSupportSessionForFirm(ctx, firmId);
      return await getSnapshotDetail(authDb, firmId, snapshotId);
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/snapshots/:snapshotId", firmId } });
    sendOk(res, { item: data.snapshot, items: data.items });
  } catch (err) {
    if (isUndefinedTableError(err) || isPermissionDeniedError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SNAPSHOT_STORE_UNAVAILABLE", message: "Snapshots are temporarily unavailable", retryable: true }));
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/snapshots/:snapshotId/pin", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const snapshotId = String(req.params.snapshotId ?? "").trim();
    const body = req.body as { reason?: string };
    const reason = String(body.reason ?? "").trim();
    if (!snapshotId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "snapshotId is required", retryable: false });

    await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.pin");
      assertActiveSupportSessionForFirm(ctx, firmId);
      await pinSnapshot(authDb, { firmId, snapshotId, actorUserId: ctx.actorUserId, reason });
      await writeAuditLog({ firmId, actorId: ctx.actorUserId, actorType: "founder", action: "firm.snapshot.pinned", entityType: "platform_snapshot", detail: JSON.stringify({ snapshotId, reason }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/snapshots/:snapshotId/pin", firmId } });

    sendOk(res, { result: { snapshot_id: snapshotId, pinned: true } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/snapshots/:snapshotId/unpin", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const snapshotId = String(req.params.snapshotId ?? "").trim();
    if (!snapshotId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "snapshotId is required", retryable: false });

    await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.pin");
      assertActiveSupportSessionForFirm(ctx, firmId);
      await unpinSnapshot(authDb, { firmId, snapshotId });
      await writeAuditLog({ firmId, actorId: ctx.actorUserId, actorType: "founder", action: "firm.snapshot.unpinned", entityType: "platform_snapshot", detail: JSON.stringify({ snapshotId }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/snapshots/:snapshotId/unpin", firmId } });

    sendOk(res, { result: { snapshot_id: snapshotId, pinned: false } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/snapshots/:snapshotId/delete", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const snapshotId = String(req.params.snapshotId ?? "").trim();
    const body = req.body as { reason?: string; typed_confirmation?: string };
    const reason = String(body.reason ?? "").trim();
    const typed = String(body.typed_confirmation ?? "").trim();
    if (!snapshotId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "snapshotId is required", retryable: false });
    if (typed !== "CONFIRM") throw new ApiError({ status: 400, code: "INVALID_CONFIRMATION_TEXT", message: "Typed confirmation does not match required text", retryable: false, details: { required: "CONFIRM" } });

    const storage = new SupabaseStorageService();
    const removed = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.delete");
      assertActiveSupportSessionForFirm(ctx, firmId);
      const result = await softDeleteSnapshot(authDb, { firmId, snapshotId, actorUserId: ctx.actorUserId, reason });
      if (result.storageDriver === "supabase" && result.storagePath) {
        try {
          storage.assertConfigured();
          await storage.deletePrivateObject(result.storagePath);
        } catch {
        }
      }
      await writeAuditLog({ firmId, actorId: ctx.actorUserId, actorType: "founder", action: "firm.snapshot.deleted", entityType: "platform_snapshot", detail: JSON.stringify({ snapshotId, reason }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
      return result;
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/snapshots/:snapshotId/delete", firmId } });

    sendOk(res, { result: { snapshot_id: snapshotId, deleted: true, storage_driver: removed.storageDriver } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/restore/preview", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as { snapshot_id?: string; restore_scope_type?: MaintenanceScopeType };
    const snapshotId = String(body.snapshot_id ?? "").trim();
    if (!snapshotId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "snapshot_id is required", retryable: false });
    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.restore.preview");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const detail = await getSnapshotDetail(authDb, firmId, snapshotId);
      if ((detail.snapshot as any)?.deletedAt || String((detail.snapshot as any)?.status ?? "") === "deleted") {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot is deleted", retryable: false });
      }
      const expiresAt = (detail.snapshot as any)?.expiresAt ? new Date(String((detail.snapshot as any).expiresAt)) : null;
      if (expiresAt && expiresAt < new Date()) {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot expired", retryable: false });
      }
      if (!(detail.snapshot as any)?.restorable) {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot is not restorable", retryable: false });
      }
      if (String((detail.snapshot as any)?.integrityStatus ?? "valid") !== "valid") {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot integrity is not valid", retryable: false, details: { integrity_status: (detail.snapshot as any)?.integrityStatus ?? null } });
      }
      if (String((detail.snapshot as any)?.status ?? "") !== "completed") {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Snapshot is not completed", retryable: false });
      }
      const snapshotType = String(detail.snapshot.snapshotType ?? "");
      const inferredScope: MaintenanceScopeType =
        snapshotType === "settings" ? "settings" : snapshotType === "module" ? "module" : snapshotType === "record" ? "record" : "firm";
      const scopeType = body.restore_scope_type ?? inferredScope;
      if (scopeType !== inferredScope) {
        throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Restore scope does not match snapshot type", retryable: false, details: { snapshot_type: snapshotType, restore_scope_type: scopeType } });
      }
      if (scopeType === "firm") throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Firm-wide restore is not supported", retryable: false });

      const riskLevel = scopeType === "settings" ? "medium" : "high";
      const impact: Record<string, number> = { snapshot_items: detail.items.length };
      for (const it of detail.items) {
        const k = String((it as any)?.itemType ?? "");
        if (!k) continue;
        impact[`snapshot_${k}`] = (impact[`snapshot_${k}`] ?? 0) + 1;
      }
      const previewPayload = { snapshot_id: snapshotId, restore_scope_type: scopeType, mode: "replace", impact_summary: impact, warnings: [] };

      const restoreActionId = await createRestorePreviewRecord(authDb, {
        firmId,
        operationCode: "restore_snapshot",
        snapshotId,
        rollbackSourceRestoreActionId: null,
        restoreScopeType: scopeType,
        moduleCode: (detail.snapshot.moduleCode ?? null) as any,
        targetEntityType: (detail.snapshot.targetEntityType ?? null) as any,
        targetEntityId: detail.snapshot.targetEntityId ?? null,
        targetLabel: detail.snapshot.targetLabel ?? null,
        riskLevel: riskLevel as any,
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        previewPayload,
      });

      const decision = evaluateDecisionForPreview({
        actionCode: "restore_snapshot",
        riskLevel: riskLevel as any,
        scopeType,
        moduleCode: detail.snapshot.moduleCode ?? null,
        actorPermissions: ctx.permissions,
        impersonation: ctx.impersonation.active,
      });
      const stepUp = decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0
        ? await createStepUpChallenge(authDb, {
          firmId,
          actionCode: "restore_snapshot",
          riskLevel: riskLevel as any,
          scopeType,
          moduleCode: detail.snapshot.moduleCode ?? null,
          targetEntityType: detail.snapshot.targetEntityType ?? null,
          targetEntityId: detail.snapshot.targetEntityId ?? null,
          requiredPhrase: defaultStepUpPhrase({ actionCode: "restore_snapshot", firmSlugOrName: String(firmId) }),
          cooldownSeconds: decision.cooldownSecondsRequired,
          expiresInSeconds: 15 * 60,
          issuedToUserId: req.userId!,
          issuedToEmail: req.email ?? null,
        })
        : null;

      await writeAuditLog(
        {
          firmId,
          actorId: req.userId,
          actorType: "founder",
          action: "firm.restore.previewed",
          entityType: (detail.snapshot.targetEntityType ?? detail.snapshot.moduleCode ?? "firm") as any,
          entityId: detail.snapshot.targetEntityType === "case" ? Number(detail.snapshot.targetEntityId) : undefined,
          detail: JSON.stringify({ restoreActionId, snapshotId, scopeType, policy: decision.approvalPolicyCode }),
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: false }
      );

      return { preview: previewPayload, restore_action_id: restoreActionId, risk_level: riskLevel, governance: decision, step_up: stepUp };
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/restore/preview", firmId } });

    sendOk(res, { preview: result.preview, restore_action_id: result.restore_action_id, required_confirmation: requiredTypedConfirmation(result.risk_level as any), governance: result.governance, step_up: result.step_up });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/restore/execute", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as { restore_action_id?: string; reason?: string; typed_confirmation?: string; approval_request_id?: string; step_up_challenge_id?: string; step_up_phrase?: string; emergency_flag?: boolean };
    const restoreActionId = String(body.restore_action_id ?? "").trim();
    if (!restoreActionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "restore_action_id is required", retryable: false });
    const reason = String(body.reason ?? "").trim();
    const typed = body.typed_confirmation ? String(body.typed_confirmation) : null;

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.snapshot.restore.execute");
      assertActiveSupportSessionForFirm(ctx, firmId);
      const [op] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, restoreActionId), eq(platformRestoreActionsTable.firmId, firmId)));
      if (!op) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });

      const common = {
        firmId,
        restoreActionId,
        reason,
        typedConfirmation: typed,
        approvalRequestId: body.approval_request_id ? String(body.approval_request_id) : null,
        stepUpChallengeId: body.step_up_challenge_id ? String(body.step_up_challenge_id) : null,
        stepUpPhrase: body.step_up_phrase ? String(body.step_up_phrase) : null,
        emergencyFlag: !!body.emergency_flag,
        actorPermissions: Array.from(ctx.permissions),
        impersonationActive: ctx.impersonation.active,
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      };

      if (op.restoreScopeType === "settings") return await restoreSettingsFromSnapshot(authDb, common);
      if (op.restoreScopeType === "module" && op.moduleCode === "projects") return await restoreProjectsModuleFromSnapshot(authDb, common);
      if (op.restoreScopeType === "record" && op.targetEntityType === "case") return await restoreCaseRecordFromSnapshot(authDb, common);
      if (op.restoreScopeType === "record" && op.targetEntityType === "project") return await restoreProjectRecordFromSnapshot(authDb, common);
      if (op.restoreScopeType === "record" && op.targetEntityType === "developer") return await restoreDeveloperRecordFromSnapshot(authDb, common);
      throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Restore scope not supported", retryable: false });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/restore/execute", firmId } });

    sendOk(res, { operation: { id: result.restoreActionId, type: "restore_action", status: "completed" }, snapshot: { id: result.preRestoreSnapshotId, created: true }, result: result.result });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/maintenance/request-approval", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as { action_id?: string; reason?: string; detailed_note?: string; emergency_flag?: boolean };
    const actionId = String(body.action_id ?? "").trim();
    if (!actionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "action_id is required", retryable: false });
    const reason = String(body.reason ?? "").trim();
    if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.approval.request");
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [action] = await authDb.select().from(platformMaintenanceActionsTable).where(and(eq(platformMaintenanceActionsTable.id, actionId), eq(platformMaintenanceActionsTable.firmId, firmId)));
      if (!action) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Action not found", retryable: false });
      if (action.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Action is not in previewed state", retryable: true });

      const preview = action.previewPayload as any;
      const decision = evaluateDecisionForPreview({
        actionCode: String(preview?.action_code ?? action.actionCode),
        riskLevel: action.riskLevel as any,
        scopeType: action.scopeType as any,
        moduleCode: action.moduleCode ?? null,
        actorPermissions: ctx.permissions,
        impersonation: ctx.impersonation.active,
      });
      if (!decision.approvalRequired) throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Approval is not required for this action", retryable: false });

      const approval = await createApprovalRequest(authDb, {
        firmId,
        actionCode: String(preview?.action_code ?? action.actionCode),
        riskLevel: action.riskLevel as any,
        scopeType: action.scopeType as any,
        moduleCode: action.moduleCode ?? null,
        targetEntityType: action.targetEntityType ?? null,
        targetEntityId: action.targetEntityId ?? null,
        targetLabel: action.targetLabel ?? null,
        snapshotId: action.preActionSnapshotId ?? null,
        operationType: "maintenance_action",
        operationId: action.id,
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        reason,
        detailedNote: body.detailed_note ? String(body.detailed_note) : null,
        approvalPolicyCode: (body.emergency_flag ? "emergency_request" : decision.approvalPolicyCode),
        requiredApprovals: decision.requiredApprovalCount,
        selfApprovalAllowed: decision.selfApprovalAllowed,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        emergencyFlag: !!body.emergency_flag,
        impersonationFlag: ctx.impersonation.active,
        policyResultJson: decision,
      });

      await authDb.update(platformMaintenanceActionsTable).set({ approvalRequestId: approval.id, updatedAt: new Date() }).where(eq(platformMaintenanceActionsTable.id, action.id));

      await writeAuditLog({ firmId, actorId: req.userId, actorType: "founder", action: "founder.approval.requested", entityType: "platform_approval", detail: JSON.stringify({ approvalId: approval.id, approvalCode: approval.requestCode, operationType: "maintenance_action", operationId: action.id }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
      return approval;
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/maintenance/request-approval", firmId } });

    sendOk(res, { approval: result }, { status: 201 });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/recovery/rollback/preview", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as { source_restore_action_id?: string };
    const sourceRestoreActionId = String(body.source_restore_action_id ?? "").trim();
    if (!sourceRestoreActionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "source_restore_action_id is required", retryable: false });

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.recovery.preview");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [source] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, sourceRestoreActionId), eq(platformRestoreActionsTable.firmId, firmId)));
      if (!source) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Source restore action not found", retryable: false });
      if (String(source.operationCode ?? "restore_snapshot") !== "restore_snapshot") {
        throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Only snapshot restores can be rolled back", retryable: false });
      }
      if (source.status !== "completed") {
        throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Source restore action is not completed", retryable: true, details: { status: source.status } });
      }
      if (!source.preRestoreSnapshotId) {
        throw new ApiError({ status: 409, code: "ROLLBACK_UNAVAILABLE", message: "Pre-restore snapshot is missing; rollback unavailable", retryable: false });
      }

      const snapshotId = String(source.preRestoreSnapshotId);
      const detail = await getSnapshotDetail(authDb, firmId, snapshotId);
      if (String(detail.snapshot.status ?? "") !== "completed") {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Pre-restore snapshot is not completed", retryable: false });
      }
      if (!detail.snapshot.restorable) {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Pre-restore snapshot is not restorable", retryable: false });
      }
      if (String(detail.snapshot.integrityStatus ?? "valid") !== "valid") {
        throw new ApiError({ status: 409, code: "SNAPSHOT_NOT_RESTORABLE", message: "Pre-restore snapshot integrity is not valid", retryable: false, details: { integrity_status: detail.snapshot.integrityStatus ?? null } });
      }

      const impact: Record<string, number> = { snapshot_items: detail.items.length };
      for (const it of detail.items) {
        const obj = it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
        const k = obj && typeof obj["itemType"] === "string" ? String(obj["itemType"]) : "";
        if (!k) continue;
        impact[`snapshot_${k}`] = (impact[`snapshot_${k}`] ?? 0) + 1;
      }
      const previewPayload = {
        mode: "rollback",
        operation_code: "rollback_restore",
        source_restore_action_id: sourceRestoreActionId,
        rollback_to_snapshot_id: snapshotId,
        restore_scope_type: source.restoreScopeType,
        impact_summary: impact,
        warnings: [{ code: "ROLLBACK_REPLACES_STATE", message: "Rollback will overwrite current state using the pre-restore snapshot." }],
      };

      const moduleCode = (() => {
        const v = source.moduleCode;
        if (typeof v !== "string") return null;
        return (MODULE_CODES as readonly string[]).includes(v) ? (v as ModuleCode) : null;
      })();
      const targetEntityType = (() => {
        const v = source.targetEntityType;
        if (typeof v !== "string") return null;
        return (TARGET_ENTITY_TYPES as readonly string[]).includes(v) ? (v as TargetEntityType) : null;
      })();

      const rollbackActionId = await createRestorePreviewRecord(authDb, {
        firmId,
        operationCode: "rollback_restore",
        snapshotId,
        rollbackSourceRestoreActionId: sourceRestoreActionId,
        restoreScopeType: source.restoreScopeType as MaintenanceScopeType,
        moduleCode,
        targetEntityType,
        targetEntityId: source.targetEntityId ?? null,
        targetLabel: source.targetLabel ?? null,
        riskLevel: "critical",
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        previewPayload,
      });

      const decision = evaluateDecisionForPreview({
        actionCode: "rollback_restore",
        riskLevel: "critical",
        scopeType: source.restoreScopeType as MaintenanceScopeType,
        moduleCode: source.moduleCode ?? null,
        actorPermissions: ctx.permissions,
        impersonation: ctx.impersonation.active,
      });
      const stepUp = decision.challengePhraseRequired || decision.cooldownSecondsRequired > 0
        ? await createStepUpChallenge(authDb, {
          firmId,
          actionCode: "rollback_restore",
          riskLevel: "critical",
          scopeType: source.restoreScopeType as MaintenanceScopeType,
          moduleCode: source.moduleCode ?? null,
          targetEntityType: source.targetEntityType ?? null,
          targetEntityId: source.targetEntityId ?? null,
          requiredPhrase: defaultStepUpPhrase({ actionCode: "rollback_restore", firmSlugOrName: String(firmId) }),
          cooldownSeconds: decision.cooldownSecondsRequired,
          expiresInSeconds: 15 * 60,
          issuedToUserId: req.userId!,
          issuedToEmail: req.email ?? null,
        })
        : null;

      await writeAuditLog(
        {
          firmId,
          actorId: req.userId,
          actorType: "founder",
          action: "firm.recovery.rollback.previewed",
          entityType: String(source.targetEntityType ?? source.moduleCode ?? "firm"),
          entityId: source.targetEntityType === "case" ? Number(source.targetEntityId) : undefined,
          detail: JSON.stringify({ rollbackActionId, sourceRestoreActionId, snapshotId, scopeType: source.restoreScopeType, policy: decision.approvalPolicyCode }),
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: false }
      );

      return { preview: previewPayload, rollback_action_id: rollbackActionId, governance: decision, step_up: stepUp };
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/recovery/rollback/preview", firmId } });

    sendOk(res, { preview: result.preview, rollback_action_id: result.rollback_action_id, required_confirmation: requiredTypedConfirmation("critical"), governance: result.governance, step_up: result.step_up });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/recovery/rollback/request-approval", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as { rollback_action_id?: string; reason?: string; detailed_note?: string; emergency_flag?: boolean };
    const rollbackActionId = String(body.rollback_action_id ?? "").trim();
    if (!rollbackActionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "rollback_action_id is required", retryable: false });
    const reason = String(body.reason ?? "").trim();
    if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.approval.request");
      assertFounderPermission(ctx, "founder.recovery.preview");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [op] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, rollbackActionId), eq(platformRestoreActionsTable.firmId, firmId)));
      if (!op) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Rollback action not found", retryable: false });
      if (String(op.operationCode ?? "") !== "rollback_restore") throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Not a rollback action", retryable: false });
      if (op.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Rollback action is not in previewed state", retryable: true });

      const decision = evaluateDecisionForPreview({
        actionCode: "rollback_restore",
        riskLevel: op.riskLevel as any,
        scopeType: op.restoreScopeType as any,
        moduleCode: op.moduleCode ?? null,
        actorPermissions: ctx.permissions,
        impersonation: ctx.impersonation.active,
      });
      if (!decision.approvalRequired) throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Approval is not required for this rollback", retryable: false });

      const approval = await createApprovalRequest(authDb, {
        firmId,
        actionCode: "rollback_restore",
        riskLevel: op.riskLevel as any,
        scopeType: op.restoreScopeType as any,
        moduleCode: op.moduleCode ?? null,
        targetEntityType: op.targetEntityType ?? null,
        targetEntityId: op.targetEntityId ?? null,
        targetLabel: op.targetLabel ?? null,
        snapshotId: op.snapshotId,
        operationType: "restore_action",
        operationId: op.id,
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        reason,
        detailedNote: body.detailed_note ? String(body.detailed_note) : null,
        approvalPolicyCode: (body.emergency_flag ? "emergency_request" : decision.approvalPolicyCode),
        requiredApprovals: decision.requiredApprovalCount,
        selfApprovalAllowed: decision.selfApprovalAllowed,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        emergencyFlag: !!body.emergency_flag,
        impersonationFlag: ctx.impersonation.active,
        policyResultJson: decision,
      });

      await authDb.update(platformRestoreActionsTable).set({ approvalRequestId: approval.id, updatedAt: new Date() }).where(eq(platformRestoreActionsTable.id, op.id));
      await writeAuditLog({ firmId, actorId: req.userId, actorType: "founder", action: "founder.approval.requested", entityType: "platform_approval", detail: JSON.stringify({ approvalId: approval.id, approvalCode: approval.requestCode, operationType: "restore_action", operationId: op.id }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
      return approval;
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/recovery/rollback/request-approval", firmId } });

    sendOk(res, { approval: result }, { status: 201 });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/recovery/rollback/execute", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as { rollback_action_id?: string; reason?: string; typed_confirmation?: string; approval_request_id?: string; step_up_challenge_id?: string; step_up_phrase?: string; emergency_flag?: boolean };
    const rollbackActionId = String(body.rollback_action_id ?? "").trim();
    if (!rollbackActionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "rollback_action_id is required", retryable: false });
    const reason = String(body.reason ?? "").trim();
    const typed = body.typed_confirmation ? String(body.typed_confirmation) : null;

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.recovery.execute");
      assertFounderPermission(ctx, "founder.recovery.rollback");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [op] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, rollbackActionId), eq(platformRestoreActionsTable.firmId, firmId)));
      if (!op) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Rollback action not found", retryable: false });
      if (String(op.operationCode ?? "") !== "rollback_restore") throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Not a rollback action", retryable: false });

      const common = {
        firmId,
        restoreActionId: rollbackActionId,
        reason,
        typedConfirmation: typed,
        approvalRequestId: body.approval_request_id ? String(body.approval_request_id) : null,
        stepUpChallengeId: body.step_up_challenge_id ? String(body.step_up_challenge_id) : null,
        stepUpPhrase: body.step_up_phrase ? String(body.step_up_phrase) : null,
        emergencyFlag: !!body.emergency_flag,
        actorPermissions: Array.from(ctx.permissions),
        impersonationActive: ctx.impersonation.active,
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      };

      if (op.restoreScopeType === "settings") return await restoreSettingsFromSnapshot(authDb, common);
      if (op.restoreScopeType === "module" && op.moduleCode === "projects") return await restoreProjectsModuleFromSnapshot(authDb, common);
      if (op.restoreScopeType === "record" && op.targetEntityType === "case") return await restoreCaseRecordFromSnapshot(authDb, common);
      if (op.restoreScopeType === "record" && op.targetEntityType === "project") return await restoreProjectRecordFromSnapshot(authDb, common);
      if (op.restoreScopeType === "record" && op.targetEntityType === "developer") return await restoreDeveloperRecordFromSnapshot(authDb, common);
      throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Rollback scope not supported", retryable: false });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/recovery/rollback/execute", firmId } });

    sendOk(res, { operation: { id: result.restoreActionId, type: "restore_action", status: "completed" }, snapshot: { id: result.preRestoreSnapshotId, created: true }, result: result.result });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/firms/:firmId/restore/request-approval", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const body = req.body as { restore_action_id?: string; reason?: string; detailed_note?: string; emergency_flag?: boolean };
    const restoreActionId = String(body.restore_action_id ?? "").trim();
    if (!restoreActionId) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "restore_action_id is required", retryable: false });
    const reason = String(body.reason ?? "").trim();
    if (reason.length < 10) throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.approval.request");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const [op] = await authDb.select().from(platformRestoreActionsTable).where(and(eq(platformRestoreActionsTable.id, restoreActionId), eq(platformRestoreActionsTable.firmId, firmId)));
      if (!op) throw new ApiError({ status: 404, code: "ACTION_NOT_FOUND", message: "Restore action not found", retryable: false });
      if (op.status !== "previewed") throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Restore action is not in previewed state", retryable: true });

      const actionCode = String(op.operationCode ?? "restore_snapshot");
      if (actionCode === "rollback_restore") {
        assertFounderPermission(ctx, "founder.recovery.preview");
      } else {
        assertFounderPermission(ctx, "founder.snapshot.restore.preview");
      }

      const decision = evaluateDecisionForPreview({
        actionCode,
        riskLevel: op.riskLevel as any,
        scopeType: op.restoreScopeType as any,
        moduleCode: op.moduleCode ?? null,
        actorPermissions: ctx.permissions,
        impersonation: ctx.impersonation.active,
      });
      if (!decision.approvalRequired) throw new ApiError({ status: 422, code: "UNSUPPORTED_OPERATION", message: "Approval is not required for this restore", retryable: false });

      const approval = await createApprovalRequest(authDb, {
        firmId,
        actionCode,
        riskLevel: op.riskLevel as any,
        scopeType: op.restoreScopeType as any,
        moduleCode: op.moduleCode ?? null,
        targetEntityType: op.targetEntityType ?? null,
        targetEntityId: op.targetEntityId ?? null,
        targetLabel: op.targetLabel ?? null,
        snapshotId: op.snapshotId,
        operationType: "restore_action",
        operationId: op.id,
        requestedByUserId: req.userId!,
        requestedByEmail: req.email ?? null,
        reason,
        detailedNote: body.detailed_note ? String(body.detailed_note) : null,
        approvalPolicyCode: (body.emergency_flag ? "emergency_request" : decision.approvalPolicyCode),
        requiredApprovals: decision.requiredApprovalCount,
        selfApprovalAllowed: decision.selfApprovalAllowed,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        emergencyFlag: !!body.emergency_flag,
        impersonationFlag: ctx.impersonation.active,
        policyResultJson: decision,
      });

      await authDb.update(platformRestoreActionsTable).set({ approvalRequestId: approval.id, updatedAt: new Date() }).where(eq(platformRestoreActionsTable.id, op.id));
      await writeAuditLog({ firmId, actorId: req.userId, actorType: "founder", action: "founder.approval.requested", entityType: "platform_approval", detail: JSON.stringify({ approvalId: approval.id, approvalCode: approval.requestCode, operationType: "restore_action", operationId: op.id }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
      return approval;
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/restore/request-approval", firmId } });

    sendOk(res, { approval: result }, { status: 201 });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/maintenance/history", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const limit = (() => {
      const v = req.query.limit;
      const raw = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const items = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);
      const maint = await authDb.select().from(platformMaintenanceActionsTable).where(eq(platformMaintenanceActionsTable.firmId, firmId)).orderBy(desc(platformMaintenanceActionsTable.createdAt)).limit(limit);
      const restores = await authDb.select().from(platformRestoreActionsTable).where(eq(platformRestoreActionsTable.firmId, firmId)).orderBy(desc(platformRestoreActionsTable.createdAt)).limit(limit);
      const approvals = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.firmId, firmId)).orderBy(desc(platformApprovalRequestsTable.createdAt)).limit(limit);
      const merged = [
        ...maint.map((m) => ({ kind: "maintenance", ...m })),
        ...restores.map((r) => ({ kind: "restore", ...r })),
        ...approvals.map((a) => ({ kind: "approval", ...a })),
      ].sort((a: any, b: any) => new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime()).slice(0, limit);
      return merged;
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/maintenance/history", firmId } });
    sendOk(res, { items });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/firms/:firmId/history", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;

    const one = (v: unknown): string | undefined =>
      typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;

    const limit = (() => {
      const raw = one((req.query as any).limit);
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();

    const kind = (() => {
      const raw = one((req.query as any).kind);
      const v = raw ? String(raw).trim() : "";
      if (v === "maintenance" || v === "restore" || v === "approval") return v;
      return null;
    })();

    const status = (() => {
      const raw = one((req.query as any).status);
      return raw ? String(raw).trim() : null;
    })();
    const moduleCode = (() => {
      const raw = one((req.query as any).module_code);
      return raw ? String(raw).trim() : null;
    })();
    const actionCode = (() => {
      const raw = one((req.query as any).action_code);
      return raw ? String(raw).trim() : null;
    })();
    const operationCode = (() => {
      const raw = one((req.query as any).operation_code);
      return raw ? String(raw).trim() : null;
    })();
    const recordType = (() => {
      const raw = one((req.query as any).record_type);
      return raw ? String(raw).trim() : null;
    })();
    const recordId = (() => {
      const raw = one((req.query as any).record_id);
      return raw ? String(raw).trim() : null;
    })();
    const requesterUserId = (() => {
      const raw = one((req.query as any).requester_user_id);
      if (!raw) return null;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const requesterEmail = (() => {
      const raw = one((req.query as any).requester_email);
      return raw ? String(raw).trim() : null;
    })();
    const approverUserId = (() => {
      const raw = one((req.query as any).approver_user_id);
      if (!raw) return null;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const before = (() => {
      const raw = one((req.query as any).before);
      if (!raw) return null;
      const d = new Date(String(raw));
      return Number.isFinite(d.getTime()) ? d : null;
    })();
    const dateFrom = (() => {
      const raw = one((req.query as any).date_from);
      if (!raw) return null;
      const d = new Date(String(raw));
      return Number.isFinite(d.getTime()) ? d : null;
    })();
    const dateTo = (() => {
      const raw = one((req.query as any).date_to);
      if (!raw) return null;
      const d = new Date(String(raw));
      return Number.isFinite(d.getTime()) ? d : null;
    })();

    const result = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.maintenance.read");
      assertActiveSupportSessionForFirm(ctx, firmId);

      const perKindLimit = Math.min(limit * 2, 200);
      const kinds: Array<"maintenance" | "restore" | "approval"> = kind ? [kind] : ["maintenance", "restore", "approval"];
      if (approverUserId && !kind) {
        kinds.splice(0, kinds.length, "approval");
      }

      const items: any[] = [];

      if (kinds.includes("maintenance")) {
        const where = [
          eq(platformMaintenanceActionsTable.firmId, firmId),
          status ? eq(platformMaintenanceActionsTable.status, status) : null,
          moduleCode ? eq(platformMaintenanceActionsTable.moduleCode, moduleCode) : null,
          actionCode ? eq(platformMaintenanceActionsTable.actionCode, actionCode) : null,
          recordType ? eq(platformMaintenanceActionsTable.targetEntityType, recordType) : null,
          recordId ? eq(platformMaintenanceActionsTable.targetEntityId, recordId) : null,
          requesterUserId ? eq(platformMaintenanceActionsTable.requestedByUserId, requesterUserId) : null,
          requesterEmail ? ilike(platformMaintenanceActionsTable.requestedByEmail, `%${requesterEmail}%`) : null,
          before ? sql`${platformMaintenanceActionsTable.createdAt} < ${before}` : null,
          dateFrom ? sql`${platformMaintenanceActionsTable.createdAt} >= ${dateFrom}` : null,
          dateTo ? sql`${platformMaintenanceActionsTable.createdAt} <= ${dateTo}` : null,
        ].filter(Boolean) as any[];
        const rows = await authDb.select().from(platformMaintenanceActionsTable).where(and(...where)).orderBy(desc(platformMaintenanceActionsTable.createdAt)).limit(perKindLimit);
        items.push(...rows.map((r) => ({ kind: "maintenance", ...r })));
      }

      if (kinds.includes("restore")) {
        const where = [
          eq(platformRestoreActionsTable.firmId, firmId),
          status ? eq(platformRestoreActionsTable.status, status) : null,
          moduleCode ? eq(platformRestoreActionsTable.moduleCode, moduleCode) : null,
          operationCode ? eq(platformRestoreActionsTable.operationCode, operationCode) : null,
          (!operationCode && actionCode) ? eq(platformRestoreActionsTable.operationCode, actionCode) : null,
          recordType ? eq(platformRestoreActionsTable.targetEntityType, recordType) : null,
          recordId ? eq(platformRestoreActionsTable.targetEntityId, recordId) : null,
          requesterUserId ? eq(platformRestoreActionsTable.requestedByUserId, requesterUserId) : null,
          requesterEmail ? ilike(platformRestoreActionsTable.requestedByEmail, `%${requesterEmail}%`) : null,
          before ? sql`${platformRestoreActionsTable.createdAt} < ${before}` : null,
          dateFrom ? sql`${platformRestoreActionsTable.createdAt} >= ${dateFrom}` : null,
          dateTo ? sql`${platformRestoreActionsTable.createdAt} <= ${dateTo}` : null,
        ].filter(Boolean) as any[];
        const rows = await authDb.select().from(platformRestoreActionsTable).where(and(...where)).orderBy(desc(platformRestoreActionsTable.createdAt)).limit(perKindLimit);
        items.push(...rows.map((r) => ({ kind: "restore", ...r })));
      }

      if (kinds.includes("approval")) {
        const where = [
          eq(platformApprovalRequestsTable.firmId, firmId),
          status ? eq(platformApprovalRequestsTable.status, status) : null,
          moduleCode ? eq(platformApprovalRequestsTable.moduleCode, moduleCode) : null,
          actionCode ? eq(platformApprovalRequestsTable.actionCode, actionCode) : null,
          recordType ? eq(platformApprovalRequestsTable.targetEntityType, recordType) : null,
          recordId ? eq(platformApprovalRequestsTable.targetEntityId, recordId) : null,
          requesterUserId ? eq(platformApprovalRequestsTable.requestedByUserId, requesterUserId) : null,
          requesterEmail ? ilike(platformApprovalRequestsTable.requestedByEmail, `%${requesterEmail}%`) : null,
          approverUserId ? sql`EXISTS (SELECT 1 FROM ${platformApprovalEventsTable} e WHERE e.request_id = ${platformApprovalRequestsTable.id} AND e.actor_user_id = ${approverUserId})` : null,
          before ? sql`${platformApprovalRequestsTable.createdAt} < ${before}` : null,
          dateFrom ? sql`${platformApprovalRequestsTable.createdAt} >= ${dateFrom}` : null,
          dateTo ? sql`${platformApprovalRequestsTable.createdAt} <= ${dateTo}` : null,
        ].filter(Boolean) as any[];
        const rows = await authDb.select().from(platformApprovalRequestsTable).where(and(...where)).orderBy(desc(platformApprovalRequestsTable.createdAt)).limit(perKindLimit);
        items.push(...rows.map((r) => ({ kind: "approval", ...r })));
      }

      const merged = items.sort((a: any, b: any) => new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime());
      const pageItems = merged.slice(0, limit);
      const hasMore = merged.length > limit;
      const nextBefore = pageItems.length ? pageItems[pageItems.length - 1].createdAt : null;

      return {
        items: pageItems,
        page_info: { limit, has_more: hasMore, next_before: nextBefore },
        filters_applied: {
          kind: kind ?? "all",
          status,
          module_code: moduleCode,
          action_code: actionCode,
          operation_code: operationCode,
          record_type: recordType,
          record_id: recordId,
          requester_user_id: requesterUserId,
          requester_email: requesterEmail,
          approver_user_id: approverUserId,
          before,
          date_from: dateFrom,
          date_to: dateTo,
        },
      };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/history", firmId } });

    sendOk(res, result);
  } catch (err) {
    sendError(res, err);
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
