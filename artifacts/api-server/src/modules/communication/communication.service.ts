import { sql } from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";
import type { AuthRequest } from "../../lib/auth.js";
import { buildConsolidatedDraftBody } from "./communication.draft-builder.js";
import { writeCommunicationAuditLog } from "./communication.audit.js";
import { sanitizeEmailHtml } from "./email-html-sanitizer.js";
import { canAcknowledgeTask, canMutateTask, getRoleNameFromReq, isPartnerOrAdminRole } from "./communication.permissions.js";
import type { CommunicationDraftStatus, CommunicationDraftType } from "./communication.types.js";
import {
  findCaseByIdOrRef,
  getCaseRefDisplay,
  getCaseResponsibleUsers,
  getDraftById,
  getEmailAccountById,
  getEmailAccountByProviderEmail,
  getEmailFolderById,
  getMessageByFolderUid,
  getMessageByInternetMessageId,
  getMailboxById,
  getMessageById,
  getMessageByProviderMessageId,
  getOrCreateDefaultManualEmailMailbox,
  getReadByMessageUser,
  getRemarkById,
  getTaskById,
  getAttachmentByProviderId,
  insertEmailAccount,
  insertAttachment,
  insertEmailSyncLog,
  insertRemark,
  insertDraft,
  insertMessage,
  insertTask,
  linkDraftTasks,
  listActiveAssigneesForMessage,
  listAllAssigneesForMessage,
  listAssigneesForTasks,
  listAuditLogsForDraft,
  listAuditLogsForMessage,
  listAuditLogsForTask,
  listAttachmentsForMessage,
  listEmailAccounts,
  listEmailFoldersForAccount,
  listEmailSyncLogsForAccount,
  listLinkedCaseSummariesByIds,
  listDraftTaskIds,
  listDrafts,
  listMailboxes,
  listReadsForMessage,
  listRemarksForMessage,
  lookupCases,
  listMessages,
  listTasksForMessage,
  listTasksMine,
  listUsersByIds,
  replaceAssigneesForMessage,
  replaceAssigneesForTask,
  setMessageReadStatus,
  softDeleteRemark,
  upsertEmailFolder,
  upsertMessageAssignees,
  upsertMessageOpened,
  updateDraft,
  updateEmailAccount,
  updateEmailFolder,
  updateEmailSyncLog,
  updateMessage,
  updateRemark,
  updateTask,
  buildCaseCommunicationTimeline,
  type LinkedCaseSummary,
  type DbConn,
} from "./communication.repository.js";
import { decryptEmailSecret, encryptEmailSecret, ensureEmailEncryptionConfigured, isEmailEncryptionConfigured, signEmailState, verifyEmailState } from "./email-crypto.js";
import { clampPreview, ensureAbsoluteReturnTo, htmlToPlainText, type ImportedMessage } from "./email-provider-utils.js";
import {
  buildMicrosoftConnectUrl,
  getMicrosoftOauthSetupStatus,
  ensureMicrosoftOauthConfigured,
  exchangeMicrosoftCodeForTokens,
  fetchMicrosoftFolderMessages,
  fetchMicrosoftFolders,
  fetchMicrosoftMailboxProfile,
  refreshMicrosoftAccessToken,
} from "./providers/microsoft-graph.provider.js";
import {
  buildGoogleConnectUrl,
  ensureGoogleOauthConfigured,
  exchangeGoogleCodeForTokens,
  fetchGoogleLabelMessages,
  fetchGoogleLabels,
  fetchGoogleMailboxProfile,
  fetchGmailMessageReferenceMetadata,
  GMAIL_SEND_SCOPE,
  getGoogleOauthSetupStatus,
  hasGoogleScope,
  refreshGoogleAccessToken,
  sendGmailMessage,
} from "./providers/gmail.provider.js";
import {
  fetchImapFolderMessages,
  fetchImapFolders,
  testImapConnection,
} from "./providers/imap.provider.js";
import { normalizeEmailAddressList } from "./providers/manual-email.provider.js";

function now(): Date {
  return new Date();
}

const GMAIL_IMPORT_BATCH_LIMIT = 100;
const GMAIL_IMPORT_BATCH_MESSAGE = "Import is too large for one request. Please reduce range/max emails or run smaller batches.";

function isLawyerRoleName(roleName: string): boolean {
  const n = roleName.trim().toLowerCase();
  return n.includes("lawyer") || n.includes("partner");
}

type EmailImportOptions = {
  range: "7d" | "30d" | "90d" | "all" | "custom";
  maxEmails: 50 | 100 | 500 | 1000;
  from?: string | null;
  to?: string | null;
};

type EmailSendInput = {
  to: string[];
  cc?: string[] | null;
  bcc?: string[] | null;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  attachments?: Array<{
    filename: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
    storagePath?: string | null;
  }> | null;
};

type EmailSendMode = "reply" | "reply_all" | "forward";

type ImapMailboxInput = {
  provider: "imap" | "yahoo_imap";
  emailAddress: string;
  displayName?: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  useTls: boolean;
};

function normalizeImportOptions(input?: Partial<EmailImportOptions> | null): EmailImportOptions {
  const range = input?.range ?? "7d";
  const maxEmails = input?.maxEmails ?? 50;
  return {
    range,
    maxEmails: maxEmails === 50 || maxEmails === 100 || maxEmails === 500 || maxEmails === 1000 ? maxEmails : 50,
    from: input?.from ?? null,
    to: input?.to ?? null,
  };
}

function resolveImportWindow(options: EmailImportOptions) {
  const until = options.to ? new Date(options.to) : null;
  if (until && Number.isNaN(until.getTime())) {
    throw new ApiError({ status: 400, code: "EMAIL_IMPORT_INVALID_TO", message: "Import end date is invalid." });
  }
  if (options.range === "all") {
    return { limit: options.maxEmails, since: null as Date | null, until };
  }
  if (options.range === "custom") {
    const since = options.from ? new Date(options.from) : null;
    if (!since || Number.isNaN(since.getTime())) {
      throw new ApiError({ status: 400, code: "EMAIL_IMPORT_INVALID_FROM", message: "Import start date is invalid." });
    }
    if (!until) {
      throw new ApiError({ status: 400, code: "EMAIL_IMPORT_INVALID_TO", message: "Import end date is invalid." });
    }
    if (since.getTime() > until.getTime()) {
      throw new ApiError({ status: 400, code: "EMAIL_IMPORT_INVALID_RANGE", message: "Import start date must be before end date." });
    }
    return { limit: options.maxEmails, since, until };
  }
  const days = options.range === "7d" ? 7 : options.range === "90d" ? 90 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { limit: options.maxEmails, since, until };
}

function buildFriendlyImapError(error: unknown): ApiError {
  if (error instanceof ApiError && error.code === "EMAIL_ENCRYPTION_NOT_CONFIGURED") return error;
  return new ApiError({
    status: 400,
    code: "IMAP_CONNECTION_FAILED",
    message: "Unable to connect to IMAP server. Please check host, port, username, password, and SSL setting.",
  });
}

function normalizeImapMailboxInput(input: ImapMailboxInput): ImapMailboxInput {
  if (input.provider === "yahoo_imap") {
    const emailAddress = input.emailAddress.trim();
    return {
      ...input,
      emailAddress,
      host: "imap.mail.yahoo.com",
      port: 993,
      username: emailAddress,
      useTls: true,
    };
  }
  return {
    ...input,
    emailAddress: input.emailAddress.trim(),
    host: input.host.trim(),
    username: input.username.trim(),
  };
}

async function attachLinkedCaseSummary<T extends { linkedCaseId?: number | null }>(r: DbConn, firmId: number, row: T): Promise<T & { linkedCase: LinkedCaseSummary | null }> {
  const caseId = typeof row.linkedCaseId === "number" ? row.linkedCaseId : null;
  if (!caseId) return { ...row, linkedCase: null };
  const [summary] = await listLinkedCaseSummariesByIds(r, firmId, [caseId]);
  return { ...row, linkedCase: summary ?? null };
}

export async function listCommunicationMailboxes(args: { r: DbConn; firmId: number; channel?: string }) {
  return listMailboxes(args.r, args.firmId, args.channel);
}

export async function listCommunicationMessages(args: {
  r: DbConn;
  firmId: number;
  userId: number;
  filter: {
    status?: string | string[];
    isBatch?: boolean;
    assignedTo?: "me" | "unassigned" | "any";
    linkedCaseId?: number | null;
    unreadOnly?: boolean;
    q?: string;
  };
  limit: number;
  offset: number;
}) {
  const rows = await listMessages(args.r, args.firmId, {
    status: args.filter.status,
    isBatch: args.filter.isBatch,
    assignedTo: args.filter.assignedTo ?? "any",
    userId: args.userId,
    linkedCaseId: typeof args.filter.linkedCaseId === "number" || args.filter.linkedCaseId === null ? args.filter.linkedCaseId : undefined,
    unreadOnly: args.filter.unreadOnly ?? false,
    q: args.filter.q,
    limit: args.limit,
    offset: args.offset,
  });
  const linkedCaseIds = rows
    .map((row) => (typeof row.message.linkedCaseId === "number" ? row.message.linkedCaseId : null))
    .filter((value): value is number => typeof value === "number");
  const summaries = await listLinkedCaseSummariesByIds(args.r, args.firmId, linkedCaseIds);
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  return rows.map((row) => ({
    ...row,
    linkedCase: row.message.linkedCaseId ? (summaryById.get(row.message.linkedCaseId) ?? null) : null,
  }));
}

export async function getCommunicationMessage(args: { r: DbConn; firmId: number; messageId: number }) {
  const message = await getMessageById(args.r, args.firmId, args.messageId);
  if (!message) return null;
  const assignees = await listActiveAssigneesForMessage(args.r, args.firmId, message.id);
  const base = { ...message, team: buildTeamFromAssignees(assignees) };
  return await attachLinkedCaseSummary(args.r, args.firmId, base);
}

function buildTeamFromAssignees(rows: Array<{ assignmentRole: string; userId: number }>) {
  const lawyer = rows.find((r) => r.assignmentRole === "lawyer_in_charge")?.userId ?? null;
  const handlers = rows.filter((r) => r.assignmentRole === "handler").map((r) => r.userId);
  const reviewer = rows.find((r) => r.assignmentRole === "reviewer")?.userId ?? null;
  const watchers = rows.filter((r) => r.assignmentRole === "watcher").map((r) => r.userId);
  return { lawyerInChargeUserId: lawyer, handlerUserIds: handlers, reviewerUserId: reviewer, watcherUserIds: watchers };
}

function normalizeTeamInput(teamRaw: any, legacyAssignedToUserId?: number | null) {
  const lawyerInChargeUserId = typeof teamRaw?.lawyerInChargeUserId === "number" ? teamRaw.lawyerInChargeUserId : null;
  const handlerIds = Array.isArray(teamRaw?.handlerUserIds) ? teamRaw.handlerUserIds.filter((x: any) => typeof x === "number") : [];
  const reviewerUserId = typeof teamRaw?.reviewerUserId === "number" ? teamRaw.reviewerUserId : null;
  const watcherIds = Array.isArray(teamRaw?.watcherUserIds) ? teamRaw.watcherUserIds.filter((x: any) => typeof x === "number") : [];

  const handlers = new Set<number>(handlerIds);
  if (typeof legacyAssignedToUserId === "number") handlers.add(legacyAssignedToUserId);
  const watchers = new Set<number>(watcherIds);

  if (lawyerInChargeUserId != null) {
    handlers.delete(lawyerInChargeUserId);
    watchers.delete(lawyerInChargeUserId);
  }
  if (reviewerUserId != null) {
    handlers.delete(reviewerUserId);
    watchers.delete(reviewerUserId);
  }
  for (const id of handlers) watchers.delete(id);

  return {
    lawyerInChargeUserId,
    handlerUserIds: Array.from(handlers),
    reviewerUserId,
    watcherUserIds: Array.from(watchers),
  };
}

async function isTaskTeamMember(r: DbConn, firmId: number, taskId: number, userId: number) {
  const assignees = await listAssigneesForTasks(r, firmId, [taskId]);
  return assignees.some((a) => a.taskId === taskId && a.userId === userId && (a.assignmentRole === "lawyer_in_charge" || a.assignmentRole === "handler"));
}

export async function createManualIncomingEmail(args: {
  r: DbConn;
  req: AuthRequest;
  input: {
    mailboxId?: number | null;
    fromName?: string | null;
    fromEmail: string;
    to: unknown;
    cc: unknown;
    subject: string;
    bodyText?: string | null;
    receivedAt?: string | null;
    caseId?: number | null;
    caseRef?: string | null;
    isBatchEmail?: boolean | null;
    assignedToUserId?: number | null;
    team?: any | null;
  };
}) {
  const firmId = args.req.firmId!;
  const actorId = args.req.userId!;
  const isBatch = Boolean(args.input.isBatchEmail);
  const availableMailboxes = args.input.mailboxId ? [] : await listMailboxes(args.r, firmId, "email");
  const mailbox = args.input.mailboxId
    ? await getMailboxById(args.r, firmId, args.input.mailboxId)
    : (availableMailboxes.find((item) => item.isActive) ?? await getOrCreateDefaultManualEmailMailbox(args.r, firmId, actorId));
  if (!mailbox) throw new Error("mailbox_not_found");
  if (mailbox.channel !== "email") throw new Error("invalid_mailbox_channel");

  const receivedAt = args.input.receivedAt ? new Date(args.input.receivedAt) : now();
  if (Number.isNaN(receivedAt.getTime())) throw new Error("invalid_received_at");
  const toAddresses = normalizeEmailAddressList(args.input.to);
  if (!toAddresses.length) throw new Error("missing_to_addresses");
  const ccAddresses = normalizeEmailAddressList(args.input.cc);
  let linkedCaseId: number | null = null;
  if (args.input.caseId || args.input.caseRef) {
    const foundCase = await findCaseByIdOrRef(args.r, firmId, {
      caseId: args.input.caseId ?? null,
      caseRef: args.input.caseRef ?? null,
    });
    if (!foundCase) throw new Error("case_not_found");
    linkedCaseId = foundCase.id;
  }
  const normalizedTeam = normalizeTeamInput(args.input.team, args.input.assignedToUserId ?? null);
  const primaryAssignee = normalizedTeam.handlerUserIds[0] ?? normalizedTeam.lawyerInChargeUserId ?? null;
  const fromName = (args.input.fromName ?? "").trim();

  const created = await insertMessage(args.r, {
    firmId,
    mailboxId: mailbox.id,
    channel: "email",
    provider: "manual",
    direction: "incoming",
    fromAddress: args.input.fromEmail.trim(),
    fromName: fromName || null,
    toAddresses,
    ccAddresses,
    bccAddresses: [],
    subject: args.input.subject.trim(),
    bodyText: (args.input.bodyText ?? "").trim(),
    receivedAt,
    internalStatus: primaryAssignee ? "assigned" : "unassigned",
    isBatch,
    linkedCaseId,
    assignedToUserId: primaryAssignee,
    lastActivityAt: receivedAt,
    createdBy: actorId,
  });

  const assignedAt = now();
  const assigneeRows: Array<any> = [];
  if (normalizedTeam.lawyerInChargeUserId) {
    assigneeRows.push({
      firmId,
      messageId: created.id,
      taskId: null,
      userId: normalizedTeam.lawyerInChargeUserId,
      assignmentRole: "lawyer_in_charge",
      isPrimary: true,
      status: "assigned",
      assignedBy: actorId,
      assignedAt,
    });
  }
  for (const [idx, userId] of normalizedTeam.handlerUserIds.entries()) {
    assigneeRows.push({
      firmId,
      messageId: created.id,
      taskId: null,
      userId,
      assignmentRole: "handler",
      isPrimary: idx === 0,
      status: "assigned",
      assignedBy: actorId,
      assignedAt,
    });
  }
  if (normalizedTeam.reviewerUserId) {
    assigneeRows.push({
      firmId,
      messageId: created.id,
      taskId: null,
      userId: normalizedTeam.reviewerUserId,
      assignmentRole: "reviewer",
      isPrimary: false,
      status: "assigned",
      assignedBy: actorId,
      assignedAt,
    });
  }
  for (const userId of normalizedTeam.watcherUserIds) {
    assigneeRows.push({
      firmId,
      messageId: created.id,
      taskId: null,
      userId,
      assignmentRole: "watcher",
      isPrimary: false,
      status: "assigned",
      assignedBy: actorId,
      assignedAt,
    });
  }
  if (assigneeRows.length) await replaceAssigneesForMessage(args.r, firmId, created.id, assigneeRows);

  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.manual_email.created",
    messageId: created.id,
    newValue: {
      isBatch,
      mailboxId: mailbox.id,
      linkedCaseId,
      assignedToUserId: primaryAssignee,
      team: normalizedTeam,
      receivedAt: receivedAt.toISOString(),
    },
  });

  return { ...created, team: normalizedTeam };
}

export async function viewMessage(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const msg = await getMessageById(args.r, firmId, args.messageId);
  if (!msg) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.viewed",
    messageId: msg.id,
  });
  await updateMessage(args.r, firmId, msg.id, { lastActivityAt: now() });
  return msg;
}

export async function assignMessageOwner(args: { r: DbConn; req: AuthRequest; messageId: number; assignedToUserId: number | null }) {
  const firmId = args.req.firmId!;
  const existing = await getMessageById(args.r, firmId, args.messageId);
  if (!existing) return null;
  const nextStatus = args.assignedToUserId ? "assigned" : "unassigned";
  const updated = await updateMessage(args.r, firmId, args.messageId, {
    assignedToUserId: args.assignedToUserId,
    internalStatus: nextStatus,
    lastActivityAt: now(),
  });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.assigned",
    messageId: updated.id,
    oldValue: { assignedToUserId: existing.assignedToUserId ?? null, internalStatus: existing.internalStatus },
    newValue: { assignedToUserId: updated.assignedToUserId ?? null, internalStatus: updated.internalStatus },
  });
  return updated;
}

export async function setMessageResponsibleTeam(args: { r: DbConn; req: AuthRequest; messageId: number; team: any }) {
  const firmId = args.req.firmId!;
  const roleName = getRoleNameFromReq(args.req);
  if (!isLawyerRoleName(roleName) && !isPartnerOrAdminRole(roleName)) return { error: "forbidden" as const };

  const existing = await getMessageById(args.r, firmId, args.messageId);
  if (!existing) return null;

  const normalizedTeam = normalizeTeamInput(args.team, null);
  const primaryAssignee = normalizedTeam.handlerUserIds[0] ?? normalizedTeam.lawyerInChargeUserId ?? null;
  const nextStatus = primaryAssignee ? "assigned" : "unassigned";
  const updated = await updateMessage(args.r, firmId, args.messageId, {
    assignedToUserId: primaryAssignee,
    internalStatus: nextStatus,
    lastActivityAt: now(),
  });
  if (!updated) return null;

  const assignedAt = now();
  const rows: Array<any> = [];
  if (normalizedTeam.lawyerInChargeUserId) {
    rows.push({
      firmId,
      messageId: updated.id,
      taskId: null,
      userId: normalizedTeam.lawyerInChargeUserId,
      assignmentRole: "lawyer_in_charge",
      isPrimary: true,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  for (const [idx, userId] of normalizedTeam.handlerUserIds.entries()) {
    rows.push({
      firmId,
      messageId: updated.id,
      taskId: null,
      userId,
      assignmentRole: "handler",
      isPrimary: idx === 0,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  if (normalizedTeam.reviewerUserId) {
    rows.push({
      firmId,
      messageId: updated.id,
      taskId: null,
      userId: normalizedTeam.reviewerUserId,
      assignmentRole: "reviewer",
      isPrimary: false,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  for (const userId of normalizedTeam.watcherUserIds) {
    rows.push({
      firmId,
      messageId: updated.id,
      taskId: null,
      userId,
      assignmentRole: "watcher",
      isPrimary: false,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  await replaceAssigneesForMessage(args.r, firmId, updated.id, rows);

  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.team_updated",
    messageId: updated.id,
    oldValue: { assignedToUserId: existing.assignedToUserId ?? null, internalStatus: existing.internalStatus },
    newValue: { assignedToUserId: updated.assignedToUserId ?? null, internalStatus: updated.internalStatus, team: normalizedTeam },
  });

  return { ...updated, team: normalizedTeam };
}

export async function linkMessageCase(args: { r: DbConn; req: AuthRequest; messageId: number; caseId?: number | null; caseRef?: string | null }) {
  const firmId = args.req.firmId!;
  const existing = await getMessageById(args.r, firmId, args.messageId);
  if (!existing) return null;
  const found = await findCaseByIdOrRef(args.r, firmId, { caseId: args.caseId ?? null, caseRef: args.caseRef ?? null });
  if (!found) return { error: "case_not_found" as const };
  const updated = await updateMessage(args.r, firmId, args.messageId, { linkedCaseId: found.id, lastActivityAt: now() });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.link_case",
    messageId: updated.id,
    oldValue: { linkedCaseId: existing.linkedCaseId ?? null },
    newValue: { linkedCaseId: updated.linkedCaseId ?? null },
  });
  return updated;
}

export async function closeMessage(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getMessageById(args.r, firmId, args.messageId);
  if (!existing) return null;
  const updated = await updateMessage(args.r, firmId, args.messageId, { internalStatus: "closed", lastActivityAt: now() });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.closed",
    messageId: updated.id,
    oldValue: { internalStatus: existing.internalStatus },
    newValue: { internalStatus: updated.internalStatus },
  });
  return updated;
}

export async function archiveMessage(args: { r: DbConn; req: AuthRequest; messageId: number; archived: boolean }) {
  const firmId = args.req.firmId!;
  const existing = await getMessageById(args.r, firmId, args.messageId);
  if (!existing) return null;
  const nextStatus = args.archived ? "archived" : (existing.assignedToUserId ? "assigned" : "unassigned");
  const updated = await updateMessage(args.r, firmId, args.messageId, { internalStatus: nextStatus, lastActivityAt: now() });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: args.archived ? "communication.message.archived" : "communication.message.unarchived",
    messageId: updated.id,
    oldValue: { internalStatus: existing.internalStatus },
    newValue: { internalStatus: updated.internalStatus },
  });
  return updated;
}

export async function unlinkMessageCase(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getMessageById(args.r, firmId, args.messageId);
  if (!existing) return null;
  const updated = await updateMessage(args.r, firmId, args.messageId, { linkedCaseId: null, lastActivityAt: now() });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.case_unlinked",
    messageId: updated.id,
    oldValue: { linkedCaseId: existing.linkedCaseId ?? null },
    newValue: { linkedCaseId: updated.linkedCaseId ?? null },
  });
  return updated;
}

export async function listMessageRemarks(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const rows = await listRemarksForMessage(args.r, firmId, args.messageId);
  const userIds = Array.from(new Set(rows.map((x) => x.userId)));
  const users = await listUsersByIds(args.r, firmId, userIds);
  const userMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((row) => ({ ...row, userName: userMap.get(row.userId) ?? null }));
}

export async function createMessageRemark(args: { r: DbConn; req: AuthRequest; messageId: number; body: string }) {
  const firmId = args.req.firmId!;
  const bodyText = args.body.trim();
  if (!bodyText) return { error: "empty_body" as const };
  const message = await getMessageById(args.r, firmId, args.messageId);
  if (!message) return null;
  const created = await insertRemark(args.r, { firmId, messageId: args.messageId, userId: args.req.userId!, body: bodyText });
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.remark.created",
    messageId: args.messageId,
    newValue: { remarkId: created.id, userId: created.userId, body: created.body },
  });
  return created;
}

export async function updateMessageRemark(args: { r: DbConn; req: AuthRequest; remarkId: number; body: string }) {
  const firmId = args.req.firmId!;
  const existing = await getRemarkById(args.r, firmId, args.remarkId);
  if (!existing) return null;
  if (existing.deletedAt) return { error: "deleted" as const };
  const roleName = getRoleNameFromReq(args.req);
  const canEdit = existing.userId === args.req.userId || isPartnerOrAdminRole(roleName);
  if (!canEdit) return { error: "forbidden" as const };
  const bodyText = args.body.trim();
  if (!bodyText) return { error: "empty_body" as const };
  const updated = await updateRemark(args.r, firmId, args.remarkId, { body: bodyText });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.remark.updated",
    messageId: updated.messageId,
    oldValue: { remarkId: existing.id, body: existing.body },
    newValue: { remarkId: updated.id, body: updated.body },
  });
  return updated;
}

export async function deleteMessageRemark(args: { r: DbConn; req: AuthRequest; remarkId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getRemarkById(args.r, firmId, args.remarkId);
  if (!existing) return null;
  if (existing.deletedAt) return { ok: true as const };
  const roleName = getRoleNameFromReq(args.req);
  const canDelete = existing.userId === args.req.userId || isPartnerOrAdminRole(roleName);
  if (!canDelete) return { error: "forbidden" as const };
  const deleted = await softDeleteRemark(args.r, firmId, args.remarkId);
  if (!deleted) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.remark.deleted",
    messageId: deleted.messageId,
    oldValue: { remarkId: existing.id, body: existing.body },
    newValue: { remarkId: deleted.id, deletedAt: deleted.deletedAt },
  });
  return { ok: true as const };
}

export async function recordMessageOpened(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const message = await getMessageById(args.r, firmId, args.messageId);
  if (!message) return null;
  const existing = await getReadByMessageUser(args.r, firmId, args.messageId, args.req.userId!);
  const shouldWriteAudit = (() => {
    if (!existing?.lastOpenedAt) return true;
    const lastOpenedAtMs = new Date(existing.lastOpenedAt).getTime();
    if (Number.isNaN(lastOpenedAtMs)) return true;
    return Date.now() - lastOpenedAtMs > 5 * 60 * 1000;
  })();
  const updated = await upsertMessageOpened(args.r, firmId, args.messageId, args.req.userId!);
  if (shouldWriteAudit) {
    await writeCommunicationAuditLog({
      r: args.r,
      req: args.req,
      action: "communication.message.opened",
      messageId: args.messageId,
      newValue: { userId: args.req.userId!, openedCount: updated?.openedCount ?? null, lastOpenedAt: updated?.lastOpenedAt ?? null },
    });
  }
  return updated;
}

export async function listMessageReads(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const rows = await listReadsForMessage(args.r, firmId, args.messageId);
  const userIds = Array.from(new Set(rows.map((x) => x.userId)));
  const users = await listUsersByIds(args.r, firmId, userIds);
  const userMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((row) => ({ ...row, userName: userMap.get(row.userId) ?? null }));
}

export async function listMessageAttachments(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const message = await getMessageById(args.r, firmId, args.messageId);
  if (!message) return null;
  return listAttachmentsForMessage(args.r, firmId, args.messageId);
}

export async function updateMessageReadStatus(args: { r: DbConn; req: AuthRequest; messageId: number; isRead: boolean }) {
  const firmId = args.req.firmId!;
  const message = await getMessageById(args.r, firmId, args.messageId);
  if (!message) return null;
  await setMessageReadStatus(args.r, { firmId, messageId: args.messageId, userId: args.req.userId!, isRead: args.isRead });
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: args.isRead ? "communication.message.marked_read" : "communication.message.marked_unread",
    messageId: args.messageId,
    newValue: { userId: args.req.userId!, isRead: args.isRead },
  });
  return { ok: true as const };
}

export async function getMessageAssignees(args: { r: DbConn; req: AuthRequest; messageId: number }) {
  const firmId = args.req.firmId!;
  const rows = await listActiveAssigneesForMessage(args.r, firmId, args.messageId);
  return { userIds: rows.map((r) => r.userId) };
}

export async function setMessageAssignees(args: { r: DbConn; req: AuthRequest; messageId: number; userIds: number[] }) {
  const firmId = args.req.firmId!;
  const message = await getMessageById(args.r, firmId, args.messageId);
  if (!message) return null;
  const oldRows = await listActiveAssigneesForMessage(args.r, firmId, args.messageId);
  const updatedRows = await upsertMessageAssignees(args.r, { firmId, messageId: args.messageId, actorId: args.req.userId!, userIds: args.userIds });
  const primaryUserId = updatedRows.find((r) => r.isPrimary)?.userId ?? updatedRows[0]?.userId ?? null;
  const patch: any = { assignedToUserId: primaryUserId, lastActivityAt: now() };
  if (message.internalStatus !== "archived") patch.internalStatus = primaryUserId ? "assigned" : "unassigned";
  const updatedMessage = await updateMessage(args.r, firmId, args.messageId, patch);
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.message.assignees.updated",
    messageId: args.messageId,
    oldValue: { userIds: oldRows.map((r) => r.userId) },
    newValue: { userIds: updatedRows.map((r) => r.userId), assignedToUserId: updatedMessage?.assignedToUserId ?? null },
  });
  return { ok: true as const, assignedToUserId: updatedMessage?.assignedToUserId ?? null, userIds: updatedRows.map((r) => r.userId) };
}

function requireMailboxManagementRole(req: AuthRequest) {
  const roleName = getRoleNameFromReq(req);
  if (!isPartnerOrAdminRole(roleName)) {
    throw new ApiError({
      status: 403,
      code: "EMAIL_PROVIDER_FORBIDDEN",
      message: "Only partner or admin users can manage mailbox connections.",
    });
  }
}

function parseStoredScopes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function buildDefaultSignature(account: { displayName?: string | null; emailAddress: string; signatureHtml?: string | null; signatureText?: string | null }) {
  const storedHtml = String(account.signatureHtml ?? "").trim();
  const storedText = String(account.signatureText ?? "").trim();
  if (storedHtml || storedText) {
    return {
      html: storedHtml || null,
      text: storedText || null,
    };
  }
  const nameLine = String(account.displayName ?? "").trim() || account.emailAddress;
  return {
    html: `<p>Regards,</p><p>${nameLine}<br>${account.emailAddress}</p>`,
    text: `Regards,\n${nameLine}\n${account.emailAddress}`,
  };
}

function getEmailAccountSendState(account: any) {
  const scopes = parseStoredScopes(account.oauthScopes);
  if (account.status !== "active") {
    return {
      canSend: false,
      requiresReconnect: false,
      reason: "Mailbox setup is incomplete. Please complete provider connection first.",
      scopes,
    };
  }
  if (account.provider === "gmail") {
    if (!hasGoogleScope(scopes, GMAIL_SEND_SCOPE)) {
      return {
        canSend: false,
        requiresReconnect: true,
        reason: "Reconnect Gmail to enable sending.",
        scopes,
      };
    }
    return {
      canSend: true,
      requiresReconnect: false,
      reason: null,
      scopes,
    };
  }
  if (account.provider === "imap" || account.provider === "yahoo_imap") {
    return {
      canSend: false,
      requiresReconnect: false,
      reason: "Sending is not configured for this mailbox. Please configure SMTP in Email Settings.",
      scopes,
    };
  }
  return {
    canSend: false,
    requiresReconnect: false,
    reason: "Sending is not configured for this mailbox.",
    scopes,
  };
}

function normalizeOutgoingEmailContent(input: EmailSendInput) {
  const to = normalizeEmailAddressList(input.to);
  const cc = normalizeEmailAddressList(input.cc ?? []);
  const bcc = normalizeEmailAddressList(input.bcc ?? []);
  const subject = String(input.subject ?? "");
  const sanitizedHtml = sanitizeEmailHtml(input.bodyHtml ?? null);
  const bodyTextSource = String(input.bodyText ?? "").trim();
  const bodyText = bodyTextSource || (sanitizedHtml ? htmlToPlainText(sanitizedHtml) ?? "" : "");
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  return {
    to,
    cc,
    bcc,
    subject,
    bodyHtml: sanitizedHtml,
    bodyText,
    attachments,
  };
}

function sanitizeEmailAccount(account: any) {
  const sendState = getEmailAccountSendState(account);
  const signature = buildDefaultSignature(account);
  return {
    id: account.id,
    provider: account.provider,
    emailAddress: account.emailAddress,
    displayName: account.displayName,
    status: account.status,
    mailboxType: account.mailboxType,
    imapHost: account.imapHost ?? null,
    imapPort: account.imapPort ?? null,
    imapUsername: account.imapUsername ?? null,
    useTls: account.useTls,
    lastSyncAt: account.lastSyncAt ?? null,
    lastError: account.lastError ?? null,
    tokenExpiresAt: account.tokenExpiresAt ?? null,
    canSend: sendState.canSend,
    sendDisabledReason: sendState.reason,
    requiresReconnectForSend: sendState.requiresReconnect,
    oauthScopes: sendState.scopes,
    signatureHtml: signature.html,
    signatureText: signature.text,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function defaultFolderSyncEnabled(folderType: string): boolean {
  return folderType === "inbox" || folderType === "sent" || folderType === "archive";
}

async function getAccountOrThrow(r: DbConn, firmId: number, accountId: number) {
  const account = await getEmailAccountById(r, firmId, accountId);
  if (!account) {
    throw new ApiError({
      status: 404,
      code: "EMAIL_ACCOUNT_NOT_FOUND",
      message: "Mailbox account not found.",
    });
  }
  return account;
}

async function ensureMicrosoftAccessToken(args: { r: DbConn; firmId: number; accountId: number }) {
  const account = await getAccountOrThrow(args.r, args.firmId, args.accountId);
  if (account.provider !== "microsoft_graph") {
    throw new ApiError({
      status: 400,
      code: "EMAIL_PROVIDER_INVALID",
      message: "Mailbox account is not a Microsoft 365 account.",
    });
  }
  const tokenExpiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (account.encryptedAccessToken && tokenExpiresAt > Date.now() + 30_000) {
    return { account, accessToken: decryptEmailSecret(account.encryptedAccessToken) ?? "" };
  }
  const refreshToken = decryptEmailSecret(account.encryptedRefreshToken) ?? "";
  if (!refreshToken) {
    throw new ApiError({
      status: 400,
      code: "MICROSOFT_REFRESH_TOKEN_MISSING",
      message: "Microsoft mailbox refresh token is missing. Please reconnect the mailbox.",
    });
  }
  const refreshed = await refreshMicrosoftAccessToken(refreshToken);
  const updated = await updateEmailAccount(args.r, args.firmId, args.accountId, {
    encryptedAccessToken: encryptEmailSecret(refreshed.accessToken),
    encryptedRefreshToken: refreshed.refreshToken ? encryptEmailSecret(refreshed.refreshToken) : account.encryptedRefreshToken,
    tokenExpiresAt: refreshed.expiresAt,
    status: "active",
    lastError: null,
  });
  return { account: updated ?? account, accessToken: refreshed.accessToken };
}

async function ensureGoogleAccessToken(args: { r: DbConn; firmId: number; accountId: number }) {
  const account = await getAccountOrThrow(args.r, args.firmId, args.accountId);
  if (account.provider !== "gmail") {
    throw new ApiError({
      status: 400,
      code: "EMAIL_PROVIDER_INVALID",
      message: "Mailbox account is not a Gmail account.",
    });
  }
  const tokenExpiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (account.encryptedAccessToken && tokenExpiresAt > Date.now() + 30_000) {
    return { account, accessToken: decryptEmailSecret(account.encryptedAccessToken) ?? "" };
  }
  const refreshToken = decryptEmailSecret(account.encryptedRefreshToken) ?? "";
  if (!refreshToken) {
    throw new ApiError({
      status: 400,
      code: "GOOGLE_REFRESH_TOKEN_MISSING",
      message: "Gmail refresh token is missing. Please reconnect the mailbox.",
    });
  }
  const refreshed = await refreshGoogleAccessToken(refreshToken);
  const updated = await updateEmailAccount(args.r, args.firmId, args.accountId, {
    encryptedAccessToken: encryptEmailSecret(refreshed.accessToken),
    encryptedRefreshToken: refreshed.refreshToken ? encryptEmailSecret(refreshed.refreshToken) : account.encryptedRefreshToken,
    tokenExpiresAt: refreshed.expiresAt,
    oauthScopes: refreshed.scopes.length ? refreshed.scopes : parseStoredScopes(account.oauthScopes),
    status: "active",
    lastError: null,
  });
  return { account: updated ?? account, accessToken: refreshed.accessToken };
}

async function upsertProviderFolders(args: {
  r: DbConn;
  firmId: number;
  accountId: number;
  folders: Array<{ providerFolderId: string; parentProviderFolderId: string | null; displayName: string; folderType: string }>;
}) {
  const existing = await listEmailFoldersForAccount(args.r, args.firmId, args.accountId);
  const existingByProviderId = new Map(existing.map((folder) => [folder.providerFolderId, folder]));
  const out = [];
  for (const folder of args.folders) {
    const current = existingByProviderId.get(folder.providerFolderId);
    const saved = await upsertEmailFolder(args.r, {
      firmId: args.firmId,
      accountId: args.accountId,
      providerFolderId: folder.providerFolderId,
      parentProviderFolderId: folder.parentProviderFolderId,
      displayName: folder.displayName,
      folderType: folder.folderType,
      syncEnabled: current?.syncEnabled ?? defaultFolderSyncEnabled(folder.folderType),
    });
    out.push(saved);
  }
  return out;
}

async function storeImportedMessage(args: {
  r: DbConn;
  req: AuthRequest;
  account: any;
  folder: any;
  message: ImportedMessage;
}) {
  const firmId = args.req.firmId!;
  const duplicate =
    (args.message.providerMessageId ? await getMessageByProviderMessageId(args.r, firmId, args.account.id, args.message.providerMessageId) : null) ??
    (args.message.providerUid ? await getMessageByFolderUid(args.r, firmId, args.account.id, args.folder.id, args.message.providerUid) : null) ??
    (args.message.internetMessageId ? await getMessageByInternetMessageId(args.r, firmId, args.account.id, args.message.internetMessageId) : null);

  if (duplicate) {
    return { status: "duplicate" as const, messageId: duplicate.id };
  }

  const created = await insertMessage(args.r, {
    firmId,
    mailboxId: null,
    emailAccountId: args.account.id,
    emailFolderId: args.folder.id,
    channel: "email",
    provider: args.message.provider,
    providerMessageId: args.message.providerMessageId,
    providerThreadId: args.message.providerThreadId,
    providerConversationId: args.message.providerConversationId,
    providerFolder: args.message.providerFolder ?? args.folder.displayName,
    internetMessageId: args.message.internetMessageId,
    providerUid: args.message.providerUid,
    providerIsRead: args.message.providerIsRead,
    direction: args.message.direction,
    fromAddress: args.message.fromAddress,
    fromName: args.message.fromName,
    toAddresses: args.message.toAddresses,
    ccAddresses: args.message.ccAddresses,
    bccAddresses: args.message.bccAddresses,
    subject: args.message.subject,
    bodyPreview: args.message.bodyPreview,
    bodyText: args.message.bodyText,
    bodyHtml: args.message.bodyHtml,
    attachmentCount: args.message.attachments.length,
    receivedAt: args.message.receivedAt,
    sentAt: args.message.sentAt,
    internalStatus: "unassigned",
    isBatch: false,
    linkedCaseId: null,
    assignedToUserId: null,
    lastActivityAt: args.message.receivedAt ?? args.message.sentAt ?? now(),
    lastSyncedAt: now(),
    createdBy: args.req.userId ?? null,
  });

  for (const attachment of args.message.attachments) {
    if (attachment.providerAttachmentId) {
      const existingAttachment = await getAttachmentByProviderId(args.r, firmId, created.id, attachment.providerAttachmentId);
      if (existingAttachment) continue;
    }
    await insertAttachment(args.r, {
      firmId,
      messageId: created.id,
      channel: "email",
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      storagePath: null,
      providerAttachmentId: attachment.providerAttachmentId,
      linkedCaseId: null,
      savedToCaseDocumentId: null,
      createdBy: args.req.userId ?? null,
    });
  }

  return { status: "imported" as const, messageId: created.id };
}

async function importMessagesForAccount(args: { r: DbConn; req: AuthRequest; accountId: number; options: EmailImportOptions }) {
  const firmId = args.req.firmId!;
  const account = await getAccountOrThrow(args.r, firmId, args.accountId);
  const enabledFolders = (await listEmailFoldersForAccount(args.r, firmId, args.accountId)).filter((folder) => folder.syncEnabled);
  if (!enabledFolders.length) {
    throw new ApiError({
      status: 400,
      code: "EMAIL_SYNC_NO_FOLDERS_ENABLED",
      message: "No sync-enabled folders found for this mailbox.",
    });
  }

  const syncLog = await insertEmailSyncLog(args.r, {
    firmId,
    accountId: args.accountId,
    folderId: null,
    startedAt: now(),
    status: "running",
    importedCount: 0,
    skippedDuplicateCount: 0,
  });

  const importWindow = resolveImportWindow(args.options);
  let importedCount = 0;
  let skippedDuplicateCount = 0;
  let failedCount = 0;
  let firstFailureMessage: string | null = null;
  const requestedLimit = importWindow.limit;
  const effectiveLimit = account.provider === "gmail" ? Math.min(requestedLimit, GMAIL_IMPORT_BATCH_LIMIT) : requestedLimit;
  const limitCapped = effectiveLimit < requestedLimit;
  if (limitCapped) {
    firstFailureMessage = GMAIL_IMPORT_BATCH_MESSAGE;
  }
  let remaining = effectiveLimit;

  try {
    if (account.provider === "microsoft_graph") {
      const { accessToken, account: currentAccount } = await ensureMicrosoftAccessToken({ r: args.r, firmId, accountId: args.accountId });
      for (const folder of enabledFolders) {
        if (remaining <= 0) break;
        const messages = await fetchMicrosoftFolderMessages(accessToken, folder.providerFolderId, {
          limit: remaining,
          since: importWindow.since,
          until: importWindow.until,
        });
        for (const item of messages) {
          try {
            const result = await storeImportedMessage({ r: args.r, req: args.req, account: currentAccount, folder, message: item });
            if (result.status === "imported") importedCount += 1;
            else skippedDuplicateCount += 1;
          } catch (error) {
            failedCount += 1;
            firstFailureMessage = firstFailureMessage ?? (error instanceof Error ? error.message : "Email import failed");
          }
          remaining -= 1;
          if (remaining <= 0) break;
        }
        await updateEmailFolder(args.r, firmId, folder.id, { lastSyncAt: now() });
      }
    } else if (account.provider === "gmail") {
      const { accessToken, account: currentAccount } = await ensureGoogleAccessToken({ r: args.r, firmId, accountId: args.accountId });
      for (const folder of enabledFolders) {
        if (remaining <= 0) break;
        const messages = await fetchGoogleLabelMessages(accessToken, folder.providerFolderId, {
          limit: remaining,
          since: importWindow.since,
          until: importWindow.until,
        });
        for (const item of messages) {
          try {
            const result = await storeImportedMessage({ r: args.r, req: args.req, account: currentAccount, folder, message: item });
            if (result.status === "imported") importedCount += 1;
            else skippedDuplicateCount += 1;
          } catch (error) {
            failedCount += 1;
            firstFailureMessage = firstFailureMessage ?? (error instanceof Error ? error.message : "Email import failed");
          }
          remaining -= 1;
          if (remaining <= 0) break;
        }
        await updateEmailFolder(args.r, firmId, folder.id, { lastSyncAt: now() });
      }
    } else if (account.provider === "imap" || account.provider === "yahoo_imap") {
      const password = decryptEmailSecret(account.encryptedImapPassword);
      if (!password || !account.imapHost || !account.imapPort || !account.imapUsername) {
        throw new ApiError({
          status: 400,
          code: "IMAP_CONFIGURATION_INCOMPLETE",
          message: "IMAP mailbox configuration is incomplete.",
        });
      }
      for (const folder of enabledFolders) {
        if (remaining <= 0) break;
        let messages;
        try {
          messages = await fetchImapFolderMessages({
            host: account.imapHost,
            port: account.imapPort,
            username: account.imapUsername,
            password,
            useTls: account.useTls ?? true,
          }, folder.providerFolderId, {
            limit: remaining,
            since: importWindow.since,
            until: importWindow.until,
          });
        } catch (error) {
          throw buildFriendlyImapError(error);
        }
        for (const item of messages) {
          try {
            const result = await storeImportedMessage({
              r: args.r,
              req: args.req,
              account,
              folder,
              message: {
                ...item,
                provider: account.provider === "yahoo_imap" ? "yahoo_imap" : "imap",
              },
            });
            if (result.status === "imported") importedCount += 1;
            else skippedDuplicateCount += 1;
          } catch (error) {
            failedCount += 1;
            firstFailureMessage = firstFailureMessage ?? (error instanceof Error ? error.message : "Email import failed");
          }
          remaining -= 1;
          if (remaining <= 0) break;
        }
        await updateEmailFolder(args.r, firmId, folder.id, { lastSyncAt: now() });
      }
    } else {
      throw new ApiError({
        status: 400,
        code: "EMAIL_PROVIDER_NOT_SUPPORTED",
        message: "This mailbox provider is not supported for import yet.",
      });
    }

    const completedStatus = failedCount > 0 || limitCapped ? "partial" : "success";
    await updateEmailSyncLog(args.r, firmId, syncLog.id, {
      finishedAt: now(),
      status: completedStatus,
      importedCount,
      skippedDuplicateCount,
      errorMessage: firstFailureMessage,
    });
    await updateEmailAccount(args.r, firmId, args.accountId, {
      status: failedCount > 0 ? "error" : "active",
      lastSyncAt: now(),
      lastError: failedCount > 0 ? firstFailureMessage : null,
    });
    await writeCommunicationAuditLog({
      r: args.r,
      req: args.req,
      action: failedCount > 0 || limitCapped ? "communication.email_sync.failed" : "communication.email_sync.success",
      newValue: { accountId: args.accountId, syncLogId: syncLog.id, importedCount, skippedDuplicateCount, failedCount, requestedLimit, effectiveLimit, options: args.options, errorMessage: firstFailureMessage },
    });
    return {
      ok: completedStatus === "success",
      importedCount,
      skippedDuplicateCount,
      failedCount,
      syncLogId: syncLog.id,
      status: completedStatus,
      errorMessage: firstFailureMessage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email import failed";
    await updateEmailSyncLog(args.r, firmId, syncLog.id, {
      finishedAt: now(),
      status: importedCount > 0 ? "partial" : "failed",
      importedCount,
      skippedDuplicateCount,
      errorMessage: message,
    });
    await updateEmailAccount(args.r, firmId, args.accountId, {
      status: "error",
      lastError: message,
    });
    await writeCommunicationAuditLog({
      r: args.r,
      req: args.req,
      action: "communication.email_sync.failed",
      newValue: { accountId: args.accountId, syncLogId: syncLog.id, importedCount, skippedDuplicateCount, failedCount, options: args.options, errorMessage: message },
    });
    throw error;
  }
}

export async function listConnectedEmailAccounts(args: { r: DbConn; req: AuthRequest }) {
  const rows = await listEmailAccounts(args.r, args.req.firmId!);
  return rows.map(sanitizeEmailAccount);
}

export async function listEmailFolders(args: { r: DbConn; req: AuthRequest; accountId: number }) {
  await getAccountOrThrow(args.r, args.req.firmId!, args.accountId);
  return listEmailFoldersForAccount(args.r, args.req.firmId!, args.accountId);
}

export async function listEmailSyncLogs(args: { r: DbConn; req: AuthRequest; accountId: number; limit: number }) {
  await getAccountOrThrow(args.r, args.req.firmId!, args.accountId);
  return listEmailSyncLogsForAccount(args.r, args.req.firmId!, args.accountId, args.limit);
}

export async function getEmailProviderSetupStatus(_args: { req: AuthRequest }) {
  const microsoft = getMicrosoftOauthSetupStatus();
  const gmail = getGoogleOauthSetupStatus();
  const encryptionConfigured = isEmailEncryptionConfigured();
  return {
    encryptionConfigured,
    encryptionMissing: encryptionConfigured ? [] : ["EMAIL_TOKEN_ENCRYPTION_KEY"],
    microsoft,
    gmail: {
      configured: gmail.configured,
      missing: gmail.missing,
      available: gmail.configured && encryptionConfigured,
      message: gmail.configured
        ? "Gmail OAuth configuration is available."
        : "Gmail connection requires Google OAuth configuration.",
    },
    yahoo: {
      available: encryptionConfigured,
      missing: encryptionConfigured ? [] : ["EMAIL_TOKEN_ENCRYPTION_KEY"],
      message: "Yahoo Mail uses IMAP with a Yahoo App Password.",
    },
    otherImap: {
      available: encryptionConfigured,
      missing: encryptionConfigured ? [] : ["EMAIL_TOKEN_ENCRYPTION_KEY"],
      message: "Custom domain mailboxes can connect with IMAP credentials or app passwords.",
    },
  };
}

export async function lookupCasesForCommunication(args: { r: DbConn; req: AuthRequest; q: string; limit: number }) {
  return lookupCases(args.r, args.req.firmId!, args.q, args.limit);
}

export async function createEmailAccount(args: { r: DbConn; req: AuthRequest; input: { provider: string; emailAddress: string; displayName?: string | null } }) {
  requireMailboxManagementRole(args.req);
  throw new ApiError({
    status: 400,
    code: "EMAIL_PROVIDER_CREATE_NOT_SUPPORTED",
    message: "Use the provider-specific connection flow for Microsoft, Gmail, Yahoo Mail, or Other IMAP.",
  });
}

export async function startMicrosoftOauth(args: { req: AuthRequest; returnTo?: string | null }) {
  requireMailboxManagementRole(args.req);
  ensureEmailEncryptionConfigured();
  ensureMicrosoftOauthConfigured();
  const state = signEmailState({
    firmId: args.req.firmId!,
    userId: args.req.userId!,
    provider: "microsoft_graph",
    returnTo: ensureAbsoluteReturnTo(args.returnTo) ?? "/app/communication/email",
    issuedAt: Date.now(),
  });
  return { url: buildMicrosoftConnectUrl(state) };
}

export async function completeMicrosoftOauth(args: { r: DbConn; req: AuthRequest; code: string; state: string }) {
  requireMailboxManagementRole(args.req);
  ensureEmailEncryptionConfigured();
  const statePayload = verifyEmailState<{ firmId: number; userId: number; provider: string; returnTo: string }>(args.state);
  if (statePayload.firmId !== args.req.firmId || statePayload.userId !== args.req.userId || statePayload.provider !== "microsoft_graph") {
    throw new ApiError({
      status: 400,
      code: "EMAIL_OAUTH_STATE_MISMATCH",
      message: "Mailbox connection state does not match the current session.",
    });
  }
  const tokenResult = await exchangeMicrosoftCodeForTokens(args.code);
  const profile = await fetchMicrosoftMailboxProfile(tokenResult.accessToken);
  const defaultSignature = buildDefaultSignature({ displayName: profile.displayName, emailAddress: profile.emailAddress });
  const existing = await getEmailAccountByProviderEmail(args.r, args.req.firmId!, "microsoft_graph", profile.emailAddress);
  const saved = existing
    ? await updateEmailAccount(args.r, args.req.firmId!, existing.id, {
        displayName: profile.displayName,
        status: "active",
        oauthScopes: parseStoredScopes(existing.oauthScopes),
        encryptedAccessToken: encryptEmailSecret(tokenResult.accessToken),
        encryptedRefreshToken: tokenResult.refreshToken ? encryptEmailSecret(tokenResult.refreshToken) : existing.encryptedRefreshToken,
        tokenExpiresAt: tokenResult.expiresAt,
        signatureHtml: existing.signatureHtml ?? defaultSignature.html,
        signatureText: existing.signatureText ?? defaultSignature.text,
        lastError: null,
      })
    : await insertEmailAccount(args.r, {
        firmId: args.req.firmId!,
        provider: "microsoft_graph",
        emailAddress: profile.emailAddress,
        displayName: profile.displayName,
        status: "active",
        oauthScopes: [],
        encryptedAccessToken: encryptEmailSecret(tokenResult.accessToken),
        encryptedRefreshToken: tokenResult.refreshToken ? encryptEmailSecret(tokenResult.refreshToken) : null,
        tokenExpiresAt: tokenResult.expiresAt,
        signatureHtml: defaultSignature.html,
        signatureText: defaultSignature.text,
        createdBy: args.req.userId ?? null,
      });
  const account = saved ?? existing;
  if (!account) throw new ApiError({ status: 500, code: "EMAIL_ACCOUNT_SAVE_FAILED", message: "Unable to save Microsoft mailbox account." });
  const folders = await fetchMicrosoftFolders(tokenResult.accessToken);
  await upsertProviderFolders({ r: args.r, firmId: args.req.firmId!, accountId: account.id, folders });
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: existing ? "communication.email_account.updated" : "communication.email_account.connected",
    newValue: { accountId: account.id, provider: "microsoft_graph", emailAddress: account.emailAddress },
  });
  return { account: sanitizeEmailAccount(account), returnTo: statePayload.returnTo };
}

export async function startGoogleOauth(args: { req: AuthRequest; returnTo?: string | null }) {
  requireMailboxManagementRole(args.req);
  ensureEmailEncryptionConfigured();
  ensureGoogleOauthConfigured();
  const state = signEmailState({
    firmId: args.req.firmId!,
    userId: args.req.userId!,
    provider: "gmail",
    returnTo: ensureAbsoluteReturnTo(args.returnTo) ?? "/app/settings/email",
    issuedAt: Date.now(),
  });
  return { url: buildGoogleConnectUrl(state) };
}

export async function completeGoogleOauth(args: { r: DbConn; req: AuthRequest; code: string; state: string }) {
  requireMailboxManagementRole(args.req);
  ensureEmailEncryptionConfigured();
  const statePayload = verifyEmailState<{ firmId: number; userId: number; provider: string; returnTo: string }>(args.state);
  if (statePayload.firmId !== args.req.firmId || statePayload.userId !== args.req.userId || statePayload.provider !== "gmail") {
    throw new ApiError({
      status: 400,
      code: "EMAIL_OAUTH_STATE_MISMATCH",
      message: "Mailbox connection state does not match the current session.",
    });
  }
  const tokenResult = await exchangeGoogleCodeForTokens(args.code);
  const profile = await fetchGoogleMailboxProfile(tokenResult.accessToken);
  const defaultSignature = buildDefaultSignature({ displayName: profile.displayName, emailAddress: profile.emailAddress });
  const existing = await getEmailAccountByProviderEmail(args.r, args.req.firmId!, "gmail", profile.emailAddress);
  const saved = existing
    ? await updateEmailAccount(args.r, args.req.firmId!, existing.id, {
        displayName: profile.displayName,
        status: "active",
        oauthScopes: tokenResult.scopes,
        encryptedAccessToken: encryptEmailSecret(tokenResult.accessToken),
        encryptedRefreshToken: tokenResult.refreshToken ? encryptEmailSecret(tokenResult.refreshToken) : existing.encryptedRefreshToken,
        tokenExpiresAt: tokenResult.expiresAt,
        signatureHtml: existing.signatureHtml ?? defaultSignature.html,
        signatureText: existing.signatureText ?? defaultSignature.text,
        lastError: null,
      })
    : await insertEmailAccount(args.r, {
        firmId: args.req.firmId!,
        provider: "gmail",
        emailAddress: profile.emailAddress,
        displayName: profile.displayName,
        status: "active",
        oauthScopes: tokenResult.scopes,
        encryptedAccessToken: encryptEmailSecret(tokenResult.accessToken),
        encryptedRefreshToken: tokenResult.refreshToken ? encryptEmailSecret(tokenResult.refreshToken) : null,
        tokenExpiresAt: tokenResult.expiresAt,
        signatureHtml: defaultSignature.html,
        signatureText: defaultSignature.text,
        createdBy: args.req.userId ?? null,
      });
  const account = saved ?? existing;
  if (!account) throw new ApiError({ status: 500, code: "EMAIL_ACCOUNT_SAVE_FAILED", message: "Unable to save Gmail mailbox account." });
  const folders = await fetchGoogleLabels(tokenResult.accessToken);
  await upsertProviderFolders({ r: args.r, firmId: args.req.firmId!, accountId: account.id, folders });
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: existing ? "communication.email_account.updated" : "communication.email_account.connected",
    newValue: { accountId: account.id, provider: "gmail", emailAddress: account.emailAddress },
  });
  return { account: sanitizeEmailAccount(account), returnTo: statePayload.returnTo };
}

export async function syncEmailAccountFolders(args: { r: DbConn; req: AuthRequest; accountId: number }) {
  requireMailboxManagementRole(args.req);
  const firmId = args.req.firmId!;
  const account = await getAccountOrThrow(args.r, firmId, args.accountId);
  if (account.provider === "microsoft_graph") {
    const { accessToken } = await ensureMicrosoftAccessToken({ r: args.r, firmId, accountId: args.accountId });
    const folders = await fetchMicrosoftFolders(accessToken);
    const saved = await upsertProviderFolders({ r: args.r, firmId, accountId: args.accountId, folders });
    await updateEmailAccount(args.r, firmId, args.accountId, { status: "active", lastError: null });
    return saved;
  }
  if (account.provider === "gmail") {
    const { accessToken } = await ensureGoogleAccessToken({ r: args.r, firmId, accountId: args.accountId });
    const folders = await fetchGoogleLabels(accessToken);
    const saved = await upsertProviderFolders({ r: args.r, firmId, accountId: args.accountId, folders });
    await updateEmailAccount(args.r, firmId, args.accountId, { status: "active", lastError: null });
    return saved;
  }
  if (account.provider === "imap" || account.provider === "yahoo_imap") {
    const password = decryptEmailSecret(account.encryptedImapPassword);
    if (!password || !account.imapHost || !account.imapPort || !account.imapUsername) {
      throw new ApiError({
        status: 400,
        code: "IMAP_CONFIGURATION_INCOMPLETE",
        message: "IMAP mailbox configuration is incomplete.",
      });
    }
    let folders;
    try {
      folders = await fetchImapFolders({
        host: account.imapHost,
        port: account.imapPort,
        username: account.imapUsername,
        password,
        useTls: account.useTls ?? true,
      });
    } catch (error) {
      throw buildFriendlyImapError(error);
    }
    const saved = await upsertProviderFolders({ r: args.r, firmId, accountId: args.accountId, folders });
    await updateEmailAccount(args.r, firmId, args.accountId, { status: "active", lastError: null });
    return saved;
  }
  throw new ApiError({
    status: 400,
    code: "EMAIL_PROVIDER_NOT_SUPPORTED",
    message: "Folder sync is not supported for this provider.",
  });
}

export async function testImapMailbox(args: {
  req: AuthRequest;
  input: ImapMailboxInput;
}) {
  requireMailboxManagementRole(args.req);
  ensureEmailEncryptionConfigured();
  const normalized = normalizeImapMailboxInput(args.input);
  try {
    return await testImapConnection({
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      password: normalized.password,
      useTls: normalized.useTls,
    });
  } catch (error) {
    throw buildFriendlyImapError(error);
  }
}

export async function connectImapMailbox(args: {
  r: DbConn;
  req: AuthRequest;
  input: ImapMailboxInput;
}) {
  requireMailboxManagementRole(args.req);
  ensureEmailEncryptionConfigured();
  const normalized = normalizeImapMailboxInput(args.input);
  let folders;
  try {
    folders = await fetchImapFolders({
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      password: normalized.password,
      useTls: normalized.useTls,
    });
  } catch (error) {
    throw buildFriendlyImapError(error);
  }
  const existing = await getEmailAccountByProviderEmail(args.r, args.req.firmId!, normalized.provider, normalized.emailAddress);
  const saved = existing
    ? await updateEmailAccount(args.r, args.req.firmId!, existing.id, {
        displayName: normalized.displayName?.trim() || null,
        status: "active",
        imapHost: normalized.host,
        imapPort: normalized.port,
        imapUsername: normalized.username,
        encryptedImapPassword: encryptEmailSecret(normalized.password),
        useTls: normalized.useTls,
        lastError: null,
      })
    : await insertEmailAccount(args.r, {
        firmId: args.req.firmId!,
        provider: normalized.provider,
        emailAddress: normalized.emailAddress,
        displayName: normalized.displayName?.trim() || null,
        status: "active",
        imapHost: normalized.host,
        imapPort: normalized.port,
        imapUsername: normalized.username,
        encryptedImapPassword: encryptEmailSecret(normalized.password),
        useTls: normalized.useTls,
        createdBy: args.req.userId ?? null,
      });
  const account = saved ?? existing;
  if (!account) throw new ApiError({ status: 500, code: "EMAIL_ACCOUNT_SAVE_FAILED", message: "Unable to save IMAP mailbox account." });
  const folderRows = await upsertProviderFolders({ r: args.r, firmId: args.req.firmId!, accountId: account.id, folders });
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: existing ? "communication.email_account.updated" : "communication.email_account.connected",
    newValue: { accountId: account.id, provider: normalized.provider, emailAddress: account.emailAddress },
  });
  return { account: sanitizeEmailAccount(account), folders: folderRows };
}

export async function patchEmailAccountDetails(args: { r: DbConn; req: AuthRequest; accountId: number; patch: { displayName?: string | null; status?: "active" | "disconnected" | "error" | "setup_required" } }) {
  requireMailboxManagementRole(args.req);
  const account = await getAccountOrThrow(args.r, args.req.firmId!, args.accountId);
  const updated = await updateEmailAccount(args.r, args.req.firmId!, args.accountId, {
    displayName: args.patch.displayName !== undefined ? (args.patch.displayName?.trim() || null) : account.displayName,
    status: args.patch.status ?? account.status,
  });
  return sanitizeEmailAccount(updated ?? account);
}

export async function disconnectEmailAccount(args: { r: DbConn; req: AuthRequest; accountId: number }) {
  requireMailboxManagementRole(args.req);
  const account = await getAccountOrThrow(args.r, args.req.firmId!, args.accountId);
  const updated = await updateEmailAccount(args.r, args.req.firmId!, args.accountId, {
    status: "disconnected",
    encryptedAccessToken: null,
    encryptedRefreshToken: null,
    encryptedImapPassword: null,
    tokenExpiresAt: null,
    lastError: null,
  });
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.email_account.disconnected",
    newValue: { accountId: account.id, provider: account.provider, emailAddress: account.emailAddress },
  });
  return sanitizeEmailAccount(updated ?? account);
}

export async function patchEmailFolderDetails(args: { r: DbConn; req: AuthRequest; folderId: number; syncEnabled: boolean }) {
  requireMailboxManagementRole(args.req);
  const folder = await getEmailFolderById(args.r, args.req.firmId!, args.folderId);
  if (!folder) {
    throw new ApiError({
      status: 404,
      code: "EMAIL_FOLDER_NOT_FOUND",
      message: "Mailbox folder not found.",
    });
  }
  const updated = await updateEmailFolder(args.r, args.req.firmId!, args.folderId, { syncEnabled: args.syncEnabled });
  return updated ?? folder;
}

export async function importEmailNow(args: { r: DbConn; req: AuthRequest; accountId: number; options?: Partial<EmailImportOptions> | null }) {
  requireMailboxManagementRole(args.req);
  const account = await getAccountOrThrow(args.r, args.req.firmId!, args.accountId);
  if (account.status === "setup_required") {
    throw new ApiError({
      status: 400,
      code: "EMAIL_SETUP_INCOMPLETE",
      message: "Mailbox setup is incomplete. Please complete provider connection first.",
    });
  }
  return await importMessagesForAccount({ ...args, options: normalizeImportOptions(args.options) });
}

function toSendCapabilityError(account: any): ApiError {
  const sendState = getEmailAccountSendState(account);
  if (sendState.canSend) {
    return new ApiError({
      status: 400,
      code: "EMAIL_SEND_UNAVAILABLE",
      message: "Sending is not available for this mailbox.",
    });
  }
  return new ApiError({
    status: 400,
    code: sendState.requiresReconnect ? "GMAIL_SEND_SCOPE_MISSING" : "EMAIL_SEND_NOT_CONFIGURED",
    message: sendState.reason ?? "Sending is not configured for this mailbox.",
  });
}

async function sendEmailForMessage(args: { r: DbConn; req: AuthRequest; messageId: number; mode: EmailSendMode; input: EmailSendInput }) {
  const firmId = args.req.firmId!;
  const original = await getMessageById(args.r, firmId, args.messageId);
  if (!original) return null;
  if (original.channel !== "email" || !original.emailAccountId) {
    throw new ApiError({
      status: 400,
      code: "EMAIL_SEND_ACCOUNT_MISSING",
      message: "This email is not linked to a connected mailbox.",
    });
  }

  const account = await getAccountOrThrow(args.r, firmId, original.emailAccountId);
  const sendState = getEmailAccountSendState(account);
  if (!sendState.canSend) throw toSendCapabilityError(account);

  const content = normalizeOutgoingEmailContent(args.input);
  if (!content.to.length) {
    throw new ApiError({
      status: 400,
      code: "EMAIL_TO_REQUIRED",
      message: "At least one recipient is required.",
    });
  }
  if (content.attachments.length) {
    throw new ApiError({
      status: 400,
      code: "EMAIL_ATTACHMENTS_NOT_SUPPORTED",
      message: "Attachment sending will be enabled in the next phase.",
    });
  }

  if (account.provider !== "gmail") throw toSendCapabilityError(account);

  const { accessToken } = await ensureGoogleAccessToken({ r: args.r, firmId, accountId: account.id });
  let referenceMeta = {
    threadId: original.providerThreadId ?? null,
    messageIdHeader: original.internetMessageId ?? null,
    referencesHeader: null as string | null,
  };
  if (args.mode !== "forward" && original.providerMessageId) {
    try {
      const liveReferenceMeta = await fetchGmailMessageReferenceMetadata(accessToken, original.providerMessageId);
      referenceMeta = {
        threadId: liveReferenceMeta.threadId ?? referenceMeta.threadId,
        messageIdHeader: liveReferenceMeta.messageIdHeader ?? referenceMeta.messageIdHeader,
        referencesHeader: liveReferenceMeta.referencesHeader ?? null,
      };
    } catch {
      // Fall back to stored metadata when Gmail metadata lookup is unavailable.
    }
  }

  const inReplyTo = args.mode === "forward" ? null : (referenceMeta.messageIdHeader ?? null);
  const references = args.mode === "forward"
    ? null
    : [referenceMeta.referencesHeader, referenceMeta.messageIdHeader]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .trim() || null;

  const providerResult = await sendGmailMessage({
    accessToken,
    fromAddress: account.emailAddress,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    bodyHtml: content.bodyHtml,
    bodyText: content.bodyText,
    threadId: args.mode === "forward" ? null : (original.providerThreadId ?? referenceMeta.threadId ?? null),
    inReplyTo,
    references,
  });

  const sentAt = now();
  const outboundMessage = await insertMessage(args.r, {
    firmId,
    mailboxId: original.mailboxId ?? null,
    emailAccountId: account.id,
    emailFolderId: null,
    channel: "email",
    provider: account.provider,
    providerMessageId: String(providerResult.id ?? "").trim() || null,
    providerThreadId: String(providerResult.threadId ?? "").trim() || original.providerThreadId || null,
    providerConversationId: String(providerResult.threadId ?? "").trim() || original.providerThreadId || null,
    providerFolder: "Sent",
    internetMessageId: null,
    providerUid: null,
    providerIsRead: true,
    direction: "outgoing",
    fromAddress: account.emailAddress,
    fromName: account.displayName ?? null,
    toAddresses: content.to,
    ccAddresses: content.cc,
    bccAddresses: content.bcc,
    subject: content.subject || null,
    bodyPreview: clampPreview(content.bodyText || (content.bodyHtml ? htmlToPlainText(content.bodyHtml) : null)),
    bodyText: content.bodyText || null,
    bodyHtml: content.bodyHtml,
    attachmentCount: 0,
    receivedAt: null,
    sentAt,
    internalStatus: "sent",
    isBatch: false,
    linkedCaseId: original.linkedCaseId ?? null,
    assignedToUserId: args.req.userId ?? null,
    lastActivityAt: sentAt,
    lastSyncedAt: sentAt,
    createdBy: args.req.userId ?? null,
  });

  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: `communication.message.${args.mode}.sent`,
    messageId: args.messageId,
    newValue: {
      outboundMessageId: outboundMessage.id,
      emailAccountId: account.id,
      providerMessageId: outboundMessage.providerMessageId,
      providerThreadId: outboundMessage.providerThreadId,
      to: content.to,
      cc: content.cc,
      bcc: content.bcc,
      subject: content.subject,
      sentAt: sentAt.toISOString(),
    },
  });

  return {
    success: true as const,
    providerMessageId: outboundMessage.providerMessageId,
    sentAt: sentAt.toISOString(),
  };
}

export async function replyToMessage(args: { r: DbConn; req: AuthRequest; messageId: number; input: EmailSendInput }) {
  return sendEmailForMessage({ ...args, mode: "reply" });
}

export async function replyAllToMessage(args: { r: DbConn; req: AuthRequest; messageId: number; input: EmailSendInput }) {
  return sendEmailForMessage({ ...args, mode: "reply_all" });
}

export async function forwardMessage(args: { r: DbConn; req: AuthRequest; messageId: number; input: EmailSendInput }) {
  return sendEmailForMessage({ ...args, mode: "forward" });
}

export async function listMessageTasks(args: { r: DbConn; firmId: number; messageId: number }) {
  const tasks = await listTasksForMessage(args.r, args.firmId, args.messageId);
  const assignees = await listAssigneesForTasks(args.r, args.firmId, tasks.map((t) => t.id));
  const byTaskId = new Map<number, Array<{ assignmentRole: string; userId: number }>>();
  for (const a of assignees) {
    const tid = a.taskId as any;
    if (typeof tid !== "number") continue;
    const arr = byTaskId.get(tid) ?? [];
    arr.push({ assignmentRole: a.assignmentRole, userId: a.userId });
    byTaskId.set(tid, arr);
  }
  return tasks.map((t) => ({ ...t, team: buildTeamFromAssignees(byTaskId.get(t.id) ?? []) }));
}

export async function listMyTasks(args: { r: DbConn; firmId: number; userId: number; limit: number; offset: number }) {
  return listTasksMine(args.r, args.firmId, args.userId, args.limit, args.offset);
}

export async function createMessageTask(args: {
  r: DbConn;
  req: AuthRequest;
  parentMessageId: number;
  input: {
    linkedCaseId?: number | null;
    caseRef?: string | null;
    partyName?: string | null;
    bankRef?: string | null;
    developerRef?: string | null;
    propertyRef?: string | null;
    assignedToUserId?: number | null;
    requiredAction?: string | null;
    dueAt?: string | null;
    team?: any | null;
  };
}) {
  const firmId = args.req.firmId!;
  const parent = await getMessageById(args.r, firmId, args.parentMessageId);
  if (!parent) return null;

  let resolvedCaseId: number | null = null;
  let caseRef = (args.input.caseRef ?? "").trim() || null;
  let responsibleLawyerId: number | null = null;
  let responsibleClerkId: number | null = null;
  if (args.input.linkedCaseId || args.input.caseRef) {
    const found = await findCaseByIdOrRef(args.r, firmId, { caseId: args.input.linkedCaseId ?? null, caseRef: args.input.caseRef ?? null });
    if (found) {
      resolvedCaseId = found.id;
      const display = await getCaseRefDisplay(args.r, firmId, found.id);
      caseRef = display?.caseRef ?? caseRef;
      const resp = await getCaseResponsibleUsers(args.r, firmId, found.id);
      responsibleLawyerId = resp.lawyerId;
      responsibleClerkId = resp.clerkId;
    }
  }

  const normalizedTeamBase = normalizeTeamInput(args.input.team, args.input.assignedToUserId ?? null);
  const normalizedTeam = {
    lawyerInChargeUserId: normalizedTeamBase.lawyerInChargeUserId ?? responsibleLawyerId ?? null,
    handlerUserIds: normalizedTeamBase.handlerUserIds.length ? normalizedTeamBase.handlerUserIds : (responsibleClerkId ? [responsibleClerkId] : []),
    reviewerUserId: normalizedTeamBase.reviewerUserId ?? null,
    watcherUserIds: normalizedTeamBase.watcherUserIds,
  };
  const primaryAssignee = normalizedTeam.handlerUserIds[0] ?? normalizedTeam.lawyerInChargeUserId ?? null;
  const task = await insertTask(args.r, {
    firmId,
    parentMessageId: parent.id,
    channel: parent.channel,
    linkedCaseId: resolvedCaseId,
    caseRef,
    partyName: args.input.partyName?.trim() || null,
    bankRef: args.input.bankRef?.trim() || null,
    developerRef: args.input.developerRef?.trim() || null,
    propertyRef: args.input.propertyRef?.trim() || null,
    responsibleLawyerId,
    responsibleClerkId,
    assignedToUserId: primaryAssignee,
    assignedByUserId: primaryAssignee ? (args.req.userId ?? null) : null,
    assignedAt: primaryAssignee ? now() : null,
    taskStatus: "pending_owner_review",
    requiredAction: args.input.requiredAction?.trim() || null,
    dueAt: args.input.dueAt ? new Date(args.input.dueAt) : null,
    createdBy: args.req.userId ?? null,
  });

  const assignedAt = now();
  const assigneeRows: Array<any> = [];
  if (normalizedTeam.lawyerInChargeUserId) {
    assigneeRows.push({
      firmId,
      messageId: parent.id,
      taskId: task.id,
      userId: normalizedTeam.lawyerInChargeUserId,
      assignmentRole: "lawyer_in_charge",
      isPrimary: true,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  for (const [idx, userId] of normalizedTeam.handlerUserIds.entries()) {
    assigneeRows.push({
      firmId,
      messageId: parent.id,
      taskId: task.id,
      userId,
      assignmentRole: "handler",
      isPrimary: idx === 0,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  if (normalizedTeam.reviewerUserId) {
    assigneeRows.push({
      firmId,
      messageId: parent.id,
      taskId: task.id,
      userId: normalizedTeam.reviewerUserId,
      assignmentRole: "reviewer",
      isPrimary: false,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  for (const userId of normalizedTeam.watcherUserIds) {
    assigneeRows.push({
      firmId,
      messageId: parent.id,
      taskId: task.id,
      userId,
      assignmentRole: "watcher",
      isPrimary: false,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  if (assigneeRows.length) await replaceAssigneesForTask(args.r, firmId, parent.id, task.id, assigneeRows);

  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.created",
    messageId: parent.id,
    caseTaskId: task.id,
    newValue: { linkedCaseId: task.linkedCaseId ?? null, assignedToUserId: task.assignedToUserId ?? null, team: normalizedTeam },
  });

  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: parent.id });
  return { ...task, team: normalizedTeam };
}

export async function assignTask(args: { r: DbConn; req: AuthRequest; taskId: number; assignedToUserId: number | null }) {
  const firmId = args.req.firmId!;
  const roleName = getRoleNameFromReq(args.req);
  if (!isPartnerOrAdminRole(roleName)) return { error: "forbidden" as const };
  const existing = await getTaskById(args.r, firmId, args.taskId);
  if (!existing) return null;
  const updated = await updateTask(args.r, firmId, args.taskId, {
    assignedToUserId: args.assignedToUserId,
    assignedByUserId: args.assignedToUserId ? (args.req.userId ?? null) : null,
    assignedAt: args.assignedToUserId ? now() : null,
  });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.assigned",
    messageId: updated.parentMessageId,
    caseTaskId: updated.id,
    oldValue: { assignedToUserId: existing.assignedToUserId ?? null },
    newValue: { assignedToUserId: updated.assignedToUserId ?? null },
  });
  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: updated.parentMessageId });
  return updated;
}

export async function setTaskResponsibleTeam(args: { r: DbConn; req: AuthRequest; taskId: number; team: any }) {
  const firmId = args.req.firmId!;
  const roleName = getRoleNameFromReq(args.req);
  if (!isPartnerOrAdminRole(roleName)) return { error: "forbidden" as const };

  const existing = await getTaskById(args.r, firmId, args.taskId);
  if (!existing) return null;

  const normalizedTeam = normalizeTeamInput(args.team, null);
  const primaryAssignee = normalizedTeam.handlerUserIds[0] ?? normalizedTeam.lawyerInChargeUserId ?? null;
  const updated = await updateTask(args.r, firmId, args.taskId, {
    assignedToUserId: primaryAssignee,
    assignedByUserId: primaryAssignee ? (args.req.userId ?? null) : null,
    assignedAt: primaryAssignee ? now() : null,
  });
  if (!updated) return null;

  const assignedAt = now();
  const rows: Array<any> = [];
  if (normalizedTeam.lawyerInChargeUserId) {
    rows.push({
      firmId,
      messageId: updated.parentMessageId,
      taskId: updated.id,
      userId: normalizedTeam.lawyerInChargeUserId,
      assignmentRole: "lawyer_in_charge",
      isPrimary: true,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  for (const [idx, userId] of normalizedTeam.handlerUserIds.entries()) {
    rows.push({
      firmId,
      messageId: updated.parentMessageId,
      taskId: updated.id,
      userId,
      assignmentRole: "handler",
      isPrimary: idx === 0,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  if (normalizedTeam.reviewerUserId) {
    rows.push({
      firmId,
      messageId: updated.parentMessageId,
      taskId: updated.id,
      userId: normalizedTeam.reviewerUserId,
      assignmentRole: "reviewer",
      isPrimary: false,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  for (const userId of normalizedTeam.watcherUserIds) {
    rows.push({
      firmId,
      messageId: updated.parentMessageId,
      taskId: updated.id,
      userId,
      assignmentRole: "watcher",
      isPrimary: false,
      status: "assigned",
      assignedBy: args.req.userId ?? null,
      assignedAt,
    });
  }
  await replaceAssigneesForTask(args.r, firmId, updated.parentMessageId, updated.id, rows);

  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.team_updated",
    messageId: updated.parentMessageId,
    caseTaskId: updated.id,
    oldValue: { assignedToUserId: existing.assignedToUserId ?? null },
    newValue: { assignedToUserId: updated.assignedToUserId ?? null, team: normalizedTeam },
  });

  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: updated.parentMessageId });
  return { ...updated, team: normalizedTeam };
}

export async function acknowledgeTask(args: { r: DbConn; req: AuthRequest; taskId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getTaskById(args.r, firmId, args.taskId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  let allowed = canAcknowledgeTask({
    actorUserId: args.req.userId!,
    roleName,
    assignedToUserId: existing.assignedToUserId ?? null,
    responsibleLawyerId: existing.responsibleLawyerId ?? null,
    responsibleClerkId: existing.responsibleClerkId ?? null,
  });
  if (!allowed) allowed = await isTaskTeamMember(args.r, firmId, existing.id, args.req.userId!);
  if (!allowed) return { error: "forbidden" as const };
  const t = now();
  const updated = await updateTask(args.r, firmId, args.taskId, {
    taskStatus: "seen_by_owner",
    seenByOwnerAt: t,
    acknowledgedAt: t,
  });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.acknowledged",
    messageId: updated.parentMessageId,
    caseTaskId: updated.id,
    oldValue: { taskStatus: existing.taskStatus },
    newValue: { taskStatus: updated.taskStatus },
  });
  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: updated.parentMessageId });
  return updated;
}

export async function updateTaskStatus(args: { r: DbConn; req: AuthRequest; taskId: number; taskStatus: string }) {
  const firmId = args.req.firmId!;
  const existing = await getTaskById(args.r, firmId, args.taskId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  let allowed = canMutateTask({
    actorUserId: args.req.userId!,
    roleName,
    assignedToUserId: existing.assignedToUserId ?? null,
    responsibleLawyerId: existing.responsibleLawyerId ?? null,
    responsibleClerkId: existing.responsibleClerkId ?? null,
  });
  if (!allowed) allowed = await isTaskTeamMember(args.r, firmId, existing.id, args.req.userId!);
  if (!allowed) return { error: "forbidden" as const };

  if (["ready_to_reply", "included_in_draft", "replied", "closed"].includes(args.taskStatus)) {
    const assignees = await listAssigneesForTasks(args.r, firmId, [existing.id]);
    const hasLawyerInCharge = assignees.some((a) => a.taskId === existing.id && a.assignmentRole === "lawyer_in_charge");
    if (!hasLawyerInCharge && !existing.responsibleLawyerId) return { error: "missing_lawyer_in_charge" as const };
  }

  const t = now();
  const patch: any = { taskStatus: args.taskStatus };
  if (args.taskStatus === "ready_to_reply" || args.taskStatus === "included_in_draft") patch.readyAt = t;
  if (args.taskStatus === "replied") patch.repliedAt = t;
  if (args.taskStatus === "closed") patch.closedAt = t;

  const updated = await updateTask(args.r, firmId, args.taskId, patch);
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.status_updated",
    messageId: updated.parentMessageId,
    caseTaskId: updated.id,
    oldValue: { taskStatus: existing.taskStatus },
    newValue: { taskStatus: updated.taskStatus },
  });
  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: updated.parentMessageId });
  return updated;
}

export async function updateTaskReplyNote(args: { r: DbConn; req: AuthRequest; taskId: number; replyNote: string | null }) {
  const firmId = args.req.firmId!;
  const existing = await getTaskById(args.r, firmId, args.taskId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  let allowed = canMutateTask({
    actorUserId: args.req.userId!,
    roleName,
    assignedToUserId: existing.assignedToUserId ?? null,
    responsibleLawyerId: existing.responsibleLawyerId ?? null,
    responsibleClerkId: existing.responsibleClerkId ?? null,
  });
  if (!allowed) allowed = await isTaskTeamMember(args.r, firmId, existing.id, args.req.userId!);
  if (!allowed) return { error: "forbidden" as const };
  const updated = await updateTask(args.r, firmId, args.taskId, { replyNote: args.replyNote?.trim() || null });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.reply_note_updated",
    messageId: updated.parentMessageId,
    caseTaskId: updated.id,
    oldValue: { replyNote: existing.replyNote ?? null },
    newValue: { replyNote: updated.replyNote ?? null },
  });
  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: updated.parentMessageId });
  return updated;
}

export async function linkTaskCase(args: { r: DbConn; req: AuthRequest; taskId: number; caseId?: number | null; caseRef?: string | null }) {
  const firmId = args.req.firmId!;
  const existing = await getTaskById(args.r, firmId, args.taskId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  let allowed = isPartnerOrAdminRole(roleName) || (existing.assignedToUserId && existing.assignedToUserId === args.req.userId);
  if (!allowed) allowed = await isTaskTeamMember(args.r, firmId, existing.id, args.req.userId!);
  if (!allowed) return { error: "forbidden" as const };
  const found = await findCaseByIdOrRef(args.r, firmId, { caseId: args.caseId ?? null, caseRef: args.caseRef ?? null });
  if (!found) return { error: "case_not_found" as const };
  const display = await getCaseRefDisplay(args.r, firmId, found.id);
  const resp = await getCaseResponsibleUsers(args.r, firmId, found.id);
  const updated = await updateTask(args.r, firmId, args.taskId, {
    linkedCaseId: found.id,
    caseRef: display?.caseRef ?? existing.caseRef ?? null,
    responsibleLawyerId: resp.lawyerId,
    responsibleClerkId: resp.clerkId,
  });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.link_case",
    messageId: updated.parentMessageId,
    caseTaskId: updated.id,
    oldValue: { linkedCaseId: existing.linkedCaseId ?? null },
    newValue: { linkedCaseId: updated.linkedCaseId ?? null },
  });
  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: updated.parentMessageId });
  return updated;
}

export async function closeTask(args: { r: DbConn; req: AuthRequest; taskId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getTaskById(args.r, firmId, args.taskId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  let allowed = canMutateTask({
    actorUserId: args.req.userId!,
    roleName,
    assignedToUserId: existing.assignedToUserId ?? null,
    responsibleLawyerId: existing.responsibleLawyerId ?? null,
    responsibleClerkId: existing.responsibleClerkId ?? null,
  });
  if (!allowed) allowed = await isTaskTeamMember(args.r, firmId, existing.id, args.req.userId!);
  if (!allowed) return { error: "forbidden" as const };
  const assignees = await listAssigneesForTasks(args.r, firmId, [existing.id]);
  const hasLawyerInCharge = assignees.some((a) => a.taskId === existing.id && a.assignmentRole === "lawyer_in_charge");
  if (!hasLawyerInCharge && !existing.responsibleLawyerId) return { error: "missing_lawyer_in_charge" as const };
  const updated = await updateTask(args.r, firmId, args.taskId, { taskStatus: "closed", closedAt: now() });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.task.closed",
    messageId: updated.parentMessageId,
    caseTaskId: updated.id,
    oldValue: { taskStatus: existing.taskStatus },
    newValue: { taskStatus: updated.taskStatus },
  });
  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: updated.parentMessageId });
  return updated;
}

export async function createDraft(args: {
  r: DbConn;
  req: AuthRequest;
  draftType: CommunicationDraftType;
  parentMessageId: number;
  taskIds: number[];
  to: unknown;
  cc: unknown;
  bcc: unknown;
  subject?: string | null;
}) {
  const firmId = args.req.firmId!;
  const roleName = getRoleNameFromReq(args.req);
  const parent = await getMessageById(args.r, firmId, args.parentMessageId);
  if (!parent) return null;

  const tasks = await listTasksForMessage(args.r, firmId, parent.id);
  const selected = tasks.filter((t) => args.taskIds.includes(t.id));
  if (!selected.length) return { error: "no_tasks" as const };

  const isPrivileged = isPartnerOrAdminRole(roleName) || isLawyerRoleName(roleName);
  if (!isPrivileged) {
    const assignees = await listAssigneesForTasks(args.r, firmId, selected.map((t) => t.id));
    const allowedByTeam = assignees.some((a) => a.userId === args.req.userId && (a.assignmentRole === "handler" || a.assignmentRole === "lawyer_in_charge"));
    if (!allowedByTeam) return { error: "forbidden" as const };
  }

  const body = buildConsolidatedDraftBody({
    channel: parent.channel as any,
    tasks: selected.map((t) => ({
      id: t.id,
      caseRef: t.caseRef ?? null,
      partyName: t.partyName ?? null,
      bankRef: t.bankRef ?? null,
      propertyRef: t.propertyRef ?? null,
      taskStatus: t.taskStatus,
      replyNote: t.replyNote ?? null,
    })),
  });

  const toAddresses = normalizeEmailAddressList(args.to);
  const ccAddresses = normalizeEmailAddressList(args.cc);
  const bccAddresses = normalizeEmailAddressList(args.bcc);
  const subject = (args.subject ?? "").trim() || (parent.subject ? `Re: ${parent.subject}` : "Reply");

  const draft = await insertDraft(args.r, {
    firmId,
    parentMessageId: parent.id,
    channel: parent.channel,
    draftType: args.draftType,
    status: "draft",
    toAddresses,
    ccAddresses,
    bccAddresses,
    subject,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    preparedByUserId: args.req.userId ?? null,
    preparedAt: now(),
  });

  await linkDraftTasks(args.r, firmId, draft.id, selected.map((t) => t.id));

  for (const t of selected) {
    await updateTask(args.r, firmId, t.id, { taskStatus: "included_in_draft", readyAt: t.readyAt ?? now() });
  }

  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.draft.created",
    messageId: parent.id,
    draftId: draft.id,
    newValue: { draftType: args.draftType, taskIds: selected.map((t) => t.id) },
  });

  await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: parent.id });
  return draft;
}

export async function patchDraft(args: { r: DbConn; req: AuthRequest; draftId: number; patch: any }) {
  const firmId = args.req.firmId!;
  const existing = await getDraftById(args.r, firmId, args.draftId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  const canEdit = isPartnerOrAdminRole(roleName) || (existing.draft.preparedByUserId && existing.draft.preparedByUserId === args.req.userId);
  if (!canEdit) return { error: "forbidden" as const };
  const updated = await updateDraft(args.r, firmId, args.draftId, {
    toAddresses: args.patch.to ? normalizeEmailAddressList(args.patch.to) : undefined,
    ccAddresses: args.patch.cc ? normalizeEmailAddressList(args.patch.cc) : undefined,
    bccAddresses: args.patch.bcc ? normalizeEmailAddressList(args.patch.bcc) : undefined,
    subject: typeof args.patch.subject === "string" ? args.patch.subject.trim() : undefined,
    bodyText: typeof args.patch.bodyText === "string" ? args.patch.bodyText : undefined,
    bodyHtml: typeof args.patch.bodyHtml === "string" ? args.patch.bodyHtml : undefined,
  });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.draft.updated",
    draftId: updated.id,
    messageId: existing.draft.parentMessageId,
  });
  return updated;
}

export async function submitDraftApproval(args: { r: DbConn; req: AuthRequest; draftId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getDraftById(args.r, firmId, args.draftId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  const status: CommunicationDraftStatus = isLawyerRoleName(roleName) ? "pending_partner_approval" : "pending_lawyer_approval";
  const updated = await updateDraft(args.r, firmId, args.draftId, { status });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.draft.submit_approval",
    draftId: updated.id,
    messageId: existing.draft.parentMessageId,
    oldValue: { status: existing.draft.status },
    newValue: { status: updated.status },
  });
  return updated;
}

export async function approveDraft(args: { r: DbConn; req: AuthRequest; draftId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getDraftById(args.r, firmId, args.draftId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  if (!isLawyerRoleName(roleName) && !isPartnerOrAdminRole(roleName)) return { error: "forbidden" as const };
  const updated = await updateDraft(args.r, firmId, args.draftId, {
    status: "approved",
    approvedByUserId: args.req.userId ?? null,
    approvedAt: now(),
  });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.draft.approved",
    draftId: updated.id,
    messageId: existing.draft.parentMessageId,
    oldValue: { status: existing.draft.status },
    newValue: { status: updated.status },
  });
  return updated;
}

export async function markDraftSent(args: { r: DbConn; req: AuthRequest; draftId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getDraftById(args.r, firmId, args.draftId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  if (!isLawyerRoleName(roleName) && !isPartnerOrAdminRole(roleName)) return { error: "forbidden" as const };
  if (existing.draft.status !== "approved") return { error: "not_approved" as const };

  const includedTaskIds = await listDraftTaskIds(args.r, firmId, args.draftId);
  const tasks = existing.tasks.filter((t) => includedTaskIds.includes(t.id));
  const tNow = now();

  const updatedDraft = await updateDraft(args.r, firmId, args.draftId, {
    status: "sent",
    sentByUserId: args.req.userId ?? null,
    sentAt: tNow,
  });
  if (!updatedDraft) return null;

  for (const t of tasks) {
    await updateTask(args.r, firmId, t.id, { taskStatus: "replied", repliedAt: tNow });
  }

  const parent = await getMessageById(args.r, firmId, existing.draft.parentMessageId);
  if (parent) {
    const caseIds = Array.from(new Set(tasks.map((x) => x.linkedCaseId).filter((x): x is number => typeof x === "number")));
    for (const linkedCaseId of caseIds) {
      await insertMessage(args.r, {
        firmId,
        mailboxId: parent.mailboxId ?? null,
        channel: parent.channel,
        provider: "manual",
        providerThreadId: parent.providerThreadId ?? `manual-parent-${parent.id}`,
        direction: "outgoing",
        fromAddress: parent.toAddresses?.[0] ?? null,
        fromName: null,
        toAddresses: existing.draft.toAddresses as any,
        ccAddresses: existing.draft.ccAddresses as any,
        bccAddresses: existing.draft.bccAddresses as any,
        subject: existing.draft.subject,
        bodyText: existing.draft.bodyText,
        bodyHtml: existing.draft.bodyHtml,
        sentAt: tNow,
        internalStatus: "closed",
        isBatch: true,
        linkedCaseId,
        lastActivityAt: tNow,
        createdBy: args.req.userId ?? null,
      });
    }
  }

  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.draft.mark_sent",
    draftId: updatedDraft.id,
    messageId: existing.draft.parentMessageId,
    newValue: { includedTaskIds },
  });

  if (parent) await recalcParentStatus({ r: args.r, req: args.req, parentMessageId: parent.id });
  return updatedDraft;
}

export async function cancelDraft(args: { r: DbConn; req: AuthRequest; draftId: number }) {
  const firmId = args.req.firmId!;
  const existing = await getDraftById(args.r, firmId, args.draftId);
  if (!existing) return null;
  const roleName = getRoleNameFromReq(args.req);
  const canCancel = isPartnerOrAdminRole(roleName) || (existing.draft.preparedByUserId && existing.draft.preparedByUserId === args.req.userId);
  if (!canCancel) return { error: "forbidden" as const };
  const updated = await updateDraft(args.r, firmId, args.draftId, { status: "cancelled" });
  if (!updated) return null;
  await writeCommunicationAuditLog({
    r: args.r,
    req: args.req,
    action: "communication.draft.cancelled",
    draftId: updated.id,
    messageId: existing.draft.parentMessageId,
    oldValue: { status: existing.draft.status },
    newValue: { status: updated.status },
  });
  return updated;
}

export async function getDraftDetail(args: { r: DbConn; firmId: number; draftId: number }) {
  return getDraftById(args.r, args.firmId, args.draftId);
}

export async function listDraftsForFirm(args: { r: DbConn; firmId: number; status?: string; limit: number; offset: number }) {
  return listDrafts(args.r, args.firmId, { status: args.status, limit: args.limit, offset: args.offset });
}

export async function getAuditForMessage(args: { r: DbConn; firmId: number; messageId: number }) {
  return listAuditLogsForMessage(args.r, args.firmId, args.messageId);
}

export async function getAuditForTask(args: { r: DbConn; firmId: number; taskId: number }) {
  return listAuditLogsForTask(args.r, args.firmId, args.taskId);
}

export async function getAuditForDraft(args: { r: DbConn; firmId: number; draftId: number }) {
  return listAuditLogsForDraft(args.r, args.firmId, args.draftId);
}

export async function getSlaSummary(args: { r: DbConn; firmId: number; userId: number }) {
  const firmId = args.firmId;
  const nowTs = now();
  const result = await args.r.execute(sql`
    WITH
      unassigned AS (
        SELECT COUNT(*)::int AS c
        FROM communication_messages m
        WHERE m.firm_id = ${firmId}
          AND m.direction = 'incoming'
          AND m.internal_status IN ('new','unassigned')
      ),
      overdue_unassigned AS (
        SELECT COUNT(*)::int AS c
        FROM communication_messages m
        WHERE m.firm_id = ${firmId}
          AND m.direction = 'incoming'
          AND m.internal_status IN ('new','unassigned')
          AND COALESCE(m.received_at, m.created_at) < (${nowTs}::timestamptz - interval '2 hours')
      ),
      my_pending_tasks AS (
        SELECT COUNT(*)::int AS c
        FROM communication_case_tasks t
        WHERE t.firm_id = ${firmId}
          AND t.assigned_to_user_id = ${args.userId}
          AND t.task_status NOT IN ('replied','closed')
      ),
      overdue_tasks AS (
        SELECT COUNT(*)::int AS c
        FROM communication_case_tasks t
        WHERE t.firm_id = ${firmId}
          AND t.assigned_to_user_id = ${args.userId}
          AND t.task_status NOT IN ('replied','closed')
          AND (
            (t.assigned_at IS NOT NULL AND t.acknowledged_at IS NULL AND t.assigned_at < (${nowTs}::timestamptz - interval '2 hours'))
            OR (t.due_at IS NOT NULL AND t.due_at < ${nowTs}::timestamptz)
          )
      ),
      pending_draft_approvals AS (
        SELECT COUNT(*)::int AS c
        FROM communication_drafts d
        WHERE d.firm_id = ${firmId}
          AND d.status IN ('pending_lawyer_approval','pending_partner_approval')
      ),
      partially_replied_batch_messages AS (
        SELECT COUNT(*)::int AS c
        FROM communication_messages m
        WHERE m.firm_id = ${firmId}
          AND m.is_batch = true
          AND m.internal_status = 'partially_replied'
      ),
      fully_ready_batch_messages AS (
        SELECT COUNT(*)::int AS c
        FROM communication_messages m
        WHERE m.firm_id = ${firmId}
          AND m.is_batch = true
          AND m.internal_status = 'fully_ready'
      )
    SELECT
      (SELECT c FROM unassigned) AS "unassignedMessages",
      (SELECT c FROM overdue_unassigned) AS "overdueUnassignedMessages",
      (SELECT c FROM my_pending_tasks) AS "myPendingTasks",
      (SELECT c FROM overdue_tasks) AS "overdueTasks",
      (SELECT c FROM pending_draft_approvals) AS "pendingDraftApprovals",
      (SELECT c FROM partially_replied_batch_messages) AS "partiallyRepliedBatchMessages",
      (SELECT c FROM fully_ready_batch_messages) AS "fullyReadyBatchMessages"
  `);
  const rows = Array.isArray(result) ? (result as any[]) : ((result as any)?.rows ?? []);
  return rows?.[0] ?? {
    unassignedMessages: 0,
    overdueUnassignedMessages: 0,
    myPendingTasks: 0,
    overdueTasks: 0,
    pendingDraftApprovals: 0,
    partiallyRepliedBatchMessages: 0,
    fullyReadyBatchMessages: 0,
  };
}

export async function getSlaOverdue(args: { r: DbConn; firmId: number; userId: number; limit: number; offset: number }) {
  const nowTs = now();
  const rows = await args.r.execute(sql`
    SELECT
      'unassigned_message' AS kind,
      m.id AS entity_id,
      m.subject,
      m.from_address,
      m.internal_status,
      COALESCE(m.received_at, m.created_at) AS event_at
    FROM communication_messages m
    WHERE m.firm_id = ${args.firmId}
      AND m.direction = 'incoming'
      AND m.internal_status IN ('new','unassigned')
      AND COALESCE(m.received_at, m.created_at) < (${nowTs}::timestamptz - interval '2 hours')
    UNION ALL
    SELECT
      'task' AS kind,
      t.id AS entity_id,
      t.case_ref AS subject,
      NULL AS from_address,
      t.task_status AS internal_status,
      COALESCE(t.due_at, t.assigned_at, t.created_at) AS event_at
    FROM communication_case_tasks t
    WHERE t.firm_id = ${args.firmId}
      AND t.assigned_to_user_id = ${args.userId}
      AND t.task_status NOT IN ('replied','closed')
      AND (
        (t.assigned_at IS NOT NULL AND t.acknowledged_at IS NULL AND t.assigned_at < (${nowTs}::timestamptz - interval '2 hours'))
        OR (t.due_at IS NOT NULL AND t.due_at < ${nowTs}::timestamptz)
      )
    ORDER BY event_at DESC
    LIMIT ${args.limit} OFFSET ${args.offset}
  `);
  return Array.isArray(rows) ? (rows as any[]) : ((rows as any)?.rows ?? []);
}

export async function getCaseCommunicationTimeline(args: { r: DbConn; firmId: number; caseId: number }) {
  return buildCaseCommunicationTimeline(args.r, args.firmId, args.caseId);
}

async function recalcParentStatus(args: { r: DbConn; req: AuthRequest; parentMessageId: number }) {
  const firmId = args.req.firmId!;
  const parent = await getMessageById(args.r, firmId, args.parentMessageId);
  if (!parent) return;

  const tasks = await listTasksForMessage(args.r, firmId, parent.id);
  const total = tasks.length;
  const replied = tasks.filter((t) => t.taskStatus === "replied" || t.taskStatus === "closed").length;
  const ready = tasks.filter((t) => t.taskStatus === "ready_to_reply" || t.taskStatus === "included_in_draft").length;
  const assigned = tasks.filter((t) => t.assignedToUserId != null).length;

  let next: any = parent.internalStatus;
  if (total > 0 && replied === total) next = "fully_replied";
  else if (replied > 0) next = "partially_replied";
  else if (total > 0 && ready === total) next = "fully_ready";
  else if (ready > 0) next = "partially_ready";
  else if (assigned > 0 || parent.assignedToUserId) next = "assigned";
  else next = "unassigned";

  const updated = await updateMessage(args.r, firmId, parent.id, { internalStatus: next, isBatch: total > 0 || parent.isBatch, lastActivityAt: now() });
  if (updated && updated.internalStatus !== parent.internalStatus) {
    await writeCommunicationAuditLog({
      r: args.r,
      req: args.req,
      action: "communication.message.status_recalculated",
      messageId: parent.id,
      oldValue: { internalStatus: parent.internalStatus },
      newValue: { internalStatus: updated.internalStatus, total, replied, ready, assigned },
    });
  }
}
