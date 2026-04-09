import { Router, type IRouter } from "express";
import { Readable } from "stream";
import { eq, ilike, count, sql, desc, and, isNull, or, type SQL } from "drizzle-orm";
import {
  db,
  firmsTable,
  usersTable,
  casesTable,
  rolesTable,
  systemFoldersTable,
  platformDocumentsTable,
  platformMessagesTable,
  platformMessageAttachmentsTable,
} from "@workspace/db";
import { CreateFirmBody, UpdateFirmBody, ListFirmsQueryParams, GetFirmParams, UpdateFirmParams } from "@workspace/api-zod";
import { requireAuth, requireFounder, writeAuditLog, type AuthRequest } from "../lib/auth";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import bcrypt from "bcryptjs";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const firstRow = (result: unknown): Record<string, unknown> | undefined => {
  if (Array.isArray(result)) {
    const row = result[0];
    return row && typeof row === "object" ? (row as Record<string, unknown>) : undefined;
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const row = rows[0];
      return row && typeof row === "object" ? (row as Record<string, unknown>) : undefined;
    }
  }
  return undefined;
};

const router: IRouter = Router();
const storage = new ObjectStorageService();

// ─── Firms ────────────────────────────────────────────────────────────────────

router.get("/platform/firms", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = ListFirmsQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const status = params.success ? params.data.status : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  let query = db.select().from(firmsTable);
  if (search) query = query.where(ilike(firmsTable.name, `%${search}%`)) as typeof query;
  if (status) query = query.where(eq(firmsTable.status, status)) as typeof query;

  const firms = await query.orderBy(desc(firmsTable.createdAt)).limit(limit).offset(offset);
  const totalResult = await db.select({ total: count() }).from(firmsTable);
  const total = totalResult[0]?.total ?? 0;

  const enriched = await Promise.all(
    firms.map(async (firm) => {
      const [userCountRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.firmId, firm.id));
      const [partnerCountRes] = await db.select({ c: count() }).from(usersTable).where(sql`firm_id = ${firm.id} AND user_type = 'firm_user'`);
      const [caseCountRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.firmId, firm.id));
      const docRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents WHERE firm_id = ${firm.id}`);
      const docC = firstRow(docRes)?.c;
      const docCount = typeof docC === "string" || typeof docC === "number" ? Number(docC) : 0;
      const billingRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_billing_entries WHERE firm_id = ${firm.id}`);
      const billingC = firstRow(billingRes)?.c;
      const billingCount = typeof billingC === "string" || typeof billingC === "number" ? Number(billingC) : 0;
      const commRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_communications WHERE firm_id = ${firm.id}`);
      const commC = firstRow(commRes)?.c;
      const commCount = typeof commC === "string" || typeof commC === "number" ? Number(commC) : 0;
      return {
        ...firm,
        userCount: Number(userCountRes?.c ?? 0),
        partnerCount: Number(partnerCountRes?.c ?? 0),
        caseCount: Number(caseCountRes?.c ?? 0),
        user_count: Number(userCountRes?.c ?? 0),
        case_count: Number(caseCountRes?.c ?? 0),
        document_count: docCount,
        billing_entry_count: billingCount,
        comm_count: commCount,
      };
    })
  );

  res.json({ data: enriched, total: Number(total), page, limit });
});

router.post("/platform/firms", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, slug, subscriptionPlan, partnerName, partnerEmail, partnerPassword } = parsed.data;
  const [existing] = await db.select().from(firmsTable).where(eq(firmsTable.slug, slug));
  if (existing) {
    res.status(400).json({ error: "Slug already taken" });
    return;
  }
  const [firm] = await db.insert(firmsTable).values({ name, slug, subscriptionPlan: subscriptionPlan ?? "starter", status: "active" }).returning();
  const passwordHash = await bcrypt.hash(partnerPassword, 10);
  await db.insert(usersTable).values({ firmId: firm.id, email: partnerEmail.toLowerCase(), name: partnerName, passwordHash, userType: "firm_user", status: "active" });
  res.status(201).json({ ...firm, userCount: 1, partnerCount: 1, caseCount: 0 });
});

router.get("/platform/firms/:firmId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = GetFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, params.data.firmId));
  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }
  const [userCountRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.firmId, firm.id));
  const [caseCountRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.firmId, firm.id));
  res.json({ ...firm, userCount: Number(userCountRes?.c ?? 0), partnerCount: 0, caseCount: Number(caseCountRes?.c ?? 0) });
});

router.patch("/platform/firms/:firmId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.subscriptionPlan !== undefined) updates.subscriptionPlan = parsed.data.subscriptionPlan;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  const [firm] = await db.update(firmsTable).set(updates).where(eq(firmsTable.id, params.data.firmId)).returning();
  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }
  res.json({ ...firm, userCount: 0, partnerCount: 0, caseCount: 0 });
});

// ─── Firm Users ───────────────────────────────────────────────────────────────

router.get("/platform/firms/:firmId/users", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const firmIdStr = one(req.params.firmId);
  const firmId = firmIdStr ? parseInt(firmIdStr, 10) : NaN;
  if (isNaN(firmId)) {
    res.status(400).json({ error: "Invalid firm ID" });
    return;
  }
  const users = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      userType: usersTable.userType,
      roleId: usersTable.roleId,
      status: usersTable.status,
      lastLoginAt: usersTable.lastLoginAt,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.firmId, firmId))
    .orderBy(usersTable.createdAt);

  const withRoles = await Promise.all(
    users.map(async (u) => {
      let roleName: string | null = null;
      if (u.roleId) {
        const [role] = await db.select({ name: rolesTable.name }).from(rolesTable).where(eq(rolesTable.id, u.roleId));
        roleName = role?.name ?? null;
      }
      return { ...u, roleName };
    })
  );

  res.json(withRoles);
});

router.post("/platform/firms/:firmId/users/:userId/reset-password", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const firmIdStr = one(req.params.firmId);
  const userIdStr = one(req.params.userId);
  const firmId = firmIdStr ? parseInt(firmIdStr, 10) : NaN;
  const userId = userIdStr ? parseInt(userIdStr, 10) : NaN;
  if (isNaN(firmId) || isNaN(userId)) { res.status(400).json({ error: "Invalid firm ID or user ID" }); return; }
  const { newPassword } = req.body as { newPassword?: string };
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.firmId, firmId)));
  if (!user) {
    res.status(404).json({ error: "User not found in this firm" });
    return;
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));
  res.json({ success: true, message: "Password reset successfully" });
});

// ─── Platform Stats ───────────────────────────────────────────────────────────

router.get("/platform/stats", requireAuth, requireFounder, async (_req, res): Promise<void> => {
  const [totalFirmsRes] = await db.select({ c: count() }).from(firmsTable);
  const [activeFirmsRes] = await db.select({ c: count() }).from(firmsTable).where(eq(firmsTable.status, "active"));
  const [totalUsersRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.userType, "firm_user"));
  const [totalCasesRes] = await db.select({ c: count() }).from(casesTable);
  const docsRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents`);
  const docsC = firstRow(docsRes)?.c;
  const totalDocuments = typeof docsC === "string" || typeof docsC === "number" ? Number(docsC) : 0;
  res.json({ totalFirms: Number(totalFirmsRes?.c ?? 0), activeFirms: Number(activeFirmsRes?.c ?? 0), totalUsers: Number(totalUsersRes?.c ?? 0), totalCases: Number(totalCasesRes?.c ?? 0), totalDocuments });
});

// ─── System Folders ───────────────────────────────────────────────────────────

router.get("/platform/folders", requireAuth, requireFounder, async (_req: AuthRequest, res): Promise<void> => {
  const folders = await withAuthSafeDb(async (authDb) =>
    authDb
      .select()
      .from(systemFoldersTable)
      .orderBy(systemFoldersTable.sortOrder, systemFoldersTable.name)
  );
  res.json(folders);
});

router.post("/platform/folders", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { name, parentId } = req.body as { name: string; parentId?: number | null };
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Folder name is required" });
    return;
  }
  const folder = await withAuthSafeDb(async (authDb) => {
    const maxSort = await authDb.execute(
      sql`SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort FROM system_folders WHERE ${parentId ? sql`parent_id = ${parentId}` : sql`parent_id IS NULL`}`
    );
    const nextSortV = firstRow(maxSort)?.next_sort;
    const nextSort = typeof nextSortV === "string" || typeof nextSortV === "number" ? Number(nextSortV) : 0;
    const [folder] = await authDb
      .insert(systemFoldersTable)
      .values({ name: name.trim(), parentId: parentId ?? null, sortOrder: nextSort })
      .returning();
    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.system_folder.create",
        entityType: "system_folder",
        entityId: folder.id,
        detail: `name=${folder.name} parentId=${folder.parentId ?? ""}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return folder;
  });
  res.status(201).json(folder);
});

router.patch("/platform/folders/:folderId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const folderIdStr = one(req.params.folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : NaN;
  if (isNaN(folderId)) { res.status(400).json({ error: "Invalid folder ID" }); return; }
  const { name, isDisabled } = req.body as { name?: string; isDisabled?: boolean };
  const wantName = name !== undefined;
  const wantDisabled = isDisabled !== undefined;
  if (!wantName && !wantDisabled) { res.status(400).json({ error: "No fields to update" }); return; }
  if (wantName && !name?.trim()) { res.status(400).json({ error: "Folder name is required" }); return; }

  const result = await withAuthSafeDb(async (authDb) => {
    const [before] = await authDb.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    if (!before) return { kind: "not_found" as const };

    const updates: Record<string, unknown> = {};
    if (wantName) updates.name = name!.trim();
    if (wantDisabled) updates.isDisabled = isDisabled!;

    const [folder] = await authDb.update(systemFoldersTable).set(updates).where(eq(systemFoldersTable.id, folderId)).returning();
    if (!folder) return { kind: "not_found" as const };

    let action = "platform.system_folder.update";
    if (wantName && !wantDisabled) action = "platform.system_folder.rename";
    if (!wantName && wantDisabled) action = isDisabled ? "platform.system_folder.disable" : "platform.system_folder.enable";

    const detailParts: string[] = [];
    if (wantName) detailParts.push(`from=${before.name} to=${folder.name}`);
    if (wantDisabled) detailParts.push(`isDisabled=${String(folder.isDisabled)}`);

    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action,
        entityType: "system_folder",
        entityId: folderId,
        detail: detailParts.join(" "),
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const, folder };
  });

  if (result.kind === "not_found") { res.status(404).json({ error: "Folder not found" }); return; }
  res.json(result.folder);
});

router.delete("/platform/folders/:folderId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const folderIdStr = one(req.params.folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : NaN;
  if (isNaN(folderId)) { res.status(400).json({ error: "Invalid folder ID" }); return; }
  const result = await withAuthSafeDb(async (authDb) => {
    const [folder] = await authDb.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    if (!folder) return { kind: "not_found" as const };

    const [childCount] = await authDb.select({ c: count() }).from(systemFoldersTable).where(eq(systemFoldersTable.parentId, folderId));
    if (Number(childCount?.c ?? 0) > 0) {
      return { kind: "bad_request" as const, error: "Cannot delete folder with subfolders. Remove subfolders first." };
    }

    const [docCount] = await authDb.select({ c: count() }).from(platformDocumentsTable).where(eq(platformDocumentsTable.folderId, folderId));
    if (Number(docCount?.c ?? 0) > 0) {
      return { kind: "bad_request" as const, error: "Cannot delete folder with documents. Remove or move documents first." };
    }

    await authDb.delete(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.system_folder.delete",
        entityType: "system_folder",
        entityId: folderId,
        detail: `name=${folder.name}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const };
  });

  if (result.kind === "not_found") { res.status(404).json({ error: "Folder not found" }); return; }
  if (result.kind === "bad_request") { res.status(400).json({ error: result.error }); return; }
  res.json({ success: true });
});

router.post("/platform/folders/reorder", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { folderId, direction } = req.body as { folderId: number; direction: "up" | "down" };
  if (!folderId || !direction) { res.status(400).json({ error: "folderId and direction required" }); return; }
  const result = await withAuthSafeDb(async (authDb) => {
    const [folder] = await authDb.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    if (!folder) return { kind: "not_found" as const };

    const siblings = await authDb
      .select()
      .from(systemFoldersTable)
      .where(folder.parentId ? eq(systemFoldersTable.parentId, folder.parentId) : isNull(systemFoldersTable.parentId))
      .orderBy(systemFoldersTable.sortOrder);

    const idx = siblings.findIndex(s => s.id === folderId);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) {
      await writeAuditLog(
        {
          firmId: null,
          actorId: req.userId,
          actorType: req.userType,
          action: "platform.system_folder.reorder",
          entityType: "system_folder",
          entityId: folderId,
          detail: `direction=${direction} noop=true parentId=${folder.parentId ?? ""}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: true }
      );
      return { kind: "ok" as const };
    }

    const swapFolder = siblings[swapIdx];
    await authDb.update(systemFoldersTable).set({ sortOrder: swapFolder.sortOrder }).where(eq(systemFoldersTable.id, folder.id));
    await authDb.update(systemFoldersTable).set({ sortOrder: folder.sortOrder }).where(eq(systemFoldersTable.id, swapFolder.id));
    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.system_folder.reorder",
        entityType: "system_folder",
        entityId: folderId,
        detail: `direction=${direction} swapWith=${swapFolder.id} parentId=${folder.parentId ?? ""}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const };
  });

  if (result.kind === "not_found") { res.status(404).json({ error: "Folder not found" }); return; }
  res.json({ success: true });
});

// ─── Platform Documents ───────────────────────────────────────────────────────

router.get("/platform/documents", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const firmIdStr = one(req.query.firmId as any);
  const folderIdStr = one(req.query.folderId as any);
  const firmId = firmIdStr ? parseInt(firmIdStr, 10) : undefined;
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : undefined;
  let condition: SQL<unknown> | undefined;
  if (firmId) condition = eq(platformDocumentsTable.firmId, firmId);
  if (folderId !== undefined) {
    const folderCondition = eq(platformDocumentsTable.folderId, folderId);
    condition = condition ? and(condition, folderCondition) : folderCondition;
  }
  const docs = await withAuthSafeDb(async (authDb) => authDb
    .select()
    .from(platformDocumentsTable)
    .where(condition)
    .orderBy(desc(platformDocumentsTable.createdAt)));
  res.json(docs);
});

router.post("/platform/documents", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { name, description, category, fileName, fileType, fileSize, objectPath, firmId, folderId } = req.body as {
    name: string;
    description?: string;
    category?: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
    objectPath: string;
    firmId?: number | null;
    folderId?: number | null;
  };
  if (!name || !fileName || !fileType || !objectPath) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const doc = await withAuthSafeDb(async (authDb) => {
    const [doc] = await authDb
      .insert(platformDocumentsTable)
      .values({
        name,
        description: description ?? null,
        category: category ?? "general",
        fileName,
        fileType,
        fileSize: fileSize ?? null,
        objectPath,
        firmId: firmId ?? null,
        folderId: folderId ?? null,
        uploadedBy: req.userId!,
      })
      .returning();
    await writeAuditLog(
      {
        firmId: doc.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.create",
        entityType: "platform_document",
        entityId: doc.id,
        detail: `name=${doc.name} category=${doc.category} folderId=${doc.folderId ?? ""}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return doc;
  });
  res.status(201).json(doc);
});

router.delete("/platform/documents/:docId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const result = await withAuthSafeDb(async (authDb) => {
    const [doc] = await authDb.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
    if (!doc) return { kind: "not_found" as const };
    await authDb.delete(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
    await writeAuditLog(
      {
        firmId: doc.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.delete",
        entityType: "platform_document",
        entityId: docId,
        detail: `name=${doc.name}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const, doc };
  });
  if (result.kind === "not_found") { res.status(404).json({ error: "Document not found" }); return; }
  res.json({ success: true });
});

router.get("/platform/documents/:docId/download", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const [doc] = await withAuthSafeDb(async (authDb) => authDb.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  try {
    const objectFile = await storage.getObjectEntityFile(doc.objectPath);
    const response = await storage.downloadObject(objectFile);
    await writeAuditLog(
      {
        firmId: doc.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.download",
        entityType: "platform_document",
        entityId: docId,
        detail: `name=${doc.name} fileName=${doc.fileName}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { strict: true }
    );
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const ascii = String(doc.fileName ?? "download").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "download";
    const encoded = encodeURIComponent(String(doc.fileName ?? ascii));
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error, docId }, "platform.document.download_failed");
    res.status(500).json({ error: "Failed to download document" });
  }
});

// ─── PDF Mappings ─────────────────────────────────────────────────────────────

router.get("/platform/documents/:docId/pdf-mappings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const [doc] = await db.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json({ mappings: doc.pdfMappings ?? { pages: [] } });
});

router.put("/platform/documents/:docId/pdf-mappings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const { mappings } = req.body as { mappings: any };
  const [doc] = await db.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  await db.update(platformDocumentsTable).set({ pdfMappings: mappings }).where(eq(platformDocumentsTable.id, docId));
  res.json({ success: true });
});

// ─── Platform Messages (Communication Hub) ───────────────────────────────────

router.get("/platform/messages", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const firmIdStr = one(req.query.firmId as any);
  const firmId = firmIdStr ? parseInt(firmIdStr, 10) : undefined;

  const msgs = await db
    .select()
    .from(platformMessagesTable)
    .where(
      firmId
        ? or(eq(platformMessagesTable.fromFirmId, firmId), eq(platformMessagesTable.toFirmId, firmId))
        : undefined
    )
    .orderBy(desc(platformMessagesTable.createdAt))
    .limit(100);

  const enriched = await Promise.all(
    msgs.map(async (m) => {
      const [sender] = await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, m.fromUserId));
      const attachments = await db.select().from(platformMessageAttachmentsTable).where(eq(platformMessageAttachmentsTable.messageId, m.id));
      let firmName: string | null = null;
      if (m.fromFirmId) {
        const [f] = await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, m.fromFirmId));
        firmName = f?.name ?? null;
      } else if (m.toFirmId) {
        const [f] = await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, m.toFirmId));
        firmName = f?.name ?? null;
      }
      return { ...m, senderName: sender?.name ?? "Unknown", senderEmail: sender?.email ?? "", firmName, attachments };
    })
  );

  res.json(enriched);
});

router.post("/platform/messages", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { subject, body, toFirmId, parentId, attachments } = req.body as {
    subject: string;
    body: string;
    toFirmId: number;
    parentId?: number;
    attachments?: Array<{ fileName: string; fileType: string; fileSize?: number; objectPath: string }>;
  };
  if (!subject || !body || !toFirmId) {
    res.status(400).json({ error: "subject, body and toFirmId are required" });
    return;
  }
  const [msg] = await db
    .insert(platformMessagesTable)
    .values({
      subject,
      body,
      fromFirmId: null,
      fromUserId: req.userId!,
      toFirmId,
      parentId: parentId ?? null,
    })
    .returning();

  if (attachments && attachments.length > 0) {
    await db.insert(platformMessageAttachmentsTable).values(
      attachments.map((a) => ({ messageId: msg.id, fileName: a.fileName, fileType: a.fileType, fileSize: a.fileSize ?? null, objectPath: a.objectPath }))
    );
  }

  res.status(201).json(msg);
});

router.patch("/platform/messages/:msgId/read", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const msgIdStr = one(req.params.msgId);
  const msgId = msgIdStr ? parseInt(msgIdStr, 10) : NaN;
  if (isNaN(msgId)) { res.status(400).json({ error: "Invalid message ID" }); return; }
  await db.update(platformMessagesTable).set({ readAt: new Date() }).where(eq(platformMessagesTable.id, msgId));
  res.json({ success: true });
});

export default router;
