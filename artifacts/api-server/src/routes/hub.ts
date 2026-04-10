import { Router, type IRouter } from "express";
import { eq, or, desc, isNull, and, inArray } from "drizzle-orm";
import {
  usersTable,
  systemFoldersTable,
  platformMessagesTable,
  platformMessageAttachmentsTable,
  platformDocumentsTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth";

const one = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
};

const getRlsDb = (req: AuthRequest, res: any): NonNullable<AuthRequest["rlsDb"]> | null => {
  const r = req.rlsDb;
  if (!r) {
    (req as any).log?.error?.({ route: req.originalUrl, userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
    res.status(500).json({ error: "Internal Server Error" });
    return null;
  }
  return r;
};

const router: IRouter = Router();

// ─── Firm → Founder messages ──────────────────────────────────────────────────

router.get("/hub/messages", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;

  const msgs = await r
    .select()
    .from(platformMessagesTable)
    .where(or(eq(platformMessagesTable.fromFirmId, firmId), eq(platformMessagesTable.toFirmId, firmId)))
    .orderBy(desc(platformMessagesTable.createdAt))
    .limit(100);

  const enriched = await Promise.all(
    msgs.map(async (m) => {
      const [sender] = await r.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, m.fromUserId));
      const attachments = await r.select().from(platformMessageAttachmentsTable).where(eq(platformMessageAttachmentsTable.messageId, m.id));
      const direction = m.fromFirmId === firmId ? "outgoing" : "incoming";
      return { ...m, senderName: sender?.name ?? "Unknown", senderEmail: sender?.email ?? "", direction, attachments };
    })
  );

  res.json(enriched);
});

router.post("/hub/messages", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;
  const { subject, body, parentId, attachments } = req.body as {
    subject: string;
    body: string;
    parentId?: number;
    attachments?: Array<{ fileName: string; fileType: string; fileSize?: number; objectPath: string }>;
  };
  if (!subject || !body) {
    res.status(400).json({ error: "subject and body are required" });
    return;
  }
  const [msg] = await r
    .insert(platformMessagesTable)
    .values({
      subject,
      body,
      fromFirmId: firmId,
      fromUserId: req.userId!,
      toFirmId: null,
      parentId: parentId ?? null,
    })
    .returning();

  if (attachments && attachments.length > 0) {
    await r.insert(platformMessageAttachmentsTable).values(
      attachments.map((a) => ({ messageId: msg.id, fileName: a.fileName, fileType: a.fileType, fileSize: a.fileSize ?? null, objectPath: a.objectPath }))
    );
  }

  res.status(201).json(msg);
});

router.patch("/hub/messages/:msgId/read", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;
  const msgIdStr = one(req.params.msgId);
  const msgId = msgIdStr ? parseInt(msgIdStr, 10) : NaN;
  if (isNaN(msgId)) { res.status(400).json({ error: "Invalid message ID" }); return; }
  const [msg] = await r.select().from(platformMessagesTable).where(eq(platformMessagesTable.id, msgId));
  if (!msg || msg.toFirmId !== firmId) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  await r.update(platformMessagesTable).set({ readAt: new Date() }).where(eq(platformMessagesTable.id, msgId));
  res.json({ success: true });
});

// ─── System Folders (visible to firm, read-only) ────────────────────────────

router.get("/hub/folders", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const folders = await r
    .select()
    .from(systemFoldersTable)
    .where(eq(systemFoldersTable.isDisabled, false))
    .orderBy(systemFoldersTable.sortOrder, systemFoldersTable.name);
  res.json(folders);
});

// ─── System Documents (visible to firm) ──────────────────────────────────────

router.get("/hub/documents", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;
  const folderIdStr = one((req.query as Record<string, unknown>).folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : undefined;

  const disabledFolders = await r
    .select({ id: systemFoldersTable.id })
    .from(systemFoldersTable)
    .where(eq(systemFoldersTable.isDisabled, true));
  const disabledIds = disabledFolders.map(f => f.id);

  const allDocs = await r
    .select()
    .from(platformDocumentsTable)
    .where(or(isNull(platformDocumentsTable.firmId), eq(platformDocumentsTable.firmId, firmId)))
    .orderBy(desc(platformDocumentsTable.createdAt));

  const unique = allDocs.filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i);

  let filtered = unique.filter(d => !d.folderId || !disabledIds.includes(d.folderId));

  if (folderId !== undefined) {
    filtered = filtered.filter(d => d.folderId === folderId);
  }

  res.json(filtered);
});

export default router;
