import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

async function queryRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

router.get("/communications", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { type, caseId, limit = "50" } = req.query as Record<string, string>;
  const rows = await queryRows(sql`
    SELECT cc.*, c.reference_no, u.name as logged_by_name
    FROM case_communications cc
    JOIN cases c ON cc.case_id = c.id
    LEFT JOIN users u ON cc.logged_by = u.id
    WHERE cc.firm_id = ${req.firmId!}
    ${type ? sql`AND cc.type = ${type}` : sql``}
    ${caseId ? sql`AND cc.case_id = ${Number(caseId)}` : sql``}
    ORDER BY COALESCE(cc.sent_at, cc.created_at) DESC
    LIMIT ${Number(limit)}
  `);
  res.json(rows);
});

router.get("/cases/:caseId/communications", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const rows = await queryRows(sql`
    SELECT cc.*, u.name as logged_by_name
    FROM case_communications cc
    LEFT JOIN users u ON cc.logged_by = u.id
    WHERE cc.case_id = ${caseId} AND cc.firm_id = ${req.firmId!}
    ORDER BY COALESCE(cc.sent_at, cc.created_at) DESC
  `);
  res.json(rows);
});

router.post("/cases/:caseId/communications", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const { type, direction, recipientName, recipientContact, subject, notes, sentAt } = req.body as {
    type: string;
    direction?: string;
    recipientName?: string;
    recipientContact?: string;
    subject?: string;
    notes?: string;
    sentAt?: string;
  };

  if (!type) {
    res.status(400).json({ error: "type is required" });
    return;
  }

  const rows = await queryRows(sql`
    INSERT INTO case_communications (case_id, firm_id, type, direction, recipient_name, recipient_contact, subject, notes, sent_at, logged_by)
    VALUES (
      ${caseId}, ${req.firmId!}, ${type}, ${direction ?? "outgoing"},
      ${recipientName ?? null}, ${recipientContact ?? null},
      ${subject ?? null}, ${notes ?? null},
      ${sentAt ? new Date(sentAt).toISOString() : new Date().toISOString()},
      ${req.userId!}
    )
    RETURNING *
  `);

  res.status(201).json(rows[0]);
});

router.delete("/cases/:caseId/communications/:commId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const commId = Number(req.params.commId);

  const rows = await queryRows(sql`
    DELETE FROM case_communications
    WHERE id = ${commId} AND case_id = ${caseId} AND firm_id = ${req.firmId!}
    RETURNING *
  `);

  if (!rows[0]) {
    res.status(404).json({ error: "Communication record not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
