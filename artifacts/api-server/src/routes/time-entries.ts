import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, sql, timeEntriesTable, usersTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

router.get("/time-entries", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const conds = [eq(timeEntriesTable.firmId, req.firmId!)];
  if (caseId) conds.push(eq(timeEntriesTable.caseId, parseInt(caseId, 10)));
  const rows = await db.select().from(timeEntriesTable).where(and(...conds)).orderBy(desc(timeEntriesTable.entryDate));
  res.json(rows);
});

router.get("/time-entries/summary", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const conds = [eq(timeEntriesTable.firmId, req.firmId!)];
  if (caseId) conds.push(eq(timeEntriesTable.caseId, parseInt(caseId, 10)));
  const cond = and(...conds);
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

  const caseIdNum = Number(caseId);
  if (!Number.isFinite(caseIdNum) || caseIdNum <= 0) { res.status(400).json({ error: "Invalid caseId" }); return; }

  const entryDateStr = typeof entryDate === "string" ? entryDate : String(entryDate);
  const descriptionStr = typeof description === "string" ? description : String(description);
  const hoursNum = Number(hours);
  if (!Number.isFinite(hoursNum)) { res.status(400).json({ error: "Invalid hours" }); return; }
  const rateNum = ratePerHour === undefined || ratePerHour === null ? 0 : Number(ratePerHour);
  if (!Number.isFinite(rateNum)) { res.status(400).json({ error: "Invalid ratePerHour" }); return; }
  const isBillableBool = typeof isBillable === "boolean" ? isBillable : true;

  const insert = {
    firmId: req.firmId!,
    caseId: caseIdNum,
    userId: req.userId!,
    entryDate: entryDateStr,
    description: descriptionStr,
    hours: hoursNum.toFixed(2),
    ratePerHour: rateNum.toFixed(2),
    isBillable: isBillableBool,
    createdBy: req.userId!,
  } satisfies typeof timeEntriesTable.$inferInsert;

  const [row] = await db.insert(timeEntriesTable).values(insert).returning();
  res.status(201).json(row);
});

router.put("/time-entries/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid time entry ID" }); return; }
  const { description, hours, ratePerHour, isBillable, entryDate } = req.body;

  const patch: Partial<typeof timeEntriesTable.$inferInsert> = { updatedAt: new Date() };
  if (description !== undefined) patch.description = typeof description === "string" ? description : String(description);
  if (hours !== undefined) {
    const hoursNum = Number(hours);
    if (!Number.isFinite(hoursNum)) { res.status(400).json({ error: "Invalid hours" }); return; }
    patch.hours = hoursNum.toFixed(2);
  }
  if (ratePerHour !== undefined) {
    const rateNum = Number(ratePerHour);
    if (!Number.isFinite(rateNum)) { res.status(400).json({ error: "Invalid ratePerHour" }); return; }
    patch.ratePerHour = rateNum.toFixed(2);
  }
  if (isBillable !== undefined) {
    if (typeof isBillable !== "boolean") { res.status(400).json({ error: "Invalid isBillable" }); return; }
    patch.isBillable = isBillable;
  }
  if (entryDate !== undefined) patch.entryDate = typeof entryDate === "string" ? entryDate : String(entryDate);

  const [row] = await db.update(timeEntriesTable).set(patch).where(and(eq(timeEntriesTable.id, id), eq(timeEntriesTable.firmId, req.firmId!))).returning();
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
