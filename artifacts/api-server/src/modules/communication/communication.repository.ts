import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  casesTable,
  caseAssignmentsTable,
  developersTable,
  rolesTable,
  usersTable,
  communicationMailboxesTable,
  communicationMessagesTable,
  communicationCaseTasksTable,
  communicationDraftsTable,
  communicationDraftTasksTable,
  communicationAttachmentsTable,
  communicationAuditLogsTable,
  communicationTaskAssigneesTable,
  communicationEmailRemarksTable,
  communicationMessageReadsTable,
  communicationEmailAccountsTable,
  communicationEmailFoldersTable,
  communicationEmailSyncLogsTable,
} from "@workspace/db";

export type DbConn = typeof import("@workspace/db").db;

export function normalizeCaseRefInput(v: string): string {
  return String(v ?? "").trim();
}

export async function getRoleNameByRoleId(r: DbConn, firmId: number, roleId: number): Promise<string | null> {
  const [row] = await r
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(and(eq(rolesTable.firmId, firmId), eq(rolesTable.id, roleId)))
    .limit(1);
  return row?.name ?? null;
}

export async function listMailboxes(r: DbConn, firmId: number, channel?: string) {
  const where = channel ? and(eq(communicationMailboxesTable.firmId, firmId), eq(communicationMailboxesTable.channel, channel)) : eq(communicationMailboxesTable.firmId, firmId);
  return r
    .select()
    .from(communicationMailboxesTable)
    .where(where)
    .orderBy(desc(communicationMailboxesTable.isActive), asc(communicationMailboxesTable.id));
}

export async function getMailboxById(r: DbConn, firmId: number, id: number) {
  const [row] = await r
    .select()
    .from(communicationMailboxesTable)
    .where(and(eq(communicationMailboxesTable.firmId, firmId), eq(communicationMailboxesTable.id, id)))
    .limit(1);
  return row ?? null;
}

export async function getOrCreateDefaultManualEmailMailbox(r: DbConn, firmId: number, actorUserId: number | null) {
  const [existing] = await r
    .select()
    .from(communicationMailboxesTable)
    .where(and(
      eq(communicationMailboxesTable.firmId, firmId),
      eq(communicationMailboxesTable.channel, "email"),
      eq(communicationMailboxesTable.provider, "manual"),
      eq(communicationMailboxesTable.mailboxType, "shared"),
      eq(communicationMailboxesTable.isActive, true),
    ))
    .orderBy(asc(communicationMailboxesTable.id))
    .limit(1);
  if (existing) return existing;
  const [created] = await r
    .insert(communicationMailboxesTable)
    .values({
      firmId,
      channel: "email",
      provider: "manual",
      displayName: "Shared Inbox (Manual)",
      address: "shared-inbox@manual.local",
      mailboxType: "shared",
      isActive: true,
      syncEnabled: false,
      createdBy: actorUserId,
    })
    .returning();
  return created;
}

export async function insertMessage(r: DbConn, values: typeof communicationMessagesTable.$inferInsert) {
  const [row] = await r.insert(communicationMessagesTable).values(values).returning();
  return row;
}

export async function updateMessage(r: DbConn, firmId: number, id: number, patch: Partial<typeof communicationMessagesTable.$inferInsert>) {
  const [row] = await r
    .update(communicationMessagesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(communicationMessagesTable.firmId, firmId), eq(communicationMessagesTable.id, id)))
    .returning();
  return row ?? null;
}

export async function getMessageById(r: DbConn, firmId: number, id: number) {
  const [row] = await r
    .select()
    .from(communicationMessagesTable)
    .where(and(eq(communicationMessagesTable.firmId, firmId), eq(communicationMessagesTable.id, id)))
    .limit(1);
  return row ?? null;
}

export async function getMessageByProviderMessageId(r: DbConn, firmId: number, accountId: number, providerMessageId: string) {
  const [row] = await r
    .select()
    .from(communicationMessagesTable)
    .where(and(
      eq(communicationMessagesTable.firmId, firmId),
      eq(communicationMessagesTable.emailAccountId, accountId),
      eq(communicationMessagesTable.providerMessageId, providerMessageId),
    ))
    .limit(1);
  return row ?? null;
}

export async function getMessageByInternetMessageId(r: DbConn, firmId: number, accountId: number, internetMessageId: string) {
  const [row] = await r
    .select()
    .from(communicationMessagesTable)
    .where(and(
      eq(communicationMessagesTable.firmId, firmId),
      eq(communicationMessagesTable.emailAccountId, accountId),
      eq(communicationMessagesTable.internetMessageId, internetMessageId),
    ))
    .limit(1);
  return row ?? null;
}

export async function getMessageByFolderUid(r: DbConn, firmId: number, accountId: number, folderId: number, providerUid: string) {
  const [row] = await r
    .select()
    .from(communicationMessagesTable)
    .where(and(
      eq(communicationMessagesTable.firmId, firmId),
      eq(communicationMessagesTable.emailAccountId, accountId),
      eq(communicationMessagesTable.emailFolderId, folderId),
      eq(communicationMessagesTable.providerUid, providerUid),
    ))
    .limit(1);
  return row ?? null;
}

export async function listMessages(
  r: DbConn,
  firmId: number,
  args: {
    status?: string | string[];
    isBatch?: boolean;
    assignedTo?: "me" | "unassigned" | "any";
    userId: number;
    linkedCaseId?: number | null;
    unreadOnly?: boolean;
    q?: string;
    limit: number;
    offset: number;
  }
) {
  const whereParts = [eq(communicationMessagesTable.firmId, firmId)] as any[];
  if (Array.isArray(args.status) && args.status.length === 1) whereParts.push(eq(communicationMessagesTable.internalStatus, args.status[0]));
  else if (Array.isArray(args.status) && args.status.length > 1) whereParts.push(inArray(communicationMessagesTable.internalStatus, args.status));
  else if (typeof args.status === "string" && args.status) whereParts.push(eq(communicationMessagesTable.internalStatus, args.status));
  if (typeof args.isBatch === "boolean") whereParts.push(eq(communicationMessagesTable.isBatch, args.isBatch));
  if (args.assignedTo === "me") {
    whereParts.push(or(
      eq(communicationMessagesTable.assignedToUserId, args.userId),
      sql`EXISTS (
        SELECT 1 FROM communication_task_assignees a
        WHERE a.firm_id = ${firmId}
          AND a.message_id = ${communicationMessagesTable.id}
          AND a.task_id IS NULL
          AND a.user_id = ${args.userId}
          AND a.status = 'assigned'
      )`
    ));
  }
  if (args.assignedTo === "unassigned") {
    whereParts.push(isNull(communicationMessagesTable.assignedToUserId));
    whereParts.push(sql`NOT EXISTS (
      SELECT 1 FROM communication_task_assignees a
      WHERE a.firm_id = ${firmId}
        AND a.message_id = ${communicationMessagesTable.id}
        AND a.task_id IS NULL
        AND a.status = 'assigned'
    )`);
  }
  if (args.linkedCaseId === null) whereParts.push(isNull(communicationMessagesTable.linkedCaseId));
  if (typeof args.linkedCaseId === "number") whereParts.push(eq(communicationMessagesTable.linkedCaseId, args.linkedCaseId));
  if (args.unreadOnly) {
    whereParts.push(sql`NOT EXISTS (
      SELECT 1 FROM communication_message_reads r
      WHERE r.firm_id = ${firmId}
        AND r.message_id = ${communicationMessagesTable.id}
        AND r.user_id = ${args.userId}
        AND r.is_read = true
    )`);
  }
  const q = String(args.q ?? "").trim();
  if (q) {
    const like = `%${q}%`;
    whereParts.push(or(
      sql`${communicationMessagesTable.fromAddress} ILIKE ${like}`,
      sql`${communicationMessagesTable.fromName} ILIKE ${like}`,
      sql`${communicationMessagesTable.subject} ILIKE ${like}`,
      sql`${communicationMessagesTable.bodyText} ILIKE ${like}`
    ));
  }

  const rows = await r
    .select({
      message: communicationMessagesTable,
      tasksTotal: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id}), 0)`.mapWith(Number),
      tasksReady: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id} AND t.task_status IN ('ready_to_reply','included_in_draft')), 0)`.mapWith(Number),
      tasksReplied: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id} AND t.task_status IN ('replied','closed')), 0)`.mapWith(Number),
      tasksUnassigned: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id} AND t.assigned_to_user_id IS NULL), 0)`.mapWith(Number),
      attachmentCount: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_attachments a WHERE a.firm_id = ${firmId} AND a.message_id = ${communicationMessagesTable.id}), 0)`.mapWith(Number),
      hasAttachments: sql<boolean>`COALESCE((SELECT COUNT(*) FROM communication_attachments a WHERE a.firm_id = ${firmId} AND a.message_id = ${communicationMessagesTable.id}), 0) > 0`.mapWith(Boolean),
      isRead: sql<boolean>`EXISTS (
        SELECT 1 FROM communication_message_reads r
        WHERE r.firm_id = ${firmId}
          AND r.message_id = ${communicationMessagesTable.id}
          AND r.user_id = ${args.userId}
          AND r.is_read = true
      )`.mapWith(Boolean),
      assigneeCount: sql<number>`COALESCE((
        SELECT COUNT(*) FROM communication_task_assignees a
        WHERE a.firm_id = ${firmId}
          AND a.message_id = ${communicationMessagesTable.id}
          AND a.task_id IS NULL
          AND a.status = 'assigned'
      ), 0)`.mapWith(Number),
    })
    .from(communicationMessagesTable)
    .where(and(...whereParts))
    .orderBy(desc(communicationMessagesTable.lastActivityAt), desc(communicationMessagesTable.receivedAt), desc(communicationMessagesTable.createdAt))
    .limit(args.limit)
    .offset(args.offset);

  return rows;
}

export async function listUsersByIds(r: DbConn, firmId: number, userIds: number[]) {
  if (!userIds.length) return [];
  return r
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(and(eq(usersTable.firmId, firmId), inArray(usersTable.id, userIds)));
}

export async function listActiveAssigneesForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationTaskAssigneesTable)
    .where(and(
      eq(communicationTaskAssigneesTable.firmId, firmId),
      eq(communicationTaskAssigneesTable.messageId, messageId),
      isNull(communicationTaskAssigneesTable.taskId),
      eq(communicationTaskAssigneesTable.status, "assigned"),
    ))
    .orderBy(asc(communicationTaskAssigneesTable.id));
}

export async function listAllAssigneesForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationTaskAssigneesTable)
    .where(and(
      eq(communicationTaskAssigneesTable.firmId, firmId),
      eq(communicationTaskAssigneesTable.messageId, messageId),
      isNull(communicationTaskAssigneesTable.taskId),
    ))
    .orderBy(asc(communicationTaskAssigneesTable.id));
}

export async function upsertMessageAssignees(r: DbConn, args: { firmId: number; messageId: number; actorId: number; userIds: number[] }) {
  const now = new Date();
  const deduped = Array.from(new Set(args.userIds)).filter((x) => Number.isFinite(x));
  const existing = await listAllAssigneesForMessage(r, args.firmId, args.messageId);
  const handlerByUser = new Map<number, typeof existing[number]>();
  for (const row of existing) {
    if (row.assignmentRole === "handler") handlerByUser.set(row.userId, row);
  }

  const assignedRows = existing.filter((row) => row.status === "assigned");
  for (const row of assignedRows) {
    await r.update(communicationTaskAssigneesTable).set({
      status: "unassigned",
      isPrimary: false,
      updatedAt: now,
    }).where(eq(communicationTaskAssigneesTable.id, row.id));
  }

  for (const [idx, userId] of deduped.entries()) {
    const existingRow = handlerByUser.get(userId);
    if (existingRow) {
      await r
        .update(communicationTaskAssigneesTable)
        .set({ status: "assigned", assignmentRole: "handler", isPrimary: idx === 0, assignedBy: args.actorId, assignedAt: now, updatedAt: now })
        .where(eq(communicationTaskAssigneesTable.id, existingRow.id));
      continue;
    }
    await r.insert(communicationTaskAssigneesTable).values({
      firmId: args.firmId,
      messageId: args.messageId,
      taskId: null,
      userId,
      assignmentRole: "handler",
      isPrimary: idx === 0,
      status: "assigned",
      assignedBy: args.actorId,
      assignedAt: now,
    });
  }

  return listActiveAssigneesForMessage(r, args.firmId, args.messageId);
}

export async function listRemarksForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationEmailRemarksTable)
    .where(and(
      eq(communicationEmailRemarksTable.firmId, firmId),
      eq(communicationEmailRemarksTable.messageId, messageId),
      isNull(communicationEmailRemarksTable.deletedAt),
    ))
    .orderBy(desc(communicationEmailRemarksTable.createdAt), desc(communicationEmailRemarksTable.id));
}

export async function getRemarkById(r: DbConn, firmId: number, remarkId: number) {
  const [row] = await r
    .select()
    .from(communicationEmailRemarksTable)
    .where(and(eq(communicationEmailRemarksTable.firmId, firmId), eq(communicationEmailRemarksTable.id, remarkId)))
    .limit(1);
  return row ?? null;
}

export async function insertRemark(r: DbConn, values: typeof communicationEmailRemarksTable.$inferInsert) {
  const [row] = await r.insert(communicationEmailRemarksTable).values(values).returning();
  return row;
}

export async function updateRemark(r: DbConn, firmId: number, remarkId: number, patch: Partial<typeof communicationEmailRemarksTable.$inferInsert>) {
  const [row] = await r
    .update(communicationEmailRemarksTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(communicationEmailRemarksTable.firmId, firmId), eq(communicationEmailRemarksTable.id, remarkId)))
    .returning();
  return row ?? null;
}

export async function softDeleteRemark(r: DbConn, firmId: number, remarkId: number) {
  const [row] = await r
    .update(communicationEmailRemarksTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(communicationEmailRemarksTable.firmId, firmId), eq(communicationEmailRemarksTable.id, remarkId)))
    .returning();
  return row ?? null;
}

export async function listReadsForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationMessageReadsTable)
    .where(and(eq(communicationMessageReadsTable.firmId, firmId), eq(communicationMessageReadsTable.messageId, messageId)))
    .orderBy(desc(communicationMessageReadsTable.lastOpenedAt), desc(communicationMessageReadsTable.openedCount));
}

export async function getReadByMessageUser(r: DbConn, firmId: number, messageId: number, userId: number) {
  const [row] = await r
    .select()
    .from(communicationMessageReadsTable)
    .where(and(
      eq(communicationMessageReadsTable.firmId, firmId),
      eq(communicationMessageReadsTable.messageId, messageId),
      eq(communicationMessageReadsTable.userId, userId),
    ))
    .limit(1);
  return row ?? null;
}

export async function upsertMessageOpened(r: DbConn, firmId: number, messageId: number, userId: number) {
  const now = new Date();
  const existing = await getReadByMessageUser(r, firmId, messageId, userId);
  if (!existing) {
    const [created] = await r.insert(communicationMessageReadsTable).values({
      firmId,
      messageId,
      userId,
      firstOpenedAt: now,
      lastOpenedAt: now,
      openedCount: 1,
    }).returning();
    return created;
  }
  const openedCount = (existing.openedCount ?? 0) + 1;
  const [updated] = await r
    .update(communicationMessageReadsTable)
    .set({
      firstOpenedAt: existing.firstOpenedAt ?? now,
      lastOpenedAt: now,
      openedCount,
      updatedAt: now,
    })
    .where(eq(communicationMessageReadsTable.id, existing.id))
    .returning();
  return updated ?? null;
}

export async function setMessageReadStatus(r: DbConn, args: { firmId: number; messageId: number; userId: number; isRead: boolean }) {
  const now = new Date();
  const existing = await getReadByMessageUser(r, args.firmId, args.messageId, args.userId);
  if (args.isRead) {
    if (!existing) {
      const [created] = await r.insert(communicationMessageReadsTable).values({
        firmId: args.firmId,
        messageId: args.messageId,
        userId: args.userId,
        firstOpenedAt: now,
        lastOpenedAt: now,
        openedCount: 1,
        isRead: true,
      }).returning();
      return created ?? null;
    }
    const [updated] = await r.update(communicationMessageReadsTable).set({
      firstOpenedAt: existing.firstOpenedAt ?? now,
      lastOpenedAt: now,
      openedCount: Math.max(existing.openedCount ?? 0, 1),
      isRead: true,
      updatedAt: now,
    }).where(eq(communicationMessageReadsTable.id, existing.id)).returning();
    return updated ?? null;
  }

  if (!existing) return null;
  const [updated] = await r.update(communicationMessageReadsTable).set({
    isRead: false,
    updatedAt: now,
  }).where(eq(communicationMessageReadsTable.id, existing.id)).returning();
  return updated ?? null;
}

export async function listEmailAccounts(r: DbConn, firmId: number) {
  return r
    .select()
    .from(communicationEmailAccountsTable)
    .where(eq(communicationEmailAccountsTable.firmId, firmId))
    .orderBy(desc(communicationEmailAccountsTable.updatedAt), desc(communicationEmailAccountsTable.id));
}

export async function insertEmailAccount(r: DbConn, values: typeof communicationEmailAccountsTable.$inferInsert) {
  const [row] = await r.insert(communicationEmailAccountsTable).values(values).returning();
  return row;
}

export async function getEmailAccountById(r: DbConn, firmId: number, accountId: number) {
  const [row] = await r
    .select()
    .from(communicationEmailAccountsTable)
    .where(and(
      eq(communicationEmailAccountsTable.firmId, firmId),
      eq(communicationEmailAccountsTable.id, accountId),
    ))
    .limit(1);
  return row ?? null;
}

export async function getEmailAccountByProviderEmail(r: DbConn, firmId: number, provider: string, emailAddress: string) {
  const [row] = await r
    .select()
    .from(communicationEmailAccountsTable)
    .where(and(
      eq(communicationEmailAccountsTable.firmId, firmId),
      eq(communicationEmailAccountsTable.provider, provider),
      eq(communicationEmailAccountsTable.emailAddress, emailAddress),
    ))
    .limit(1);
  return row ?? null;
}

export async function updateEmailAccount(r: DbConn, firmId: number, accountId: number, patch: Partial<typeof communicationEmailAccountsTable.$inferInsert>) {
  const [row] = await r
    .update(communicationEmailAccountsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(communicationEmailAccountsTable.firmId, firmId), eq(communicationEmailAccountsTable.id, accountId)))
    .returning();
  return row ?? null;
}

export async function upsertEmailFolder(r: DbConn, values: typeof communicationEmailFoldersTable.$inferInsert & { syncEnabled?: boolean | null }) {
  const [existing] = await r
    .select()
    .from(communicationEmailFoldersTable)
    .where(and(
      eq(communicationEmailFoldersTable.accountId, values.accountId),
      eq(communicationEmailFoldersTable.providerFolderId, values.providerFolderId),
    ))
    .limit(1);

  if (!existing) {
    const [created] = await r.insert(communicationEmailFoldersTable).values({
      ...values,
      syncEnabled: values.syncEnabled ?? false,
    }).returning();
    return created;
  }

  const [updated] = await r
    .update(communicationEmailFoldersTable)
    .set({
      parentProviderFolderId: values.parentProviderFolderId ?? null,
      displayName: values.displayName,
      folderType: values.folderType,
      syncEnabled: values.syncEnabled ?? existing.syncEnabled,
      updatedAt: new Date(),
    })
    .where(eq(communicationEmailFoldersTable.id, existing.id))
    .returning();
  return updated ?? existing;
}

export async function getEmailFolderById(r: DbConn, firmId: number, folderId: number) {
  const [row] = await r
    .select()
    .from(communicationEmailFoldersTable)
    .where(and(
      eq(communicationEmailFoldersTable.firmId, firmId),
      eq(communicationEmailFoldersTable.id, folderId),
    ))
    .limit(1);
  return row ?? null;
}

export async function updateEmailFolder(r: DbConn, firmId: number, folderId: number, patch: Partial<typeof communicationEmailFoldersTable.$inferInsert>) {
  const [row] = await r
    .update(communicationEmailFoldersTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(communicationEmailFoldersTable.firmId, firmId),
      eq(communicationEmailFoldersTable.id, folderId),
    ))
    .returning();
  return row ?? null;
}

export async function listEmailFoldersForAccount(r: DbConn, firmId: number, accountId: number) {
  return r
    .select()
    .from(communicationEmailFoldersTable)
    .where(and(eq(communicationEmailFoldersTable.firmId, firmId), eq(communicationEmailFoldersTable.accountId, accountId)))
    .orderBy(asc(communicationEmailFoldersTable.displayName));
}

export async function listEmailSyncLogsForAccount(r: DbConn, firmId: number, accountId: number, limit: number) {
  return r
    .select()
    .from(communicationEmailSyncLogsTable)
    .where(and(eq(communicationEmailSyncLogsTable.firmId, firmId), eq(communicationEmailSyncLogsTable.accountId, accountId)))
    .orderBy(desc(communicationEmailSyncLogsTable.startedAt), desc(communicationEmailSyncLogsTable.id))
    .limit(limit);
}

export async function insertEmailSyncLog(r: DbConn, values: typeof communicationEmailSyncLogsTable.$inferInsert) {
  const [row] = await r.insert(communicationEmailSyncLogsTable).values(values).returning();
  return row;
}

export async function updateEmailSyncLog(r: DbConn, firmId: number, syncLogId: number, patch: Partial<typeof communicationEmailSyncLogsTable.$inferInsert>) {
  const [row] = await r
    .update(communicationEmailSyncLogsTable)
    .set(patch)
    .where(and(
      eq(communicationEmailSyncLogsTable.firmId, firmId),
      eq(communicationEmailSyncLogsTable.id, syncLogId),
    ))
    .returning();
  return row ?? null;
}

export async function insertAttachment(r: DbConn, values: typeof communicationAttachmentsTable.$inferInsert) {
  const [row] = await r.insert(communicationAttachmentsTable).values(values).returning();
  return row;
}

export async function getAttachmentByProviderId(r: DbConn, firmId: number, messageId: number, providerAttachmentId: string) {
  const [row] = await r
    .select()
    .from(communicationAttachmentsTable)
    .where(and(
      eq(communicationAttachmentsTable.firmId, firmId),
      eq(communicationAttachmentsTable.messageId, messageId),
      eq(communicationAttachmentsTable.providerAttachmentId, providerAttachmentId),
    ))
    .limit(1);
  return row ?? null;
}

export async function listAttachmentsForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationAttachmentsTable)
    .where(and(eq(communicationAttachmentsTable.firmId, firmId), eq(communicationAttachmentsTable.messageId, messageId)))
    .orderBy(desc(communicationAttachmentsTable.createdAt), desc(communicationAttachmentsTable.id));
}

export async function listTasksForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationCaseTasksTable)
    .where(and(eq(communicationCaseTasksTable.firmId, firmId), eq(communicationCaseTasksTable.parentMessageId, messageId)))
    .orderBy(asc(communicationCaseTasksTable.id));
}

export async function getTaskById(r: DbConn, firmId: number, taskId: number) {
  const [row] = await r
    .select()
    .from(communicationCaseTasksTable)
    .where(and(eq(communicationCaseTasksTable.firmId, firmId), eq(communicationCaseTasksTable.id, taskId)))
    .limit(1);
  return row ?? null;
}

export async function insertTask(r: DbConn, values: typeof communicationCaseTasksTable.$inferInsert) {
  const [row] = await r.insert(communicationCaseTasksTable).values(values).returning();
  return row;
}

export async function updateTask(r: DbConn, firmId: number, taskId: number, patch: Partial<typeof communicationCaseTasksTable.$inferInsert>) {
  const [row] = await r
    .update(communicationCaseTasksTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(communicationCaseTasksTable.firmId, firmId), eq(communicationCaseTasksTable.id, taskId)))
    .returning();
  return row ?? null;
}

export async function listTasksMine(r: DbConn, firmId: number, userId: number, limit: number, offset: number) {
  const byLegacyAssigned = await r
    .select()
    .from(communicationCaseTasksTable)
    .where(and(eq(communicationCaseTasksTable.firmId, firmId), eq(communicationCaseTasksTable.assignedToUserId, userId)))
    .orderBy(desc(communicationCaseTasksTable.updatedAt), desc(communicationCaseTasksTable.createdAt))
    .limit(limit)
    .offset(offset);

  const byTeam = await r
    .select({ task: communicationCaseTasksTable })
    .from(communicationTaskAssigneesTable)
    .innerJoin(communicationCaseTasksTable, and(
      eq(communicationCaseTasksTable.firmId, firmId),
      eq(communicationCaseTasksTable.id, communicationTaskAssigneesTable.taskId),
    ))
    .where(and(
      eq(communicationTaskAssigneesTable.firmId, firmId),
      eq(communicationTaskAssigneesTable.userId, userId),
      inArray(communicationTaskAssigneesTable.assignmentRole, ["lawyer_in_charge", "handler"]),
    ))
    .orderBy(desc(communicationCaseTasksTable.updatedAt), desc(communicationCaseTasksTable.createdAt))
    .limit(limit)
    .offset(offset);

  const seen = new Set<number>();
  const merged: Array<typeof communicationCaseTasksTable.$inferSelect> = [];
  for (const row of byTeam.map((x) => x.task)) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  for (const row of byLegacyAssigned) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

export async function listAssigneesForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationTaskAssigneesTable)
    .where(and(
      eq(communicationTaskAssigneesTable.firmId, firmId),
      eq(communicationTaskAssigneesTable.messageId, messageId),
      isNull(communicationTaskAssigneesTable.taskId),
    ))
    .orderBy(asc(communicationTaskAssigneesTable.id));
}

export async function listAssigneesForTasks(r: DbConn, firmId: number, taskIds: number[]) {
  if (!taskIds.length) return [];
  return r
    .select()
    .from(communicationTaskAssigneesTable)
    .where(and(
      eq(communicationTaskAssigneesTable.firmId, firmId),
      inArray(communicationTaskAssigneesTable.taskId, taskIds),
    ))
    .orderBy(asc(communicationTaskAssigneesTable.id));
}

export async function replaceAssigneesForMessage(r: DbConn, firmId: number, messageId: number, rows: Array<typeof communicationTaskAssigneesTable.$inferInsert>) {
  await r
    .delete(communicationTaskAssigneesTable)
    .where(and(
      eq(communicationTaskAssigneesTable.firmId, firmId),
      eq(communicationTaskAssigneesTable.messageId, messageId),
      isNull(communicationTaskAssigneesTable.taskId),
    ));
  if (!rows.length) return [];
  const inserted = await r.insert(communicationTaskAssigneesTable).values(rows).returning();
  return inserted;
}

export async function replaceAssigneesForTask(r: DbConn, firmId: number, messageId: number, taskId: number, rows: Array<typeof communicationTaskAssigneesTable.$inferInsert>) {
  await r
    .delete(communicationTaskAssigneesTable)
    .where(and(
      eq(communicationTaskAssigneesTable.firmId, firmId),
      eq(communicationTaskAssigneesTable.messageId, messageId),
      eq(communicationTaskAssigneesTable.taskId, taskId),
    ));
  if (!rows.length) return [];
  const inserted = await r.insert(communicationTaskAssigneesTable).values(rows).returning();
  return inserted;
}

export async function insertDraft(r: DbConn, values: typeof communicationDraftsTable.$inferInsert) {
  const [row] = await r.insert(communicationDraftsTable).values(values).returning();
  return row;
}

export async function linkDraftTasks(r: DbConn, firmId: number, draftId: number, taskIds: number[]) {
  const values = taskIds.map((taskId) => ({ firmId, draftId, caseTaskId: taskId }));
  if (!values.length) return;
  await r.insert(communicationDraftTasksTable).values(values).onConflictDoNothing();
}

export async function getDraftById(r: DbConn, firmId: number, draftId: number) {
  const [draft] = await r
    .select()
    .from(communicationDraftsTable)
    .where(and(eq(communicationDraftsTable.firmId, firmId), eq(communicationDraftsTable.id, draftId)))
    .limit(1);
  if (!draft) return null;
  const tasks = await r
    .select({ link: communicationDraftTasksTable, task: communicationCaseTasksTable })
    .from(communicationDraftTasksTable)
    .innerJoin(communicationCaseTasksTable, and(
      eq(communicationDraftTasksTable.caseTaskId, communicationCaseTasksTable.id),
      eq(communicationCaseTasksTable.firmId, firmId),
    ))
    .where(and(eq(communicationDraftTasksTable.firmId, firmId), eq(communicationDraftTasksTable.draftId, draftId)))
    .orderBy(asc(communicationDraftTasksTable.id));
  return { draft, tasks: tasks.map((t) => t.task) };
}

export async function listDrafts(r: DbConn, firmId: number, args: { status?: string; limit: number; offset: number }) {
  const where = args.status ? and(eq(communicationDraftsTable.firmId, firmId), eq(communicationDraftsTable.status, args.status)) : eq(communicationDraftsTable.firmId, firmId);
  return r
    .select()
    .from(communicationDraftsTable)
    .where(where)
    .orderBy(desc(communicationDraftsTable.updatedAt), desc(communicationDraftsTable.createdAt))
    .limit(args.limit)
    .offset(args.offset);
}

export async function updateDraft(r: DbConn, firmId: number, draftId: number, patch: Partial<typeof communicationDraftsTable.$inferInsert>) {
  const [row] = await r
    .update(communicationDraftsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(communicationDraftsTable.firmId, firmId), eq(communicationDraftsTable.id, draftId)))
    .returning();
  return row ?? null;
}

export async function listDraftTaskIds(r: DbConn, firmId: number, draftId: number): Promise<number[]> {
  const rows = await r
    .select({ caseTaskId: communicationDraftTasksTable.caseTaskId })
    .from(communicationDraftTasksTable)
    .where(and(eq(communicationDraftTasksTable.firmId, firmId), eq(communicationDraftTasksTable.draftId, draftId)));
  return rows.map((x) => x.caseTaskId);
}

export async function findCaseByIdOrRef(r: DbConn, firmId: number, input: { caseId?: number | null; caseRef?: string | null }) {
  const caseId = typeof input.caseId === "number" ? input.caseId : null;
  const rawRef = input.caseRef ? normalizeCaseRefInput(input.caseRef) : "";
  if (caseId) {
    const [row] = await r.select().from(casesTable).where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, caseId))).limit(1);
    return row ?? null;
  }
  if (rawRef) {
    const [row] = await r
      .select()
      .from(casesTable)
      .where(and(
        eq(casesTable.firmId, firmId),
        or(eq(casesTable.referenceNo, rawRef), eq(casesTable.parcelNo, rawRef)),
      ))
      .limit(1);
    return row ?? null;
  }
  return null;
}

export async function lookupCases(r: DbConn, firmId: number, q: string, limit: number) {
  const query = String(q ?? "").trim();
  if (!query) return [];
  const like = `%${query}%`;

  const rows = await r
    .select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      parcelNo: casesTable.parcelNo,
      status: casesTable.status,
      developerName: developersTable.name,
      createdAt: casesTable.createdAt,
    })
    .from(casesTable)
    .leftJoin(developersTable, and(eq(developersTable.firmId, firmId), eq(developersTable.id, casesTable.developerId)))
    .where(and(
      eq(casesTable.firmId, firmId),
      or(
        sql`${casesTable.referenceNo} ILIKE ${like}`,
        sql`${casesTable.parcelNo} ILIKE ${like}`,
        sql`${casesTable.borrowers}::text ILIKE ${like}`,
        sql`${casesTable.propertyDetails}::text ILIKE ${like}`,
        sql`${developersTable.name} ILIKE ${like}`,
      )
    ))
    .orderBy(desc(casesTable.createdAt), desc(casesTable.id))
    .limit(Math.min(limit, 50));

  return rows.map((r) => ({ id: r.id, caseRef: r.referenceNo ?? r.parcelNo ?? null, status: r.status, developerName: r.developerName ?? null, createdAt: r.createdAt }));
}

export async function getCaseRefDisplay(r: DbConn, firmId: number, caseId: number): Promise<{ caseRef: string | null; parcelNo: string | null; referenceNo: string | null } | null> {
  const [row] = await r
    .select({ referenceNo: casesTable.referenceNo, parcelNo: casesTable.parcelNo })
    .from(casesTable)
    .where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, caseId)))
    .limit(1);
  if (!row) return null;
  const ref = row.referenceNo ? String(row.referenceNo) : (row.parcelNo ? String(row.parcelNo) : null);
  return { caseRef: ref, parcelNo: row.parcelNo ?? null, referenceNo: row.referenceNo ?? null };
}

export async function getCaseResponsibleUsers(r: DbConn, firmId: number, caseId: number): Promise<{ lawyerId: number | null; clerkId: number | null }> {
  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, caseId)))
    .limit(1);
  if (!caseRow) return { lawyerId: null, clerkId: null };
  const rows = await r
    .select({ userId: caseAssignmentsTable.userId, roleInCase: caseAssignmentsTable.roleInCase })
    .from(caseAssignmentsTable)
    .where(and(eq(caseAssignmentsTable.caseId, caseId), isNull(caseAssignmentsTable.unassignedAt)));
  const lawyer = rows.find((x) => String(x.roleInCase ?? "").toLowerCase().includes("lawyer") || String(x.roleInCase ?? "").toLowerCase().includes("partner"));
  const clerk = rows.find((x) => String(x.roleInCase ?? "").toLowerCase().includes("clerk"));
  return { lawyerId: lawyer?.userId ?? null, clerkId: clerk?.userId ?? null };
}

export async function insertCommunicationAuditLog(r: DbConn, values: typeof communicationAuditLogsTable.$inferInsert) {
  const [row] = await r.insert(communicationAuditLogsTable).values(values).returning();
  return row;
}

export async function listAuditLogsForMessage(r: DbConn, firmId: number, messageId: number) {
  return r
    .select()
    .from(communicationAuditLogsTable)
    .where(and(eq(communicationAuditLogsTable.firmId, firmId), eq(communicationAuditLogsTable.messageId, messageId)))
    .orderBy(desc(communicationAuditLogsTable.createdAt));
}

export async function listAuditLogsForTask(r: DbConn, firmId: number, taskId: number) {
  return r
    .select()
    .from(communicationAuditLogsTable)
    .where(and(eq(communicationAuditLogsTable.firmId, firmId), eq(communicationAuditLogsTable.caseTaskId, taskId)))
    .orderBy(desc(communicationAuditLogsTable.createdAt));
}

export async function listAuditLogsForDraft(r: DbConn, firmId: number, draftId: number) {
  return r
    .select()
    .from(communicationAuditLogsTable)
    .where(and(eq(communicationAuditLogsTable.firmId, firmId), eq(communicationAuditLogsTable.draftId, draftId)))
    .orderBy(desc(communicationAuditLogsTable.createdAt));
}

export async function buildCaseCommunicationTimeline(r: DbConn, firmId: number, caseId: number) {
  const messages = await r
    .select()
    .from(communicationMessagesTable)
    .where(and(eq(communicationMessagesTable.firmId, firmId), eq(communicationMessagesTable.linkedCaseId, caseId)))
    .orderBy(desc(communicationMessagesTable.receivedAt), desc(communicationMessagesTable.sentAt), desc(communicationMessagesTable.createdAt));
  const tasks = await r
    .select()
    .from(communicationCaseTasksTable)
    .where(and(eq(communicationCaseTasksTable.firmId, firmId), eq(communicationCaseTasksTable.linkedCaseId, caseId)))
    .orderBy(desc(communicationCaseTasksTable.updatedAt), desc(communicationCaseTasksTable.createdAt));

  const messageIds = messages.map((m) => m.id);
  const taskIds = tasks.map((t) => t.id);

  const draftsByMessage = messageIds.length
    ? await r
      .select()
      .from(communicationDraftsTable)
      .where(and(eq(communicationDraftsTable.firmId, firmId), inArray(communicationDraftsTable.parentMessageId, messageIds)))
      .orderBy(desc(communicationDraftsTable.updatedAt), desc(communicationDraftsTable.createdAt))
    : [];

  const draftsByTask = taskIds.length
    ? await r
      .select({ draft: communicationDraftsTable })
      .from(communicationDraftTasksTable)
      .innerJoin(communicationDraftsTable, and(
        eq(communicationDraftsTable.firmId, firmId),
        eq(communicationDraftsTable.id, communicationDraftTasksTable.draftId),
      ))
      .where(and(eq(communicationDraftTasksTable.firmId, firmId), inArray(communicationDraftTasksTable.caseTaskId, taskIds)))
      .orderBy(desc(communicationDraftsTable.updatedAt), desc(communicationDraftsTable.createdAt))
    : [];

  const seenDraftIds = new Set<number>();
  const drafts = [] as Array<typeof communicationDraftsTable.$inferSelect>;
  for (const d of draftsByMessage) {
    if (seenDraftIds.has(d.id)) continue;
    seenDraftIds.add(d.id);
    drafts.push(d);
  }
  for (const row of draftsByTask) {
    const d = row.draft;
    if (seenDraftIds.has(d.id)) continue;
    seenDraftIds.add(d.id);
    drafts.push(d);
  }

  return { messages, tasks, drafts };
}
