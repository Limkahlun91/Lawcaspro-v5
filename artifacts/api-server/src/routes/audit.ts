import express, { type Router as ExpressRouter } from "express";
import { db, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requireFounder, requirePermission, type AuthRequest } from "../lib/auth.js";
import { withAuthSafeDb } from "../lib/auth-safe-db.js";
import { ApiError, sendError, sendOk, type ResLike } from "../lib/api-response.js";
import { assertFounderPermission, loadFounderGovernanceContext } from "../services/founder-governance/index.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbExec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

async function queryRows(executor: DbExec, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await executor.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

router.get(
  "/audit-logs",
  requireAuth,
  async (req: AuthRequest, res: ResLike, next: unknown): Promise<void> => {
    if (req.userType !== "founder") {
      (next as any)();
      return;
    }
    const one = (v: unknown): string | undefined =>
      typeof v === "string" ? v : Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : undefined;
    const q = req.query as Record<string, unknown>;
    const limit = (() => {
      const raw = one(q.limit);
      const n = raw ? Number.parseInt(raw, 10) : 100;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 150) : 100;
    })();
    const offset = (() => {
      const raw = one(q.offset);
      const n = raw ? Number.parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? Math.max(n, 0) : 0;
    })();
    sendOk(
      res,
      { data: [], total: 0, pagination: { limit, offset }, filters_applied: { action: null, entityType: null, actorId: null } },
      { warnings: [{ code: "FOUNDER_AUDIT_LOGS_NOT_APPLICABLE", message: "Firm audit logs are not available in founder context; returned empty list." }] },
    );
  },
  requireFirmUser,
  requirePermission("audit", "read"),
  async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const one = (v: unknown): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : undefined);

    const q = req.query as Record<string, unknown>;
    const action = one(q.action);
    const entityType = one(q.entityType);
    const actorId = (() => {
      const raw = one(q.actorId);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid actorId", retryable: false });
      return n;
    })();
    const limit = (() => {
      const raw = one(q.limit);
      const n = raw ? Number.parseInt(raw, 10) : 100;
      if (!Number.isFinite(n) || n < 1) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid limit", retryable: false });
      return Math.min(Math.max(n, 1), 150);
    })();
    const offset = (() => {
      const raw = one(q.offset);
      const n = raw ? Number.parseInt(raw, 10) : 0;
      if (!Number.isFinite(n) || n < 0) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid offset", retryable: false });
      return n;
    })();

    const firmId = req.firmId;
    if (!firmId) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Missing firm context", retryable: false });

    const executor = req.rlsDb ?? db;

    const rows = await queryRows(executor, sql`
      SELECT al.*, u.name as actor_name, u.email as actor_email
      FROM audit_logs al
      LEFT JOIN users u ON al.actor_id = u.id
      WHERE al.firm_id = ${firmId}
      ${action ? sql`AND al.action = ${action}` : sql``}
      ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
      ${actorId ? sql`AND al.actor_id = ${actorId}` : sql``}
      ORDER BY al.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    const countRows = await queryRows(executor, sql`
      SELECT COUNT(*) as total
      FROM audit_logs al
      WHERE al.firm_id = ${firmId}
      ${action ? sql`AND al.action = ${action}` : sql``}
      ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
      ${actorId ? sql`AND al.actor_id = ${actorId}` : sql``}
    `);

    sendOk(res, {
      data: rows,
      total: Number(countRows[0]?.total ?? 0),
      pagination: { limit, offset },
      filters_applied: { action: action ?? null, entityType: entityType ?? null, actorId },
    });
  } catch (err: any) {
    const code = typeof err?.code === "string" ? err.code : undefined;
    if (code === "42P01" || code === "42703") {
      sendOk(
        res,
        { data: [], total: 0, pagination: { limit: 100, offset: 0 }, filters_applied: { action: null, entityType: null, actorId: null } },
        { warnings: [{ code: "DB_FEATURE_UNAVAILABLE", message: "Audit logs store is unavailable; returned empty list." }] },
      );
      return;
    }
    if (code === "42501") {
      sendError(res, new ApiError({ status: 503, code: "AUDIT_LOGS_UNAVAILABLE", message: "Audit logs are temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err, { status: 500, code: "AUDIT_LOGS_QUERY_FAILED", message: "Failed to load audit logs" });
  }
  }
);

router.get("/platform/audit-logs", requireAuth, requireFounder, async (req: AuthRequest, res: ResLike): Promise<void> => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const action = q.action ? String(q.action) : undefined;
    const entityType = q.entityType ? String(q.entityType) : undefined;
    const firmIdRaw = q.firmId ? String(q.firmId) : undefined;
    const cursor = q.cursor ? String(q.cursor) : undefined;
    const includeTotal = q.includeTotal === "1";

    const limitRaw = q.limit ? Number.parseInt(String(q.limit), 10) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 150) : 50;

    const firmId = (() => {
      if (!firmIdRaw) return undefined;
      const n = Number.parseInt(firmIdRaw, 10);
      if (!Number.isFinite(n) || n < 1) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid firmId", retryable: false });
      return n;
    })();

    const cursorParsed = (() => {
      if (!cursor) return null;
      try {
        const decoded = Buffer.from(cursor, "base64").toString("utf8");
        const parsed = JSON.parse(decoded) as { createdAt?: string; id?: number };
        if (!parsed?.createdAt || typeof parsed.createdAt !== "string") return null;
        const d = new Date(parsed.createdAt);
        if (!Number.isFinite(d.getTime())) return null;
        const id = typeof parsed.id === "number" && Number.isFinite(parsed.id) ? parsed.id : null;
        if (!id) return null;
        return { createdAt: d.toISOString(), id };
      } catch {
        return null;
      }
    })();

    const result = await withAuthSafeDb(
      async (authDb) => {
        const ctx = await loadFounderGovernanceContext(authDb, req);
        assertFounderPermission(ctx, "founder.audit.read");

        const statementTimeoutMs = 12000;
        await authDb.execute(sql`SET LOCAL statement_timeout = ${statementTimeoutMs}`);

        const rows = await queryRows(authDb, sql`
          SELECT al.*, u.name as actor_name, u.email as actor_email, f.name as firm_name
          FROM audit_logs al
          LEFT JOIN users u ON al.actor_id = u.id
          LEFT JOIN firms f ON al.firm_id = f.id
          WHERE 1=1
          ${firmId ? sql`AND al.firm_id = ${firmId}` : sql``}
          ${action ? sql`AND al.action = ${action}` : sql``}
          ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
          ${cursorParsed ? sql`AND (al.created_at < ${cursorParsed.createdAt} OR (al.created_at = ${cursorParsed.createdAt} AND al.id < ${cursorParsed.id}))` : sql``}
          ORDER BY al.created_at DESC, al.id DESC
          LIMIT ${limit}
        `);

        let total: number | null = null;
        if (includeTotal) {
          const countRows = await queryRows(authDb, sql`
            SELECT COUNT(*) as total FROM audit_logs al
            WHERE 1=1
            ${firmId ? sql`AND al.firm_id = ${firmId}` : sql``}
            ${action ? sql`AND al.action = ${action}` : sql``}
            ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
          `);
          total = Number(countRows[0]?.total ?? 0);
        }

        const last = rows.length ? rows[rows.length - 1] : null;
        const nextCursor = (() => {
          if (!last) return null;
          const createdAt =
            typeof last.created_at === "string"
              ? last.created_at
              : last.created_at instanceof Date
                ? last.created_at.toISOString()
                : null;
          const id = typeof last.id === "number" ? last.id : null;
          if (!createdAt || !id) return null;
          return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64");
        })();

        return {
          items: rows,
          pagination: { limit, has_more: rows.length === limit, next_cursor: nextCursor },
          total,
        };
      },
      { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/audit-logs", firmId: firmId ?? null } }
    );

    sendOk(res, { items: result.items, pagination: result.pagination, ...(result.total !== null ? { total: result.total } : {}) });
  } catch (err: any) {
    if (err instanceof ApiError && err.code === "PERMISSION_DENIED") {
      sendOk(
        res,
        { items: [], pagination: { limit: 50, has_more: false, next_cursor: null } },
        { warnings: [{ code: err.code, message: err.message }] },
      );
      return;
    }
    const code = typeof err?.code === "string" ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err ?? "");
    const lowered = message.toLowerCase();
    if (code === "42P01" || code === "42703" || code === "42501") {
      sendOk(
        res,
        { items: [], pagination: { limit: 50, has_more: false, next_cursor: null } },
        { warnings: [{ code: "DB_FEATURE_UNAVAILABLE", message: "Audit logs store is unavailable; returned empty list." }] },
      );
      return;
    }
    if (code === "57014" || lowered.includes("statement timeout")) {
      sendError(res, new ApiError({
        status: 504,
        code: "QUERY_TIMEOUT",
        message: "Audit logs query timed out. Try narrowing by firm or reducing limit.",
        retryable: true,
        stage: "query_audit_logs",
        suggestion: "Filter by firm and retry, or reduce limit.",
      }));
      return;
    }
    sendError(res, err, { status: 500, code: "AUDIT_LOGS_QUERY_FAILED", message: "Failed to load audit logs" });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
