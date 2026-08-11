import { and, eq } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  communicationMessagesTable,
  communicationCaseTasksTable,
  communicationTaskAssigneesTable,
  casesTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

const communicationCaseTaskLinkAuditTable = pgTable("communication_case_task_link_audit", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  messageId: integer("message_id").notNull(),
  caseTaskId: integer("case_task_id"),
  caseId: integer("case_id").notNull(),
  actionType: text("action_type").notNull().default("LINK_TASK"),
  beforeAssignedToUserId: integer("before_assigned_to_user_id"),
  afterAssignedToUserId: integer("after_assigned_to_user_id"),
  beforeTaskStatus: text("before_task_status"),
  afterTaskStatus: text("after_task_status"),
  beforeRequiredAction: text("before_required_action"),
  afterRequiredAction: text("after_required_action"),
  beforeDueAt: timestamp("before_due_at", { withTimezone: true }),
  afterDueAt: timestamp("after_due_at", { withTimezone: true }),
  readToggledOnMessage: boolean("read_toggled_on_message").notNull().default(false),
  idempotencyKey: text("idempotency_key"),
  actorUserId: integer("actor_user_id"),
  actorRole: text("actor_role"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdx: index("idx_comm_task_link_audit_firm").on(t.firmId),
  firmMsgIdx: index("idx_comm_task_link_audit_msg").on(t.firmId, t.messageId),
  firmCaseIdx: index("idx_comm_task_link_audit_case").on(t.firmId, t.caseId),
  uqIdem: uniqueIndex("uq_comm_task_link_audit_idem").on(t.firmId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
}));

export type CommunicationTaskStatus =
  | "pending_owner_review"
  | "seen_by_owner"
  | "in_progress"
  | "waiting_client"
  | "waiting_developer"
  | "waiting_bank"
  | "waiting_lawyer_review"
  | "ready_to_reply"
  | "included_in_draft"
  | "replied"
  | "closed";

export interface LinkMessageCaseTaskInput {
  firmId: number;
  parentMessageId: number;
  caseId: number;
  assignedToUserId?: number | null;
  taskStatus?: CommunicationTaskStatus | null;
  requiredAction?: string | null;
  dueAt?: Date | string | null;
  caseRef?: string | null;
  partyName?: string | null;
  bankRef?: string | null;
  developerRef?: string | null;
  propertyRef?: string | null;
  priority?: "low" | "medium" | "high" | null;
  idempotencyKey?: string | null;
  actorUserId: number;
  actorRole?: string | null;
  team?: {
    lawyerInChargeUserId?: number | null;
    handlerUserIds?: number[] | null;
    reviewerUserId?: number | null;
    watcherUserIds?: number[] | null;
  } | null;
}

export interface LinkMessageCaseTaskResult {
  caseTaskId: number;
  messageId: number;
  caseId: number;
  assignedToUserId: number | null;
  taskStatus: string | null;
  requiredAction: string | null;
  dueAt: Date | null;
  caseRef: string | null;
  providerIsReadUntouched: boolean;
  readToggleOccurred: boolean;
  idempotencyKey: string | null;
  auditId: number | null;
  existed: boolean;
}

function toDateOrNull(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

export async function linkMessageCaseTask(
  input: LinkMessageCaseTaskInput,
  opts: { tx?: unknown } = {},
): Promise<LinkMessageCaseTaskResult> {
  const conn = pickDbConn(opts.tx);

  if (!input.parentMessageId || typeof input.parentMessageId !== "number") {
    throw new ApiError({ status: 400, code: "LINK_TASK_PARENT_MSG_REQUIRED", message: "Parent message id is required", retryable: false });
  }
  if (!input.caseId || typeof input.caseId !== "number") {
    throw new ApiError({ status: 400, code: "LINK_TASK_CASE_REQUIRED", message: "Case id is required", retryable: false });
  }

  const parentMsg = (await conn
    .select()
    .from(communicationMessagesTable as any)
    .where(and(
      eq(communicationMessagesTable.firmId, input.firmId),
      eq(communicationMessagesTable.id, input.parentMessageId),
    ))
    .limit(1))?.[0] as any;

  if (!parentMsg) {
    throw new ApiError({ status: 404, code: "LINK_TASK_PARENT_MSG_NOT_FOUND", message: "Parent email message not found in firm scope", retryable: false });
  }

  const caseRow = (await conn
    .select({ id: casesTable.id, referenceNo: (casesTable as any).referenceNo ?? (casesTable as any).caseRef })
    .from(casesTable as any)
    .where(and(
      eq((casesTable as any).firmId, input.firmId),
      eq((casesTable as any).id, input.caseId),
    ))
    .limit(1))?.[0] as any;

  if (!caseRow) {
    throw new ApiError({ status: 404, code: "LINK_TASK_CASE_NOT_FOUND", message: "Case not found in firm scope", retryable: false });
  }

  const idemKey = input.idempotencyKey ?? `COMM_TASK_LINK:${input.parentMessageId}:${input.caseId}`;
  const now = new Date();
  const dueAtObj = toDateOrNull(input.dueAt);
  const caseRefVal = input.caseRef ?? (caseRow?.referenceNo ? String(caseRow.referenceNo) : null);

  const msgProviderIsReadBefore = typeof parentMsg.providerIsRead === "boolean" ? parentMsg.providerIsRead : null;
  const msgIsReadBefore = typeof parentMsg.isRead === "boolean" ? parentMsg.isRead : null;

  const taskCols = (communicationCaseTasksTable as any);

  let existingTask: any = null;
  try {
    existingTask = (await conn
      .select()
      .from(communicationCaseTasksTable as any)
      .where(and(
        eq(taskCols.firmId, input.firmId),
        eq(taskCols.messageId, input.parentMessageId),
        eq(taskCols.linkedCaseId, input.caseId),
      ))
      .limit(1))?.[0] as any;
  } catch {
    existingTask = null;
  }

  const assignedToUserId = typeof input.assignedToUserId === "number" ? input.assignedToUserId : null;
  const taskStatus = input.taskStatus ?? (existingTask?.taskStatus ?? "pending_owner_review");
  const requiredAction = input.requiredAction ?? null;
  const priorityVal = input.priority ?? (existingTask?.priority ?? "medium");

  let caseTaskId: number | null = null;
  let existed = false;
  let beforeAssignedToUserId: number | null = null;
  let beforeTaskStatus: string | null = null;
  let beforeRequiredAction: string | null = null;
  let beforeDueAt: Date | null = null;

  if (existingTask) {
    caseTaskId = Number(existingTask.id);
    existed = true;
    beforeAssignedToUserId = typeof existingTask.assignedToUserId === "number" ? existingTask.assignedToUserId : null;
    beforeTaskStatus = existingTask.taskStatus ?? null;
    beforeRequiredAction = existingTask.requiredAction ?? null;
    beforeDueAt = existingTask.dueAt ?? null;

    try {
      await conn
        .update(communicationCaseTasksTable as any)
        .set({
          assignedToUserId,
          taskStatus,
          requiredAction,
          dueAt: dueAtObj,
          caseRef: caseRefVal,
          partyName: input.partyName ?? existingTask.partyName ?? null,
          bankRef: input.bankRef ?? existingTask.bankRef ?? null,
          developerRef: input.developerRef ?? existingTask.developerRef ?? null,
          propertyRef: input.propertyRef ?? existingTask.propertyRef ?? null,
          priority: priorityVal,
          updatedAt: now,
        } as any)
        .where(and(
          eq(taskCols.firmId, input.firmId),
          eq(taskCols.id, caseTaskId),
        ));
    } catch (err) {
      // allow best-effort; row-level constraint conflict still returns existing id below
    }
  } else {
    try {
      const insertRows = await conn
        .insert(communicationCaseTasksTable as any)
        .values({
          firmId: input.firmId,
          messageId: input.parentMessageId,
          linkedCaseId: input.caseId,
          caseRef: caseRefVal,
          partyName: input.partyName ?? null,
          bankRef: input.bankRef ?? null,
          developerRef: input.developerRef ?? null,
          propertyRef: input.propertyRef ?? null,
          assignedToUserId,
          taskStatus,
          requiredAction,
          dueAt: dueAtObj,
          priority: priorityVal,
          idempotencyKey: idemKey,
          createdBy: input.actorUserId,
          createdAt: now,
          updatedAt: now,
        } as any)
        .onConflictDoNothing()
        .returning({ id: taskCols.id });

      if (insertRows?.[0]) {
        caseTaskId = Number((insertRows[0] as any).id);
      } else {
        const fallback = (await conn
          .select({ id: taskCols.id })
          .from(communicationCaseTasksTable as any)
          .where(and(
            eq(taskCols.firmId, input.firmId),
            eq(taskCols.messageId, input.parentMessageId),
            eq(taskCols.linkedCaseId, input.caseId),
          ))
          .limit(1))?.[0] as any;
        if (fallback) {
          caseTaskId = Number(fallback.id);
          existed = true;
        }
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err?.code ?? "");
      const isUnique = /unique|uq_|23505|duplicate/i.test(msg);
      if (!isUnique) throw err;
      const fallback = (await conn
        .select({ id: taskCols.id })
        .from(communicationCaseTasksTable as any)
        .where(and(
          eq(taskCols.firmId, input.firmId),
          eq(taskCols.messageId, input.parentMessageId),
          eq(taskCols.linkedCaseId, input.caseId),
        ))
        .limit(1))?.[0] as any;
      if (fallback) {
        caseTaskId = Number(fallback.id);
        existed = true;
      }
    }
  }

  if (caseTaskId == null) {
    throw new ApiError({ status: 500, code: "LINK_TASK_INSERT_FAILED", message: "Case task link insert failed without returning id", retryable: true });
  }

  if (typeof input.assignedToUserId === "number") {
    try {
      await conn
        .insert(communicationTaskAssigneesTable as any)
        .values({
          firmId: input.firmId,
          messageId: input.parentMessageId,
          taskId: caseTaskId,
          userId: input.assignedToUserId,
          assignmentRole: "handler",
          status: "assigned",
          assignedBy: input.actorUserId,
          assignedAt: now,
          createdAt: now,
          updatedAt: now,
        } as any)
        .onConflictDoNothing();
    } catch {
      // non-fatal
    }
  }

  const team = input.team;
  if (team) {
    try {
      const assigneeInserts: any[] = [];
      if (typeof team.lawyerInChargeUserId === "number") {
        assigneeInserts.push({
          firmId: input.firmId,
          messageId: input.parentMessageId,
          taskId: caseTaskId,
          userId: team.lawyerInChargeUserId,
          assignmentRole: "lawyer_in_charge",
          status: "assigned",
          assignedBy: input.actorUserId,
          assignedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const uid of (team.handlerUserIds ?? [])) {
        if (typeof uid !== "number") continue;
        if (uid === input.assignedToUserId) continue;
        assigneeInserts.push({
          firmId: input.firmId,
          messageId: input.parentMessageId,
          taskId: caseTaskId,
          userId: uid,
          assignmentRole: "handler",
          status: "assigned",
          assignedBy: input.actorUserId,
          assignedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (typeof team.reviewerUserId === "number") {
        assigneeInserts.push({
          firmId: input.firmId,
          messageId: input.parentMessageId,
          taskId: caseTaskId,
          userId: team.reviewerUserId,
          assignmentRole: "reviewer",
          status: "assigned",
          assignedBy: input.actorUserId,
          assignedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const uid of (team.watcherUserIds ?? [])) {
        if (typeof uid !== "number") continue;
        assigneeInserts.push({
          firmId: input.firmId,
          messageId: input.parentMessageId,
          taskId: caseTaskId,
          userId: uid,
          assignmentRole: "watcher",
          status: "assigned",
          assignedBy: input.actorUserId,
          assignedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (assigneeInserts.length) {
        await conn
          .insert(communicationTaskAssigneesTable as any)
          .values(assigneeInserts as any[])
          .onConflictDoNothing();
      }
    } catch {
      // non-fatal
    }
  }

  let auditId: number | null = null;
  try {
    const auditRows = await conn
      .insert(communicationCaseTaskLinkAuditTable as any)
      .values({
        firmId: input.firmId,
        messageId: input.parentMessageId,
        caseTaskId,
        caseId: input.caseId,
        actionType: existed ? "UPDATE_TASK" : "LINK_TASK",
        beforeAssignedToUserId,
        afterAssignedToUserId: assignedToUserId,
        beforeTaskStatus,
        afterTaskStatus: taskStatus,
        beforeRequiredAction,
        afterRequiredAction: requiredAction,
        beforeDueAt,
        afterDueAt: dueAtObj,
        readToggledOnMessage: false,
        idempotencyKey: idemKey,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole ?? null,
        createdAt: now,
      } as any)
      .onConflictDoNothing()
      .returning({ id: communicationCaseTaskLinkAuditTable.id });
    if (auditRows?.[0]) {
      auditId = Number((auditRows[0] as any).id);
    }
  } catch {
    // audit best-effort
  }

  const msgAfter = (await conn
    .select({
      providerIsRead: (communicationMessagesTable as any).providerIsRead,
      isRead: (communicationMessagesTable as any).isRead,
    })
    .from(communicationMessagesTable as any)
    .where(and(
      eq(communicationMessagesTable.firmId, input.firmId),
      eq(communicationMessagesTable.id, input.parentMessageId),
    ))
    .limit(1))?.[0] as any;

  const msgProviderIsReadAfter = msgAfter && typeof msgAfter.providerIsRead === "boolean" ? msgAfter.providerIsRead : msgProviderIsReadBefore;
  const msgIsReadAfter = msgAfter && typeof msgAfter.isRead === "boolean" ? msgAfter.isRead : msgIsReadBefore;
  const providerIsReadUntouched = msgProviderIsReadBefore === msgProviderIsReadAfter;
  const readToggleOccurred = msgIsReadBefore !== msgIsReadAfter;

  return {
    caseTaskId,
    messageId: input.parentMessageId,
    caseId: input.caseId,
    assignedToUserId,
    taskStatus,
    requiredAction,
    dueAt: dueAtObj,
    caseRef: caseRefVal,
    providerIsReadUntouched,
    readToggleOccurred,
    idempotencyKey: idemKey,
    auditId,
    existed,
  };
}
