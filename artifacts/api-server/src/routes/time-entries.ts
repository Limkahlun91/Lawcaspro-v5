import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, sql, timeEntriesTable, usersTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

router.get("/time-entries", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  let cond = eq(timeEntriesTable.firmId, req.firmId!);
  if (caseId) cond = and(cond, eq(timeEntriesTable.caseId, parseInt(caseId))) as any;
  const rows = await db.select().from(timeEntriesTable).where(cond).orderBy(desc(timeEntriesTable.entryDate));
  res.json(rows);
});

router.get("/time-entries/summary", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  let cond = eq(timeEntriesTable.firmId, req.firmId!);
  if (caseId) cond = and(cond, eq(timeEntriesTable.caseId, parseInt(caseId))) as any;
  const [row] = await db.select({
    totalHours: sql<string>`COALESCE(SUM(hours), 0)`,
    totalAmount: sql<string>`COALESCE(SUM(hours * rate_per_hour), 0)`,
    billableHours: sql<string>`COALESCE(SUM(CASE WHEN is_billable THEN hours ELSE 0 END), 0)`,
    unbilledAmount: sql<string>`COALESCE(SUM(CASE WHEN is_billable AND NOT is_billed THEN hours * rate_per_hour ELSE 0 END), 0)`,
  }).from(timeEntriesTable).where(cond);
  res.json(row);
});

router.post("/time-entries", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { caseId, entryDate, description, hours, ratePerHour, isBillable } = req.body;
  if (!caseId || !entryDate || !description || hours === undefined) {
    res.status(400).json({ error: "caseId, entryDate, description, hours required" }); return;
  }
  const [row] = await db.insert(timeEntriesTable).values({
    firmId: req.firmId!, caseId: parseInt(caseId), userId: req.userId!,
    entryDate: entryDate as any, description,
    hours: String(Number(hours)) as any,
    ratePerHour: String(Number(ratePerHour ?? 0)) as any,
    isBillable: isBillable !== false,
    createdBy: req.userId!,
  }).returning();
  res.status(201).json(row);
});

router.put("/time-entries/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid time entry ID" }); return; }
  const { description, hours, ratePerHour, isBillable, entryDate } = req.body;
  const [row] = await db.update(timeEntriesTable).set({
    ...(description !== undefined && { description }),
    ...(hours !== undefined && { hours: String(Number(hours)) as any }),
    ...(ratePerHour !== undefined && { ratePerHour: String(Number(ratePerHour)) as any }),
    ...(isBillable !== undefined && { isBillable }),
    ...(entryDate !== undefined && { entryDate: entryDate as any }),
    updatedAt: new Date(),
  }).where(and(eq(timeEntriesTable.id, id), eq(timeEntriesTable.firmId, req.firmId!))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/time-entries/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid time entry ID" }); return; }
  await db.delete(timeEntriesTable).where(and(eq(timeEntriesTable.id, id), eq(timeEntriesTable.firmId, req.firmId!)));
  res.json({ success: true });
});

export default router;
