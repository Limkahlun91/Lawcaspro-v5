import { Router, type IRouter } from "express";
import { eq, ilike, count, desc, and, sql } from "drizzle-orm";
import { db, projectsTable, developersTable, casesTable, type Project, type InsertProject } from "@workspace/db";
import {
  CreateProjectBody, UpdateProjectBody, ListProjectsQueryParams,
  GetProjectParams, UpdateProjectParams, DeleteProjectParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

async function enrichProject(r: DbConn, proj: Project) {
  const [devRow] = await r.select().from(developersTable).where(eq(developersTable.id, proj.developerId));
  const [ccRes] = await r.select({ c: count() }).from(casesTable).where(eq(casesTable.projectId, proj.id));
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
    extraFields: (proj.extraFields ?? {}) as Record<string, unknown>,
    caseCount: Number(ccRes?.c ?? 0),
    createdAt: proj.createdAt.toISOString(),
  };
}

router.get("/projects", requireAuth, requireFirmUser, requirePermission("projects", "read"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const r = rdb(req);
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
    if (search) conditions.push(ilike(projectsTable.name, `%${search}%`));

    const projs = await r.select().from(projectsTable)
      .where(and(...conditions))
      .orderBy(desc(projectsTable.createdAt))
      .limit(limit).offset(offset);

    const [totalRes] = await r.select({ c: count() }).from(projectsTable).where(and(...conditions));

    const enriched = await Promise.all(projs.map((p) => enrichProject(r, p)));
    res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
  } catch (err) {
    console.error("[projects] runtime error", { path: req.path, firmId: req.firmId, userId: req.userId, error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/projects", requireAuth, requireFirmUser, requirePermission("projects", "create"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      (req as any).log?.error?.({ route: "POST /api/projects", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const parsed = CreateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { developerId, name, projectType, titleType, landUse, developmentCondition, unitCategory, extraFields } = parsed.data;
    const { phase, developerName, titleSubtype, masterTitleNumber, masterTitleLandSize, mukim, daerah, negeri } = req.body as Record<string, unknown>;

    const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, developerId));
    if (!dev || dev.firmId !== req.firmId) {
      res.status(400).json({ error: "Developer not found in this firm" });
      return;
    }

    const insertBase: Omit<InsertProject, "createdBy"> = {
      firmId: req.firmId!,
      developerId,
      name,
      phase: typeof phase === "string" && phase.trim() ? phase : null,
      developerName: typeof developerName === "string" && developerName.trim() ? developerName : dev.name,
      projectType,
      titleType,
      titleSubtype: typeof titleSubtype === "string" && titleSubtype.trim() ? titleSubtype : null,
      masterTitleNumber: typeof masterTitleNumber === "string" && masterTitleNumber.trim() ? masterTitleNumber : null,
      masterTitleLandSize: typeof masterTitleLandSize === "string" && masterTitleLandSize.trim() ? masterTitleLandSize : null,
      mukim: typeof mukim === "string" && mukim.trim() ? mukim : null,
      daerah: typeof daerah === "string" && daerah.trim() ? daerah : null,
      negeri: typeof negeri === "string" && negeri.trim() ? negeri : null,
      landUse,
      developmentCondition,
      unitCategory,
      extraFields: extraFields ?? {},
    };

    let ctxFirmId: string | null = null;
    let ctxIsFounder: string | null = null;
    try {
      const result = await r.execute(sql`
        select
          current_setting('app.current_firm_id', true) as firm_id,
          current_setting('app.is_founder', true) as is_founder
      `);
      const rows = Array.isArray(result)
        ? result
        : ("rows" in (result as any) ? (result as any).rows : []);
      const row = rows?.[0] as any;
      ctxFirmId = typeof row?.firm_id === "string" ? row.firm_id : null;
      ctxIsFounder = typeof row?.is_founder === "string" ? row.is_founder : null;
    } catch {
    }
    (req as any).log?.info?.({
      route: "POST /api/projects",
      userId: req.userId,
      firmId: req.firmId,
      insertFirmId: insertBase.firmId,
      ctxFirmId,
      ctxIsFounder,
    }, "create route tenant context");

    let proj: Project;
    [proj] = await r
      .insert(projectsTable)
      .values(insertBase)
      .returning();

    try {
      await r
        .update(projectsTable)
        .set({ createdBy: req.userId } as any)
        .where(and(eq(projectsTable.id, proj.id), eq(projectsTable.firmId, req.firmId!)));
    } catch {
    }

    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "projects.create", entityType: "project", entityId: proj.id, detail: `name=${proj.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(await enrichProject(r, proj));
    return;
  } catch (e) {
    const pg = (() => {
      let cur: any = e;
      for (let i = 0; i < 6 && cur; i++) {
        if (typeof cur?.code === "string" || typeof cur?.message === "string" || typeof cur?.detail === "string" || typeof cur?.constraint === "string") {
          const code = typeof cur.code === "string" ? cur.code : undefined;
          const message = typeof cur.message === "string" ? cur.message : undefined;
          const detail = typeof cur.detail === "string" ? cur.detail : undefined;
          const constraint = typeof cur.constraint === "string" ? cur.constraint : undefined;
          return { code, message, detail, constraint };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    (req as any).log?.error?.({ err: e, pg }, "projects.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/projects/:projectId", requireAuth, requireFirmUser, requirePermission("projects", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [proj] = await r.select().from(projectsTable).where(eq(projectsTable.id, params.data.projectId));
  if (!proj || proj.firmId !== req.firmId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(await enrichProject(r, proj));
});

router.patch("/projects/:projectId", requireAuth, requireFirmUser, requirePermission("projects", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const params = UpdateProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await r.select().from(projectsTable).where(
    and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.firmId, req.firmId!))
  );
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { name, developerId, projectType, titleType, titleSubtype, masterTitleNumber, masterTitleLandSize,
    mukim, daerah, negeri, phase, developerName, landUse, developmentCondition, unitCategory, extraFields } = req.body;

  if (developerId !== undefined && developerId !== null) {
    const [dev] = await r.select().from(developersTable).where(
      and(eq(developersTable.id, developerId), eq(developersTable.firmId, req.firmId!))
    );
    if (!dev) {
      res.status(400).json({ error: "Developer not found" });
      return;
    }
  }

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

  const [proj] = await r
    .update(projectsTable)
    .set(updateData)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.firmId, req.firmId!)))
    .returning();

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "projects.update", entityType: "project", entityId: proj.id, detail: `fields=${Object.keys(updateData).join(",")}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(await enrichProject(r, proj));
});

router.delete("/projects/:projectId", requireAuth, requireFirmUser, requirePermission("projects", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const r = req.rlsDb;
  if (!r) {
    console.error("[projects] missing tenant database context", { path: req.path, firmId: req.firmId, userId: req.userId });
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const [proj] = await r
    .delete(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.firmId, req.firmId!)))
    .returning();
  if (!proj || proj.firmId !== req.firmId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "projects.delete", entityType: "project", entityId: proj.id, detail: `name=${proj.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

export default router;
