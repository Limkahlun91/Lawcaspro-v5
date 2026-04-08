import { Router, type IRouter } from "express";
import { eq, and, desc, sql, lte } from "drizzle-orm";
import { db, caseTasksTable, casesTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

router.get("/case-tasks", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const status = one((req.query as any).status);
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  let cond = eq(caseTasksTable.firmId, req.firmId!);
  if (caseId) {
    const cid = parseInt(caseId, 10);
    if (Number.isNaN(cid)) { res.status(400).json({ error: "Invalid case ID" }); return; }
    cond = and(cond, eq(caseTasksTable.caseId, cid)) as any;
  }
  if (status) cond = and(cond, eq(caseTasksTable.status, status)) as any;
  const rows = await r.select().from(caseTasksTable).where(cond).orderBy(caseTasksTable.dueDate, caseTasksTable.createdAt);
  res.json(rows);
});

// Firm-wide upcoming tasks (for dashboard)
router.get("/case-tasks/upcoming", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const limitStr = one((req.query as any).limit);
  const limit = limitStr ? parseInt(limitStr, 10) : 20;
  if (Number.isNaN(limit) || limit < 1) { res.status(400).json({ error: "Invalid limit" }); return; }
  const capped = Math.min(limit, 100);
  const rows = await r.select().from(caseTasksTable)
    .where(and(eq(caseTasksTable.firmId, req.firmId!), eq(caseTasksTable.status, "open")))
    .orderBy(caseTasksTable.dueDate)
    .limit(capped);
  res.json(rows);
});

router.post("/case-tasks", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const { caseId, title, description, assignedTo, dueDate, priority } = req.body;
  if (!caseId || !title) { res.status(400).json({ error: "caseId and title required" }); return; }
  const cid = parseInt(String(caseId), 10);
  if (Number.isNaN(cid)) { res.status(400).json({ error: "Invalid caseId" }); return; }
  const [caseRow] = await r.select({ id: casesTable.id }).from(casesTable).where(and(eq(casesTable.id, cid), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) { res.status(404).json({ error: "Case not found" }); return; }
  const assigned = assignedTo !== undefined && assignedTo !== null && String(assignedTo).trim()
    ? parseInt(String(assignedTo), 10)
    : null;
  if (assigned !== null && Number.isNaN(assigned)) { res.status(400).json({ error: "Invalid assignedTo" }); return; }
  const [row] = await r.insert(caseTasksTable).values({
    firmId: req.firmId!, caseId: cid, title,
    description: description || null,
    assignedTo: assigned,
    dueDate: dueDate || null,
    priority: priority || "normal",
    status: "open",
    createdBy: req.userId!,
  }).returning();
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "cases.task.create", entityType: "case_task", entityId: row.id, detail: `caseId=${cid} title=${title}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(row);
});

router.put("/case-tasks/:id", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  if (!idStr) { res.status(400).json({ error: "id required" }); return; }
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task ID" }); return; }
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const { title, description, assignedTo, dueDate, priority, status } = req.body;
  const updates: Record<string, any> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (assignedTo !== undefined) {
    const assigned = assignedTo !== null && String(assignedTo).trim() ? parseInt(String(assignedTo), 10) : null;
    if (assigned !== null && Number.isNaN(assigned)) { res.status(400).json({ error: "Invalid assignedTo" }); return; }
    updates.assignedTo = assigned;
  }
  if (dueDate !== undefined) updates.dueDate = dueDate || null;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) {
    updates.status = status;
    if (status === "done") { updates.completedAt = new Date(); updates.completedBy = req.userId!; }
    else { updates.completedAt = null; updates.completedBy = null; }
  }
  const [row] = await r.update(caseTasksTable).set(updates)
    .where(and(eq(caseTasksTable.id, id), eq(caseTasksTable.firmId, req.firmId!))).returning();
  if (!row) { res.status(404).json({ error: "Task not found" }); return; }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "cases.task.update", entityType: "case_task", entityId: id, detail: `fields=${Object.keys(updates).filter((k) => k !== "updatedAt").join(",")}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(row);
});

router.delete("/case-tasks/:id", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  if (!idStr) { res.status(400).json({ error: "id required" }); return; }
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task ID" }); return; }
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const [deleted] = await r.delete(caseTasksTable).where(and(eq(caseTasksTable.id, id), eq(caseTasksTable.firmId, req.firmId!))).returning();
  if (!deleted) { res.status(404).json({ error: "Task not found" }); return; }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "cases.task.delete", entityType: "case_task", entityId: id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ success: true });
});

export default router;
