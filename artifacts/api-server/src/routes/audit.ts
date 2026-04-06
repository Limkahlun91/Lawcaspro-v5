import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireFirmUser, requireFounder, requirePermission, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

async function queryRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

router.get("/audit-logs", requireAuth, requireFirmUser, requirePermission("audit", "read"), async (req: AuthRequest, res): Promise<void> => {
  const { action, entityType, actorId, limit = "100", offset = "0" } = req.query as Record<string, string>;

  const rows = await queryRows(sql`
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

  const countRows = await queryRows(sql`
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

  const rows = await queryRows(sql`
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

  const countRows = await queryRows(sql`
    SELECT COUNT(*) as total FROM audit_logs al
    WHERE 1=1
    ${firmId ? sql`AND al.firm_id = ${Number(firmId)}` : sql``}
    ${action ? sql`AND al.action = ${action}` : sql``}
    ${entityType ? sql`AND al.entity_type = ${entityType}` : sql``}
  `);

  res.json({
    data: rows,
    total: Number(countRows[0]?.total ?? 0),
  });
});

export default router;
