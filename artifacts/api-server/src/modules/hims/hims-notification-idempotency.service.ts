import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  userNotificationsTable,
  himsNotificationAuditTable,
  caseAssignmentsTable,
  casesTable,
  hrEmployeesTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";
import { logger } from "../../lib/logger.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

export type HimsNotificationSeverity = "info" | "warning" | "error" | "critical";
export type HimsNotificationTargetScope =
  | "firm"
  | "user"
  | "case_team"
  | "finance_team"
  | "compliance_team"
  | "responsible_lawyer";

export interface EnsureHimsNotificationInput {
  firmId: number;
  caseId?: number | null;
  idempotencyKey: string;
  notificationType: string;
  title: string;
  message: string;
  severity?: HimsNotificationSeverity;
  targetUserId?: number | null;
  targetScope?: HimsNotificationTargetScope;
  meta?: Record<string, unknown> | null;
  correlationId?: string | null;
  sourceSystem?: string | null;
  sourceEventName?: string | null;
  sourceEventRef?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  actorUserId?: number | null;
  dismissible?: boolean;
  resolutionMode?: string | null;
  ruleCode?: string | null;
  workflowRequired?: boolean;
}

export interface EnsureHimsNotificationResult {
  idempotencyKey: string;
  notificationId: number | null;
  auditId: number;
  wasCreated: boolean;
  wasDeduplicated: boolean;
  deduplicatedAgainstId: number | null;
  previousDeliveryCount: number;
  notificationCreated: boolean;
  notificationErrorCode?: string;
}

export async function resolveHimsNotificationRecipients(
  input: {
    firmId: number;
    caseId?: number | null;
    targetScope: HimsNotificationTargetScope;
    targetUserId?: number | null;
  },
  opts: { tx?: unknown } = {},
): Promise<number[]> {
  const conn = pickDbConn(opts.tx);
  const { firmId, caseId, targetScope, targetUserId } = input;

  if (targetScope === "user") {
    if (!Number.isInteger(targetUserId)) {
      throw new ApiError({
        status: 400,
        code: "HIMS_NOTIFICATION_TARGET_REQUIRED",
        message: "A valid target user is required for user-scoped HIMS notifications",
        retryable: false,
      });
    }
    return [Number(targetUserId)];
  }

  if (targetScope === "case_team") {
    if (!Number.isInteger(caseId)) {
      throw new ApiError({
        status: 400,
        code: "HIMS_NOTIFICATION_CASE_REQUIRED",
        message: "A valid case id is required for case_team-scoped HIMS notifications",
        retryable: false,
      });
    }
    const rows = await conn
      .select({ userId: caseAssignmentsTable.userId })
      .from(caseAssignmentsTable)
      .innerJoin(casesTable, eq(casesTable.id, caseAssignmentsTable.caseId))
      .where(and(
        eq(casesTable.firmId, firmId),
        eq(caseAssignmentsTable.caseId, Number(caseId)),
        isNull(caseAssignmentsTable.unassignedAt),
      ));
    const userIds = (rows ?? [])
      .map((r) => (typeof r.userId === "number" ? Number(r.userId) : null))
      .filter((v): v is number => v != null);
    if (userIds.length === 0) {
      throw new ApiError({
        status: 400,
        code: "HIMS_NOTIFICATION_CASE_TEAM_EMPTY",
        message: "Case team has no active members for HIMS notification",
        retryable: false,
      });
    }
    return [...new Set(userIds)];
  }

  if (targetScope === "responsible_lawyer") {
    if (!Number.isInteger(caseId)) {
      throw new ApiError({
        status: 400,
        code: "HIMS_NOTIFICATION_CASE_REQUIRED",
        message: "A valid case id is required for responsible_lawyer-scoped HIMS notifications",
        retryable: false,
      });
    }
    const rows = await conn
      .select({ userId: caseAssignmentsTable.userId })
      .from(caseAssignmentsTable)
      .innerJoin(casesTable, eq(casesTable.id, caseAssignmentsTable.caseId))
      .where(and(
        eq(casesTable.firmId, firmId),
        eq(caseAssignmentsTable.caseId, Number(caseId)),
        eq(caseAssignmentsTable.roleInCase, "lawyer"),
        isNull(caseAssignmentsTable.unassignedAt),
      ));
    const userIds = (rows ?? [])
      .map((r) => (typeof r.userId === "number" ? Number(r.userId) : null))
      .filter((v): v is number => v != null);
    if (userIds.length === 0) {
      throw new ApiError({
        status: 400,
        code: "HIMS_NOTIFICATION_RESPONSIBLE_LAWYER_NOT_FOUND",
        message: "No responsible lawyer assigned to case for HIMS notification",
        retryable: false,
      });
    }
    return [...new Set(userIds)];
  }

  if (targetScope === "firm" || targetScope === "finance_team" || targetScope === "compliance_team") {
    const whereParts: any[] = [
      eq(hrEmployeesTable.firmId, firmId),
      eq(hrEmployeesTable.employmentStatus, "active"),
    ];
    if (targetScope === "finance_team") {
      whereParts.push(eq(hrEmployeesTable.departmentId as any, 0));
    } else if (targetScope === "compliance_team") {
      whereParts.push(eq(hrEmployeesTable.departmentId as any, 0));
    }
    const rows = await conn
      .select({ linkedUserId: hrEmployeesTable.linkedUserId })
      .from(hrEmployeesTable)
      .where(and(...whereParts));
    const userIds = (rows ?? [])
      .map((r) => (typeof r.linkedUserId === "number" ? Number(r.linkedUserId) : null))
      .filter((v): v is number => v != null);
    if (userIds.length === 0) {
      throw new ApiError({
        status: 400,
        code: "HIMS_NOTIFICATION_FIRM_RECIPIENTS_EMPTY",
        message: `No active ${targetScope} members found for HIMS notification`,
        retryable: false,
      });
    }
    return [...new Set(userIds)];
  }

  throw new ApiError({
    status: 400,
    code: "HIMS_NOTIFICATION_SCOPE_UNSUPPORTED",
    message: `Unsupported target scope: ${targetScope}`,
    retryable: false,
  });
}

async function insertOneUserNotification(
  conn: DbConnLike,
  args: {
    firmId: number;
    userId: number;
    idemKey: string;
    input: EnsureHimsNotificationInput;
    severity: HimsNotificationSeverity;
    targetScope: string;
    sourceSystem: string;
    now: Date;
  },
): Promise<{ notificationId: number | null; created: boolean }> {
  const { firmId, userId, idemKey, input, severity, targetScope, sourceSystem, now } = args;
  const perUserKey = `HIMS_STATUS:${input.caseId ?? 0}:${input.notificationType ?? "NOTIFY"}:${userId}`;

  try {
    const existingNotif = (await conn
      .select({ id: userNotificationsTable.id })
      .from(userNotificationsTable as any)
      .where(and(
        eq(userNotificationsTable.firmId, firmId),
        eq(userNotificationsTable.correlationId as any, perUserKey),
      ))
      .limit(1))?.[0] as any;

    if (existingNotif) {
      return { notificationId: Number(existingNotif.id), created: false };
    }

    const notifRows = await conn
      .insert(userNotificationsTable as any)
      .values({
        firmId,
        userId,
        sourceType: sourceSystem,
        sourceId: typeof input.caseId === "number" ? input.caseId : typeof input.entityId === "number" ? input.entityId : null,
        caseId: typeof input.caseId === "number" ? input.caseId : null,
        notificationType: String(input.notificationType ?? "HIMS_GENERIC"),
        title: String(input.title ?? ""),
        message: String(input.message ?? ""),
        meta: input.meta ?? {},
        isRead: false,
        status: "unread",
        dismissible: input.dismissible !== false,
        severity,
        correlationId: perUserKey,
        resolutionMode: input.resolutionMode ?? "MANUAL_ALLOWED",
        ruleCode: input.ruleCode ?? input.notificationType ?? "HIMS_NOTIFY",
        entityType: input.entityType ?? (input.caseId ? "case" : null),
        entityId: typeof input.entityId === "number" ? input.entityId : (typeof input.caseId === "number" ? input.caseId : null),
        targetScope,
        deliveryCount: 1,
        lastNotifiedAt: now,
        createdAt: now,
        updatedAt: now,
      } as any)
      .onConflictDoNothing()
      .returning({ id: userNotificationsTable.id });

    if (notifRows?.[0]) {
      return { notificationId: Number((notifRows[0] as any).id), created: true };
    }

    const fallback = (await conn
      .select({ id: userNotificationsTable.id })
      .from(userNotificationsTable as any)
      .where(and(
        eq(userNotificationsTable.firmId, firmId),
        eq(userNotificationsTable.correlationId as any, perUserKey),
      ))
      .limit(1))?.[0] as any;
    if (fallback) {
      return { notificationId: Number(fallback.id), created: false };
    }
    return { notificationId: null, created: false };
  } catch (err) {
    logger.error(
      { err, firmId, userId, idemKey: perUserKey, caseId: input.caseId, event: "hims.notification_insert_failed" },
      "HIMS canonical notification insert failed",
    );
    if (input.workflowRequired === true) {
      throw new ApiError({
        status: 500,
        code: "HIMS_NOTIFICATION_INSERT_FAILED",
        message: "Workflow-required HIMS notification insert failed",
        retryable: true,
      });
    }
    return { notificationId: null, created: false };
  }
}

export async function ensureHimsNotification(
  input: EnsureHimsNotificationInput,
  opts: { tx?: unknown } = {},
): Promise<EnsureHimsNotificationResult> {
  const conn = pickDbConn(opts.tx);

  if (!input.idempotencyKey || !String(input.idempotencyKey).trim()) {
    throw new ApiError({
      status: 400,
      code: "HIMS_NOTIF_IDEM_REQUIRED",
      message: "HIMS notification idempotency key is required",
      retryable: false,
    });
  }

  const idemKey = String(input.idempotencyKey).trim();
  const now = new Date();
  const severity = (input.severity ?? "info") as HimsNotificationSeverity;
  const targetScope = (input.targetScope ?? "firm") as HimsNotificationTargetScope;
  const sourceSystem = input.sourceSystem ?? "HIMS";

  const existingAudit = (await conn
    .select()
    .from(himsNotificationAuditTable)
    .where(and(
      eq(himsNotificationAuditTable.firmId, input.firmId),
      eq(himsNotificationAuditTable.idempotencyKey, idemKey),
    ))
    .limit(1))?.[0] as any;

  if (existingAudit) {
    const prevDelivery = Number(existingAudit.deliveryCount ?? 0);
    try {
      await conn
        .update(himsNotificationAuditTable)
        .set({
          deliveryCount: prevDelivery + 1,
          lastDeliveryAttemptAt: now,
          updatedAt: now,
        } as any)
        .where(eq(himsNotificationAuditTable.id, Number(existingAudit.id)));
    } catch (err) {
      logger.warn({ err, auditId: existingAudit.id, event: "hims.audit_delivery_bump_failed" }, "HIMS audit delivery count bump best-effort failed");
    }

    return {
      idempotencyKey: idemKey,
      notificationId: typeof existingAudit.notificationId === "number" ? existingAudit.notificationId : null,
      auditId: Number(existingAudit.id),
      wasCreated: false,
      wasDeduplicated: true,
      deduplicatedAgainstId: Number(existingAudit.id),
      previousDeliveryCount: prevDelivery,
      notificationCreated: Boolean(existingAudit.notificationCreated),
    };
  }

  let notificationErrorCode: string | undefined;
  let anyNotifCreated = false;
  let firstNotificationId: number | null = null;

  try {
    const recipientUserIds = await resolveHimsNotificationRecipients(
      {
        firmId: input.firmId,
        caseId: input.caseId ?? null,
        targetScope,
        targetUserId: input.targetUserId ?? null,
      },
      { tx: conn },
    );

    for (const userId of recipientUserIds) {
      const result = await insertOneUserNotification(conn, {
        firmId: input.firmId,
        userId,
        idemKey,
        input,
        severity,
        targetScope,
        sourceSystem,
        now,
      });
      if (result.created) anyNotifCreated = true;
      if (result.notificationId != null && firstNotificationId == null) {
        firstNotificationId = result.notificationId;
      }
    }
  } catch (err: any) {
    if (err instanceof ApiError) {
      notificationErrorCode = String(err.code ?? "HIMS_NOTIFICATION_RESOLVE_FAILED");
      if (input.workflowRequired === true) throw err;
    } else {
      notificationErrorCode = "HIMS_NOTIFICATION_RESOLVE_ERROR";
      if (input.workflowRequired === true) {
        throw new ApiError({
          status: 500,
          code: notificationErrorCode,
          message: "Workflow-required HIMS recipient resolution failed",
          retryable: true,
        });
      }
    }
    logger.error(
      { err, firmId: input.firmId, caseId: input.caseId, targetScope, idemKey, event: "hims.recipient_resolution_failed" },
      "HIMS notification recipient resolution failed",
    );
  }

  let auditId: number | null = null;
  try {
    const auditRows = await conn
      .insert(himsNotificationAuditTable)
      .values({
        firmId: input.firmId,
        caseId: typeof input.caseId === "number" ? input.caseId : null,
        idempotencyKey: idemKey,
        notificationType: String(input.notificationType ?? "HIMS_GENERIC"),
        targetUserId: typeof input.targetUserId === "number" ? input.targetUserId : null,
        targetScope,
        payloadJson: {
          title: input.title,
          message: input.message,
          meta: input.meta ?? {},
          correlationId: input.correlationId ?? idemKey,
          sourceEventName: input.sourceEventName ?? null,
          sourceEventRef: input.sourceEventRef ?? null,
          notificationErrorCode,
        } as any,
        severity,
        correlationId: input.correlationId ?? idemKey,
        sourceSystem,
        sourceEventName: input.sourceEventName ?? null,
        sourceEventRef: input.sourceEventRef ?? null,
        notificationCreated: anyNotifCreated,
        notificationId: firstNotificationId,
        deduplicated: false,
        deduplicatedAgainstId: null,
        deliveryCount: 1,
        lastDeliveryAttemptAt: now,
        lastDeliveryError: notificationErrorCode ?? null,
        actorUserId: typeof input.actorUserId === "number" ? input.actorUserId : null,
        createdAt: now,
        updatedAt: now,
      } as any)
      .onConflictDoNothing()
      .returning({ id: himsNotificationAuditTable.id });

    if (auditRows?.[0]) {
      auditId = Number((auditRows[0] as any).id);
    } else {
      const fallbackAudit = (await conn
        .select({ id: himsNotificationAuditTable.id, notificationId: himsNotificationAuditTable.notificationId })
        .from(himsNotificationAuditTable)
        .where(and(
          eq(himsNotificationAuditTable.firmId, input.firmId),
          eq(himsNotificationAuditTable.idempotencyKey, idemKey),
        ))
        .limit(1))?.[0] as any;
      if (fallbackAudit) {
        auditId = Number(fallbackAudit.id);
        if (firstNotificationId == null && typeof fallbackAudit.notificationId === "number") {
          firstNotificationId = Number(fallbackAudit.notificationId);
        }
      }
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err?.code ?? "");
    const isUnique = /unique|uq_|23505|duplicate/i.test(msg);
    if (!isUnique) {
      logger.error({ err, firmId: input.firmId, idemKey, event: "hims.audit_insert_failed" }, "HIMS notification audit insert failed (non-unique)");
      if (input.workflowRequired === true) throw err;
    }
    const fallbackAudit = (await conn
      .select({ id: himsNotificationAuditTable.id, notificationId: himsNotificationAuditTable.notificationId })
      .from(himsNotificationAuditTable)
      .where(and(
        eq(himsNotificationAuditTable.firmId, input.firmId),
        eq(himsNotificationAuditTable.idempotencyKey, idemKey),
      ))
      .limit(1))?.[0] as any;
    if (fallbackAudit) {
      auditId = Number(fallbackAudit.id);
      if (firstNotificationId == null && typeof fallbackAudit.notificationId === "number") {
        firstNotificationId = Number(fallbackAudit.notificationId);
      }
    }
  }

  if (auditId == null) {
    throw new ApiError({
      status: 500,
      code: "HIMS_NOTIF_AUDIT_FAILED",
      message: "HIMS notification audit insert failed without id",
      retryable: true,
    });
  }

  return {
    idempotencyKey: idemKey,
    notificationId: firstNotificationId,
    auditId,
    wasCreated: anyNotifCreated && firstNotificationId != null,
    wasDeduplicated: false,
    deduplicatedAgainstId: null,
    previousDeliveryCount: 0,
    notificationCreated: anyNotifCreated,
    notificationErrorCode,
  };
}

export interface GetHimsNotificationStatusInput {
  firmId: number;
  idempotencyKey: string;
}

export interface HimsNotificationStatus {
  exists: boolean;
  auditId: number | null;
  notificationId: number | null;
  deliveryCount: number;
  notificationCreated: boolean;
  firstCreatedAt: Date | null;
  lastAttemptAt: Date | null;
  notificationType: string | null;
  severity: string | null;
}

export async function getHimsNotificationStatus(
  input: GetHimsNotificationStatusInput,
  opts: { tx?: unknown } = {},
): Promise<HimsNotificationStatus> {
  const conn = pickDbConn(opts.tx);

  const auditRow = (await conn
    .select()
    .from(himsNotificationAuditTable)
    .where(and(
      eq(himsNotificationAuditTable.firmId, input.firmId),
      eq(himsNotificationAuditTable.idempotencyKey, String(input.idempotencyKey ?? "").trim()),
    ))
    .limit(1))?.[0] as any;

  if (!auditRow) {
    return {
      exists: false,
      auditId: null,
      notificationId: null,
      deliveryCount: 0,
      notificationCreated: false,
      firstCreatedAt: null,
      lastAttemptAt: null,
      notificationType: null,
      severity: null,
    };
  }

  return {
    exists: true,
    auditId: Number(auditRow.id),
    notificationId: typeof auditRow.notificationId === "number" ? auditRow.notificationId : null,
    deliveryCount: Number(auditRow.deliveryCount ?? 0),
    notificationCreated: Boolean(auditRow.notificationCreated),
    firstCreatedAt: auditRow.createdAt ?? null,
    lastAttemptAt: auditRow.lastDeliveryAttemptAt ?? auditRow.updatedAt ?? null,
    notificationType: auditRow.notificationType ?? null,
    severity: auditRow.severity ?? null,
  };
}

export function buildHimsCaseMismatchIdemKey(caseId: number | string, fieldKey: string): string {
  const safeField = String(fieldKey ?? "").replace(/[^a-zA-Z0-9_:.-]/g, "_");
  return `HIMS_MISMATCH:${caseId}:${safeField}`;
}

export function buildHimsStatusChangeIdemKey(caseId: number | string, oldStatus: string, newStatus: string): string {
  return `HIMS_STATUS_CHANGE:${caseId}:${oldStatus || "NULL"}->${newStatus || "NULL"}`;
}

export function buildHimsTrackingStartIdemKey(caseId: number | string): string {
  return `HIMS_TRACKER_START:${caseId}`;
}

export function buildEkycVerificationIdemKey(caseId: number | string, ekycTxId: string): string {
  const safeTxId = String(ekycTxId ?? "").replace(/[^a-zA-Z0-9_:.-]/g, "_");
  return `EKYC_VERIFIED:${caseId}:${safeTxId}`;
}
