import express, { type Router as ExpressRouter } from "express";
import { eq, ilike, count, desc, and } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import multer from "multer";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { db, developersTable, developerDocumentsTable, projectsTable, sql } from "@workspace/db";
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const getHeader = (req: AuthRequestLike, key: string): string | undefined => {
  const lower = key.toLowerCase();
  const value = req.headers?.[lower] ?? req.headers?.[key];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return asOptionalString(value);
};

const DeveloperIdParamsSchema = z.object({ developerId: z.coerce.number().int().min(1) });
const ListDevelopersQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequestLike): DbConn => req.rlsDb ?? db;

type DeveloperInsert = typeof developersTable.$inferInsert;
type DeveloperInsertPayload = Pick<DeveloperInsert, "firmId" | "name"> & Partial<Omit<
  DeveloperInsert,
  "firmId" | "name" | "id" | "createdAt" | "updatedAt"
>>;

interface DeveloperContact {
  salutation?: string;
  name: string;
  department: string;
  phone: string;
  phoneExt: string;
  email: string;
}

const SALUTATIONS = new Set(["MR.", "MS.", "MRS.", "MDM.", "DR.", "DATUK"]);

function normalizeSalutation(value: unknown): string {
  const s = typeof value === "string" ? value.trim().toUpperCase() : "";
  return SALUTATIONS.has(s) ? s : "";
}

function normalizeContacts(value: unknown): DeveloperContact[] {
  if (!Array.isArray(value)) return [];
  const out: DeveloperContact[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    out.push({
      salutation: normalizeSalutation(rec.salutation),
      name,
      department: typeof rec.department === "string" ? rec.department.trim() : "",
      phone: typeof rec.phone === "string" ? rec.phone.trim() : "",
      phoneExt: typeof rec.phoneExt === "string" ? rec.phoneExt.trim() : "",
      email: typeof rec.email === "string" ? rec.email.trim() : "",
    });
    if (out.length >= 5) break;
  }
  return out;
}

function parseContacts(raw: string | null | undefined): DeveloperContact[] {
  if (!raw) return [];
  try {
    return normalizeContacts(JSON.parse(raw));
  } catch {
    return [];
  }
}

type DeveloperRow = typeof developersTable.$inferSelect;

async function enrichDeveloper(r: DbConn, dev: DeveloperRow) {
  const [pcRes] = await r.select({ c: count() }).from(projectsTable).where(eq(projectsTable.developerId, dev.id));
  const contacts = (() => {
    try {
      return parseContacts(dev.contacts);
    } catch (err) {
      logger.warn({ err, developerId: dev.id, firmId: dev.firmId }, "[developers] contacts_parse_failed");
      return [];
    }
  })();
  return {
    id: dev.id,
    firmId: dev.firmId,
    name: dev.name,
    companyRegNo: dev.companyRegNo ?? null,
    address: dev.address ?? null,
    businessAddress: dev.businessAddress ?? null,
    contacts,
    contactPerson: dev.contactPerson ?? null,
    phone: dev.phone ?? null,
    email: dev.email ?? null,
    projectCount: Number(pcRes?.c ?? 0),
    createdAt: dev.createdAt.toISOString(),
  };
}

routerInternal.get("/developers", requireAuth, requireFirmUser, requirePermission("developers", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = rdb(req);
    const params = ListDevelopersQuerySchema.safeParse(req.query);
    const search = params.success ? params.data.search : undefined;
    const page = params.success ? (params.data.page ?? 1) : 1;
    const limit = params.success ? (params.data.limit ?? 20) : 20;
    const offset = (page - 1) * limit;

    let devs;
    let totalRes;

    if (search) {
      devs = await r.select().from(developersTable)
        .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)))
        .orderBy(desc(developersTable.createdAt))
        .limit(limit).offset(offset);
      const [t] = await r.select({ c: count() }).from(developersTable)
        .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)));
      totalRes = t;
    } else {
      devs = await r.select().from(developersTable)
        .where(eq(developersTable.firmId, req.firmId!))
        .orderBy(desc(developersTable.createdAt))
        .limit(limit).offset(offset);
      const [t] = await r.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, req.firmId!));
      totalRes = t;
    }

    const enriched = await Promise.all(devs.map((d: DeveloperRow) => enrichDeveloper(r, d)));
    res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[developers]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

routerInternal.post("/developers", requireAuth, requireFirmUser, requirePermission("developers", "create"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "POST /api/developers", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const body = asRecord(req.body);
    const name = asOptionalString(body.name);
    const companyRegNo = asOptionalString(body.companyRegNo);
    const address = asOptionalString(body.address);
    const businessAddress = asOptionalString(body.businessAddress);
    const contactPerson = asOptionalString(body.contactPerson);
    const phone = asOptionalString(body.phone);
    const email = asOptionalString(body.email);
    const contacts = body.contacts !== undefined ? normalizeContacts(body.contacts) : undefined;
    if (!name) {
      res.status(400).json({ error: "Company name is required" });
      return;
    }

    const insertBase = {
      firmId: req.firmId!,
      name,
      companyRegNo: companyRegNo ?? null,
      address: address ?? null,
      businessAddress: businessAddress ?? null,
      contacts: contacts ? JSON.stringify(contacts) : null,
      contactPerson: contactPerson ?? null,
      phone: phone ?? null,
      email: email ?? null,
    } satisfies DeveloperInsertPayload;

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
      route: "POST /api/developers",
      userId: req.userId,
      firmId: req.firmId,
      insertFirmId: insertBase.firmId,
      ctxFirmId,
      ctxIsFounder,
    }, "create route tenant context");

    let dev: DeveloperRow;
    const getErrorMessage = (e: unknown): string => {
      const err = e as { message?: unknown; cause?: unknown };
      const msg =
        (typeof err?.message === "string" ? err.message : undefined)
        ?? (typeof (err?.cause as any)?.message === "string" ? (err?.cause as any)?.message : undefined)
        ?? (typeof ((err?.cause as any)?.cause as any)?.message === "string" ? ((err?.cause as any)?.cause as any)?.message : undefined);
      return msg ? String(msg) : "";
    };

    const missingColumnFromMessage = (msg: string): string | null => {
      const m = msg.match(/column \"([^\"]+)\" of relation \"developers\" does not exist/i);
      return m?.[1] ?? null;
    };

    const columnToKey: Record<string, keyof DeveloperInsertPayload> = {
      company_reg_no: "companyRegNo",
      address: "address",
      business_address: "businessAddress",
      contacts: "contacts",
      contact_person: "contactPerson",
      phone: "phone",
      email: "email",
    };

    let insertValues: DeveloperInsertPayload = { ...insertBase };
    for (;;) {
      try {
        [dev] = await r
          .insert(developersTable)
          .values(insertValues)
          .returning();
        break;
      } catch (e) {
        const col = missingColumnFromMessage(getErrorMessage(e));
        if (!col) throw e;
        const key = columnToKey[col];
        if (!key) throw e;
        insertValues = { ...insertValues, [key]: undefined };
      }
    }

    try {
      const createdByUpdate = { createdBy: req.userId } satisfies Partial<typeof developersTable.$inferInsert>;
      await r
        .update(developersTable)
        .set(createdByUpdate)
        .where(and(eq(developersTable.id, dev.id), eq(developersTable.firmId, req.firmId!)));
    } catch {
    }

    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.create", entityType: "developer", entityId: dev.id, detail: `name=${dev.name}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
    res.status(201).json(await enrichDeveloper(r, dev));
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
    req.log.error({ err: e, pg }, "developers.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

routerInternal.get("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = DeveloperIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, params.data.developerId));
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  res.json(await enrichDeveloper(r, dev));
});

routerInternal.patch("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "update"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = DeveloperIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = asRecord(req.body);
  const name = asOptionalString(body.name);
  const companyRegNo = asOptionalString(body.companyRegNo);
  const address = asOptionalString(body.address);
  const businessAddress = asOptionalString(body.businessAddress);
  const contactPerson = asOptionalString(body.contactPerson);
  const phone = asOptionalString(body.phone);
  const email = asOptionalString(body.email);
  const contacts = body.contacts !== undefined ? normalizeContacts(body.contacts) : undefined;

  const updateData: Partial<typeof developersTable.$inferInsert> = {};
  if (name !== undefined) updateData.name = name;
  if (companyRegNo !== undefined) updateData.companyRegNo = companyRegNo;
  if (address !== undefined) updateData.address = address;
  if (businessAddress !== undefined) updateData.businessAddress = businessAddress;
  if (contacts !== undefined) updateData.contacts = JSON.stringify(contacts);
  if (contactPerson !== undefined) updateData.contactPerson = contactPerson;
  if (phone !== undefined) updateData.phone = phone;
  if (email !== undefined) updateData.email = email;

  const [dev] = await r
    .update(developersTable)
    .set(updateData)
    .where(eq(developersTable.id, params.data.developerId))
    .returning();

  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.update", entityType: "developer", entityId: dev.id, detail: `fields=${Object.keys(updateData).join(",")}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.json(await enrichDeveloper(r, dev));
});

routerInternal.delete("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "delete"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const params = DeveloperIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[developers] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const [dev] = await r
    .delete(developersTable)
    .where(and(eq(developersTable.id, params.data.developerId), eq(developersTable.firmId, req.firmId!)))
    .returning();
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.delete", entityType: "developer", entityId: dev.id, detail: `name=${dev.name}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.sendStatus(204);
});

routerInternal.get("/developers/:developerId/documents", requireAuth, requireFirmUser, requirePermission("developers", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = rdb(req);
    const params = DeveloperIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const developerId = params.data.developerId;
    const [dev] = await r.select({ id: developersTable.id, firmId: developersTable.firmId }).from(developersTable).where(eq(developersTable.id, developerId));
    if (!dev || dev.firmId !== req.firmId) {
      res.status(404).json({ error: "Developer not found" });
      return;
    }

    const rows = await r
      .select()
      .from(developerDocumentsTable)
      .where(and(eq(developerDocumentsTable.firmId, req.firmId!), eq(developerDocumentsTable.developerId, developerId)))
      .orderBy(desc(developerDocumentsTable.createdAt));

    res.json(rows.map((d) => ({
      id: d.id,
      developerId: d.developerId,
      documentName: d.documentName,
      fileName: d.fileName,
      mimeType: d.mimeType ?? null,
      fileSize: d.fileSize ?? null,
      hasExpiry: d.hasExpiry,
      validFrom: d.validFrom ? String(d.validFrom) : null,
      validTo: d.validTo ? String(d.validTo) : null,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    })));
  } catch (err) {
    console.error(err);
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[developers.documents]");
    res.json([]);
  }
});

routerInternal.post("/developers/:developerId/documents", requireAuth, requireFirmUser, requirePermission("developers", "update"), upload.single("file"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[developers.documents] missing tenant database context");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }

    const params = DeveloperIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const developerId = params.data.developerId;
    const [dev] = await r.select({ id: developersTable.id, firmId: developersTable.firmId }).from(developersTable).where(and(eq(developersTable.id, developerId), eq(developersTable.firmId, req.firmId!)));
    if (!dev) {
      res.status(404).json({ error: "Developer not found" });
      return;
    }

    const f = (req as any).file as { originalname?: string; mimetype?: string; buffer?: Buffer; size?: number } | undefined;
    if (!f || !Buffer.isBuffer(f.buffer) || f.buffer.length === 0) {
      res.status(400).json({ error: "file is required" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const documentName = typeof body.documentName === "string" ? body.documentName.trim() : "";
    if (!documentName) {
      res.status(400).json({ error: "documentName is required" });
      return;
    }
    const hasExpiry = normalizeBoolean(body.hasExpiry);
    const validFrom = hasExpiry ? normalizeDateOnly(body.validFrom) : null;
    const validTo = hasExpiry ? normalizeDateOnly(body.validTo) : null;

    const fileName = typeof f.originalname === "string" && f.originalname.trim() ? f.originalname.trim() : "document";
    const safeName = safeFilenameAscii(fileName).replace(/\s+/g, "_");
    const objectPath = `/objects/developers/${req.firmId!}/${developerId}/${randomUUID()}-${safeName}`;

    await withTimeout(
      supabaseStorage.uploadPrivateObject({
        objectPath,
        fileBytes: f.buffer,
        contentType: typeof f.mimetype === "string" && f.mimetype.trim() ? f.mimetype.trim() : "application/octet-stream",
      }),
      12_000,
      "uploadPrivateObject",
    );

    const [created] = await r
      .insert(developerDocumentsTable)
      .values({
        firmId: req.firmId!,
        developerId,
        documentName,
        objectPath,
        fileName,
        mimeType: typeof f.mimetype === "string" ? f.mimetype : null,
        fileSize: Math.floor(f.buffer.length),
        hasExpiry,
        validFrom: validFrom as any,
        validTo: validTo as any,
      })
      .returning();

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "developers.documents.upload",
      entityType: "developer_document",
      entityId: created.id,
      detail: `developerId=${developerId} name=${documentName}`,
      ipAddress: req.ip,
      userAgent: getHeader(req, "user-agent"),
    });

    res.status(201).json({
      id: created.id,
      developerId: created.developerId,
      documentName: created.documentName,
      fileName: created.fileName,
      mimeType: created.mimeType ?? null,
      fileSize: created.fileSize ?? null,
      hasExpiry: created.hasExpiry,
      validFrom: created.validFrom ? String(created.validFrom) : null,
      validTo: created.validTo ? String(created.validTo) : null,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error(err);
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[developers.documents.upload]");
    res.status(503).json({ error: "Upload failed" });
  }
});

routerInternal.get("/developers/:developerId/documents/:docId/view", requireAuth, requireFirmUser, requirePermission("developers", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = z.object({ developerId: z.coerce.number().int().min(1), docId: z.coerce.number().int().min(1) }).safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const [row] = await r
    .select({ objectPath: developerDocumentsTable.objectPath, firmId: developerDocumentsTable.firmId })
    .from(developerDocumentsTable)
    .where(and(
      eq(developerDocumentsTable.id, params.data.docId),
      eq(developerDocumentsTable.developerId, params.data.developerId),
      eq(developerDocumentsTable.firmId, req.firmId!),
    ))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  try {
    const url = await withTimeout(supabaseStorage.createSignedDownloadUrl(row.objectPath, 60 * 10), 8_000, "createSignedDownloadUrl");
    (res as any).redirect(url);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.status(503).json({ error: "Storage unavailable" });
  }
});

routerInternal.delete("/developers/:developerId/documents/:docId", requireAuth, requireFirmUser, requirePermission("developers", "update"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[developers.documents] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const params = z.object({ developerId: z.coerce.number().int().min(1), docId: z.coerce.number().int().min(1) }).safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const [deleted] = await r
    .delete(developerDocumentsTable)
    .where(and(
      eq(developerDocumentsTable.id, params.data.docId),
      eq(developerDocumentsTable.developerId, params.data.developerId),
      eq(developerDocumentsTable.firmId, req.firmId!),
    ))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  try {
    await withTimeout(supabaseStorage.deletePrivateObject(deleted.objectPath), 8_000, "deletePrivateObject");
  } catch (err) {
    if (!(err instanceof ObjectNotFoundError)) {
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[developers.documents] delete_private_object_failed");
    }
  }

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "developers.documents.delete",
    entityType: "developer_document",
    entityId: deleted.id,
    detail: `developerId=${params.data.developerId} name=${deleted.documentName}`,
    ipAddress: req.ip,
    userAgent: getHeader(req, "user-agent"),
  });
  res.sendStatus(204);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export const __test__ = { normalizeSalutation, normalizeContacts, parseContacts };
export default exportedRouter;
