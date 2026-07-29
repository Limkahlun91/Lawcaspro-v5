import express, { type Router as ExpressRouter, type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db, caseNotificationsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, requireRlsDb, type AuthRequest } from "../lib/auth.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const routerInternal = expressRouter as unknown as RouterInternalLike;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => requireRlsDb(req);

const requireAuthHandler = requireAuth as RequestHandler;
const requireFirmUserHandler = requireFirmUser as RequestHandler;

routerInternal.get(
  "/case-notifications/unread-counts",
  requireAuthHandler,
  requireFirmUserHandler,
  requirePermission("cases", "read") as RequestHandler,
  async (req, res) => {
    const r = rdb(req as any);
    if (!req.firmId || !req.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const result = await r.execute(sql`
      select
        count(*)::int as total_unread,
        sum(case when type = 'OPEN_FILE_PENDING_APPROVAL' then 1 else 0 end)::int as pending_approval_unread,
        sum(case when type = 'CASE_DETAILS_TO_AMEND' then 1 else 0 end)::int as amend_unread,
        sum(case when type in ('CASE_APPROVED', 'REFERENCE_NO_CHANGED') then 1 else 0 end)::int as approved_unread
      from case_notifications
      where
        firm_id = ${req.firmId}
        and recipient_user_id = ${req.userId}
        and is_read = false
    `);

    const rows = Array.isArray(result)
      ? result
      : ("rows" in (result as any) ? (result as any).rows : []);
    const row = rows?.[0] as any;

    res.json({
      totalUnreadCount: Number(row?.total_unread ?? 0),
      pendingApprovalUnreadCount: Number(row?.pending_approval_unread ?? 0),
      amendUnreadCount: Number(row?.amend_unread ?? 0),
      approvedUnreadCount: Number(row?.approved_unread ?? 0),
    });
  }
);

routerInternal.post(
  "/case-notifications/mark-read",
  requireAuthHandler,
  requireFirmUserHandler,
  requirePermission("cases", "read") as RequestHandler,
  async (req, res) => {
    const r = rdb(req as any);
    if (!req.firmId || !req.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const bodySchema = z.object({
      types: z.array(z.string().trim().min(1).max(80)).min(1),
    });
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Validation failed", fields: body.error.flatten().fieldErrors });
      return;
    }

    const now = new Date();
    await r
      .update(caseNotificationsTable)
      .set({ isRead: true, readAt: now })
      .where(and(
        eq(caseNotificationsTable.firmId, req.firmId),
        eq(caseNotificationsTable.recipientUserId, req.userId),
        eq(caseNotificationsTable.isRead, false),
        inArray(caseNotificationsTable.type, body.data.types),
      ));

    res.json({ ok: true });
  }
);

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
