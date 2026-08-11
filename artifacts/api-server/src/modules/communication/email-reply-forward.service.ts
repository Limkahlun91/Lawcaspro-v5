import { and, eq } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  communicationMessagesTable,
  communicationDraftsTable,
  communicationAttachmentsTable,
  communicationMailboxesTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

export type ReplyType = "REPLY" | "REPLY_ALL" | "FORWARD" | "FORWARD_ATTACHMENT";
export type DraftType =
  | "consolidated"
  | "partial"
  | "split_case"
  | "normal_reply"
  | "reply"
  | "reply_all"
  | "forward"
  | "forward_attachment";

export interface ComposeReplyInput {
  firmId: number;
  parentMessageId: number;
  replyType: ReplyType;
  actorUserId: number;
  idempotencyKey: string;
  caseLink?: {
    caseId?: number | null;
    caseRef?: string | null;
  } | null;
  draftType?: DraftType;
  toOverrides?: string[] | null;
  ccOverrides?: string[] | null;
  bccOverrides?: string[] | null;
  subjectPrefix?: string | null;
  bodyPrefixHtml?: string | null;
  bodyPrefixText?: string | null;
  mailboxId?: number | null;
  assignedToUserId?: number | null;
}

export interface ComposeReplyAttachmentRef {
  attachmentId: number | null;
  savedToCaseDocumentId: number | null;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  providerAttachmentId: string | null;
}

export interface ComposeReplyResult {
  draftId: number;
  parentMessageId: number;
  replyType: ReplyType;
  draftType: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  linkedCaseId: number | null;
  linkedCaseRef: string | null;
  originalMessageId: string | null;
  originalReferences: string | null;
  forwardedAttachmentRefs: ComposeReplyAttachmentRef[];
  mailboxId: number | null;
  assignedToUserId: number | null;
  idempotencyKey: string;
  createdFromDuplicate: boolean;
}

function parseAddressList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function extractEmail(addr: string): string {
  const m = /<([^<>]+)>/.exec(String(addr ?? ""));
  if (m) return m[1].trim().toLowerCase();
  return String(addr ?? "").trim().toLowerCase();
}

function sanitizeRecipients(recipients: string[], ownAddress: string): string[] {
  const own = ownAddress.trim().toLowerCase();
  return [
    ...new Map(
      recipients
        .map((v) => v.trim())
        .filter(Boolean)
        .filter((v) => extractEmail(v) !== own)
        .map((v) => [extractEmail(v), v]),
    ).values(),
  ];
}

function requireStableActionKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8) {
    throw new ApiError({
      status: 400,
      code: "EMAIL_DRAFT_IDEMPOTENCY_KEY_REQUIRED",
      message: "A stable idempotency key is required for email draft creation (min 8 chars)",
      retryable: false,
    });
  }
  return value.trim();
}

function buildReplySubject(original: string | null | undefined, replyType: ReplyType, explicitPrefix?: string | null): string {
  const base = String(original ?? "").trim();
  if (explicitPrefix !== undefined && explicitPrefix !== null) {
    return explicitPrefix ? `${explicitPrefix} ${base}` : base;
  }
  if (replyType === "FORWARD" || replyType === "FORWARD_ATTACHMENT") {
    if (/^\s*Fwd?\s*:/i.test(base)) return base;
    return `Fwd: ${base}`;
  }
  if (/^\s*Re\s*:/i.test(base)) return base;
  return `Re: ${base}`;
}

function buildQuotedBodyHtml(originalHtml: string | null, originalText: string | null, senderLabel: string, sentAtIso: string | null): string {
  const dateStr = sentAtIso ? new Date(sentAtIso).toLocaleString() : "";
  const headerLine = `<br><hr style="border:0;border-top:1px solid #e0e0e0;"><div style="color:#666;font-size:13px;">On ${dateStr} ${senderLabel} wrote:</div>`;
  if (originalHtml && originalHtml.trim()) {
    return `${headerLine}<blockquote style="border-left:3px solid #ccc;margin:0 0 0 8px;padding:0 0 0 12px;color:#555;">${originalHtml}</blockquote>`;
  }
  const escapedText = String(originalText ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `${headerLine}<blockquote style="border-left:3px solid #ccc;margin:0 0 0 8px;padding:0 0 0 12px;color:#555;">${escapedText}</blockquote>`;
}

function buildQuotedBodyText(originalText: string | null, senderLabel: string, sentAtIso: string | null): string {
  const dateStr = sentAtIso ? new Date(sentAtIso).toLocaleString() : "";
  const intro = `\n\n----- Original Message -----\nFrom: ${senderLabel}\nDate: ${dateStr}\n\n`;
  const body = String(originalText ?? "");
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n");
  return `${intro}${quoted}`;
}

export async function composeReply(
  input: ComposeReplyInput,
  opts: { tx?: unknown } = {},
): Promise<ComposeReplyResult> {
  const conn = pickDbConn(opts.tx);

  if (!input.parentMessageId || typeof input.parentMessageId !== "number") {
    throw new ApiError({
      status: 400,
      code: "EMAIL_PARENT_MSG_REQUIRED",
      message: "Parent message id is required",
      retryable: false,
    });
  }

  const idemKey = requireStableActionKey(input.idempotencyKey);

  const parentMsg = (await conn
    .select()
    .from(communicationMessagesTable as any)
    .where(and(
      eq(communicationMessagesTable.firmId, input.firmId),
      eq(communicationMessagesTable.id, input.parentMessageId),
    ))
    .limit(1))?.[0] as any;

  if (!parentMsg) {
    throw new ApiError({
      status: 404,
      code: "EMAIL_PARENT_MSG_NOT_FOUND",
      message: "Parent email message not found in firm scope",
      retryable: false,
    });
  }

  let mailboxId: number | null = typeof input.mailboxId === "number" ? input.mailboxId : null;
  let ownEmailAddress: string | null = null;

  if (mailboxId == null) {
    const accountMailboxId = parentMsg.emailAccountId ?? parentMsg.mailboxId ?? null;
    if (typeof accountMailboxId === "number") {
      const mbRow = (await conn
        .select()
        .from(communicationMailboxesTable as any)
        .where(and(
          eq(communicationMailboxesTable.firmId, input.firmId),
          eq(communicationMailboxesTable.id, accountMailboxId),
        ))
        .limit(1))?.[0] as any;
      if (mbRow) {
        mailboxId = Number(mbRow.id);
        ownEmailAddress = mbRow.address ?? mbRow.emailAddress ?? null;
      }
    }
  } else {
    const mbRow = (await conn
      .select()
      .from(communicationMailboxesTable as any)
      .where(and(
        eq(communicationMailboxesTable.firmId, input.firmId),
        eq(communicationMailboxesTable.id, mailboxId),
      ))
      .limit(1))?.[0] as any;
    if (mbRow) {
      ownEmailAddress = mbRow.address ?? mbRow.emailAddress ?? null;
    }
  }

  const originalFromList = parseAddressList(parentMsg.fromAddress ?? parentMsg.from);
  const originalToList = parseAddressList(parentMsg.toAddresses ?? parentMsg.toAddress ?? parentMsg.to);
  const originalCcList = parseAddressList(parentMsg.ccAddresses ?? parentMsg.ccAddress ?? parentMsg.cc);

  let to: string[] = [];
  let cc: string[] = [];
  const bcc: string[] = Array.isArray(input.bccOverrides) ? input.bccOverrides : [];

  const replyType: ReplyType = input.replyType === "REPLY_ALL" || input.replyType === "FORWARD" || input.replyType === "FORWARD_ATTACHMENT"
    ? input.replyType
    : "REPLY";

  if (replyType === "REPLY") {
    to = originalFromList.length ? originalFromList : originalToList.slice(0, 1);
  } else if (replyType === "REPLY_ALL") {
    to = originalFromList.length ? originalFromList : originalToList.slice(0, 1);
    const seen = new Set(to.map(extractEmail).filter(Boolean));
    for (const r of [...originalToList, ...originalCcList]) {
      const e = extractEmail(r);
      if (e && !seen.has(e)) {
        seen.add(e);
        cc.push(r);
      }
    }
  } else if (replyType === "FORWARD" || replyType === "FORWARD_ATTACHMENT") {
    to = [];
    cc = [];
  }

  if (ownEmailAddress) {
    to = sanitizeRecipients(to, ownEmailAddress);
    cc = sanitizeRecipients(cc, ownEmailAddress);
  }

  if (Array.isArray(input.toOverrides)) {
    const raw = input.toOverrides.filter((x) => typeof x === "string" && x.trim());
    to = ownEmailAddress ? sanitizeRecipients(raw, ownEmailAddress) : raw;
  }
  if (Array.isArray(input.ccOverrides)) {
    const raw = input.ccOverrides.filter((x) => typeof x === "string" && x.trim());
    cc = ownEmailAddress ? sanitizeRecipients(raw, ownEmailAddress) : raw;
  }

  const subject = buildReplySubject(parentMsg.subject, replyType, input.subjectPrefix);

  const fromLabel = originalFromList[0] ?? "the sender";
  const sentAt = parentMsg.receivedAt ?? parentMsg.sentAt ?? parentMsg.createdAt ?? null;
  const sentAtIso = sentAt instanceof Date ? sentAt.toISOString() : sentAt ? String(sentAt) : null;

  const originalBodyHtml = typeof parentMsg.bodyHtml === "string" ? parentMsg.bodyHtml : null;
  const originalBodyText = typeof parentMsg.bodyText === "string" ? parentMsg.bodyText : null;

  let bodyHtml = buildQuotedBodyHtml(originalBodyHtml, originalBodyText, fromLabel, sentAtIso);
  let bodyText = buildQuotedBodyText(originalBodyText, fromLabel, sentAtIso);

  if (typeof input.bodyPrefixHtml === "string" && input.bodyPrefixHtml) {
    bodyHtml = `${input.bodyPrefixHtml}${bodyHtml}`;
  }
  if (typeof input.bodyPrefixText === "string" && input.bodyPrefixText) {
    bodyText = `${input.bodyPrefixText}${bodyText}`;
  }

  const originalInReplyTo = parentMsg.inReplyTo ?? parentMsg.inReplyToInternetMessageId ?? null;
  const originalInternetMessageId = parentMsg.internetMessageId ?? parentMsg.providerMessageId ?? null;
  const originalReferences = parentMsg.references ?? parentMsg.referenceChain ?? null;
  const newReferences = [
    originalReferences ? String(originalReferences) : null,
    originalInReplyTo ? String(originalInReplyTo) : null,
    originalInternetMessageId ? String(originalInternetMessageId) : null,
  ].filter(Boolean).join(" ");

  const linkedCaseId: number | null = typeof input.caseLink?.caseId === "number"
    ? input.caseLink.caseId
    : typeof parentMsg.linkedCaseId === "number" ? parentMsg.linkedCaseId : null;
  const linkedCaseRef: string | null = typeof input.caseLink?.caseRef === "string"
    ? input.caseLink.caseRef
    : typeof parentMsg.caseRef === "string" ? parentMsg.caseRef : null;

  const explicitDraftType = input.draftType
    ? input.draftType
    : replyType === "FORWARD_ATTACHMENT"
      ? "forward_attachment"
      : replyType === "FORWARD"
        ? "forward"
        : replyType === "REPLY_ALL"
          ? "reply_all"
          : "reply";

  const forwardedAttachmentRefs: ComposeReplyAttachmentRef[] = [];
  if (replyType === "FORWARD_ATTACHMENT") {
    try {
      const origAttachments = await conn
        .select()
        .from(communicationAttachmentsTable as any)
        .where(and(
          eq(communicationAttachmentsTable.firmId, input.firmId),
          eq(communicationAttachmentsTable.messageId as any, input.parentMessageId),
        ));
      for (const a of (origAttachments ?? [])) {
        const att = a as any;
        forwardedAttachmentRefs.push({
          attachmentId: Number(att.id),
          savedToCaseDocumentId: typeof att.savedToCaseDocumentId === "number" ? att.savedToCaseDocumentId : null,
          filename: att.filename ?? att.fileName ?? null,
          mimeType: att.mimeType ?? att.contentType ?? null,
          sizeBytes: typeof att.sizeBytes === "number" ? att.sizeBytes : null,
          providerAttachmentId: att.providerAttachmentId ?? att.providerId ?? null,
        });
      }
    } catch {
      // non-fatal
    }
  }

  const now = new Date();
  let draftId: number | null = null;
  let createdFromDuplicate = false;

  try {
    const draftRows = await conn
      .insert(communicationDraftsTable as any)
      .values({
        firmId: input.firmId,
        parentMessageId: input.parentMessageId,
        mailboxId,
        linkedCaseId,
        caseRef: linkedCaseRef,
        draftType: explicitDraftType,
        replyType,
        toAddresses: to as any,
        ccAddresses: cc as any,
        bccAddresses: bcc as any,
        to: to as any,
        cc: cc as any,
        bcc: bcc as any,
        subject,
        bodyHtml,
        bodyText,
        status: "draft",
        inReplyTo: originalInternetMessageId,
        references: newReferences || null,
        forwardedFromMessageId: (replyType === "FORWARD" || replyType === "FORWARD_ATTACHMENT") ? input.parentMessageId : null,
        includeOriginalAttachments: replyType === "FORWARD_ATTACHMENT",
        idempotencyKey: idemKey,
        assignedToUserId: typeof input.assignedToUserId === "number" ? input.assignedToUserId : (typeof parentMsg.assignedToUserId === "number" ? parentMsg.assignedToUserId : null),
        createdBy: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      } as any)
      .onConflictDoNothing()
      .returning({ id: communicationDraftsTable.id });

    if (draftRows?.[0]) {
      draftId = Number((draftRows[0] as any).id);
    } else {
      const existingDraft = (await conn
        .select({ id: communicationDraftsTable.id })
        .from(communicationDraftsTable)
        .where(and(
          eq(communicationDraftsTable.firmId, input.firmId),
          eq(communicationDraftsTable.idempotencyKey, idemKey),
        ))
        .limit(1))?.[0] as any;
      if (existingDraft) {
        draftId = Number(existingDraft.id);
        createdFromDuplicate = true;
      }
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err?.code ?? "");
    const isUnique = /unique|uq_|23505|duplicate/i.test(msg);
    if (!isUnique) throw err;
    const existingDraft = (await conn
      .select({ id: communicationDraftsTable.id })
      .from(communicationDraftsTable)
      .where(and(
        eq(communicationDraftsTable.firmId, input.firmId),
        eq(communicationDraftsTable.idempotencyKey, idemKey),
      ))
      .limit(1))?.[0] as any;
    if (existingDraft) {
      draftId = Number(existingDraft.id);
      createdFromDuplicate = true;
    }
  }

  if (draftId == null) {
    throw new ApiError({
      status: 500,
      code: "EMAIL_DRAFT_CREATE_FAILED",
      message: "Email draft insert failed",
      retryable: true,
    });
  }

  return {
    draftId,
    parentMessageId: input.parentMessageId,
    replyType,
    draftType: explicitDraftType,
    to,
    cc,
    bcc,
    subject,
    bodyHtml,
    bodyText,
    linkedCaseId,
    linkedCaseRef,
    originalMessageId: originalInternetMessageId,
    originalReferences: newReferences || originalReferences || null,
    forwardedAttachmentRefs,
    mailboxId,
    assignedToUserId: typeof input.assignedToUserId === "number" ? input.assignedToUserId : null,
    idempotencyKey: idemKey,
    createdFromDuplicate,
  };
}
