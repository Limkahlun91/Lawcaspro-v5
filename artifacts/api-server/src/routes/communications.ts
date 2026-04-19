import { Router, type IRouter } from "express";
import { db, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

const getRlsDb = (req: AuthRequest, res: any): NonNullable<AuthRequest["rlsDb"]> | null => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return null;
  }
  return r;
};

router.get("/cases/:caseId/threads", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) { res.status(400).json({ error: "Invalid case ID" }); return; }
  const firmId = req.firmId!;
  const rows = await queryRows(r, sql`
    SELECT t.*,
      u.name as created_by_name,
      (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId}) as message_count,
      (SELECT MAX(cc.created_at) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId}) as last_message_at,
      (SELECT cc.notes FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId} ORDER BY cc.created_at DESC LIMIT 1) as last_message,
      CASE WHEN rs.last_read_at IS NULL THEN
        (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId})
      ELSE
        (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId} AND cc.created_at > rs.last_read_at)
      END as unread_count
    FROM communication_threads t
    LEFT JOIN users u ON t.created_by = u.id
    LEFT JOIN communication_read_status rs ON rs.thread_id = t.id AND rs.user_id = ${req.userId!}
    WHERE t.case_id = ${caseId} AND t.firm_id = ${firmId}
    ORDER BY COALESCE((SELECT MAX(cc2.created_at) FROM case_communications cc2 WHERE cc2.thread_id = t.id AND cc2.firm_id = ${firmId}), t.created_at) DESC
  `);
  res.json(rows);
});

router.post("/cases/:caseId/threads", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) { res.status(400).json({ error: "Invalid case ID" }); return; }
  const { subject } = req.body as { subject: string };

  if (!subject?.trim()) {
    res.status(400).json({ error: "Subject is required" });
    return;
  }

  const rows = await queryRows(r, sql`
    INSERT INTO communication_threads (case_id, firm_id, subject, created_by)
    VALUES (${caseId}, ${req.firmId!}, ${subject.trim()}, ${req.userId!})
    RETURNING *
  `);
  const created = rows[0];
  const createdId = created && typeof created === "object" && "id" in created && typeof (created as { id?: unknown }).id === "number"
    ? (created as { id: number }).id
    : undefined;
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "communications.thread.create", entityType: "communication_thread", entityId: createdId, detail: `caseId=${caseId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(rows[0]);
});

router.delete("/cases/:caseId/threads/:threadId", requireAuth, requireFirmUser, requirePermission("communications", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const threadIdStr = one((req.params as any).threadId);
  const threadId = threadIdStr ? parseInt(threadIdStr, 10) : NaN;
  if (Number.isNaN(threadId)) { res.status(400).json({ error: "Invalid thread ID" }); return; }
  const firmId = req.firmId!;

  const check = await queryRows(r, sql`
    SELECT id FROM communication_threads WHERE id = ${threadId} AND firm_id = ${firmId}
  `);
  if (!check[0]) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  await queryRows(r, sql`DELETE FROM case_communications WHERE thread_id = ${threadId} AND firm_id = ${firmId}`);
  await queryRows(r, sql`DELETE FROM communication_read_status WHERE thread_id = ${threadId}`);
  await queryRows(r, sql`DELETE FROM communication_threads WHERE id = ${threadId} AND firm_id = ${firmId}`);

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "communications.thread.delete", entityType: "communication_thread", entityId: threadId, detail: `caseId=${req.params.caseId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

router.get("/cases/:caseId/threads/:threadId/messages", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const threadIdStr = one((req.params as any).threadId);
  const threadId = threadIdStr ? parseInt(threadIdStr, 10) : NaN;
  if (Number.isNaN(threadId)) { res.status(400).json({ error: "Invalid thread ID" }); return; }
  const rows = await queryRows(r, sql`
    SELECT cc.*, u.name as logged_by_name
    FROM case_communications cc
    LEFT JOIN users u ON cc.logged_by = u.id
    WHERE cc.thread_id = ${threadId} AND cc.firm_id = ${req.firmId!}
    ORDER BY cc.created_at ASC
  `);
  res.json(rows);
});

router.post("/cases/:caseId/threads/:threadId/messages", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const threadIdStr = one((req.params as any).threadId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const threadId = threadIdStr ? parseInt(threadIdStr, 10) : NaN;
  if (Number.isNaN(caseId) || Number.isNaN(threadId)) { res.status(400).json({ error: "Invalid IDs" }); return; }
  const { notes } = req.body as { notes: string };

  if (!notes?.trim()) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  const rows = await queryRows(r, sql`
    INSERT INTO case_communications (case_id, firm_id, thread_id, type, direction, notes, logged_by)
    VALUES (${caseId}, ${req.firmId!}, ${threadId}, 'message', 'internal', ${notes.trim()}, ${req.userId!})
    RETURNING *
  `);

  await queryRows(r, sql`
    UPDATE communication_threads SET updated_at = NOW() WHERE id = ${threadId}
  `);

  await queryRows(r, sql`
    INSERT INTO communication_read_status (thread_id, user_id, last_read_at)
    VALUES (${threadId}, ${req.userId!}, NOW())
    ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = NOW()
  `);

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "communications.message.create", entityType: "communication_thread", entityId: threadId, detail: `caseId=${caseId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(rows[0]);
});

router.post("/cases/:caseId/threads/:threadId/read", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const threadIdStr = one((req.params as any).threadId);
  const threadId = threadIdStr ? parseInt(threadIdStr, 10) : NaN;
  if (Number.isNaN(threadId)) { res.status(400).json({ error: "Invalid thread ID" }); return; }

  await queryRows(r, sql`
    INSERT INTO communication_read_status (thread_id, user_id, last_read_at)
    VALUES (${threadId}, ${req.userId!}, NOW())
    ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = NOW()
  `);

  res.json({ success: true });
});

router.get("/communications/unread-count", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;
  const userId = req.userId!;
  const rows = await queryRows(r, sql`
    SELECT COUNT(DISTINCT t.id) as count
    FROM communication_threads t
    WHERE t.firm_id = ${firmId}
    AND (
      NOT EXISTS (
        SELECT 1 FROM communication_read_status rs
        WHERE rs.thread_id = t.id AND rs.user_id = ${userId}
      )
      OR EXISTS (
        SELECT 1 FROM case_communications cc
        WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId}
        AND cc.created_at > (
          SELECT rs2.last_read_at FROM communication_read_status rs2
          WHERE rs2.thread_id = t.id AND rs2.user_id = ${userId}
        )
      )
    )
    AND EXISTS (SELECT 1 FROM case_communications cc2 WHERE cc2.thread_id = t.id AND cc2.firm_id = ${firmId})
  `);
  res.json({ count: Number(rows[0]?.count ?? 0) });
});

router.get("/communications", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;
  const userId = req.userId!;
  const since = one((req.query as any).since);
  const type = one((req.query as any).type);
  const sinceSql = since === "this_month"
    ? sql`AND EXISTS (
        SELECT 1 FROM case_communications cc3
        WHERE cc3.thread_id = t.id
        AND cc3.firm_id = ${firmId}
        AND cc3.created_at >= date_trunc('month', NOW())
      )`
    : sql``;
  const typeSql = type
    ? sql`AND EXISTS (
        SELECT 1 FROM case_communications cc4
        WHERE cc4.thread_id = t.id
        AND cc4.firm_id = ${firmId}
        AND cc4.type = ${type}
      )`
    : sql``;
  const rows = await queryRows(r, sql`
    SELECT t.*,
      u.name as created_by_name,
      c.reference_no,
      (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId}) as message_count,
      (SELECT MAX(cc.created_at) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId}) as last_message_at,
      (SELECT cc.notes FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId} ORDER BY cc.created_at DESC LIMIT 1) as last_message,
      CASE WHEN rs.last_read_at IS NULL THEN
        (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId})
      ELSE
        (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId} AND cc.created_at > rs.last_read_at)
      END as unread_count
    FROM communication_threads t
    LEFT JOIN users u ON t.created_by = u.id
    LEFT JOIN cases c ON t.case_id = c.id
    LEFT JOIN communication_read_status rs ON rs.thread_id = t.id AND rs.user_id = ${userId}
    WHERE t.firm_id = ${firmId}
    ${sinceSql}
    ${typeSql}
    ORDER BY COALESCE((SELECT MAX(cc2.created_at) FROM case_communications cc2 WHERE cc2.thread_id = t.id AND cc2.firm_id = ${firmId}), t.created_at) DESC
    LIMIT 100
  `);
  res.json(rows);
});

router.get("/communications/threads/:threadId", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const threadIdStr = one((req.params as any).threadId);
  const threadId = threadIdStr ? parseInt(threadIdStr, 10) : NaN;
  if (Number.isNaN(threadId)) { res.status(400).json({ error: "Invalid thread ID" }); return; }
  const firmId = req.firmId!;
  const userId = req.userId!;
  const rows = await queryRows(r, sql`
    SELECT t.*,
      u.name as created_by_name,
      c.reference_no,
      (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId}) as message_count,
      (SELECT MAX(cc.created_at) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId}) as last_message_at,
      (SELECT cc.notes FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId} ORDER BY cc.created_at DESC LIMIT 1) as last_message,
      CASE WHEN rs.last_read_at IS NULL THEN
        (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId})
      ELSE
        (SELECT COUNT(*) FROM case_communications cc WHERE cc.thread_id = t.id AND cc.firm_id = ${firmId} AND cc.created_at > rs.last_read_at)
      END as unread_count
    FROM communication_threads t
    LEFT JOIN users u ON t.created_by = u.id
    LEFT JOIN cases c ON t.case_id = c.id
    LEFT JOIN communication_read_status rs ON rs.thread_id = t.id AND rs.user_id = ${userId}
    WHERE t.firm_id = ${firmId} AND t.id = ${threadId}
    LIMIT 1
  `);
  if (!rows[0]) { res.status(404).json({ error: "Thread not found" }); return; }
  res.json(rows[0]);
});

router.get("/communications/threads/:threadId/messages", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const threadIdStr = one((req.params as any).threadId);
  const threadId = threadIdStr ? parseInt(threadIdStr, 10) : NaN;
  if (Number.isNaN(threadId)) { res.status(400).json({ error: "Invalid thread ID" }); return; }
  const firmId = req.firmId!;
  const rows = await queryRows(r, sql`
    SELECT cc.*, u.name as logged_by_name
    FROM case_communications cc
    LEFT JOIN users u ON cc.logged_by = u.id
    WHERE cc.thread_id = ${threadId} AND cc.firm_id = ${firmId}
    ORDER BY cc.created_at ASC
  `);
  res.json(rows);
});

export default router;
