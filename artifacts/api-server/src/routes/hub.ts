import { Router, type IRouter } from "express";
import { eq, or, desc, isNull, and, inArray } from "drizzle-orm";
import {
  usersTable,
  systemFoldersTable,
  platformMessagesTable,
  platformMessageAttachmentsTable,
  platformDocumentsTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";
import { Readable } from "stream";
import { getSupabaseStorageConfigError, ObjectNotFoundError, SupabaseStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const one = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
};

const getRlsDb = (req: AuthRequest, res: any): NonNullable<AuthRequest["rlsDb"]> | null => {
  const r = req.rlsDb;
  if (!r) {
    logger.error({ route: req.originalUrl, userId: req.userId ?? null, firmId: req.firmId ?? null }, "rls.missing_context");
    res.status(503).json({ error: "Tenant context temporarily unavailable", code: "RLS_CONTEXT" });
    return null;
  }
  return r;
};

const router: IRouter = Router();
const supabaseStorage = new SupabaseStorageService();

function safeFilenameAscii(filename: string): string {
  const base = filename.replace(/[\r\n"]/g, "").trim();
  if (!base) return "download";
  return base.replace(/[^\x20-\x7E]/g, "_");
}

function encodeRFC5987ValueChars(str: string): string {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A")
    .replace(/%(7C|60|5E)/g, (m) => m.toLowerCase());
}

function contentDispositionAttachment(filename: string): string {
  const ascii = safeFilenameAscii(filename);
  const encoded = encodeRFC5987ValueChars(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ─── Firm → Founder messages ──────────────────────────────────────────────────

router.get("/hub/messages", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;

  try {
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
  } catch (err) {
    logger.error({ err, route: req.originalUrl, firmId: req.firmId ?? null, userId: req.userId ?? null }, "hub.messages_failed");
    res.status(503).json({ error: "Failed to load messages" });
  }
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

router.get("/hub/messages/:msgId/attachments/:attachmentId/download", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;

  const msgIdStr = one(req.params.msgId);
  const attachmentIdStr = one(req.params.attachmentId);
  const msgId = msgIdStr ? parseInt(msgIdStr, 10) : NaN;
  const attachmentId = attachmentIdStr ? parseInt(attachmentIdStr, 10) : NaN;
  if (!Number.isFinite(msgId) || !Number.isFinite(attachmentId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [msg] = await r
    .select()
    .from(platformMessagesTable)
    .where(and(eq(platformMessagesTable.id, msgId), or(eq(platformMessagesTable.fromFirmId, firmId), eq(platformMessagesTable.toFirmId, firmId))));
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  const [att] = await r
    .select()
    .from(platformMessageAttachmentsTable)
    .where(and(eq(platformMessageAttachmentsTable.id, attachmentId), eq(platformMessageAttachmentsTable.messageId, msgId)));
  if (!att) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  try {
    const response = await supabaseStorage.fetchPrivateObjectResponse(att.objectPath);

    await writeAuditLog({
      firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "hub.message_attachment.download",
      entityType: "platform_message_attachment",
      entityId: attachmentId,
      detail: `messageId=${msgId} fileName=${att.fileName}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Content-Disposition", contentDispositionAttachment(String(att.fileName ?? "download")));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "File not found" }); return; }
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) { res.status(cfgErr.statusCode).json({ error: cfgErr.error }); return; }
    res.status(500).json({ error: "Failed to download attachment" });
  }
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

  try {
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
  } catch (err) {
    logger.error({ err, route: req.originalUrl, firmId: req.firmId ?? null, userId: req.userId ?? null }, "hub.documents_failed");
    res.status(503).json({ error: "Failed to load documents" });
  }
});

router.get("/hub/documents/:docId/download", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const firmId = req.firmId!;

  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (!Number.isFinite(docId)) {
    res.status(400).json({ error: "Invalid document ID" });
    return;
  }

  const [doc] = await r
    .select()
    .from(platformDocumentsTable)
    .where(and(eq(platformDocumentsTable.id, docId), or(isNull(platformDocumentsTable.firmId), eq(platformDocumentsTable.firmId, firmId))));

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  try {
    const response = await supabaseStorage.fetchPrivateObjectResponse(doc.objectPath);

    await writeAuditLog({
      firmId: doc.firmId ?? firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "hub.document.download",
      entityType: "platform_document",
      entityId: docId,
      detail: `name=${doc.name} fileName=${doc.fileName}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Content-Disposition", contentDispositionAttachment(String(doc.fileName ?? "download")));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      res.status(cfgErr.statusCode).json({ error: cfgErr.error });
      return;
    }
    res.status(500).json({ error: "Failed to download document" });
  }
});

export default router;
