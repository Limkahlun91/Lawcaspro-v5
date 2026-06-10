import express, { type Response, type Router as ExpressRouter } from "express";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import {
  DraftCreateSchema,
  DraftPatchSchema,
  ManualEmailCreateSchema,
  MessageAssignSchema,
  MessageLinkCaseSchema,
  TaskAssignSchema,
  TaskCreateSchema,
  TaskLinkCaseSchema,
  TaskReplyNoteSchema,
  TaskStatusUpdateSchema,
} from "../modules/communication/communication.types.js";
import {
  acknowledgeTask,
  approveDraft,
  assignMessageOwner,
  assignTask,
  cancelDraft,
  closeMessage,
  closeTask,
  createDraft,
  createManualIncomingEmail,
  createMessageTask,
  getAuditForDraft,
  getAuditForMessage,
  getAuditForTask,
  getCaseCommunicationTimeline,
  getCommunicationMessage,
  getDraftDetail,
  getSlaOverdue,
  getSlaSummary,
  linkMessageCase,
  linkTaskCase,
  listCommunicationMailboxes,
  listCommunicationMessages,
  listDraftsForFirm,
  listMessageTasks,
  listMyTasks,
  updateTaskReplyNote,
  updateTaskStatus,
  patchDraft,
  submitDraftApproval,
  viewMessage,
  markDraftSent,
} from "../modules/communication/communication.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const getRlsDb = (req: AuthRequest, res: Response) => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Internal Server Error" });
    return null;
  }
  return r as any;
};

router.get("/communication/mailboxes", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const channel = one((req.query as any).channel);
  const rows = await listCommunicationMailboxes({ r, firmId: req.firmId!, channel: channel ?? undefined });
  res.json(rows);
});

router.get("/communication/messages", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const limit = Math.min(parseInt(one((req.query as any).limit) ?? "50", 10) || 50, 200);
  const offset = parseInt(one((req.query as any).offset) ?? "0", 10) || 0;
  const statusRaw = one((req.query as any).status) ?? undefined;
  const status = statusRaw?.includes(",") ? statusRaw.split(",").map((value) => value.trim()).filter(Boolean) : statusRaw;
  const isBatchRaw = one((req.query as any).isBatch);
  const isBatch = typeof isBatchRaw === "string" ? (isBatchRaw === "true" ? true : isBatchRaw === "false" ? false : undefined) : undefined;
  const assignedTo = (one((req.query as any).assignedTo) as any) ?? "any";
  const linkedCaseIdRaw = one((req.query as any).linkedCaseId);
  const linkedCaseId = linkedCaseIdRaw ? parseInt(linkedCaseIdRaw, 10) : undefined;
  const rows = await listCommunicationMessages({
    r,
    firmId: req.firmId!,
    userId: req.userId!,
    filter: { status, isBatch, assignedTo, linkedCaseId: Number.isFinite(linkedCaseId as any) ? (linkedCaseId as any) : undefined },
    limit,
    offset,
  });
  res.json(rows);
});

router.get("/communication/messages/:id", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const msg = await getCommunicationMessage({ r, firmId: req.firmId!, messageId: id });
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }
  res.json(msg);
});

router.post("/communication/messages/manual-email", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const parsed = ManualEmailCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  try {
    const created = await createManualIncomingEmail({ r, req, input: parsed.data as any });
    res.status(201).json(created);
  } catch (error) {
    const message = error instanceof Error ? error.message : "manual_email_create_failed";
    if (message === "case_not_found") {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    if (message === "mailbox_not_found" || message === "invalid_mailbox_channel") {
      res.status(400).json({ error: "Invalid mailbox" });
      return;
    }
    throw error;
  }
});

router.post("/communication/messages/:id/view", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const msg = await viewMessage({ r, req, messageId: id });
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

router.patch("/communication/messages/:id/assign", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = MessageAssignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const msg = await assignMessageOwner({ r, req, messageId: id, assignedToUserId: parsed.data.assignedToUserId });
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }
  res.json(msg);
});

router.patch("/communication/messages/:id/link-case", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = MessageLinkCaseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await linkMessageCase({ r, req, messageId: id, caseId: parsed.data.caseId ?? null, caseRef: parsed.data.caseRef ?? null });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "case_not_found") { res.status(404).json({ error: "Case not found" }); return; }
  res.json(result);
});

router.patch("/communication/messages/:id/close", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const msg = await closeMessage({ r, req, messageId: id });
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }
  res.json(msg);
});

router.get("/communication/messages/:id/tasks", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const rows = await listMessageTasks({ r, firmId: req.firmId!, messageId: id });
  res.json(rows);
});

router.get("/communication/tasks/mine", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const limit = Math.min(parseInt(one((req.query as any).limit) ?? "50", 10) || 50, 200);
  const offset = parseInt(one((req.query as any).offset) ?? "0", 10) || 0;
  const rows = await listMyTasks({ r, firmId: req.firmId!, userId: req.userId!, limit, offset });
  res.json(rows);
});

router.post("/communication/messages/:id/tasks", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = TaskCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const task = await createMessageTask({ r, req, parentMessageId: id, input: parsed.data as any });
  if (!task) { res.status(404).json({ error: "Message not found" }); return; }
  res.status(201).json(task);
});

router.patch("/communication/tasks/:taskId/assign", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const parsed = TaskAssignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await assignTask({ r, req, taskId: id, assignedToUserId: parsed.data.assignedToUserId });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.patch("/communication/tasks/:taskId/acknowledge", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const result = await acknowledgeTask({ r, req, taskId: id });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.patch("/communication/tasks/:taskId/status", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const parsed = TaskStatusUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await updateTaskStatus({ r, req, taskId: id, taskStatus: parsed.data.taskStatus });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.patch("/communication/tasks/:taskId/reply-note", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const parsed = TaskReplyNoteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await updateTaskReplyNote({ r, req, taskId: id, replyNote: parsed.data.replyNote ?? null });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.patch("/communication/tasks/:taskId/link-case", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const parsed = TaskLinkCaseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await linkTaskCase({ r, req, taskId: id, caseId: parsed.data.caseId ?? null, caseRef: parsed.data.caseRef ?? null });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "case_not_found") { res.status(404).json({ error: "Case not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.patch("/communication/tasks/:taskId/close", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const result = await closeTask({ r, req, taskId: id });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.post("/communication/drafts/consolidated", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const parsed = DraftCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const draft = await createDraft({ r, req, draftType: "consolidated", parentMessageId: parsed.data.parentMessageId, taskIds: parsed.data.taskIds, to: parsed.data.to, cc: parsed.data.cc, bcc: parsed.data.bcc, subject: parsed.data.subject ?? null });
  if (!draft) { res.status(404).json({ error: "Not found" }); return; }
  if ((draft as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  if ((draft as any).error === "no_tasks") { res.status(400).json({ error: "No tasks selected" }); return; }
  res.status(201).json(draft);
});

router.post("/communication/drafts/partial", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const parsed = DraftCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const draft = await createDraft({ r, req, draftType: "partial", parentMessageId: parsed.data.parentMessageId, taskIds: parsed.data.taskIds, to: parsed.data.to, cc: parsed.data.cc, bcc: parsed.data.bcc, subject: parsed.data.subject ?? null });
  if (!draft) { res.status(404).json({ error: "Not found" }); return; }
  if ((draft as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  if ((draft as any).error === "no_tasks") { res.status(400).json({ error: "No tasks selected" }); return; }
  res.status(201).json(draft);
});

router.get("/communication/drafts", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const limit = Math.min(parseInt(one((req.query as any).limit) ?? "50", 10) || 50, 200);
  const offset = parseInt(one((req.query as any).offset) ?? "0", 10) || 0;
  const status = one((req.query as any).status) ?? undefined;
  const drafts = await listDraftsForFirm({ r, firmId: req.firmId!, status, limit, offset });
  res.json(drafts);
});

router.get("/communication/drafts/:draftId", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).draftId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const draft = await getDraftDetail({ r, firmId: req.firmId!, draftId: id });
  if (!draft) { res.status(404).json({ error: "Not found" }); return; }
  res.json(draft);
});

router.patch("/communication/drafts/:draftId", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).draftId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const parsed = DraftPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await patchDraft({ r, req, draftId: id, patch: parsed.data });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.post("/communication/drafts/:draftId/submit-approval", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).draftId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const result = await submitDraftApproval({ r, req, draftId: id });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  res.json(result);
});

router.post("/communication/drafts/:draftId/approve", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).draftId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const result = await approveDraft({ r, req, draftId: id });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.post("/communication/drafts/:draftId/mark-sent", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).draftId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const result = await markDraftSent({ r, req, draftId: id });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  if ((result as any).error === "not_approved") { res.status(400).json({ error: "Draft not approved" }); return; }
  res.json(result);
});

router.post("/communication/drafts/:draftId/cancel", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).draftId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const result = await cancelDraft({ r, req, draftId: id });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.get("/communication/audit/message/:messageId", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).messageId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const rows = await getAuditForMessage({ r, firmId: req.firmId!, messageId: id });
  res.json(rows);
});

router.get("/communication/audit/task/:taskId", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const rows = await getAuditForTask({ r, firmId: req.firmId!, taskId: id });
  res.json(rows);
});

router.get("/communication/audit/draft/:draftId", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).draftId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const rows = await getAuditForDraft({ r, firmId: req.firmId!, draftId: id });
  res.json(rows);
});

router.get("/communication/sla/summary", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const data = await getSlaSummary({ r, firmId: req.firmId!, userId: req.userId! });
  res.json(data);
});

router.get("/communication/sla/overdue", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const limit = Math.min(parseInt(one((req.query as any).limit) ?? "50", 10) || 50, 200);
  const offset = parseInt(one((req.query as any).offset) ?? "0", 10) || 0;
  const data = await getSlaOverdue({ r, firmId: req.firmId!, userId: req.userId!, limit, offset });
  res.json(data);
});

router.get("/cases/:caseId/communication-timeline", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) { res.status(400).json({ error: "Invalid case id" }); return; }
  const data = await getCaseCommunicationTimeline({ r, firmId: req.firmId!, caseId });
  res.json(data);
});

export default expressRouter;
