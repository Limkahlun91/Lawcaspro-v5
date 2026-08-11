import { and, eq } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  userNotificationsTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

const himsNotificationAuditTable = pgTable("hims_notification_audit", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  notificationType: text("notification_type").notNull(),
  targetUserId: integer("target_user_id"),
  targetScope: text("target_scope").notNull().default("firm"),
  payloadJson: jsonb("payload_json"),
  severity: text("severity").default("info"),
  correlationId: text("correlation_id"),
  sourceSystem: text("source_system").notNull().default("HIMS"),
  sourceEventName: text("source_event_name"),
  sourceEventRef: text("source_event_ref"),
  notificationCreated: boolean("notification_created").notNull().default(false),
  notificationId: integer("notification_id"),
  deduplicated: boolean("deduplicated").notNull().default(false),
  deduplicatedAgainstId: integer("deduplicated_against_id"),
  deliveryCount: integer("delivery_count").notNull().default(0),
  lastDeliveryAttemptAt: timestamp("last_delivery_attempt_at", { withTimezone: true }),
  lastDeliveryError: text("last_delivery_error"),
  actorUserId: integer("actor_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_hims_notif_audit_firm").on(t.firmId),
  firmCaseIdx: index("idx_hims_notif_audit_firm_case").on(t.firmId, t.caseId),
  uqIdem: uniqueIndex("uq_hims_notif_audit_idem").on(t.firmId, t.idempotencyKey),
}));

export type HimsNotificationSeverity = "info" | "warning" | "error" | "critical";
export type HimsNotificationTargetScope = "firm" | "user" | "case_team" | "finance_team" | "compliance_team";

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
}

export interface EnsureHimsNotificationResult {
  idempotencyKey: string;
  notificationId: number | null;
  auditId: number;
  wasCreated: boolean;
  wasDeduplicated: boolean;
  deduplicatedAgainstId: number | null;
  previousDeliveryCount: number;
}

export async function ensureHimsNotification(
  input: EnsureHimsNotificationInput,
  opts: { tx?: unknown } = {},
): Promise<EnsureHimsNotificationResult> {
  const conn = pickDbConn(opts.tx);

  if (!input.idempotencyKey || !String(input.idempotencyKey).trim()) {
    throw new ApiError({ status: 400, code: "HIMS_NOTIF_IDEM_REQUIRED", message: "HIMS notification idempotency key is required", retryable: false });
  }

  const idemKey = String(input.idempotencyKey).trim();
  const now = new Date();
  const severity = input.severity ?? "info";
  const targetScope = input.targetScope ?? "firm";
  const sourceSystem = input.sourceSystem ?? "HIMS";

  const existingAudit = (await conn
    .select()
    .from(himsNotificationAuditTable as any)
    .where(and(
      eq(himsNotificationAuditTable.firmId, input.firmId),
      eq(himsNotificationAuditTable.idempotencyKey, idemKey),
    ))
    .limit(1))?.[0] as any;

  if (existingAudit) {
    const prevDelivery = Number(existingAudit.deliveryCount ?? 0);
    try {
      await conn
        .update(himsNotificationAuditTable as any)
        .set({
          deliveryCount: prevDelivery + 1,
          lastDeliveryAttemptAt: now,
          updatedAt: now,
        } as any)
        .where(eq(himsNotificationAuditTable.id, Number(existingAudit.id)));
    } catch {
      // best-effort delivery count bump
    }

    return {
      idempotencyKey: idemKey,
      notificationId: typeof existingAudit.notificationId === "number" ? existingAudit.notificationId : null,
      auditId: Number(existingAudit.id),
      wasCreated: false,
      wasDeduplicated: true,
      deduplicatedAgainstId: Number(existingAudit.id),
      previousDeliveryCount: prevDelivery,
    };
  }

  let notificationId: number | null = null;
  let notificationCreated = false;

  try {
    const existingNotif = (await conn
      .select({ id: userNotificationsTable.id })
      .from(userNotificationsTable as any)
      .where(and(
        eq(userNotificationsTable.firmId, input.firmId),
        eq(userNotificationsTable.correlationId as any, idemKey),
      ))
      .limit(1))?.[0] as any;

    if (existingNotif) {
      notificationId = Number(existingNotif.id);
      notificationCreated = true;
    } else {
      const notifRows = await conn
        .insert(userNotificationsTable as any)
        .values({
          firmId: input.firmId,
          userId: typeof input.targetUserId === "number" ? input.targetUserId : 0,
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
          correlationId: idemKey,
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
        notificationId = Number((notifRows[0] as any).id);
        notificationCreated = true;
      } else {
        const fallback = (await conn
          .select({ id: userNotificationsTable.id })
          .from(userNotificationsTable as any)
          .where(and(
            eq(userNotificationsTable.firmId, input.firmId),
            eq(userNotificationsTable.correlationId as any, idemKey),
          ))
          .limit(1))?.[0] as any;
        if (fallback) {
          notificationId = Number(fallback.id);
          notificationCreated = true;
        }
      }
    }
  } catch (err: any) {
    notificationCreated = notificationId != null;
  }

  let auditId: number | null = null;
  try {
    const auditRows = await conn
      .insert(himsNotificationAuditTable as any)
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
        } as any,
        severity,
        correlationId: input.correlationId ?? idemKey,
        sourceSystem,
        sourceEventName: input.sourceEventName ?? null,
        sourceEventRef: input.sourceEventRef ?? null,
        notificationCreated,
        notificationId,
        deduplicated: false,
        deduplicatedAgainstId: null,
        deliveryCount: 1,
        lastDeliveryAttemptAt: now,
        lastDeliveryError: null,
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
        .from(himsNotificationAuditTable as any)
        .where(and(
          eq(himsNotificationAuditTable.firmId, input.firmId),
          eq(himsNotificationAuditTable.idempotencyKey, idemKey),
        ))
        .limit(1))?.[0] as any;
      if (fallbackAudit) {
        auditId = Number(fallbackAudit.id);
        if (notificationId == null && typeof fallbackAudit.notificationId === "number") {
          notificationId = Number(fallbackAudit.notificationId);
        }
      }
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err?.code ?? "");
    const isUnique = /unique|uq_|23505|duplicate/i.test(msg);
    if (!isUnique) throw err;

    const fallbackAudit = (await conn
      .select({ id: himsNotificationAuditTable.id, notificationId: himsNotificationAuditTable.notificationId })
      .from(himsNotificationAuditTable as any)
      .where(and(
        eq(himsNotificationAuditTable.firmId, input.firmId),
        eq(himsNotificationAuditTable.idempotencyKey, idemKey),
      ))
      .limit(1))?.[0] as any;
    if (fallbackAudit) {
      auditId = Number(fallbackAudit.id);
      if (notificationId == null && typeof fallbackAudit.notificationId === "number") {
        notificationId = Number(fallbackAudit.notificationId);
      }
    }
  }

  if (auditId == null) {
    throw new ApiError({ status: 500, code: "HIMS_NOTIF_AUDIT_FAILED", message: "HIMS notification audit insert failed without id", retryable: true });
  }

  return {
    idempotencyKey: idemKey,
    notificationId,
    auditId,
    wasCreated: notificationCreated && notificationId != null,
    wasDeduplicated: false,
    deduplicatedAgainstId: null,
    previousDeliveryCount: 0,
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
    .from(himsNotificationAuditTable as any)
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
