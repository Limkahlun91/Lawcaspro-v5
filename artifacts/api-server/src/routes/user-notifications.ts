import express, { type Response, type Router as ExpressRouter } from "express";
import { and, count, eq } from "drizzle-orm";
import { db, userNotificationsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const rdb = (req: AuthRequest) => req.rlsDb ?? db;

router.get("/user-notifications/unread-count", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const [row] = await rdb(req)
    .select({ count: count() })
    .from(userNotificationsTable)
    .where(and(
      eq(userNotificationsTable.firmId, req.firmId!),
      eq(userNotificationsTable.userId, req.userId!),
      eq(userNotificationsTable.isRead, false),
    ));
  res.json({ count: Number(row?.count ?? 0) });
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
