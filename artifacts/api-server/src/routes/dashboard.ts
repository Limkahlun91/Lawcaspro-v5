import express, { type Response, type Router as ExpressRouter } from "express";
import { db, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { computeDashboardStats } from "../services/dashboard-stats.js";

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function tableExists(r: DbConn, reg: string): Promise<boolean> {
  const rows = await queryRows(r, sql`SELECT to_regclass(${reg}) AS reg`);
  return Boolean(rows[0]?.reg);
}

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

router.get("/dashboard", requireAuth, requireFirmUser, requirePermission("dashboard", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const r = rdb(req);
    const hasCache = await tableExists(r, "public.firm_dashboard_stats_cache");
    if (hasCache) {
      const cachedRows = await queryRows(r, sql`
        SELECT payload_json
        FROM firm_dashboard_stats_cache
        WHERE firm_id = ${firmId} AND expires_at > now()
        LIMIT 1
      `);
      const cached = cachedRows[0] && typeof cachedRows[0] === "object" ? (cachedRows[0] as any).payload_json : undefined;
      if (cached && typeof cached === "object") {
        res.json(cached);
        return;
      }
    }

    const payload = await computeDashboardStats(r, firmId);

    if (hasCache) {
      const ttlSec = (() => {
        const raw = process.env.DASHBOARD_CACHE_TTL_SEC ? Number.parseInt(process.env.DASHBOARD_CACHE_TTL_SEC, 10) : 300;
        return Number.isFinite(raw) ? Math.min(Math.max(raw, 30), 3600) : 300;
      })();
      await queryRows(r, sql`
        INSERT INTO firm_dashboard_stats_cache (firm_id, payload_json, computed_at, expires_at)
        VALUES (${firmId}, ${payload as any}::jsonb, now(), now() + (${ttlSec}::text || ' seconds')::interval)
        ON CONFLICT (firm_id) DO UPDATE SET
          payload_json = EXCLUDED.payload_json,
          computed_at = EXCLUDED.computed_at,
          expires_at = EXCLUDED.expires_at
      `);
    }

    res.json(payload);
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[dashboard]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
