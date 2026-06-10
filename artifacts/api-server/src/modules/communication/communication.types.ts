import { z } from "zod";

export const CommunicationChannelSchema = z.enum(["email", "whatsapp"]);
export type CommunicationChannel = z.infer<typeof CommunicationChannelSchema>;

export const CommunicationProviderSchema = z.enum(["manual", "microsoft_graph", "gmail", "yahoo_imap", "imap", "whatsapp_cloud"]);
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

export const MessageAssigneesPatchSchema = z.object({
  userIds: z.array(z.number().int().positive()).max(50),
});

export const MessageReadStatusPatchSchema = z.object({
  isRead: z.boolean(),
});

export const MessageArchivePatchSchema = z.object({
  archived: z.boolean(),
});

export const RemarkCreateSchema = z.object({
  body: z.string().min(1).max(10000),
});

export const RemarkPatchSchema = z.object({
  body: z.string().min(1).max(10000),
});

export const EmailAccountProviderSchema = z.enum(["microsoft_graph", "gmail", "yahoo_imap", "imap"]);

export const EmailAccountCreateSchema = z.object({
  provider: EmailAccountProviderSchema,
  emailAddress: z.string().email(),
  displayName: z.string().trim().max(200).optional().nullable(),
});

export const EmailAccountPatchSchema = z.object({
  displayName: z.string().trim().max(200).optional().nullable(),
  status: z.enum(["active", "disconnected", "error", "setup_required"]).optional(),
});

export const EmailFolderPatchSchema = z.object({
  syncEnabled: z.boolean(),
});

export const EmailImportRangeSchema = z.enum(["7d", "30d", "90d", "all", "custom"]);

export const EmailImportRequestSchema = z.object({
  range: EmailImportRangeSchema.default("30d"),
  maxEmails: z.union([z.literal(100), z.literal(500), z.literal(1000)]).default(500),
  from: z.string().datetime().optional().nullable(),
  to: z.string().datetime().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.range === "custom") {
    if (!value.from || !value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Custom import range requires both from and to.",
        path: ["from"],
      });
      return;
    }
    if (new Date(value.from).getTime() > new Date(value.to).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Custom import range start must be before end.",
        path: ["from"],
      });
    }
  }
});

export const MicrosoftConnectQuerySchema = z.object({
  returnTo: z.string().url().optional().nullable(),
});

export const ImapConnectionInputSchema = z.object({
  provider: z.enum(["imap", "yahoo_imap"]).default("imap"),
  emailAddress: z.string().email(),
  displayName: z.string().trim().max(200).optional().nullable(),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().positive().max(65535),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1000),
  useTls: z.boolean().default(true),
});

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

export const CommunicationAssignmentRoleSchema = z.enum(["lawyer_in_charge", "handler", "reviewer", "watcher"]);
export type CommunicationAssignmentRole = z.infer<typeof CommunicationAssignmentRoleSchema>;

export const ResponsibleTeamSchema = z.object({
  lawyerInChargeUserId: z.number().int().positive().optional().nullable(),
  handlerUserIds: z.array(z.number().int().positive()).optional().nullable().default([]),
  reviewerUserId: z.number().int().positive().optional().nullable(),
  watcherUserIds: z.array(z.number().int().positive()).optional().nullable().default([]),
});
export type ResponsibleTeam = z.infer<typeof ResponsibleTeamSchema>;

export const ManualEmailCreateSchema = z.object({
  mailboxId: z.number().int().positive().optional().nullable(),
  fromName: z.string().trim().optional().nullable().default(""),
  fromEmail: z.string().trim().email(),
  to: z.array(z.string().trim().min(1)).optional().nullable().default([]),
  cc: z.array(z.string().trim().min(1)).optional().nullable().default([]),
  subject: z.string().trim().min(1),
  bodyText: z.string().trim().optional().nullable().default(""),
  receivedAt: z.string().datetime().optional().nullable(),
  assignedToUserId: z.number().int().positive().optional().nullable(),
  caseId: z.number().int().positive().optional().nullable(),
  caseRef: z.string().trim().optional().nullable(),
  isBatchEmail: z.boolean().optional().nullable().default(false),
  team: ResponsibleTeamSchema.optional().nullable(),
});
export type ManualEmailCreateInput = z.infer<typeof ManualEmailCreateSchema>;

export const MessageAssignSchema = z.object({
  assignedToUserId: z.number().int().positive().nullable(),
});

export const MessageTeamPatchSchema = ResponsibleTeamSchema;

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
  team: ResponsibleTeamSchema.optional().nullable(),
});

export const TaskAssignSchema = z.object({
  assignedToUserId: z.number().int().positive().nullable(),
});

export const TaskTeamPatchSchema = ResponsibleTeamSchema;

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

