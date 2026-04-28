import express, { type Router as ExpressRouter } from "express";
import { db, supportSessionsTable, firmsTable, usersTable } from "@workspace/db";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { requireAuth, requireFirmUser, requireFounder, requirePartner, requireReAuth, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { sensitiveRateLimiter } from "../lib/rate-limit.js";
import { isTransientDbConnectionError, withAuthSafeDb } from "../lib/auth-safe-db.js";
import { ApiError, parseIntParam, sendError, sendOk, type ResLike } from "../lib/api-response.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const isUndefinedTableError = (err: unknown): boolean => {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return code === "42P01";
};

const isUndefinedColumnError = (err: unknown): boolean => {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return code === "42703";
};

const isPermissionDeniedError = (err: unknown): boolean => {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return code === "42501" || (err instanceof Error && /permission denied/i.test(err.message));
};

router.get("/support-sessions", requireAuth, requireFounder, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const firmIdFilter = (() => {
      const raw = typeof req.query.firmId === "string" ? req.query.firmId : Array.isArray(req.query.firmId) ? req.query.firmId[0] : undefined;
      if (!raw) return null;
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const sessions = await withAuthSafeDb(async (authDb) => {
      const base = authDb.select({
          id: supportSessionsTable.id,
          founderId: supportSessionsTable.founderId,
          targetFirmId: supportSessionsTable.targetFirmId,
          status: supportSessionsTable.status,
          reason: supportSessionsTable.reason,
          startedAt: supportSessionsTable.startedAt,
          endedAt: supportSessionsTable.endedAt,
          approvedByUserId: supportSessionsTable.approvedByUserId,
          approvedAt: supportSessionsTable.approvedAt,
          rejectedByUserId: supportSessionsTable.rejectedByUserId,
          rejectedAt: supportSessionsTable.rejectedAt,
          decisionNote: supportSessionsTable.decisionNote,
          expiresAt: supportSessionsTable.expiresAt,
          ipAddress: supportSessionsTable.ipAddress,
          userAgent: supportSessionsTable.userAgent,
          actionLog: supportSessionsTable.actionLog,
          firmName: firmsTable.name,
          founderEmail: usersTable.email,
        }).from(supportSessionsTable)
        .leftJoin(firmsTable, eq(supportSessionsTable.targetFirmId, firmsTable.id))
        .leftJoin(usersTable, eq(supportSessionsTable.founderId, usersTable.id));

      const q = firmIdFilter ? base.where(eq(supportSessionsTable.targetFirmId, firmIdFilter)) : base;
      return await q.orderBy(desc(supportSessionsTable.startedAt)).limit(100);
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /support-sessions", userId: req.userId ?? null, firmId: firmIdFilter } });
    sendOk(res, { items: sessions });
  } catch (err) {
    if (isUndefinedTableError(err) || isUndefinedColumnError(err)) {
      sendOk(res, { items: [] });
      return;
    }
    if (isPermissionDeniedError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SUPPORT_SESSIONS_UNAVAILABLE", message: "Support sessions are temporarily unavailable", retryable: true }));
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err, { status: 503, code: "SUPPORT_SESSIONS_QUERY_FAILED", message: "Support sessions are temporarily unavailable" });
  }
});

router.get("/support-sessions/active", requireAuth, requireFounder, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const now = new Date();
    const sessions = await withAuthSafeDb(async (authDb) => {
      return await authDb
        .select()
        .from(supportSessionsTable)
        .where(and(
          eq(supportSessionsTable.status, "approved"),
          isNull(supportSessionsTable.endedAt),
          or(isNull(supportSessionsTable.expiresAt), gt(supportSessionsTable.expiresAt, now)),
        ))
        .orderBy(desc(supportSessionsTable.startedAt));
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /support-sessions/active" } });
    sendOk(res, { items: sessions });
  } catch (err) {
    if (isUndefinedTableError(err) || isUndefinedColumnError(err)) {
      sendOk(res, { items: [] });
      return;
    }
    if (isPermissionDeniedError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SUPPORT_SESSIONS_UNAVAILABLE", message: "Support sessions are temporarily unavailable", retryable: true }));
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err, { status: 503, code: "SUPPORT_SESSIONS_QUERY_FAILED", message: "Support sessions are temporarily unavailable" });
  }
});

router.post("/support-sessions", sensitiveRateLimiter, requireAuth, requireFounder, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const targetFirmId = parseIntParam("targetFirmId", (req.body as any)?.targetFirmId, { required: true, min: 1 })!;
    const reason = String((req.body as any)?.reason ?? "").trim();
    if (reason.length < 10) {
      throw new ApiError({ status: 422, code: "INVALID_INPUT", message: "Reason must be at least 10 characters", retryable: false });
    }

    const created = await withAuthSafeDb(async (authDb) => {
      const [firm] = await authDb.select({ id: firmsTable.id, name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, targetFirmId)).limit(1);
      if (!firm) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Firm not found", retryable: false });

      const [session] = await authDb
        .insert(supportSessionsTable)
        .values({
          founderId: req.userId!,
          targetFirmId,
          reason,
          status: "requested",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          ipAddress: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          actionLog: [],
        })
        .returning();

      await writeAuditLog(
        {
          actorId: req.userId,
          actorType: "founder",
          action: "support_session.requested",
          entityType: "firm",
          entityId: targetFirmId,
          detail: `session_id=${session.id}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: false }
      );

      return session;
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /support-sessions", userId: req.userId ?? null, firmId: targetFirmId } });

    sendOk(res, { item: created }, { status: 201 });
  } catch (err) {
    sendError(res, err);
  }
});

router.patch("/support-sessions/:id/end", requireAuth, requireFounder, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const sessionId = parseIntParam("id", req.params.id, { required: true, min: 1 })!;
    const updated = await withAuthSafeDb(async (authDb) => {
      const [session] = await authDb.select().from(supportSessionsTable).where(eq(supportSessionsTable.id, sessionId)).limit(1);
      if (!session) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Support session not found", retryable: false });
      if (session.founderId !== req.userId) throw new ApiError({ status: 403, code: "FORBIDDEN", message: "Can only end your own support sessions", retryable: false });
      if (session.endedAt) throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Session already ended", retryable: false });

      const [row] = await authDb
        .update(supportSessionsTable)
        .set({ endedAt: new Date(), status: "ended" })
        .where(eq(supportSessionsTable.id, sessionId))
        .returning();

      await writeAuditLog(
        {
          actorId: req.userId,
          actorType: "founder",
          action: "support_session.ended",
          entityType: "firm",
          entityId: session.targetFirmId,
          detail: `session_id=${sessionId}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: false }
      );

      return row;
    }, { retry: true, allowUnsafe: true, ctx: { route: "PATCH /support-sessions/:id/end", userId: req.userId ?? null } });
    sendOk(res, { item: updated });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/support-sessions/:id/log", sensitiveRateLimiter, requireAuth, requireFounder, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const sessionId = parseIntParam("id", req.params.id, { required: true, min: 1 })!;
    const action = String((req.body as any)?.action ?? "").trim();
    const detail = (req.body as any)?.detail ? String((req.body as any).detail) : null;
    if (!action) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "action is required", retryable: false });

    await withAuthSafeDb(async (authDb) => {
      const [session] = await authDb.select().from(supportSessionsTable).where(eq(supportSessionsTable.id, sessionId)).limit(1);
      const now = new Date();
      const expired = session?.expiresAt ? session.expiresAt < now : false;
      const active = !!session && session.status === "approved" && !session.endedAt && !expired;
      if (!active || session!.founderId !== req.userId) {
        throw new ApiError({ status: 400, code: "INVALID_SUPPORT_SESSION", message: "Invalid or inactive support session", retryable: false });
      }

      const logEntry = { action, detail, at: new Date().toISOString() };
      const currentLog = (session!.actionLog as object[]) ?? [];
      const newLog = [...currentLog, logEntry];

      await authDb.update(supportSessionsTable).set({ actionLog: newLog }).where(eq(supportSessionsTable.id, sessionId));

      await writeAuditLog(
        {
          actorId: req.userId,
          firmId: session!.targetFirmId,
          actorType: "founder",
          action: `support_session.action.${action}`,
          detail: `session_id=${sessionId} ${detail ?? ""}`.trim(),
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: false }
      );
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /support-sessions/:id/log", userId: req.userId ?? null } });

    sendOk(res, { result: { logged: true } });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/support-sessions/requests", requireAuth, requireFirmUser, requirePartner, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const now = new Date();
    const executor = req.rlsDb;
    if (!executor) throw new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true });
    const rows: unknown = await executor.execute(sql`
      SELECT ss.*, u.email as founder_email
      FROM support_sessions ss
      LEFT JOIN users u ON ss.founder_id = u.id
      WHERE ss.target_firm_id = ${req.firmId!}
        AND ss.status = 'requested'
        AND ss.ended_at IS NULL
        AND (ss.expires_at IS NULL OR ss.expires_at > ${now.toISOString()}::timestamptz)
      ORDER BY ss.started_at DESC
      LIMIT 100
    `);
    const items = Array.isArray(rows) ? (rows as any) : (rows as any)?.rows ?? [];
    sendOk(res, { items });
  } catch (err) {
    if (isUndefinedTableError(err)) {
      sendOk(res, { items: [] });
      return;
    }
    if (isPermissionDeniedError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SUPPORT_SESSIONS_UNAVAILABLE", message: "Support sessions are temporarily unavailable", retryable: true }));
      return;
    }
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err);
  }
});

router.post("/support-sessions/:id/approve", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePartner, requireReAuth, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const sessionId = parseIntParam("id", req.params.id, { required: true, min: 1 })!;
    const note = String((req.body as any)?.note ?? "").trim();
    const now = new Date();

    const r = req.rlsDb as any;
    if (!r) throw new ApiError({ status: 500, code: "RLS_CONTEXT", message: "Missing tenant database context", retryable: true });
    const updated = await r.transaction(async (tx: any) => {
      const [session] = await tx.select().from(supportSessionsTable).where(eq(supportSessionsTable.id, sessionId)).limit(1);
      if (!session) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Support session not found", retryable: false });
      if (session.targetFirmId !== req.firmId) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Support session not found", retryable: false });
      if (session.status !== "requested" || session.endedAt) throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Support session is not pending", retryable: false });
      if (session.expiresAt && session.expiresAt < now) throw new ApiError({ status: 409, code: "REQUEST_EXPIRED", message: "Support session request expired", retryable: false });

      const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const [row] = await tx
        .update(supportSessionsTable)
        .set({ status: "approved", approvedByUserId: req.userId!, approvedAt: now, decisionNote: note || null, expiresAt })
        .where(eq(supportSessionsTable.id, sessionId))
        .returning();

      await writeAuditLog(
        {
          firmId: req.firmId!,
          actorId: req.userId,
          actorType: req.userType,
          action: "support_session.approved",
          entityType: "support_session",
          entityId: sessionId,
          detail: `founder_id=${session.founderId} expires_at=${expiresAt.toISOString()}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: tx, strict: false }
      );

      return row;
    });

    sendOk(res, { item: updated });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/support-sessions/:id/reject", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePartner, requireReAuth, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const sessionId = parseIntParam("id", req.params.id, { required: true, min: 1 })!;
    const note = String((req.body as any)?.note ?? "").trim();
    const now = new Date();

    const r = req.rlsDb as any;
    if (!r) throw new ApiError({ status: 500, code: "RLS_CONTEXT", message: "Missing tenant database context", retryable: true });
    const updated = await r.transaction(async (tx: any) => {
      const [session] = await tx.select().from(supportSessionsTable).where(eq(supportSessionsTable.id, sessionId)).limit(1);
      if (!session) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Support session not found", retryable: false });
      if (session.targetFirmId !== req.firmId) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Support session not found", retryable: false });
      if (session.status !== "requested" || session.endedAt) throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "Support session is not pending", retryable: false });
      if (session.expiresAt && session.expiresAt < now) throw new ApiError({ status: 409, code: "REQUEST_EXPIRED", message: "Support session request expired", retryable: false });

      const [row] = await tx
        .update(supportSessionsTable)
        .set({ status: "rejected", rejectedByUserId: req.userId!, rejectedAt: now, decisionNote: note || null, endedAt: now })
        .where(eq(supportSessionsTable.id, sessionId))
        .returning();

      await writeAuditLog(
        {
          firmId: req.firmId!,
          actorId: req.userId,
          actorType: req.userType,
          action: "support_session.rejected",
          entityType: "support_session",
          entityId: sessionId,
          detail: `founder_id=${session.founderId}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: tx, strict: false }
      );

      return row;
    });

    sendOk(res, { item: updated });
  } catch (err) {
    sendError(res, err);
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
