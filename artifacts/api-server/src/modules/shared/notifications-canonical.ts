import { eq, and, inArray, isNull, desc, like } from "drizzle-orm";
import type { PgTableWithColumns, AnyPgColumn } from "drizzle-orm/pg-core";
import {
  db,
  userNotificationsTable,
} from "@workspace/db";
import type { SelectedFieldsFlat } from "drizzle-orm/pg-core/query-builders/select.types";

export type NotificationIdempotentKey =
  | { kind: "pv_overdue"; pvId: number | string; level: "L1_RESPONSIBLE" | "L2_PARTNER" }
  | { kind: "case_stuck"; caseId: number | string; stage: string }
  | { kind: "leave_approval"; leaveId: number | string; approverId: number | string }
  | { kind: "claim_approval"; claimId: number | string; approverId: number | string }
  | { kind: "training_expiry"; assignmentId: number | string }
  | { kind: "generic"; eventKey: string };

export function buildNotificationEventKey(k: NotificationIdempotentKey): string {
  switch (k.kind) {
    case "pv_overdue":
      return `PV_OVERDUE:${k.pvId}:${k.level}`;
    case "case_stuck":
      return `CASE_STUCK:${k.caseId}:${k.stage}`;
    case "leave_approval":
      return `LEAVE_APPROVAL:${k.leaveId}:${k.approverId}`;
    case "claim_approval":
      return `CLAIM_APPROVAL:${k.claimId}:${k.approverId}`;
    case "training_expiry":
      return `TRAINING_EXPIRY:${k.assignmentId}`;
    case "generic":
      return k.eventKey.startsWith("EVT:") ? k.eventKey : `EVT:${k.eventKey}`;
  }
}

const ACTIVE_STATUSES: ReadonlyArray<string> = [
  "unread", "read", "acknowledged", "escalated",
];

export type UpsertNotificationInput = {
  firmId: number;
  userId: number;
  sourceType: string;
  sourceId: number;
  caseId?: number | null;
  notificationType: string;
  title: string;
  message: string;
  meta?: Record<string, unknown> | null;
  severity?: "normal" | "high" | "urgent";
  targetScope?: "user" | "lawyer" | "manager" | "selected_partner" | "all_partners";
  correlationId?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  repeatHours?: number;
  eventKey: string;
};

type DbConnLike = {
  select: (f: any) => any;
  insert: (t: any) => any;
  update: (t: any) => any;
  execute?: () => any;
};

function pickDb(input: unknown): DbConnLike {
  if (input && typeof (input as any).select === "function") return input as DbConnLike;
  return db as unknown as DbConnLike;
}

export async function upsertIdempotentNotification(
  input: UpsertNotificationInput,
  txOverride?: unknown,
): Promise<{ id: number | null; created: boolean; updated: boolean; deliveryCount: number }> {
  const d = pickDb(txOverride);
  const {
    firmId, userId, sourceType, sourceId, caseId,
    notificationType, title, message, meta, severity,
    targetScope, correlationId, entityType, entityId,
    repeatHours, eventKey,
  } = input;

  const ACTIVE = ACTIVE_STATUSES;
  const existingQ = d
    .select({
      id: userNotificationsTable.id,
      status: userNotificationsTable.status,
      deliveryCount: userNotificationsTable.deliveryCount,
    })
    .from(userNotificationsTable)
    .where(and(
      eq(userNotificationsTable.firmId, firmId),
      eq(userNotificationsTable.userId, userId),
      eq(userNotificationsTable.ruleCode, eventKey),
      inArray(userNotificationsTable.status, ACTIVE),
    ))
    .orderBy(desc(userNotificationsTable.id))
    .limit(1);
  const existingRows = await (typeof existingQ.execute === "function" ? existingQ.execute() : existingQ);
  const existing = existingRows && existingRows[0];
  if (existing) {
    const current = Number(existing.deliveryCount ?? 1);
    const nextCount = current + 1;
    const now = new Date();
    const nextAt = repeatHours
      ? new Date(now.getTime() + repeatHours * 3_600_000)
      : null;
    const updQ = d
      .update(userNotificationsTable)
      .set({
        lastNotifiedAt: now,
        nextNotifyAt: nextAt ?? undefined,
        deliveryCount: nextCount,
        updatedAt: now,
      })
      .where(eq(userNotificationsTable.id, Number(existing.id)));
    await (typeof updQ.execute === "function" ? updQ.execute() : updQ);
    return { id: Number(existing.id), created: false, updated: true, deliveryCount: nextCount };
  }

  const now = new Date();
  const nextAt = repeatHours ? new Date(now.getTime() + repeatHours * 3_600_000) : undefined;
  const ins = d
    .insert(userNotificationsTable)
    .values({
      firmId,
      userId,
      sourceType,
      sourceId,
      caseId: caseId ?? undefined,
      notificationType,
      title,
      message: message ?? "",
      meta: meta ?? undefined,
      isRead: false,
      status: "unread",
      dismissible: true,
      severity: severity ?? "normal",
      statusSetAt: now,
      targetScope: targetScope ?? undefined,
      ruleCode: eventKey,
      correlationId: correlationId ?? undefined,
      entityType: entityType ?? undefined,
      entityId: entityId ?? undefined,
      lastNotifiedAt: now,
      nextNotifyAt: nextAt,
      deliveryCount: 1,
      updatedAt: now,
      createdAt: now,
    })
    .returning({ id: userNotificationsTable.id });
  const rows = await (typeof ins.execute === "function" ? ins.execute() : ins);
  const id = rows && rows[0] ? Number((rows[0] as any).id) : null;
  return { id, created: true, updated: false, deliveryCount: 1 };
}

export async function resolveNotificationsByEventKey(
  firmId: number,
  prefixOrPattern: string,
  opts: {
    entityType?: string;
    resolvedReason?: string;
    resolvedByUserId?: number;
    useLike?: boolean;
    tx?: unknown;
  } = {},
): Promise<number> {
  const d = pickDb(opts.tx);
  const useLike = opts.useLike ?? true;
  const statuses = ACTIVE_STATUSES;
  const cols = { id: userNotificationsTable.id };
  const q = useLike
    ? d.select(cols).from(userNotificationsTable).where(and(
        eq(userNotificationsTable.firmId, firmId),
        inArray(userNotificationsTable.status, statuses),
        like((userNotificationsTable as any).ruleCode, `${prefixOrPattern}%`),
      ))
    : d.select(cols).from(userNotificationsTable).where(and(
        eq(userNotificationsTable.firmId, firmId),
        inArray(userNotificationsTable.status, statuses),
        eq(userNotificationsTable.ruleCode, prefixOrPattern),
      ));
  const rows = await (typeof q.execute === "function" ? q.execute() : q);
  if (!rows || rows.length === 0) return 0;
  const ids = rows.map((r: any) => Number(r.id)).filter(Boolean);
  const now = new Date();
  const upd = d
    .update(userNotificationsTable)
    .set({
      status: "resolved",
      resolvedAt: now,
      autoResolvedAt: now,
      eventAutoResolvedAt: now,
      resolvedBy: opts.resolvedByUserId ?? undefined,
      resolvedReason: opts.resolvedReason ?? "auto_resolved_by_event",
      updatedAt: now,
    })
    .where(eq(userNotificationsTable.firmId, firmId) as any);
  // Fallback: cannot use inArray with plain array literal unless column exists,
  // use raw and filter client-side is safe for scope rows small.
  await (typeof upd.execute === "function" ? upd.execute() : upd);
  let resolved = 0;
  for (const id of ids) {
    const single = d
      .update(userNotificationsTable)
      .set({
        status: "resolved",
        resolvedAt: now,
        autoResolvedAt: now,
        eventAutoResolvedAt: now,
        resolvedBy: opts.resolvedByUserId ?? undefined,
        resolvedReason: opts.resolvedReason ?? "auto_resolved_by_event",
        updatedAt: now,
      })
      .where(eq(userNotificationsTable.id, id));
    const r = await (typeof single.execute === "function" ? single.execute() : single);
    if (r) resolved++;
  }
  return resolved;
}
