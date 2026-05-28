import express, { type Response, type Router as ExpressRouter } from "express";
import { db, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { computeDashboardStats } from "../services/dashboard-stats.js";

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function getPgCode(err: unknown): string | null {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : null;
}

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
  const allowDetails =
    process.env.API_ERROR_DETAILS === "1" ||
    process.env.NODE_ENV !== "production" ||
    Boolean((res as any)?.locals?.allowErrorDetails) ||
    (() => {
      const headerToken = one(req.headers["x-debug-token"] as any);
      const expected = process.env.API_DEBUG_TOKEN;
      if (!expected) return false;
      return Boolean(headerToken && headerToken === expected);
    })();

  try {
    const firmId = req.firmId!;
    const r = rdb(req);
    const refresh = (() => {
      const raw = one((req.query as unknown as Record<string, unknown>)?.refresh as string | string[] | undefined);
      if (!raw) return false;
      const v = raw.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    })();
    const assignedToMe = (() => {
      const raw = one((req.query as unknown as Record<string, unknown>)?.assignedToMe as string | string[] | undefined);
      if (!raw) return false;
      const v = raw.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    })();
    const assignedToUserId = (() => {
      const raw = one((req.query as unknown as Record<string, unknown>)?.assignedToUserId as string | string[] | undefined);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    })();
    if (assignedToMe) {
      const payload = await computeDashboardStats(r, firmId, { assignedToUserId: req.userId ?? undefined });
      res.json(payload);
      return;
    }
    if (assignedToUserId) {
      const payload = await computeDashboardStats(r, firmId, { assignedToUserId });
      res.json(payload);
      return;
    }

    const hasCache = await (async () => {
      try {
        return await tableExists(r, "public.firm_dashboard_stats_cache");
      } catch (err) {
        logger.warn({ err, code: getPgCode(err), firmId, userId: req.userId }, "[dashboard] cache_table_exists_failed");
        return false;
      }
    })();

    if (hasCache && !refresh) {
      const cachedRows = await (async () => {
        try {
          return await queryRows(r, sql`
          SELECT payload_json
          FROM firm_dashboard_stats_cache
          WHERE firm_id = ${firmId} AND expires_at > now()
          LIMIT 1
        `);
        } catch (err) {
          logger.warn({ err, code: getPgCode(err), firmId, userId: req.userId }, "[dashboard] cache_read_failed");
          return [];
        }
      })();
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
      try {
        await queryRows(r, sql`
          INSERT INTO firm_dashboard_stats_cache (firm_id, payload_json, computed_at, expires_at)
          VALUES (${firmId}, ${payload as any}::jsonb, now(), now() + (${ttlSec}::text || ' seconds')::interval)
          ON CONFLICT (firm_id) DO UPDATE SET
            payload_json = EXCLUDED.payload_json,
            computed_at = EXCLUDED.computed_at,
            expires_at = EXCLUDED.expires_at
        `);
      } catch (err) {
        logger.warn({ err, code: getPgCode(err), firmId, userId: req.userId }, "[dashboard] cache_write_failed");
      }
    }

    res.json(payload);
  } catch (err) {
    logger.error(
      allowDetails
        ? { err, path: req.path, firmId: req.firmId, userId: req.userId, query: req.query }
        : { err, path: req.path, firmId: req.firmId, userId: req.userId },
      "[dashboard]",
    );
    if (allowDetails) {
      const details = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const code = getPgCode(err);
      res.status(500).json({ error: "Dashboard unavailable", details, code, stack });
      return;
    }
    res.status(500).json({ error: "Dashboard unavailable" });
    return;
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
