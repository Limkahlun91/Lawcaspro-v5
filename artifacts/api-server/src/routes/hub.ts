import { Router, type IRouter } from "express";
import { eq, or, desc } from "drizzle-orm";
import {
  db,
  usersTable,
  firmsTable,
  platformMessagesTable,
  platformMessageAttachmentsTable,
  platformDocumentsTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

// ─── Firm → Founder messages ──────────────────────────────────────────────────

router.get("/hub/messages", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const firmId = req.firmId!;

  const msgs = await db
    .select()
    .from(platformMessagesTable)
    .where(or(eq(platformMessagesTable.fromFirmId, firmId), eq(platformMessagesTable.toFirmId, firmId)))
    .orderBy(desc(platformMessagesTable.createdAt))
    .limit(100);

  const enriched = await Promise.all(
    msgs.map(async (m) => {
      const [sender] = await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, m.fromUserId));
      const attachments = await db.select().from(platformMessageAttachmentsTable).where(eq(platformMessageAttachmentsTable.messageId, m.id));
      const direction = m.fromFirmId === firmId ? "outgoing" : "incoming";
      return { ...m, senderName: sender?.name ?? "Unknown", senderEmail: sender?.email ?? "", direction, attachments };
    })
  );

  res.json(enriched);
});

router.post("/hub/messages", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
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
  const [msg] = await db
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
    await db.insert(platformMessageAttachmentsTable).values(
      attachments.map((a) => ({ messageId: msg.id, fileName: a.fileName, fileType: a.fileType, fileSize: a.fileSize ?? null, objectPath: a.objectPath }))
    );
  }

  res.status(201).json(msg);
});

router.patch("/hub/messages/:msgId/read", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const firmId = req.firmId!;
  const msgId = parseInt(req.params.msgId, 10);
  const [msg] = await db.select().from(platformMessagesTable).where(eq(platformMessagesTable.id, msgId));
  if (!msg || msg.toFirmId !== firmId) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  await db.update(platformMessagesTable).set({ readAt: new Date() }).where(eq(platformMessagesTable.id, msgId));
  res.json({ success: true });
});

// ─── System Documents (visible to firm) ──────────────────────────────────────

router.get("/hub/documents", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const firmId = req.firmId!;
  const docs = await db
    .select()
    .from(platformDocumentsTable)
    .where(
      or(eq(platformDocumentsTable.firmId, firmId), eq(platformDocumentsTable.firmId, 0))
    )
    .orderBy(desc(platformDocumentsTable.createdAt));

  // Also get docs with null firm_id (shared with all)
  const sharedDocs = await db
    .select()
    .from(platformDocumentsTable)
    .where(eq(platformDocumentsTable.firmId, null as unknown as number))
    .orderBy(desc(platformDocumentsTable.createdAt));

  const firmDocs = await db
    .select()
    .from(platformDocumentsTable)
    .where(eq(platformDocumentsTable.firmId, firmId))
    .orderBy(desc(platformDocumentsTable.createdAt));

  const all = [...sharedDocs, ...firmDocs];
  const unique = all.filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i);
  unique.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json(unique);
});

export default router;
