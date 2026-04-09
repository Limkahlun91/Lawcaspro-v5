import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireFirmUser, requireFounder, requirePermission, type AuthRequest } from "../lib/auth";
import { withAuthSafeDb } from "../lib/auth-safe-db";

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
  const { action, entityType, firmId, limit = "100", offset = "0" } = req.query as Record<string, string>;

  const { rows, total } = await withAuthSafeDb(async (authDb) => {
    const rows = await queryRows(authDb, sql`
      SELECT al.*, u.name as actor_name, u.email as actor_email, f.name as firm_name
      FROM audit_logs al
      LEFT JOIN users u ON al.actor_id = u.id
      LEFT JOIN firms f ON al.firm_id = f.id
      WHERE 1=1
      ${firmId ? sql`AND al.firm_id = ${Number(firmId)}` : sql``}
      ${action ? sql`AND al.action = ${action}` : sql``}
      ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
      ORDER BY al.created_at DESC
      LIMIT ${Number(limit)}
      OFFSET ${Number(offset)}
    `);
    const countRows = await queryRows(authDb, sql`
      SELECT COUNT(*) as total FROM audit_logs al
      WHERE 1=1
      ${firmId ? sql`AND al.firm_id = ${Number(firmId)}` : sql``}
      ${action ? sql`AND al.action = ${action}` : sql``}
      ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
    `);
    return { rows, total: Number(countRows[0]?.total ?? 0) };
  });

  res.json({
    data: rows,
    total,
  });
});

export default router;
