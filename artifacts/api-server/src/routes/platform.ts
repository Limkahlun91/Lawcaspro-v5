import { Router, type IRouter } from "express";
import { eq, ilike, count, sql, desc, and, isNull, or } from "drizzle-orm";
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
import { requireAuth, requireFounder, type AuthRequest } from "../lib/auth";
import bcrypt from "bcryptjs";
import { ObjectStorageService } from "../lib/objectStorage";

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
      const docCount = Number((Array.isArray(docRes) ? docRes[0] : (docRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);
      const billingRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_billing_entries WHERE firm_id = ${firm.id}`);
      const billingCount = Number((Array.isArray(billingRes) ? billingRes[0] : (billingRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);
      const commRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_communications WHERE firm_id = ${firm.id}`);
      const commCount = Number((Array.isArray(commRes) ? commRes[0] : (commRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);
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
  const firmId = parseInt(req.params.firmId, 10);
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
  const firmId = parseInt(req.params.firmId, 10);
  const userId = parseInt(req.params.userId, 10);
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
  const totalDocuments = Number((Array.isArray(docsRes) ? docsRes[0] : (docsRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);
  res.json({ totalFirms: Number(totalFirmsRes?.c ?? 0), activeFirms: Number(activeFirmsRes?.c ?? 0), totalUsers: Number(totalUsersRes?.c ?? 0), totalCases: Number(totalCasesRes?.c ?? 0), totalDocuments });
});

// ─── System Folders ───────────────────────────────────────────────────────────

router.get("/platform/folders", requireAuth, requireFounder, async (_req: AuthRequest, res): Promise<void> => {
  const folders = await db
    .select()
    .from(systemFoldersTable)
    .orderBy(systemFoldersTable.sortOrder, systemFoldersTable.name);
  res.json(folders);
});

router.post("/platform/folders", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { name, parentId } = req.body as { name: string; parentId?: number | null };
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Folder name is required" });
    return;
  }
  const maxSort = await db.execute(
    sql`SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort FROM system_folders WHERE ${parentId ? sql`parent_id = ${parentId}` : sql`parent_id IS NULL`}`
  );
  const nextSort = Number((Array.isArray(maxSort) ? maxSort[0] : (maxSort as any).rows[0])?.next_sort ?? 0);
  const [folder] = await db
    .insert(systemFoldersTable)
    .values({ name: name.trim(), parentId: parentId ?? null, sortOrder: nextSort })
    .returning();
  res.status(201).json(folder);
});

router.patch("/platform/folders/:folderId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const folderId = parseInt(req.params.folderId, 10);
  if (isNaN(folderId)) { res.status(400).json({ error: "Invalid folder ID" }); return; }
  const { name, isDisabled } = req.body as { name?: string; isDisabled?: boolean };
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name.trim();
  if (isDisabled !== undefined) updates.isDisabled = isDisabled;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  const [folder] = await db.update(systemFoldersTable).set(updates).where(eq(systemFoldersTable.id, folderId)).returning();
  if (!folder) { res.status(404).json({ error: "Folder not found" }); return; }
  res.json(folder);
});

router.delete("/platform/folders/:folderId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const folderId = parseInt(req.params.folderId, 10);
  if (isNaN(folderId)) { res.status(400).json({ error: "Invalid folder ID" }); return; }
  const [folder] = await db.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
  if (!folder) { res.status(404).json({ error: "Folder not found" }); return; }
  const [childCount] = await db.select({ c: count() }).from(systemFoldersTable).where(eq(systemFoldersTable.parentId, folderId));
  if (Number(childCount?.c ?? 0) > 0) {
    res.status(400).json({ error: "Cannot delete folder with subfolders. Remove subfolders first." });
    return;
  }
  const [docCount] = await db.select({ c: count() }).from(platformDocumentsTable).where(eq(platformDocumentsTable.folderId, folderId));
  if (Number(docCount?.c ?? 0) > 0) {
    res.status(400).json({ error: "Cannot delete folder with documents. Remove or move documents first." });
    return;
  }
  await db.delete(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
  res.json({ success: true });
});

router.post("/platform/folders/reorder", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { folderId, direction } = req.body as { folderId: number; direction: "up" | "down" };
  if (!folderId || !direction) { res.status(400).json({ error: "folderId and direction required" }); return; }
  const [folder] = await db.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
  if (!folder) { res.status(404).json({ error: "Folder not found" }); return; }

  const siblings = await db
    .select()
    .from(systemFoldersTable)
    .where(folder.parentId ? eq(systemFoldersTable.parentId, folder.parentId) : isNull(systemFoldersTable.parentId))
    .orderBy(systemFoldersTable.sortOrder);

  const idx = siblings.findIndex(s => s.id === folderId);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) { res.json({ success: true }); return; }

  const swapFolder = siblings[swapIdx];
  await db.update(systemFoldersTable).set({ sortOrder: swapFolder.sortOrder }).where(eq(systemFoldersTable.id, folder.id));
  await db.update(systemFoldersTable).set({ sortOrder: folder.sortOrder }).where(eq(systemFoldersTable.id, swapFolder.id));
  res.json({ success: true });
});

// ─── Platform Documents ───────────────────────────────────────────────────────

router.get("/platform/documents", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const firmId = req.query.firmId ? parseInt(req.query.firmId as string, 10) : undefined;
  const folderId = req.query.folderId ? parseInt(req.query.folderId as string, 10) : undefined;
  let condition;
  if (firmId) condition = eq(platformDocumentsTable.firmId, firmId);
  if (folderId !== undefined) {
    const folderCondition = eq(platformDocumentsTable.folderId, folderId);
    condition = condition ? and(condition, folderCondition) : folderCondition;
  }
  const docs = await db
    .select()
    .from(platformDocumentsTable)
    .where(condition)
    .orderBy(desc(platformDocumentsTable.createdAt));
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
  const [doc] = await db
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
  res.status(201).json(doc);
});

router.delete("/platform/documents/:docId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docId = parseInt(req.params.docId, 10);
  const [doc] = await db.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  await db.delete(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
  res.json({ success: true });
});

// ─── PDF Mappings ─────────────────────────────────────────────────────────────

router.get("/platform/documents/:docId/pdf-mappings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docId = parseInt(req.params.docId, 10);
  const [doc] = await db.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json({ mappings: doc.pdfMappings ?? { pages: [] } });
});

router.put("/platform/documents/:docId/pdf-mappings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docId = parseInt(req.params.docId, 10);
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
  const firmId = req.query.firmId ? parseInt(req.query.firmId as string, 10) : undefined;

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
  const msgId = parseInt(req.params.msgId, 10);
  await db.update(platformMessagesTable).set({ readAt: new Date() }).where(eq(platformMessagesTable.id, msgId));
  res.json({ success: true });
});

export default router;
