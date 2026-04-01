import { Router, type IRouter } from "express";
import { eq, ilike, count, or, desc, and } from "drizzle-orm";
import { db, developersTable, projectsTable } from "@workspace/db";
import {
  CreateDeveloperBody, UpdateDeveloperBody, ListDevelopersQueryParams,
  GetDeveloperParams, UpdateDeveloperParams, DeleteDeveloperParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

async function enrichDeveloper(dev: typeof developersTable.$inferSelect) {
  const [pcRes] = await db.select({ c: count() }).from(projectsTable).where(eq(projectsTable.developerId, dev.id));
  return {
    id: dev.id,
    firmId: dev.firmId,
    name: dev.name,
    companyRegNo: dev.companyRegNo ?? null,
    address: dev.address ?? null,
    contactPerson: dev.contactPerson ?? null,
    phone: dev.phone ?? null,
    email: dev.email ?? null,
    projectCount: Number(pcRes?.c ?? 0),
    createdAt: dev.createdAt.toISOString(),
  };
}

router.get("/developers", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = ListDevelopersQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  let devs;
  let totalRes;

  if (search) {
    devs = await db.select().from(developersTable)
      .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)))
      .orderBy(desc(developersTable.createdAt))
      .limit(limit).offset(offset);
    const [t] = await db.select({ c: count() }).from(developersTable)
      .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)));
    totalRes = t;
  } else {
    devs = await db.select().from(developersTable)
      .where(eq(developersTable.firmId, req.firmId!))
      .orderBy(desc(developersTable.createdAt))
      .limit(limit).offset(offset);
    const [t] = await db.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, req.firmId!));
    totalRes = t;
  }

  const enriched = await Promise.all(devs.map(enrichDeveloper));
  res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
});

router.post("/developers", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateDeveloperBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [dev] = await db
    .insert(developersTable)
    .values({ firmId: req.firmId!, ...parsed.data, createdBy: req.userId })
    .returning();

  res.status(201).json(await enrichDeveloper(dev));
});

router.get("/developers/:developerId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = GetDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [dev] = await db.select().from(developersTable).where(eq(developersTable.id, params.data.developerId));
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  res.json(await enrichDeveloper(dev));
});

router.patch("/developers/:developerId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateDeveloperBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [dev] = await db
    .update(developersTable)
    .set(parsed.data)
    .where(eq(developersTable.id, params.data.developerId))
    .returning();

  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  res.json(await enrichDeveloper(dev));
});

router.delete("/developers/:developerId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [dev] = await db.delete(developersTable).where(eq(developersTable.id, params.data.developerId)).returning();
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
