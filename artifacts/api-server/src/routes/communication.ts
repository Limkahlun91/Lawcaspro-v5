import express, { type NextFunction, type Response, type Router as ExpressRouter } from "express";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import {
  DraftCreateSchema,
  DraftPatchSchema,
  EmailAccountPatchSchema,
  ManualEmailCreateSchema,
  MessageArchivePatchSchema,
  MessageAssigneesPatchSchema,
  MessageAssignSchema,
  MessageTeamPatchSchema,
  MessageLinkCaseSchema,
  MessageReadStatusPatchSchema,
  EmailAccountCreateSchema,
  EmailFolderPatchSchema,
  ImapConnectionInputSchema,
  MicrosoftConnectQuerySchema,
  RemarkCreateSchema,
  RemarkPatchSchema,
  TaskAssignSchema,
  TaskCreateSchema,
  TaskTeamPatchSchema,
  TaskLinkCaseSchema,
  TaskReplyNoteSchema,
  TaskStatusUpdateSchema,
} from "../modules/communication/communication.types.js";
import {
  acknowledgeTask,
  approveDraft,
  assignMessageOwner,
  assignTask,
  archiveMessage,
  cancelDraft,
  closeMessage,
  closeTask,
  completeMicrosoftOauth,
  connectImapMailbox,
  createDraft,
  createEmailAccount,
  createManualIncomingEmail,
  createMessageRemark,
  createMessageTask,
  disconnectEmailAccount,
  deleteMessageRemark,
  setMessageResponsibleTeam,
  setTaskResponsibleTeam,
  getAuditForDraft,
  getAuditForMessage,
  getAuditForTask,
  getCaseCommunicationTimeline,
  getCommunicationMessage,
  getMessageAssignees,
  getDraftDetail,
  getSlaOverdue,
  getSlaSummary,
  linkMessageCase,
  unlinkMessageCase,
  linkTaskCase,
  listCommunicationMailboxes,
  listCommunicationMessages,
  listConnectedEmailAccounts,
  listEmailFolders,
  listMessageAttachments,
  listEmailSyncLogs,
  listMessageReads,
  listMessageRemarks,
  lookupCasesForCommunication,
  listDraftsForFirm,
  listMessageTasks,
  listMyTasks,
  importEmailNow,
  patchEmailAccountDetails,
  patchEmailFolderDetails,
  recordMessageOpened,
  setMessageAssignees,
  startMicrosoftOauth,
  syncEmailAccountFolders,
  testImapMailbox,
  updateTaskReplyNote,
  updateMessageReadStatus,
  updateMessageRemark,
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
  const unreadRaw = one((req.query as any).unread);
  const unreadOnly = unreadRaw === "true" || unreadRaw === "1";
  const q = one((req.query as any).q) ?? undefined;
  const rows = await listCommunicationMessages({
    r,
    firmId: req.firmId!,
    userId: req.userId!,
    filter: { status, isBatch, assignedTo, linkedCaseId: Number.isFinite(linkedCaseId as any) ? (linkedCaseId as any) : undefined, unreadOnly, q },
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
    if (message === "missing_to_addresses") {
      res.status(400).json({ error: "At least one recipient is required" });
      return;
    }
    if (message === "invalid_received_at") {
      res.status(400).json({ error: "Invalid received date/time" });
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

router.patch("/communication/messages/:id/team", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = MessageTeamPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const msg = await setMessageResponsibleTeam({ r, req, messageId: id, team: parsed.data as any });
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

router.delete("/communication/messages/:id/link-case", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const updated = await unlinkMessageCase({ r, req, messageId: id });
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.patch("/communication/messages/:id/archive", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = MessageArchivePatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const updated = await archiveMessage({ r, req, messageId: id, archived: parsed.data.archived });
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.get("/communication/messages/:id/assignees", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const result = await getMessageAssignees({ r, req, messageId: id });
  res.json(result);
});

router.patch("/communication/messages/:id/assignees", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = MessageAssigneesPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await setMessageAssignees({ r, req, messageId: id, userIds: parsed.data.userIds });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  res.json(result);
});

router.get("/communication/messages/:id/remarks", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const rows = await listMessageRemarks({ r, req, messageId: id });
  res.json(rows);
});

router.post("/communication/messages/:id/remarks", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = RemarkCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const created = await createMessageRemark({ r, req, messageId: id, body: parsed.data.body });
  if (!created) { res.status(404).json({ error: "Not found" }); return; }
  if ((created as any).error === "empty_body") { res.status(400).json({ error: "Remark body is required" }); return; }
  res.status(201).json(created);
});

router.patch("/communication/remarks/:remarkId", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).remarkId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid remark id" }); return; }
  const parsed = RemarkPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const updated = await updateMessageRemark({ r, req, remarkId: id, body: parsed.data.body });
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  if ((updated as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  if ((updated as any).error === "empty_body") { res.status(400).json({ error: "Remark body is required" }); return; }
  if ((updated as any).error === "deleted") { res.status(409).json({ error: "Remark already deleted" }); return; }
  res.json(updated);
});

router.delete("/communication/remarks/:remarkId", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).remarkId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid remark id" }); return; }
  const result = await deleteMessageRemark({ r, req, remarkId: id });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  if ((result as any).error === "forbidden") { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(result);
});

router.get("/communication/messages/:id/reads", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const rows = await listMessageReads({ r, req, messageId: id });
  res.json(rows);
});

router.get("/communication/messages/:id/attachments", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const rows = await listMessageAttachments({ r, req, messageId: id });
  if (!rows) { res.status(404).json({ error: "Not found" }); return; }
  res.json(rows);
});

router.post("/communication/messages/:id/read", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const updated = await recordMessageOpened({ r, req, messageId: id });
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.patch("/communication/messages/:id/read-status", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
  const parsed = MessageReadStatusPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const updated = await updateMessageReadStatus({ r, req, messageId: id, isRead: parsed.data.isRead });
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

const sendProviderError = (res: Response, error: unknown) => {
  const status = typeof (error as any)?.status === "number" ? Number((error as any).status) : 500;
  const message = error instanceof Error ? error.message : "Internal Server Error";
  const code = typeof (error as any)?.code === "string" ? String((error as any).code) : "EMAIL_PROVIDER_ERROR";
  res.status(status).json({
    error: message,
    code,
    requestId: typeof (res.locals as any)?.requestId === "string" ? String((res.locals as any).requestId) : null,
  });
};

router.get("/communication/email/microsoft/connect", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  try {
    const parsed = MicrosoftConnectQuerySchema.safeParse({ returnTo: one((req.query as any).returnTo) ?? null });
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
    const result = await startMicrosoftOauth({ req, returnTo: parsed.data.returnTo ?? null });
    res.json(result);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.get("/communication/email/microsoft/callback", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const code = one((req.query as any).code) ?? "";
  const state = one((req.query as any).state) ?? "";
  const providerError = one((req.query as any).error) ?? "";
  if (providerError) {
    const description = one((req.query as any).error_description) ?? providerError;
    res.status(400).json({ error: description, code: providerError });
    return;
  }
  if (!code || !state) {
    res.status(400).json({ error: "Missing Microsoft OAuth callback parameters." });
    return;
  }
  try {
    const result = await completeMicrosoftOauth({ r, req, code, state });
    const target = new URL(result.returnTo);
    target.searchParams.set("provider", "microsoft_graph");
    target.searchParams.set("providerStatus", "connected");
    target.searchParams.set("accountId", String(result.account.id));
    res.redirect(target.toString());
  } catch (error) {
    const fallback = one((req.query as any).returnTo);
    if (fallback) {
      try {
        const target = new URL(fallback);
        target.searchParams.set("provider", "microsoft_graph");
        target.searchParams.set("providerStatus", "error");
        target.searchParams.set("providerError", error instanceof Error ? error.message : "Microsoft connection failed");
        res.redirect(target.toString());
        return;
      } catch {
        // Fall through to JSON error.
      }
    }
    sendProviderError(res, error);
  }
});

router.post("/communication/email/imap/test", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  try {
    const parsed = ImapConnectionInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
    const result = await testImapMailbox({ req, input: {
      emailAddress: parsed.data.emailAddress,
      displayName: parsed.data.displayName ?? null,
      host: parsed.data.host,
      port: parsed.data.port,
      username: parsed.data.username,
      password: parsed.data.password,
      useTls: parsed.data.useTls,
    } });
    res.json(result);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.post("/communication/email/imap/connect", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  try {
    const parsed = ImapConnectionInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
    const result = await connectImapMailbox({ r, req, input: {
      emailAddress: parsed.data.emailAddress,
      displayName: parsed.data.displayName ?? null,
      host: parsed.data.host,
      port: parsed.data.port,
      username: parsed.data.username,
      password: parsed.data.password,
      useTls: parsed.data.useTls,
    } });
    res.status(201).json(result);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.get("/communication/email/accounts", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  try {
    const rows = await listConnectedEmailAccounts({ r, req });
    res.json(rows);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.post("/communication/email/accounts", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const parsed = EmailAccountCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  try {
    const created = await createEmailAccount({ r, req, input: { provider: parsed.data.provider, emailAddress: parsed.data.emailAddress, displayName: parsed.data.displayName ?? null } });
    res.status(201).json(created);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.patch("/communication/email/accounts/:accountId", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).accountId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid account id" }); return; }
  const parsed = EmailAccountPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  try {
    const updated = await patchEmailAccountDetails({ r, req, accountId: id, patch: parsed.data });
    res.json(updated);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.delete("/communication/email/accounts/:accountId", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).accountId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid account id" }); return; }
  try {
    const updated = await disconnectEmailAccount({ r, req, accountId: id });
    res.json(updated);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.get("/communication/email/accounts/:accountId/folders", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).accountId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid account id" }); return; }
  try {
    const rows = await listEmailFolders({ r, req, accountId: id });
    res.json(rows);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.post("/communication/email/microsoft/:accountId/sync-folders", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).accountId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid account id" }); return; }
  try {
    const rows = await syncEmailAccountFolders({ r, req, accountId: id });
    res.json(rows);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.post("/communication/email/accounts/:accountId/sync-folders", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).accountId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid account id" }); return; }
  try {
    const rows = await syncEmailAccountFolders({ r, req, accountId: id });
    res.json(rows);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.patch("/communication/email/folders/:folderId", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).folderId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid folder id" }); return; }
  const parsed = EmailFolderPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  try {
    const updated = await patchEmailFolderDetails({ r, req, folderId: id, syncEnabled: parsed.data.syncEnabled });
    res.json(updated);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.get("/communication/email/accounts/:accountId/sync-logs", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).accountId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid account id" }); return; }
  const limit = Math.min(parseInt(one((req.query as any).limit) ?? "50", 10) || 50, 200);
  try {
    const rows = await listEmailSyncLogs({ r, req, accountId: id, limit });
    res.json(rows);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.post("/communication/email/accounts/:accountId/import-now", requireAuth, requireFirmUser, requirePermission("communications", "create"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).accountId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid account id" }); return; }
  try {
    const result = await importEmailNow({ r, req, accountId: id });
    res.json(result);
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.get("/communication/case-lookup", requireAuth, requireFirmUser, requirePermission("communications", "read"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const q = one((req.query as any).q) ?? "";
  const limit = Math.min(parseInt(one((req.query as any).limit) ?? "20", 10) || 20, 50);
  const rows = await lookupCasesForCommunication({ r, req, q, limit });
  res.json(rows);
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

router.patch("/communication/tasks/:taskId/team", requireAuth, requireFirmUser, requirePermission("communications", "update"), async (req: AuthRequest, res: Response) => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).taskId);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const parsed = TaskTeamPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const result = await setTaskResponsibleTeam({ r, req, taskId: id, team: parsed.data as any });
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
  if ((result as any).error === "missing_lawyer_in_charge") { res.status(400).json({ error: "Lawyer in charge is required" }); return; }
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
  if ((result as any).error === "missing_lawyer_in_charge") { res.status(400).json({ error: "Lawyer in charge is required" }); return; }
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

expressRouter.use((error: unknown, _req: AuthRequest, res: Response, next: NextFunction) => {
  const msg = error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  const isMissingAssigneesTable =
    code === "42P01" ||
    msg.includes("communication_task_assignees") ||
    msg.includes("relation") && msg.includes("does not exist") && msg.includes("communication_task_assignees");
  if (isMissingAssigneesTable) {
    res.status(500).json({ error: "Migration missing: communication_task_assignees. Apply 0117_communication_task_assignees.sql" });
    return;
  }
  next(error);
});

export default expressRouter;
