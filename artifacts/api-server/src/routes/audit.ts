import { Router, type IRouter } from "express";
import { db, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requireFounder, requirePermission, type AuthRequest } from "../lib/auth";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import { ApiError, sendError, sendOk } from "../lib/api-response";
import { assertFounderPermission, loadFounderGovernanceContext } from "../services/founder-governance";

const router: IRouter = Router();

type DbExec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

async function queryRows(executor: DbExec, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await executor.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

router.get("/audit-logs", requireAuth, requireFirmUser, requirePermission("audit", "read"), async (req: AuthRequest, res): Promise<void> => {
  const { action, entityType, actorId, limit = "100", offset = "0" } = req.query as Record<string, string>;
  const executor = req.rlsDb ?? db;

  const rows = await queryRows(executor, sql`
    SELECT al.*, u.name as actor_name, u.email as actor_email
    FROM audit_logs al
    LEFT JOIN users u ON al.actor_id = u.id
    WHERE al.firm_id = ${req.firmId!}
    ${action ? sql`AND al.action = ${action}` : sql``}
    ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
    ${actorId ? sql`AND al.actor_id = ${Number(actorId)}` : sql``}
    ORDER BY al.created_at DESC
    LIMIT ${Number(limit)}
    OFFSET ${Number(offset)}
  `);

  const countRows = await queryRows(executor, sql`
    SELECT COUNT(*) as total
    FROM audit_logs al
    WHERE al.firm_id = ${req.firmId!}
    ${action ? sql`AND al.action = ${action}` : sql``}
    ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
    ${actorId ? sql`AND al.actor_id = ${Number(actorId)}` : sql``}
  `);

  res.json({
    data: rows,
    total: Number(countRows[0]?.total ?? 0),
  });
});

router.get("/platform/audit-logs", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
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
          const createdAt = typeof last.created_at === "string" ? last.created_at : null;
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
    const code = typeof err?.code === "string" ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err ?? "");
    const lowered = message.toLowerCase();
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

export default router;
