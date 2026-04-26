import express, { type Router as ExpressRouter } from "express";
import { eq, ilike, count, desc, and, isNull } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { z } from "zod/v4";
import { casesTable, db, developersTable, projectsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

type ReqLike = IncomingMessage & {
  body?: unknown;
  headers: IncomingHttpHeaders & Record<string, string | string[] | undefined>;
  ip?: string;
  originalUrl?: string;
  params?: Record<string, unknown>;
  path?: string;
  query?: Record<string, unknown>;
  firmId?: number | null;
  userId?: number | null;
  userType?: string | null;
  roleId?: number | null;
  log?: { error?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  rlsDb?: unknown;
  [key: string]: unknown;
};

type RouteResLike = {
  status: (code: number) => RouteResLike;
  json: (body: unknown) => unknown;
  sendStatus: (code: number) => unknown;
  [key: string]: unknown;
};

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const routerInternal = expressRouter as unknown as RouterInternalLike;

type AuthRequestLike = AuthRequest & ReqLike;

const asOptionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const getHeader = (req: AuthRequestLike, key: string): string | undefined => {
  const lower = key.toLowerCase();
  const value = req.headers?.[lower] ?? req.headers?.[key];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return asOptionalString(value);
};

const ListProjectsQuerySchema = z.object({
  search: z.string().optional(),
  developerId: z.coerce.number().int().min(1).optional(),
  projectType: z.string().optional(),
  titleType: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const ProjectIdParamsSchema = z.object({ projectId: z.coerce.number().int().min(1) });

const CreateProjectBodySchema = z.object({
  developerId: z.coerce.number().int().min(1),
  name: z.string().min(1),
  projectType: z.string().min(1),
  titleType: z.string().min(1),
  landUse: z.string().optional().nullable(),
  developmentCondition: z.string().optional().nullable(),
  unitCategory: z.string().optional().nullable(),
  extraFields: z.record(z.string(), z.unknown()).optional(),
});

const UpdateProjectBodySchema = z.object({
  name: z.string().optional(),
  developerId: z.coerce.number().int().min(1).optional().nullable(),
  projectType: z.string().optional(),
  titleType: z.string().optional(),
  titleSubtype: z.string().optional().nullable(),
  masterTitleNumber: z.string().optional().nullable(),
  masterTitleLandSize: z.string().optional().nullable(),
  mukim: z.string().optional().nullable(),
  daerah: z.string().optional().nullable(),
  negeri: z.string().optional().nullable(),
  phase: z.string().optional().nullable(),
  developerName: z.string().optional().nullable(),
  landUse: z.string().optional().nullable(),
  developmentCondition: z.string().optional().nullable(),
  unitCategory: z.string().optional().nullable(),
  extraFields: z.record(z.string(), z.unknown()).optional(),
});

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequestLike): DbConn => req.rlsDb ?? db;

type ProjectInsert = typeof projectsTable.$inferInsert;
type ProjectRow = typeof projectsTable.$inferSelect;

async function enrichProject(r: DbConn, proj: ProjectRow) {
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

routerInternal.get("/projects", requireAuth, requireFirmUser, requirePermission("projects", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = rdb(req);
    const params = ListProjectsQuerySchema.safeParse(req.query);
    const search = params.success ? params.data.search : undefined;
    const developerId = params.success ? params.data.developerId : undefined;
    const projectType = params.success ? params.data.projectType : undefined;
    const titleType = params.success ? params.data.titleType : undefined;
    const page = params.success ? (params.data.page ?? 1) : 1;
    const limit = params.success ? (params.data.limit ?? 20) : 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(projectsTable.firmId, req.firmId!), isNull(projectsTable.archivedAt)];
    if (developerId) conditions.push(eq(projectsTable.developerId, developerId));
    if (projectType) conditions.push(eq(projectsTable.projectType, projectType));
    if (titleType) conditions.push(eq(projectsTable.titleType, titleType));
    if (search) conditions.push(ilike(projectsTable.name, `%${search}%`));

    const projs = await r.select().from(projectsTable)
      .where(and(...conditions))
      .orderBy(desc(projectsTable.createdAt))
      .limit(limit).offset(offset);

    const [totalRes] = await r.select({ c: count() }).from(projectsTable).where(and(...conditions));

    const enriched = await Promise.all(projs.map((p: ProjectRow) => enrichProject(r, p)));
    res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[projects]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

routerInternal.post("/projects", requireAuth, requireFirmUser, requirePermission("projects", "create"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "POST /api/projects", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const parsed = CreateProjectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { developerId, name, projectType, titleType, landUse, developmentCondition, unitCategory, extraFields } = parsed.data;
    const rawBody = asRecord(req.body);
    const phase = asOptionalString(rawBody.phase);
    const developerName = asOptionalString(rawBody.developerName);
    const titleSubtype = asOptionalString(rawBody.titleSubtype);
    const masterTitleNumber = asOptionalString(rawBody.masterTitleNumber);
    const masterTitleLandSize = asOptionalString(rawBody.masterTitleLandSize);
    const mukim = asOptionalString(rawBody.mukim);
    const daerah = asOptionalString(rawBody.daerah);
    const negeri = asOptionalString(rawBody.negeri);

    const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, developerId));
    if (!dev || dev.firmId !== req.firmId) {
      res.status(400).json({ error: "Developer not found in this firm" });
      return;
    }

    const insertBase = {
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
    } satisfies Omit<ProjectInsert, "id" | "createdAt" | "updatedAt" | "createdBy">;

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
    req.log.info({
      route: "POST /api/projects",
      userId: req.userId,
      firmId: req.firmId,
      insertFirmId: insertBase.firmId,
      ctxFirmId,
      ctxIsFounder,
    }, "create route tenant context");

    let proj: ProjectRow;
    [proj] = await r
      .insert(projectsTable)
      .values(insertBase)
      .returning();

    try {
      const createdByUpdate = { createdBy: req.userId } satisfies Partial<typeof projectsTable.$inferInsert>;
      await r
        .update(projectsTable)
        .set(createdByUpdate)
        .where(and(eq(projectsTable.id, proj.id), eq(projectsTable.firmId, req.firmId!)));
    } catch {
    }

    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "projects.create", entityType: "project", entityId: proj.id, detail: `name=${proj.name}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
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
    req.log.error({ err: e, pg }, "projects.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

routerInternal.get("/projects/:projectId", requireAuth, requireFirmUser, requirePermission("projects", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = ProjectIdParamsSchema.safeParse(req.params);
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

routerInternal.patch("/projects/:projectId", requireAuth, requireFirmUser, requirePermission("projects", "update"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = ProjectIdParamsSchema.safeParse(req.params);
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

  const parsed = UpdateProjectBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, developerId, projectType, titleType, titleSubtype, masterTitleNumber, masterTitleLandSize,
    mukim, daerah, negeri, phase, developerName, landUse, developmentCondition, unitCategory, extraFields } = parsed.data;

  if (developerId !== undefined && developerId !== null) {
    const [dev] = await r.select().from(developersTable).where(
      and(eq(developersTable.id, developerId), eq(developersTable.firmId, req.firmId!))
    );
    if (!dev) {
      res.status(400).json({ error: "Developer not found" });
      return;
    }
  }

  const updateData: Partial<typeof projectsTable.$inferInsert> = {};
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

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "projects.update", entityType: "project", entityId: proj.id, detail: `fields=${Object.keys(updateData).join(",")}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.json(await enrichProject(r, proj));
});

routerInternal.delete("/projects/:projectId", requireAuth, requireFirmUser, requirePermission("projects", "delete"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const params = ProjectIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[projects] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const [activeCases] = await r
    .select({ c: count() })
    .from(casesTable)
    .where(and(eq(casesTable.firmId, req.firmId!), eq(casesTable.projectId, params.data.projectId), isNull(casesTable.deletedAt)));
  const activeCaseCount = Number(activeCases?.c ?? 0);
  if (activeCaseCount > 0) {
    res.status(409).json({ error: "Project is referenced by active cases", code: "DEPENDENCY_BLOCKED", details: { activeCaseCount } });
    return;
  }

  const [proj] = await r
    .update(projectsTable)
    .set({ archivedAt: new Date(), archivedBy: req.userId ?? null, archivedReason: "user_delete" })
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.firmId, req.firmId!), isNull(projectsTable.archivedAt)))
    .returning();
  if (!proj || proj.firmId !== req.firmId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "projects.archive", entityType: "project", entityId: proj.id, detail: `name=${proj.name}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.sendStatus(204);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
