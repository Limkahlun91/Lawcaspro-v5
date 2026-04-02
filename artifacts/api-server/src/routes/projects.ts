import { Router, type IRouter } from "express";
import { eq, ilike, count, desc, and } from "drizzle-orm";
import { db, projectsTable, developersTable, casesTable } from "@workspace/db";
import {
  CreateProjectBody, UpdateProjectBody, ListProjectsQueryParams,
  GetProjectParams, UpdateProjectParams, DeleteProjectParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

async function enrichProject(proj: typeof projectsTable.$inferSelect) {
  const [devRow] = await db.select().from(developersTable).where(eq(developersTable.id, proj.developerId));
  const [ccRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.projectId, proj.id));
  return {
    id: proj.id,
    firmId: proj.firmId,
    developerId: proj.developerId,
    developerName: proj.developerName || devRow?.name || "Unknown",
    name: proj.name,
    phase: proj.phase ?? null,
    projectType: proj.projectType,
    titleType: proj.titleType,
    titleSubtype: proj.titleSubtype ?? null,
    masterTitleNumber: proj.masterTitleNumber ?? null,
    masterTitleLandSize: proj.masterTitleLandSize ?? null,
    mukim: proj.mukim ?? null,
    daerah: proj.daerah ?? null,
    negeri: proj.negeri ?? null,
    landUse: proj.landUse ?? null,
    developmentCondition: proj.developmentCondition ?? null,
    unitCategory: proj.unitCategory ?? null,
    extraFields: (proj.extraFields as Record<string, unknown>) ?? {},
    caseCount: Number(ccRes?.c ?? 0),
    createdAt: proj.createdAt.toISOString(),
  };
}

router.get("/projects", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = ListProjectsQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const developerId = params.success ? params.data.developerId : undefined;
  const projectType = params.success ? params.data.projectType : undefined;
  const titleType = params.success ? params.data.titleType : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  const conditions = [eq(projectsTable.firmId, req.firmId!)];
  if (developerId) conditions.push(eq(projectsTable.developerId, developerId));
  if (projectType) conditions.push(eq(projectsTable.projectType, projectType));
  if (titleType) conditions.push(eq(projectsTable.titleType, titleType));

  const projs = await db.select().from(projectsTable)
    .where(and(...conditions))
    .orderBy(desc(projectsTable.createdAt))
    .limit(limit).offset(offset);

  const [totalRes] = await db.select({ c: count() }).from(projectsTable).where(and(...conditions));

  const enriched = await Promise.all(projs.map(enrichProject));
  res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
});

router.post("/projects", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { developerId, name, projectType, titleType, landUse, developmentCondition, unitCategory, extraFields } = parsed.data;
  const { phase, developerName, titleSubtype, masterTitleNumber, masterTitleLandSize, mukim, daerah, negeri } = req.body;

  const [dev] = await db.select().from(developersTable).where(eq(developersTable.id, developerId));
  if (!dev || dev.firmId !== req.firmId) {
    res.status(400).json({ error: "Developer not found in this firm" });
    return;
  }

  const [proj] = await db
    .insert(projectsTable)
    .values({
      firmId: req.firmId!,
      developerId,
      name,
      phase: phase || null,
      developerName: developerName || dev.name,
      projectType,
      titleType,
      titleSubtype: titleSubtype || null,
      masterTitleNumber: masterTitleNumber || null,
      masterTitleLandSize: masterTitleLandSize || null,
      mukim: mukim || null,
      daerah: daerah || null,
      negeri: negeri || null,
      landUse,
      developmentCondition,
      unitCategory,
      extraFields: extraFields as Record<string, unknown> ?? {},
      createdBy: req.userId,
    })
    .returning();

  res.status(201).json(await enrichProject(proj));
});

router.get("/projects/:projectId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, params.data.projectId));
  if (!proj || proj.firmId !== req.firmId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(await enrichProject(proj));
});

router.patch("/projects/:projectId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(projectsTable).where(
    and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.firmId, req.firmId!))
  );
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { name, developerId, projectType, titleType, titleSubtype, masterTitleNumber, masterTitleLandSize,
    mukim, daerah, negeri, phase, developerName, landUse, developmentCondition, unitCategory, extraFields } = req.body;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (developerId !== undefined) updateData.developerId = developerId;
  if (projectType !== undefined) updateData.projectType = projectType;
  if (titleType !== undefined) updateData.titleType = titleType;
  if (titleSubtype !== undefined) updateData.titleSubtype = titleSubtype || null;
  if (masterTitleNumber !== undefined) updateData.masterTitleNumber = masterTitleNumber || null;
  if (masterTitleLandSize !== undefined) updateData.masterTitleLandSize = masterTitleLandSize || null;
  if (mukim !== undefined) updateData.mukim = mukim || null;
  if (daerah !== undefined) updateData.daerah = daerah || null;
  if (negeri !== undefined) updateData.negeri = negeri || null;
  if (phase !== undefined) updateData.phase = phase || null;
  if (developerName !== undefined) updateData.developerName = developerName || null;
  if (landUse !== undefined) updateData.landUse = landUse || null;
  if (developmentCondition !== undefined) updateData.developmentCondition = developmentCondition || null;
  if (unitCategory !== undefined) updateData.unitCategory = unitCategory || null;
  if (extraFields !== undefined) updateData.extraFields = extraFields;
  updateData.updatedAt = new Date();

  const [proj] = await db
    .update(projectsTable)
    .set(updateData)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.firmId, req.firmId!)))
    .returning();

  res.json(await enrichProject(proj));
});

router.delete("/projects/:projectId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [proj] = await db.delete(projectsTable).where(eq(projectsTable.id, params.data.projectId)).returning();
  if (!proj || proj.firmId !== req.firmId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
