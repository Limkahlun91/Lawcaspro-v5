import { z } from "zod";

export const CommunicationChannelSchema = z.enum(["email", "whatsapp"]);
export type CommunicationChannel = z.infer<typeof CommunicationChannelSchema>;

export const CommunicationProviderSchema = z.enum(["manual", "microsoft_graph", "gmail", "imap", "whatsapp_cloud"]);
export type CommunicationProvider = z.infer<typeof CommunicationProviderSchema>;

export const CommunicationDirectionSchema = z.enum(["incoming", "outgoing"]);
export type CommunicationDirection = z.infer<typeof CommunicationDirectionSchema>;

export const CommunicationMessageInternalStatusSchema = z.enum([
  "new",
  "unassigned",
  "assigned",
  "in_progress",
  "partially_ready",
  "fully_ready",
  "partially_replied",
  "fully_replied",
  "closed",
  "archived",
]);
export type CommunicationMessageInternalStatus = z.infer<typeof CommunicationMessageInternalStatusSchema>;

export const CommunicationTaskStatusSchema = z.enum([
  "pending_owner_review",
  "seen_by_owner",
  "in_progress",
  "waiting_client",
  "waiting_developer",
  "waiting_bank",
  "waiting_lawyer_review",
  "ready_to_reply",
  "included_in_draft",
  "replied",
  "closed",
]);
export type CommunicationTaskStatus = z.infer<typeof CommunicationTaskStatusSchema>;

export const CommunicationDraftTypeSchema = z.enum(["consolidated", "partial", "split_case", "normal_reply"]);
export type CommunicationDraftType = z.infer<typeof CommunicationDraftTypeSchema>;

export const CommunicationDraftStatusSchema = z.enum([
  "draft",
  "pending_lawyer_approval",
  "pending_partner_approval",
  "approved",
  "sent",
  "cancelled",
]);
export type CommunicationDraftStatus = z.infer<typeof CommunicationDraftStatusSchema>;

export const ManualEmailCreateSchema = z.object({
  mailboxId: z.number().int().positive().optional().nullable(),
  fromName: z.string().trim().min(1),
  fromEmail: z.string().trim().email(),
  to: z.array(z.string().trim().min(1)).optional().nullable().default([]),
  cc: z.array(z.string().trim().min(1)).optional().nullable().default([]),
  subject: z.string().trim().min(1),
  bodyText: z.string().trim().optional().nullable().default(""),
  receivedAt: z.string().datetime().optional().nullable(),
  isBatchEmail: z.boolean().optional().nullable().default(false),
});
export type ManualEmailCreateInput = z.infer<typeof ManualEmailCreateSchema>;

export const MessageAssignSchema = z.object({
  assignedToUserId: z.number().int().positive().nullable(),
});

export const MessageLinkCaseSchema = z.object({
  caseId: z.number().int().positive().optional().nullable(),
  caseRef: z.string().trim().optional().nullable(),
});

export const TaskCreateSchema = z.object({
  linkedCaseId: z.number().int().positive().optional().nullable(),
  caseRef: z.string().trim().optional().nullable(),
  partyName: z.string().trim().optional().nullable(),
  bankRef: z.string().trim().optional().nullable(),
  developerRef: z.string().trim().optional().nullable(),
  propertyRef: z.string().trim().optional().nullable(),
  assignedToUserId: z.number().int().positive().optional().nullable(),
  requiredAction: z.string().trim().optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
});

export const TaskAssignSchema = z.object({
  assignedToUserId: z.number().int().positive().nullable(),
});

export const TaskLinkCaseSchema = z.object({
  caseId: z.number().int().positive().optional().nullable(),
  caseRef: z.string().trim().optional().nullable(),
});

export const TaskStatusUpdateSchema = z.object({
  taskStatus: CommunicationTaskStatusSchema,
});

export const TaskReplyNoteSchema = z.object({
  replyNote: z.string().trim().optional().nullable(),
});

export const DraftCreateSchema = z.object({
  parentMessageId: z.number().int().positive(),
  taskIds: z.array(z.number().int().positive()).min(1),
  to: z.array(z.string().trim().min(1)).optional().nullable().default([]),
  cc: z.array(z.string().trim().min(1)).optional().nullable().default([]),
  bcc: z.array(z.string().trim().min(1)).optional().nullable().default([]),
  subject: z.string().trim().optional().nullable(),
});

export const DraftPatchSchema = z.object({
  to: z.array(z.string().trim().min(1)).optional().nullable(),
  cc: z.array(z.string().trim().min(1)).optional().nullable(),
  bcc: z.array(z.string().trim().min(1)).optional().nullable(),
  subject: z.string().trim().optional().nullable(),
  bodyText: z.string().optional().nullable(),
  bodyHtml: z.string().optional().nullable(),
  status: CommunicationDraftStatusSchema.optional(),
});

