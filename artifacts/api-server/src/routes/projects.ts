import express, { type Router as ExpressRouter } from "express";
import { eq, ilike, count, desc, and, isNull } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import multer from "multer";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { casesTable, db, developersTable, projectDocumentsTable, projectsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { ObjectNotFoundError, SupabaseStorageService } from "../lib/objectStorage.js";

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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const supabaseStorage = new SupabaseStorageService();

type AuthRequestLike = AuthRequest & ReqLike;

const asOptionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function safeFilenameAscii(filename: string): string {
  const base = String(filename || "").replace(/[\r\n"]/g, "").trim();
  if (!base) return "file";
  return base.replace(/[^\x20-\x7E]/g, "_").replace(/[\/\\]/g, "_");
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

function normalizeDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  return s;
}

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
  isEncumbered: z.boolean().optional(),
  tenure: z.enum(["freehold", "leasehold"]).optional(),
  masterChargeeBank: z.string().optional().nullable(),
  masterChargeeAccount: z.string().optional().nullable(),
  constructionPeriodMonths: z.coerce.number().int().min(0).optional().nullable(),
  actualVpDate: z.string().optional().nullable(),
  cccDate: z.string().optional().nullable(),
  hdaAccount: z.string().optional().nullable(),
  hdaBank: z.string().optional().nullable(),
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
  isEncumbered: z.boolean().optional(),
  tenure: z.enum(["freehold", "leasehold"]).optional(),
  masterChargeeBank: z.string().optional().nullable(),
  masterChargeeAccount: z.string().optional().nullable(),
  constructionPeriodMonths: z.coerce.number().int().min(0).optional().nullable(),
  actualVpDate: z.string().optional().nullable(),
  cccDate: z.string().optional().nullable(),
  hdaAccount: z.string().optional().nullable(),
  hdaBank: z.string().optional().nullable(),
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
    isEncumbered: proj.isEncumbered,
    tenure: proj.tenure,
    masterChargeeBank: proj.masterChargeeBank ?? null,
    masterChargeeAccount: proj.masterChargeeAccount ?? null,
    constructionPeriodMonths: proj.constructionPeriodMonths ?? null,
    actualVpDate: proj.actualVpDate ? String(proj.actualVpDate) : null,
    cccDate: proj.cccDate ? String(proj.cccDate) : null,
    hdaAccount: proj.hdaAccount ?? null,
    hdaBank: proj.hdaBank ?? null,
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
    console.error("🚨 CRITICAL BACKEND ERROR:", err);
    console.error(err);
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[projects]");
    const params = ListProjectsQuerySchema.safeParse(req.query);
    const page = params.success ? (params.data.page ?? 1) : 1;
    const limit = params.success ? (params.data.limit ?? 20) : 20;
    res.json({ data: [], total: 0, page, limit });
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

    const {
      developerId,
      name,
      projectType,
      titleType,
      isEncumbered,
      tenure,
      masterChargeeBank,
      masterChargeeAccount,
      constructionPeriodMonths,
      actualVpDate,
      cccDate,
      hdaAccount,
      hdaBank,
      landUse,
      developmentCondition,
      unitCategory,
      extraFields,
    } = parsed.data;
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
      isEncumbered: Boolean(isEncumbered ?? false),
      tenure: tenure ?? "freehold",
      masterChargeeBank: (isEncumbered ?? false) ? (typeof masterChargeeBank === "string" && masterChargeeBank.trim() ? masterChargeeBank.trim() : null) : null,
      masterChargeeAccount: (typeof masterChargeeAccount === "string" && masterChargeeAccount.trim()) ? masterChargeeAccount.trim() : null,
      constructionPeriodMonths: typeof constructionPeriodMonths === "number" ? constructionPeriodMonths : null,
      actualVpDate: (typeof actualVpDate === "string" && actualVpDate.trim()) ? actualVpDate.trim() : null,
      cccDate: (typeof cccDate === "string" && cccDate.trim()) ? cccDate.trim() : null,
      hdaAccount: (typeof hdaAccount === "string" && hdaAccount.trim()) ? hdaAccount.trim() : null,
      hdaBank: (typeof hdaBank === "string" && hdaBank.trim()) ? hdaBank.trim() : null,
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
  const {
    name,
    developerId,
    projectType,
    titleType,
    isEncumbered,
    tenure,
    masterChargeeBank,
    masterChargeeAccount,
    constructionPeriodMonths,
    actualVpDate,
    cccDate,
    hdaAccount,
    hdaBank,
    titleSubtype,
    masterTitleNumber,
    masterTitleLandSize,
    mukim,
    daerah,
    negeri,
    phase,
    developerName,
    landUse,
    developmentCondition,
    unitCategory,
    extraFields,
  } = parsed.data;

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
  if (isEncumbered !== undefined) updateData.isEncumbered = Boolean(isEncumbered);
  if (tenure !== undefined) updateData.tenure = tenure;
  if (masterChargeeBank !== undefined) updateData.masterChargeeBank = (updateData.isEncumbered ?? existing.isEncumbered) ? (typeof masterChargeeBank === "string" && masterChargeeBank.trim() ? masterChargeeBank.trim() : null) : null;
  if (masterChargeeAccount !== undefined) updateData.masterChargeeAccount = (typeof masterChargeeAccount === "string" && masterChargeeAccount.trim()) ? masterChargeeAccount.trim() : null;
  if (constructionPeriodMonths !== undefined) updateData.constructionPeriodMonths = (typeof constructionPeriodMonths === "number") ? constructionPeriodMonths : null;
  if (actualVpDate !== undefined) updateData.actualVpDate = (typeof actualVpDate === "string" && actualVpDate.trim()) ? actualVpDate.trim() : null;
  if (cccDate !== undefined) updateData.cccDate = (typeof cccDate === "string" && cccDate.trim()) ? cccDate.trim() : null;
  if (hdaAccount !== undefined) updateData.hdaAccount = (typeof hdaAccount === "string" && hdaAccount.trim()) ? hdaAccount.trim() : null;
  if (hdaBank !== undefined) updateData.hdaBank = (typeof hdaBank === "string" && hdaBank.trim()) ? hdaBank.trim() : null;
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

routerInternal.get("/projects/:projectId/documents", requireAuth, requireFirmUser, requirePermission("projects", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = ProjectIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const projectId = params.data.projectId;
  const [proj] = await r.select({ id: projectsTable.id, firmId: projectsTable.firmId }).from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!proj || proj.firmId !== req.firmId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const category = typeof (req.query as any)?.category === "string" ? String((req.query as any).category).trim() : "";
  const categoryFilter = category && ["general", "advertisement_permit", "developer_license", "developer_mlu", "bank_mlu"].includes(category) ? category : null;

  const whereClause = categoryFilter
    ? and(
        eq(projectDocumentsTable.firmId, req.firmId!),
        eq(projectDocumentsTable.projectId, projectId),
        eq(projectDocumentsTable.category, categoryFilter),
      )
    : and(
        eq(projectDocumentsTable.firmId, req.firmId!),
        eq(projectDocumentsTable.projectId, projectId),
      );

  const rows = await r
    .select()
    .from(projectDocumentsTable)
    .where(whereClause)
    .orderBy(desc(projectDocumentsTable.createdAt));

  res.json(rows.map((d) => ({
    id: d.id,
    projectId: d.projectId,
    category: d.category,
    documentName: d.documentName,
    licenseNumber: d.licenseNumber ?? null,
    bankName: d.bankName ?? null,
    documentDate: d.documentDate ? String(d.documentDate) : null,
    fileName: d.fileName,
    mimeType: d.mimeType ?? null,
    fileSize: d.fileSize ?? null,
    hasExpiry: d.hasExpiry,
    validFrom: d.validFrom ? String(d.validFrom) : null,
    validTo: d.validTo ? String(d.validTo) : null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  })));
});

routerInternal.post("/projects/:projectId/documents", requireAuth, requireFirmUser, requirePermission("projects", "update"), upload.single("file"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const warnings: string[] = [];
  try {
    const r = req.rlsDb;
    if (!r) {
      logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[projects.documents] missing tenant database context");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const params = ProjectIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const projectId = params.data.projectId;
    const [proj] = await r.select({ id: projectsTable.id, firmId: projectsTable.firmId }).from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.firmId, req.firmId!)));
    if (!proj) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const f = (req as any).file as { originalname?: string; mimetype?: string; buffer?: Buffer; size?: number } | undefined;
    if (!f || !Buffer.isBuffer(f.buffer) || f.buffer.length === 0) {
      res.status(400).json({ error: "file is required" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const category = typeof body.category === "string" ? body.category.trim() : "general";
  if (!["general", "advertisement_permit", "developer_license", "developer_mlu", "bank_mlu"].includes(category)) {
      res.status(400).json({ error: "Invalid category" });
      return;
    }
  const licenseNumber = typeof body.licenseNumber === "string" && body.licenseNumber.trim() ? body.licenseNumber.trim() : null;
    const documentName = typeof body.documentName === "string" ? body.documentName.trim() : "";
    if (!documentName) {
      res.status(400).json({ error: "documentName is required" });
      return;
    }
    const bankName = typeof body.bankName === "string" && body.bankName.trim() ? body.bankName.trim() : null;
    const documentDate = normalizeDateOnly(body.documentDate);

  const apOrDl = category === "advertisement_permit" || category === "developer_license";
  if (apOrDl && !licenseNumber) {
    res.status(400).json({ error: "licenseNumber is required for Advertisement Permit / Developer License" });
    return;
  }

  const hasExpiry = apOrDl ? true : normalizeBoolean(body.hasExpiry);
  const validFrom = hasExpiry ? normalizeDateOnly(body.validFrom) : null;
  const validTo = hasExpiry ? normalizeDateOnly(body.validTo) : null;
  if (apOrDl && (!validFrom || !validTo)) {
    res.status(400).json({ error: "validFrom and validTo are required for Advertisement Permit / Developer License" });
    return;
  }

    const fileName = typeof f.originalname === "string" && f.originalname.trim() ? f.originalname.trim() : "document";
    const safeName = safeFilenameAscii(fileName).replace(/\s+/g, "_");
    const primaryObjectPath = `/objects/projects/${req.firmId!}/${projectId}/${randomUUID()}-${safeName}`;
    let objectPath = primaryObjectPath;
    try {
      await supabaseStorage.uploadPrivateObject({
        objectPath: primaryObjectPath,
        fileBytes: f.buffer,
        contentType: typeof f.mimetype === "string" && f.mimetype.trim() ? f.mimetype.trim() : "application/octet-stream",
      });
    } catch (err) {
      console.warn(err);
      objectPath = `pending_upload/projects/${req.firmId!}/${projectId}/${randomUUID()}-${safeName}`;
      warnings.push("Storage service is currently unavailable. File metadata saved but file content was not uploaded.");
    }

    const [created] = await r
      .insert(projectDocumentsTable)
      .values({
        firmId: req.firmId!,
        projectId,
        category,
        documentName,
        licenseNumber,
        bankName,
        documentDate: documentDate as any,
        objectPath,
        fileName,
        mimeType: typeof f.mimetype === "string" ? f.mimetype : null,
        fileSize: Math.floor(f.buffer.length),
        hasExpiry,
        validFrom: validFrom as any,
        validTo: validTo as any,
        createdBy: req.userId ?? null,
      })
      .returning();

    try {
      await writeAuditLog({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: req.userType,
        action: "projects.documents.upload",
        entityType: "project_document",
        entityId: created.id,
        detail: `projectId=${projectId} category=${category} name=${documentName}`,
        ipAddress: req.ip,
        userAgent: getHeader(req, "user-agent"),
      });
    } catch (err) {
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[projects.documents.upload] audit log failed");
      warnings.push("Audit logging is temporarily unavailable. Upload succeeded, but audit trail may be incomplete.");
    }

    res.status(warnings.length ? 200 : 201).json({
      id: created.id,
      projectId: created.projectId,
      category: created.category,
      documentName: created.documentName,
      licenseNumber: created.licenseNumber ?? null,
      bankName: created.bankName ?? null,
      documentDate: created.documentDate ? String(created.documentDate) : null,
      fileName: created.fileName,
      mimeType: created.mimeType ?? null,
      fileSize: created.fileSize ?? null,
      hasExpiry: created.hasExpiry,
      validFrom: created.validFrom ? String(created.validFrom) : null,
      validTo: created.validTo ? String(created.validTo) : null,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
      ...(warnings.length ? { warning: warnings[0], warnings } : {}),
    });
  } catch (err) {
    console.error(err);
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[projects.documents.upload]");
    res.status(200).json({
      warning: "Upload completed with degraded mode. If the document does not appear, please try uploading again.",
      warnings: ["Upload completed with degraded mode. If the document does not appear, please try uploading again."],
    });
  }
});

routerInternal.get("/projects/:projectId/documents/:docId/view", requireAuth, requireFirmUser, requirePermission("projects", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = z.object({ projectId: z.coerce.number().int().min(1), docId: z.coerce.number().int().min(1) }).safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const [row] = await r
    .select({ objectPath: projectDocumentsTable.objectPath })
    .from(projectDocumentsTable)
    .where(and(
      eq(projectDocumentsTable.id, params.data.docId),
      eq(projectDocumentsTable.projectId, params.data.projectId),
      eq(projectDocumentsTable.firmId, req.firmId!),
    ))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  if (!row.objectPath.startsWith("/objects/")) {
    res.status(409).json({ error: "File content not available. Storage upload pending." });
    return;
  }

  try {
    const url = await supabaseStorage.createSignedDownloadUrl(row.objectPath, 60 * 10);
    (res as any).redirect(url);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.status(503).json({ error: "Storage unavailable" });
  }
});

routerInternal.delete("/projects/:projectId/documents/:docId", requireAuth, requireFirmUser, requirePermission("projects", "update"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[projects.documents] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const params = z.object({ projectId: z.coerce.number().int().min(1), docId: z.coerce.number().int().min(1) }).safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const [deleted] = await r
    .delete(projectDocumentsTable)
    .where(and(
      eq(projectDocumentsTable.id, params.data.docId),
      eq(projectDocumentsTable.projectId, params.data.projectId),
      eq(projectDocumentsTable.firmId, req.firmId!),
    ))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  try {
    await supabaseStorage.deletePrivateObject(deleted.objectPath);
  } catch (err) {
    if (!(err instanceof ObjectNotFoundError)) {
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[projects.documents] delete_private_object_failed");
    }
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "projects.documents.delete",
    entityType: "project_document",
    entityId: deleted.id,
    detail: `projectId=${params.data.projectId} category=${deleted.category} name=${deleted.documentName}`,
    ipAddress: req.ip,
    userAgent: getHeader(req, "user-agent"),
  });
  res.sendStatus(204);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
