import express, { type Router as ExpressRouter } from "express";
import { db, sql } from "@workspace/db";
import { z } from "zod";
import { Readable } from "stream";
import { requireAuth, requireFirmUser, requireFounder, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { getSupabaseStorageConfigError, ObjectNotFoundError, SupabaseStorageService } from "../lib/objectStorage.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const supabaseStorage = new SupabaseStorageService();

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

async function queryRows(r: any, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as any).rows as Record<string, unknown>[];
  return [];
}

async function streamPrivateObjectToResponse(objectPath: string, res: any, fallbackContentType: string): Promise<void> {
  const storageResp = await supabaseStorage.fetchPrivateObjectResponse(objectPath);
  const ct = storageResp.headers.get("content-type") || fallbackContentType;
  const cl = storageResp.headers.get("content-length");
  if (ct) res.setHeader("Content-Type", ct);
  if (cl) res.setHeader("Content-Length", cl);
  if (!storageResp.body) throw new Error("Failed to stream file");
  const nodeStream = Readable.fromWeb(storageResp.body as any);
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("error", reject);
    res.on("finish", resolve);
    nodeStream.pipe(res);
  });
}

router.get("/templates", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  try {
    if (req.userType === "founder") {
      await requireFounder(req, res as any, async () => {});
      const rows = await queryRows(
        db,
        sql`SELECT t.*, f.name AS firm_name
            FROM templates t
            LEFT JOIN firms f ON f.id = t.firm_id
            ORDER BY t.created_at DESC`
      );
      res.json(rows);
      return;
    }

    await requireFirmUser(req, res as any, async () => {});
    await requirePermission("documents", "read")(req, res as any, async () => {});
    const rlsDb = req.rlsDb ?? db;
    const rows = await queryRows(
      rlsDb,
      sql`SELECT t.*, NULL::text AS firm_name
          FROM templates t
          ORDER BY t.created_at DESC`
    );
    res.json(rows);
  } catch (err: unknown) {
    logger.error({ err, path: req.path, userId: req.userId, firmId: req.firmId, userType: req.userType }, "[templates] list_failed");
    res.status(503).json({ error: "Failed to load templates" });
  }
});

router.get("/templates/:id/download", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one((req.params as any).id);
  const templateId = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  try {
    const isFounder = req.userType === "founder";
    if (isFounder) {
      await requireFounder(req, res as any, async () => {});
    } else {
      await requireFirmUser(req, res as any, async () => {});
      await requirePermission("documents", "read")(req, res as any, async () => {});
    }

    const r = isFounder ? db : (req.rlsDb ?? db);
    const rows = await queryRows(
      r,
      sql`SELECT id, firm_id, file_type, storage_path, is_active
          FROM templates
          WHERE id = ${templateId}
          LIMIT 1`
    );
    const row = rows[0];
    if (!row || row.is_active === false) {
      res.status(404).json({ error: "Template not found", code: "TEMPLATE_NOT_FOUND" });
      return;
    }

    const firmIdRaw = row.firm_id;
    const firmId =
      typeof firmIdRaw === "number"
        ? firmIdRaw
        : typeof firmIdRaw === "string"
          ? Number(firmIdRaw)
          : null;
    if (!isFounder && firmId !== null && firmId !== req.firmId) {
      res.status(404).json({ error: "Template not found", code: "TEMPLATE_NOT_FOUND" });
      return;
    }

    const fileType = typeof row.file_type === "string" ? row.file_type.toLowerCase() : "";
    const storagePath = typeof row.storage_path === "string" ? String(row.storage_path) : "";
    if (!storagePath) {
      res.status(422).json({ error: "Template missing storage_path", code: "TEMPLATE_STORAGE_PATH_MISSING" });
      return;
    }

    const fallbackContentType =
      fileType === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await streamPrivateObjectToResponse(storagePath, res, fallbackContentType);
  } catch (err: unknown) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      res.status(cfgErr.statusCode).json({ error: cfgErr.error, code: "STORAGE_NOT_CONFIGURED" });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Template file not found", code: "FILE_NOT_FOUND" });
      return;
    }
    logger.error({ err, path: req.path, userId: req.userId, firmId: req.firmId, userType: req.userType }, "[templates] download_failed");
    res.status(503).json({ error: "Failed to download template" });
  }
});

router.post("/templates", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const bodySchema = z.object({
    name: z.string().min(1),
    fileType: z.enum(["docx", "pdf"]),
    storagePath: z.string().min(1),
    firmId: z.number().int().positive().nullable().optional(),
    mappingConfig: z.any().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid request body" });
    return;
  }

  const requestedFirmId = parsed.data.firmId ?? null;
  const isFounder = req.userType === "founder";
  try {
    if (isFounder) {
      await requireFounder(req, res as any, async () => {});
    } else {
      await requireFirmUser(req, res as any, async () => {});
      await requirePermission("documents", "create")(req, res as any, async () => {});
    }

    const firmId = isFounder ? requestedFirmId : req.firmId!;
    const storagePath = parsed.data.storagePath;
    const expectedPrefix =
      firmId === null ? "/objects/templates/global/" : `/objects/templates/firms/${firmId}/`;
    if (!storagePath.startsWith(expectedPrefix)) {
      res.status(400).json({ error: "Invalid storage_path", code: "INVALID_STORAGE_PATH" });
      return;
    }

    const r = isFounder ? db : (req.rlsDb ?? db);
    const rows = await queryRows(
      r,
      sql`INSERT INTO templates (firm_id, name, file_type, storage_path, mapping_config, is_active, created_by)
          VALUES (${firmId}, ${parsed.data.name}, ${parsed.data.fileType}, ${storagePath}, ${parsed.data.mappingConfig ?? null}, ${parsed.data.isActive ?? true}, ${req.userId ?? null})
          RETURNING *`
    );
    const created = rows[0];
    const createdId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : undefined;
    await writeAuditLog({
      firmId: firmId ?? undefined,
      actorId: req.userId,
      actorType: req.userType,
      action: "templates.create",
      entityType: "template",
      entityId: createdId,
      detail: `fileType=${parsed.data.fileType} scope=${firmId === null ? "global" : `firm:${firmId}`}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json(rows[0]);
  } catch (err: unknown) {
    logger.error({ err, path: req.path, userId: req.userId, firmId: req.firmId, userType: req.userType }, "[templates] create_failed");
    res.status(503).json({ error: "Failed to create template" });
  }
});

router.patch("/templates/:id", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one((req.params as any).id);
  const templateId = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const bodySchema = z.object({
    name: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
    mappingConfig: z.any().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid request body" });
    return;
  }

  const isFounder = req.userType === "founder";
  try {
    if (isFounder) {
      await requireFounder(req, res as any, async () => {});
    } else {
      await requireFirmUser(req, res as any, async () => {});
      await requirePermission("documents", "update")(req, res as any, async () => {});
    }

    const r = isFounder ? db : (req.rlsDb ?? db);
    const canUpdateGlobal = isFounder;
    const where = isFounder
      ? sql`id = ${templateId}`
      : sql`id = ${templateId} AND firm_id = ${req.firmId!}`;

    const currentRows = await queryRows(
      r,
      sql`SELECT id, firm_id, file_type, is_active FROM templates WHERE ${where} LIMIT 1`
    );
    const current = currentRows[0];
    if (!current) {
      res.status(404).json({ error: "Template not found", code: "TEMPLATE_NOT_FOUND" });
      return;
    }
    if (!canUpdateGlobal && current.firm_id === null) {
      res.status(403).json({ error: "Permission denied", code: "FORBIDDEN" });
      return;
    }
    if (parsed.data.mappingConfig !== undefined) {
      const ft = typeof current.file_type === "string" ? current.file_type.toLowerCase() : "";
      if (ft !== "pdf") {
        res.status(422).json({ error: "mapping_config is only supported for pdf templates", code: "MAPPING_NOT_SUPPORTED" });
        return;
      }
    }

    const hasName = parsed.data.name !== undefined;
    const hasIsActive = parsed.data.isActive !== undefined;
    const hasMapping = parsed.data.mappingConfig !== undefined;

    const rows = await queryRows(
      r,
      sql`UPDATE templates
          SET name = CASE WHEN ${hasName} THEN ${parsed.data.name ?? null} ELSE name END,
              is_active = CASE WHEN ${hasIsActive} THEN ${parsed.data.isActive ?? null} ELSE is_active END,
              mapping_config = CASE WHEN ${hasMapping} THEN ${parsed.data.mappingConfig ?? null} ELSE mapping_config END,
              updated_at = now()
          WHERE ${where}
          RETURNING *`
    );
    const updated = rows[0];
    await writeAuditLog({
      firmId: (updated as any)?.firm_id ?? (req.firmId ?? undefined),
      actorId: req.userId,
      actorType: req.userType,
      action: "templates.update",
      entityType: "template",
      entityId: templateId,
      detail: `fields=${Object.keys(parsed.data).join(",")}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(rows[0]);
  } catch (err: unknown) {
    logger.error({ err, path: req.path, userId: req.userId, firmId: req.firmId, userType: req.userType }, "[templates] update_failed");
    res.status(503).json({ error: "Failed to update template" });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
