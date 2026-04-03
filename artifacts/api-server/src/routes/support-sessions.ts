import { Router, type IRouter } from "express";
import { db, supportSessionsTable, firmsTable } from "@workspace/db";
import { eq, desc, isNull } from "drizzle-orm";
import { requireAuth, requireFounder, writeAuditLog, type AuthRequest } from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";

const router: IRouter = Router();

router.get("/support-sessions", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const sessions = await db
    .select()
    .from(supportSessionsTable)
    .orderBy(desc(supportSessionsTable.startedAt))
    .limit(100);
  res.json({ data: sessions });
});

router.get("/support-sessions/active", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const sessions = await db
    .select()
    .from(supportSessionsTable)
    .where(isNull(supportSessionsTable.endedAt))
    .orderBy(desc(supportSessionsTable.startedAt));
  res.json({ data: sessions });
});

router.post("/support-sessions", sensitiveRateLimiter, requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { targetFirmId, reason } = req.body as { targetFirmId: number; reason: string };

  if (!targetFirmId || !reason?.trim()) {
    res.status(400).json({ error: "targetFirmId and reason are required" });
    return;
  }

  const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, targetFirmId));
  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }

  const [session] = await db
    .insert(supportSessionsTable)
    .values({
      founderId: req.userId!,
      targetFirmId,
      reason: reason.trim(),
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      actionLog: [],
    })
    .returning();

  await writeAuditLog({
    actorId: req.userId,
    actorType: "founder",
    action: "support_session.started",
    entityType: "firm",
    entityId: targetFirmId,
    detail: `session_id=${session.id} reason="${reason.trim()}"`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(201).json({ data: session });
});

router.patch("/support-sessions/:id/end", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const sessionId = Number(req.params.id);
  const [session] = await db
    .select()
    .from(supportSessionsTable)
    .where(eq(supportSessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Support session not found" });
    return;
  }

  if (session.founderId !== req.userId) {
    res.status(403).json({ error: "Can only end your own support sessions" });
    return;
  }

  if (session.endedAt) {
    res.status(400).json({ error: "Session already ended" });
    return;
  }

  const [updated] = await db
    .update(supportSessionsTable)
    .set({ endedAt: new Date() })
    .where(eq(supportSessionsTable.id, sessionId))
    .returning();

  await writeAuditLog({
    actorId: req.userId,
    actorType: "founder",
    action: "support_session.ended",
    entityType: "firm",
    entityId: session.targetFirmId,
    detail: `session_id=${sessionId}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({ data: updated });
});

router.post("/support-sessions/:id/log", sensitiveRateLimiter, requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const sessionId = Number(req.params.id);
  const { action, detail } = req.body as { action: string; detail?: string };

  const [session] = await db.select().from(supportSessionsTable).where(eq(supportSessionsTable.id, sessionId));
  if (!session || session.founderId !== req.userId || session.endedAt) {
    res.status(400).json({ error: "Invalid or ended support session" });
    return;
  }

  const logEntry = { action, detail, at: new Date().toISOString() };
  const currentLog = (session.actionLog as object[]) ?? [];
  const newLog = [...currentLog, logEntry];

  await db.update(supportSessionsTable).set({ actionLog: newLog }).where(eq(supportSessionsTable.id, sessionId));

  await writeAuditLog({
    actorId: req.userId,
    firmId: session.targetFirmId,
    actorType: "founder",
    action: `support_session.action.${action}`,
    detail: `session_id=${sessionId} ${detail ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({ success: true });
});

export default router;
