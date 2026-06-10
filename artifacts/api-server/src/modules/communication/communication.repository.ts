import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  casesTable,
  caseAssignmentsTable,
  rolesTable,
  communicationMailboxesTable,
  communicationMessagesTable,
  communicationCaseTasksTable,
  communicationDraftsTable,
  communicationDraftTasksTable,
  communicationAuditLogsTable,
  communicationTaskAssigneesTable,
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

export async function listMessages(
  r: DbConn,
  firmId: number,
  args: { status?: string | string[]; isBatch?: boolean; assignedToUserId?: number | null; linkedCaseId?: number | null; limit: number; offset: number }
) {
  const whereParts = [eq(communicationMessagesTable.firmId, firmId)] as any[];
  if (Array.isArray(args.status) && args.status.length === 1) whereParts.push(eq(communicationMessagesTable.internalStatus, args.status[0]));
  else if (Array.isArray(args.status) && args.status.length > 1) whereParts.push(inArray(communicationMessagesTable.internalStatus, args.status));
  else if (typeof args.status === "string" && args.status) whereParts.push(eq(communicationMessagesTable.internalStatus, args.status));
  if (typeof args.isBatch === "boolean") whereParts.push(eq(communicationMessagesTable.isBatch, args.isBatch));
  if (args.assignedToUserId === null) whereParts.push(isNull(communicationMessagesTable.assignedToUserId));
  if (typeof args.assignedToUserId === "number") whereParts.push(eq(communicationMessagesTable.assignedToUserId, args.assignedToUserId));
  if (args.linkedCaseId === null) whereParts.push(isNull(communicationMessagesTable.linkedCaseId));
  if (typeof args.linkedCaseId === "number") whereParts.push(eq(communicationMessagesTable.linkedCaseId, args.linkedCaseId));

  const rows = await r
    .select({
      message: communicationMessagesTable,
      tasksTotal: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id}), 0)`.mapWith(Number),
      tasksReady: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id} AND t.task_status IN ('ready_to_reply','included_in_draft')), 0)`.mapWith(Number),
      tasksReplied: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id} AND t.task_status IN ('replied','closed')), 0)`.mapWith(Number),
      tasksUnassigned: sql<number>`COALESCE((SELECT COUNT(*) FROM communication_case_tasks t WHERE t.firm_id = ${firmId} AND t.parent_message_id = ${communicationMessagesTable.id} AND t.assigned_to_user_id IS NULL), 0)`.mapWith(Number),
    })
    .from(communicationMessagesTable)
    .where(and(...whereParts))
    .orderBy(desc(communicationMessagesTable.lastActivityAt), desc(communicationMessagesTable.receivedAt), desc(communicationMessagesTable.createdAt))
    .limit(args.limit)
    .offset(args.offset);

  return rows;
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
  return { messages, tasks };
}
