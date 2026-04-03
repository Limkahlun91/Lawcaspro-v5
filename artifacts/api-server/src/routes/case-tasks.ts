import { Router, type IRouter } from "express";
import { eq, and, desc, sql, lte } from "drizzle-orm";
import { db, caseTasksTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

router.get("/case-tasks", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const status = one((req.query as any).status);
  let cond = eq(caseTasksTable.firmId, req.firmId!);
  if (caseId) cond = and(cond, eq(caseTasksTable.caseId, parseInt(caseId))) as any;
  if (status) cond = and(cond, eq(caseTasksTable.status, status)) as any;
  const rows = await db.select().from(caseTasksTable).where(cond).orderBy(caseTasksTable.dueDate, caseTasksTable.createdAt);
  res.json(rows);
});

// Firm-wide upcoming tasks (for dashboard)
router.get("/case-tasks/upcoming", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const limit = parseInt(one(req.query.limit as any) ?? "20");
  const rows = await db.select().from(caseTasksTable)
    .where(and(eq(caseTasksTable.firmId, req.firmId!), eq(caseTasksTable.status, "open")))
    .orderBy(caseTasksTable.dueDate)
    .limit(limit);
  res.json(rows);
});

router.post("/case-tasks", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { caseId, title, description, assignedTo, dueDate, priority } = req.body;
  if (!caseId || !title) { res.status(400).json({ error: "caseId and title required" }); return; }
  const [row] = await db.insert(caseTasksTable).values({
    firmId: req.firmId!, caseId: parseInt(caseId), title,
    description: description || null,
    assignedTo: assignedTo ? parseInt(assignedTo) : null,
    dueDate: dueDate || null,
    priority: priority || "normal",
    status: "open",
    createdBy: req.userId!,
  }).returning();
  res.status(201).json(row);
});

router.put("/case-tasks/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  if (!idStr) { res.status(400).json({ error: "id required" }); return; }
  const id = parseInt(idStr);
  const { title, description, assignedTo, dueDate, priority, status } = req.body;
  const updates: Record<string, any> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (assignedTo !== undefined) updates.assignedTo = assignedTo ? parseInt(assignedTo) : null;
  if (dueDate !== undefined) updates.dueDate = dueDate || null;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) {
    updates.status = status;
    if (status === "done") { updates.completedAt = new Date(); updates.completedBy = req.userId!; }
    else { updates.completedAt = null; updates.completedBy = null; }
  }
  const [row] = await db.update(caseTasksTable).set(updates)
    .where(and(eq(caseTasksTable.id, id), eq(caseTasksTable.firmId, req.firmId!))).returning();
  if (!row) { res.status(404).json({ error: "Task not found" }); return; }
  res.json(row);
});

router.delete("/case-tasks/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  if (!idStr) { res.status(400).json({ error: "id required" }); return; }
  const id = parseInt(idStr);
  await db.delete(caseTasksTable).where(and(eq(caseTasksTable.id, id), eq(caseTasksTable.firmId, req.firmId!)));
  res.json({ success: true });
});

export default router;
