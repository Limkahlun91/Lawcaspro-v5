import express, { type Router as ExpressRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { platformApprovalRequestsTable, platformIncidentsTable, platformMaintenanceActionStepsTable, platformMaintenanceActionsTable, platformRestoreActionStepsTable, platformRestoreActionsTable, auditLogsTable } from "@workspace/db";
import { requireAuth, requireFounder, requireFounderPermission, type AuthRequest } from "../lib/auth.js";
import { withAuthSafeDb } from "../lib/auth-safe-db.js";
import { one, sendError, sendOk, type ResLike } from "../lib/api-response.js";
import { computeOverview, computePending, computeReadiness, computeRecommendationsForIncident, getApprovalEventActors, getIncidentDetail, listIncidents, listOpsLogs, recomputeIncidents, setIncidentStatus, addIncidentNote } from "../services/ops-center.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

router.get("/platform/operations/overview", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const range = (() => {
      const v = one((req.query as any).range);
      if (v === "24h" || v === "7d" || v === "30d") return v;
      return "7d";
    })();
    const data = await withAuthSafeDb(async (authDb) => {
      return await computeOverview(authDb, { range });
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/overview" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/operations/logs", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const limit = (() => {
      const raw = one((req.query as any).limit);
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const before = (() => {
      const raw = one((req.query as any).before);
      if (!raw) return null;
      const d = new Date(String(raw));
      return Number.isFinite(d.getTime()) ? d : null;
    })();
    const firmId = (() => {
      const raw = one((req.query as any).firm_id);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const moduleCode = (() => {
      const raw = one((req.query as any).module_code);
      return raw ? String(raw).trim() : null;
    })();
    const category = (() => {
      const raw = one((req.query as any).event_category);
      const v = raw ? String(raw).trim() : null;
      if (v === "maintenance" || v === "governance" || v === "safety" || v === "system" || v === "incident") return v;
      return null;
    })();
    const severity = (() => {
      const raw = one((req.query as any).severity);
      const v = raw ? String(raw).trim() : null;
      if (v === "low" || v === "medium" || v === "high" || v === "critical") return v;
      return null;
    })();
    const riskLevel = (() => {
      const raw = one((req.query as any).risk_level);
      const v = raw ? String(raw).trim() : null;
      if (v === "low" || v === "medium" || v === "high" || v === "critical") return v;
      return null;
    })();
    const actorUserId = (() => {
      const raw = one((req.query as any).actor_user_id);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const status = (() => {
      const raw = one((req.query as any).status);
      const v = raw ? String(raw).trim() : null;
      if (v === "success" || v === "failed" || v === "blocked" || v === "pending") return v;
      return null;
    })();
    const emergencyOnly = (() => {
      const raw = one((req.query as any).emergency_only);
      if (!raw) return null;
      const v = String(raw).trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "no") return false;
      return null;
    })();
    const impersonationOnly = (() => {
      const raw = one((req.query as any).impersonation_only);
      if (!raw) return null;
      const v = String(raw).trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "no") return false;
      return null;
    })();
    const approvalState = (() => {
      const raw = one((req.query as any).approval_state);
      return raw ? String(raw).trim() : null;
    })();
    const q = (() => {
      const raw = one((req.query as any).q);
      return raw ? String(raw).trim() : null;
    })();

    const data = await withAuthSafeDb(async (authDb) => {
      return await listOpsLogs(authDb, { limit, before, firmId, moduleCode, category, severity, riskLevel, actorUserId, status, emergencyOnly, impersonationOnly, approvalState, q });
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/logs" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/operations/operations/:kind/:id", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const kind = String(req.params.kind ?? "");
    const id = String(req.params.id ?? "");

    const data = await withAuthSafeDb(async (authDb) => {
      if (kind === "maintenance") {
        const [action] = await authDb.select().from(platformMaintenanceActionsTable).where(eq(platformMaintenanceActionsTable.id, id)).limit(1);
        if (!action) throw new Error("Not found");
        const steps = await authDb.select().from(platformMaintenanceActionStepsTable).where(eq(platformMaintenanceActionStepsTable.actionId, id)).orderBy(sql`${platformMaintenanceActionStepsTable.startedAt} ASC NULLS LAST`);
        const approval = action.approvalRequestId
          ? (await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, String(action.approvalRequestId))).limit(1))[0] ?? null
          : null;
        const audit = await authDb.select().from(auditLogsTable).where(and(eq(auditLogsTable.firmId, action.firmId), sql`COALESCE(${auditLogsTable.detail}, '') ILIKE ${`%${id}%`}`)).orderBy(sql`${auditLogsTable.createdAt} DESC`).limit(50);
        return { kind, action, steps, approval, audit };
      }
      if (kind === "restore") {
        const [action] = await authDb.select().from(platformRestoreActionsTable).where(eq(platformRestoreActionsTable.id, id)).limit(1);
        if (!action) throw new Error("Not found");
        const steps = await authDb.select().from(platformRestoreActionStepsTable).where(eq(platformRestoreActionStepsTable.restoreActionId, id)).orderBy(sql`${platformRestoreActionStepsTable.startedAt} ASC NULLS LAST`);
        const approval = action.approvalRequestId
          ? (await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, String(action.approvalRequestId))).limit(1))[0] ?? null
          : null;
        const audit = await authDb.select().from(auditLogsTable).where(and(eq(auditLogsTable.firmId, action.firmId), sql`COALESCE(${auditLogsTable.detail}, '') ILIKE ${`%${id}%`}`)).orderBy(sql`${auditLogsTable.createdAt} DESC`).limit(50);
        return { kind, action, steps, approval, audit };
      }
      if (kind === "approval") {
        const [item] = await authDb.select().from(platformApprovalRequestsTable).where(eq(platformApprovalRequestsTable.id, id)).limit(1);
        if (!item) throw new Error("Not found");
        const events = await getApprovalEventActors(authDb, id);
        const audit = await authDb.select().from(auditLogsTable).where(and(eq(auditLogsTable.firmId, item.firmId), sql`COALESCE(${auditLogsTable.detail}, '') ILIKE ${`%${id}%`}`)).orderBy(sql`${auditLogsTable.createdAt} DESC`).limit(50);
        return { kind, item, events, audit };
      }
      throw new Error("Unsupported kind");
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/operations/:kind/:id" } });

    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/operations/incidents", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const limit = (() => {
      const raw = one((req.query as any).limit);
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const before = (() => {
      const raw = one((req.query as any).before);
      if (!raw) return null;
      const d = new Date(String(raw));
      return Number.isFinite(d.getTime()) ? d : null;
    })();
    const status = (() => {
      const raw = one((req.query as any).status);
      return raw ? String(raw).trim() : null;
    })();
    const severity = (() => {
      const raw = one((req.query as any).severity);
      const v = raw ? String(raw).trim() : null;
      if (v === "low" || v === "medium" || v === "high" || v === "critical") return v;
      return null;
    })();
    const firmId = (() => {
      const raw = one((req.query as any).firm_id);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const moduleCode = (() => {
      const raw = one((req.query as any).module_code);
      return raw ? String(raw).trim() : null;
    })();
    const q = (() => {
      const raw = one((req.query as any).q);
      return raw ? String(raw).trim() : null;
    })();

    const data = await withAuthSafeDb(async (authDb) => {
      return await listIncidents(authDb, { limit, before, status, severity, firmId, moduleCode, q });
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/incidents" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/operations/incidents/:id", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const id = String(req.params.id ?? "");
    const data = await withAuthSafeDb(async (authDb) => {
      const d = await getIncidentDetail(authDb, id);
      const recommendations = await computeRecommendationsForIncident(authDb, d.incident);
      return { ...d, recommendations };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/incidents/:id" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/operations/recommendations", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const limit = (() => {
      const raw = one((req.query as any).limit);
      const n = raw ? Number.parseInt(raw, 10) : 30;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 30;
    })();
    const data = await withAuthSafeDb(async (authDb) => {
      const incidents = await authDb
        .select()
        .from(platformIncidentsTable)
        .where(sql`status IN ('open','investigating','awaiting-approval','awaiting-execution')`)
        .orderBy(sql`CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC`, sql`${platformIncidentsTable.detectedAt} DESC`)
        .limit(limit);

      const items = [];
      for (const i of incidents) {
        const recs = await computeRecommendationsForIncident(authDb, i);
        for (const r of recs) {
          items.push({ incident: i, recommendation: r });
        }
      }

      const readiness = await computeReadiness(authDb, { limit: 100 });
      const readinessRecs = (readiness.items ?? [])
        .filter((r: any) => (r.blockers ?? []).includes("no_valid_snapshot"))
        .slice(0, 30)
        .map((r: any) => ({
          incident: null,
          recommendation: {
            recommendation_code: "create_snapshot_first",
            title: "Create snapshot first",
            severity: "high",
            reason: "Firm has no valid restorable snapshot.",
            confidence_level: "high",
            applies_to_scope: { firm_id: r.firm_id, module_code: null, entity_type: null, entity_id: null },
            recommended_next_action: "Create a new snapshot before attempting restore/reset.",
            can_execute_directly: true,
            required_permission: "founder.snapshot.create",
            required_approval: false,
            related_snapshot_id: null,
            related_incident_id: null,
            supporting_signals: { readiness: r },
            note: null,
          },
        }));

      return { items: [...items, ...readinessRecs].slice(0, 200) };
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/recommendations" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/operations/incidents/:id/acknowledge", requireAuth, requireFounder, requireFounderPermission("founder.ops.incident.ack"), async (req: AuthRequest, res: ResLike) => {
  try {
    const id = String(req.params.id ?? "");
    await withAuthSafeDb(async (authDb) => {
      await setIncidentStatus(authDb, { incidentId: id, status: "investigating", actorUserId: req.userId ?? 0, note: null });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/operations/incidents/:id/acknowledge" } });
    sendOk(res, { result: { acknowledged: true } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/operations/incidents/:id/resolve", requireAuth, requireFounder, requireFounderPermission("founder.ops.incident.resolve"), async (req: AuthRequest, res: ResLike) => {
  try {
    const id = String(req.params.id ?? "");
    const note = (req.body as any)?.note ? String((req.body as any).note) : null;
    await withAuthSafeDb(async (authDb) => {
      await setIncidentStatus(authDb, { incidentId: id, status: "resolved", actorUserId: req.userId ?? 0, note });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/operations/incidents/:id/resolve" } });
    sendOk(res, { result: { resolved: true } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/operations/incidents/:id/dismiss", requireAuth, requireFounder, requireFounderPermission("founder.ops.incident.dismiss"), async (req: AuthRequest, res: ResLike) => {
  try {
    const id = String(req.params.id ?? "");
    const note = (req.body as any)?.note ? String((req.body as any).note) : null;
    await withAuthSafeDb(async (authDb) => {
      await setIncidentStatus(authDb, { incidentId: id, status: "dismissed", actorUserId: req.userId ?? 0, note });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/operations/incidents/:id/dismiss" } });
    sendOk(res, { result: { dismissed: true } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/operations/incidents/:id/notes", requireAuth, requireFounder, requireFounderPermission("founder.ops.incident.note"), async (req: AuthRequest, res: ResLike) => {
  try {
    const id = String(req.params.id ?? "");
    const note = String((req.body as any)?.note ?? "");
    await withAuthSafeDb(async (authDb) => {
      await addIncidentNote(authDb, { incidentId: id, authorUserId: req.userId ?? 0, note });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/operations/incidents/:id/notes" } });
    sendOk(res, { result: { created: true } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/operations/incidents/recompute", requireAuth, requireFounder, requireFounderPermission("founder.ops.recommendation.recompute"), async (req: AuthRequest, res: ResLike) => {
  try {
    const days = (() => {
      const raw = one((req.query as any).days);
      const n = raw ? Number.parseInt(raw, 10) : 7;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 90) : 7;
    })();
    const limit = (() => {
      const raw = one((req.query as any).limit);
      const n = raw ? Number.parseInt(raw, 10) : 200;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 200;
    })();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const data = await withAuthSafeDb(async (authDb) => {
      return await recomputeIncidents(authDb, { since, limit });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/operations/incidents/recompute" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/operations/readiness", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const limit = (() => {
      const raw = one((req.query as any).limit);
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const firmId = (() => {
      const raw = one((req.query as any).firm_id);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const data = await withAuthSafeDb(async (authDb) => {
      return await computeReadiness(authDb, { limit, firmId });
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/readiness" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/operations/pending", requireAuth, requireFounder, requireFounderPermission("founder.ops.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const limit = (() => {
      const raw = one((req.query as any).limit);
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();
    const data = await withAuthSafeDb(async (authDb) => {
      return await computePending(authDb, { limit });
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/operations/pending" } });
    sendOk(res, data);
  } catch (err) {
    sendError(res, err);
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
